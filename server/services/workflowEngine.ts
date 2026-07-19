/**
 * Workflow engine — the runtime that actually FIRES event-triggered workflow
 * rules (the /v2/workflows › "Workflow rules" surface and its AI-suggested
 * rules). Until now only `deal_stuck` rules ran (a nightly cron) and `testFire`
 * (manual). Rules with event triggers — `signal_received`, `record_created`,
 * `stage_changed`, … — could be saved but never fired at runtime.
 *
 * This module closes that gap: `fireWorkflowRules(ws, triggerType, ctx)` loads
 * the enabled rules for a trigger, filters them through the shared
 * `evalConditions` predicate (+ optional signal/entity gates from
 * triggerConfig), runs each matching rule's actions, and records a workflow_run
 * + bumps fireCount — exactly like the deal_stuck / testFire paths, but for any
 * trigger and from any event site.
 *
 * Action coverage: webhook / post_slack / notify_teams (outbound alerts, same
 * logic as testFire) PLUS the CRM actions `create_task` and `notify`. Unknown
 * action types (e.g. update_field, enroll — which need entity-specific context)
 * are skipped silently rather than erroring. Best-effort throughout: a single
 * action or rule failing never throws into the caller's event path.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import {
  contacts, emailDrafts, enrollments, leads, notifications, opportunities,
  sequences, tasks, workflowRules, workflowRuns, workspaceSettings,
} from "../../drizzle/schema";
import { invokeLLM } from "../_core/llm";

/**
 * Evaluate a rule's condition spec against a flat payload. Supports `{all:[…]}`
 * (AND) and `{any:[…]}` (OR) groups of `{field, op, value}` comparators. Lives
 * here (the engine) so both the runtime dispatcher and operations' testFire
 * share one predicate with no import cycle; re-exported from routers/operations
 * for backward-compatible importers (leadScoring, tests).
 */
export function evalConditions(
  spec: { all?: Array<{ field: string; op: string; value: any }>; any?: Array<{ field: string; op: string; value: any }> },
  payload: Record<string, any>,
): boolean {
  const cmp = (op: string, a: any, b: any) => {
    switch (op) {
      case "eq": return a === b;
      case "neq": return a !== b;
      case "gt": return Number(a) > Number(b);
      case "gte": return Number(a) >= Number(b);
      case "lt": return Number(a) < Number(b);
      case "lte": return Number(a) <= Number(b);
      case "contains": return String(a ?? "").toLowerCase().includes(String(b).toLowerCase());
      default: return false;
    }
  };
  if (spec.all && !spec.all.every((c) => cmp(c.op, payload[c.field], c.value))) return false;
  if (spec.any && !spec.any.some((c) => cmp(c.op, payload[c.field], c.value))) return false;
  return true;
}

export type WorkflowTrigger =
  | "record_created" | "record_updated" | "stage_changed" | "task_overdue"
  | "nps_submitted" | "signal_received" | "field_equals" | "schedule" | "deal_stuck";

type Action = { type: string; params?: Record<string, any> };

export interface FireContext {
  /** Flat payload matched against each rule's conditions (+ signal/entity gates). */
  payload: Record<string, any>;
  /** CRM linkage for create_task. */
  relatedType?: string;
  relatedId?: number | null;
  ownerUserId?: number | null;
}

const TASK_TYPES = ["call", "manual_email", "social_touch", "follow_up", "meeting_prep", "crm_update", "generic_action", "todo"];
const TASK_PRIORITIES = ["low", "normal", "high", "urgent"];

/** Bare-array conditions (`[{field,op,value}]`) → `{all:[…]}` so evalConditions applies them. */
function normalizeConditions(raw: unknown): { all?: any[]; any?: any[] } {
  if (Array.isArray(raw)) return { all: raw as any[] };
  if (raw && typeof raw === "object") return raw as { all?: any[]; any?: any[] };
  return {};
}

async function runAction(
  db: any, ws: number, rule: any, action: Action,
  wsSettings: { slackWebhookUrl?: string | null; teamsWebhookUrl?: string | null } | undefined,
  ctx: FireContext,
): Promise<string | null> {
  const p = action.params ?? {};
  try {
    switch (action.type) {
      case "webhook": {
        const url = p.url;
        if (!url) return "webhook: no url";
        const body = p.body ? JSON.stringify(p.body)
          : JSON.stringify({ event: "workflow_fired", ruleId: rule.id, ruleName: rule.name, payload: ctx.payload, firedAt: new Date().toISOString() });
        const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(p.headers ?? {}) }, body, signal: AbortSignal.timeout(10_000) });
        return resp.ok ? null : `webhook ${url} returned ${resp.status}`;
      }
      case "post_slack": {
        const url = wsSettings?.slackWebhookUrl;
        if (!url) return "post_slack: no Slack webhook configured";
        const payload: Record<string, any> = { text: p.message ?? `Workflow rule fired: ${rule.name}` };
        if (p.channel) payload.channel = p.channel;
        const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
        return resp.ok ? null : `Slack webhook returned ${resp.status}`;
      }
      case "notify_teams": {
        const url = wsSettings?.teamsWebhookUrl;
        if (!url) return "notify_teams: no Teams webhook configured";
        const message = p.message ?? `Workflow rule fired: ${rule.name}`;
        const payload = { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: { type: "AdaptiveCard", body: [{ type: "TextBlock", text: message, wrap: true }], "$schema": "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4" } }] };
        const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
        return resp.ok ? null : `Teams webhook returned ${resp.status}`;
      }
      case "create_task": {
        const type = TASK_TYPES.includes(p.type) ? p.type : "follow_up";
        const priority = TASK_PRIORITIES.includes(p.priority) ? p.priority : "normal";
        const days = Number.isFinite(Number(p.dueInDays)) ? Math.max(0, Math.min(30, Math.round(Number(p.dueInDays)))) : null;
        await db.insert(tasks).values({
          workspaceId: ws,
          title: String(p.title ?? rule.name ?? "Workflow task").slice(0, 240),
          description: p.description ?? rule.description ?? null,
          type, priority, status: "open",
          dueAt: days == null ? null : new Date(Date.now() + days * 86400000),
          relatedType: ctx.relatedType ?? null,
          relatedId: ctx.relatedId ?? null,
          ownerUserId: p.ownerUserId ?? ctx.ownerUserId ?? null,
          source: "workflow",
        } as never);
        return null;
      }
      // The rule builder emits "notify_user"; this case was named "notify",
      // so every "Notify user" action fell through to the silent default and
      // did nothing while the run still logged as successful.
      case "notify":
      case "notify_user": {
        const uid = p.userId ?? ctx.ownerUserId;
        if (!uid) return null; // no explicit target — skip quietly (team alerts use slack/teams/webhook)
        await db.insert(notifications).values({
          workspaceId: ws, userId: Number(uid), kind: "workflow_fired",
          title: String(p.title ?? `Rule fired: ${rule.name}`).slice(0, 240),
          body: p.message ?? null,
        } as never);
        return null;
      }

      case "enroll_sequence": {
        const sequenceId = Number(p.sequenceId);
        if (!Number.isFinite(sequenceId) || sequenceId <= 0) return "enroll_sequence: no sequenceId set";
        // Only people can be enrolled. An opportunity-triggered rule has no
        // single person to mail, so say so rather than failing obscurely.
        const target = ctx.relatedType;
        if (target !== "contact" && target !== "lead" && target !== "prospect") {
          return `enroll_sequence: cannot enroll a ${target ?? "record"} — needs a contact, lead or prospect`;
        }
        if (!ctx.relatedId) return "enroll_sequence: no record to enroll";
        // Sequence must belong to this workspace (params come from user input).
        const [seq] = await db.select({ id: sequences.id }).from(sequences)
          .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, ws))).limit(1);
        if (!seq) return `enroll_sequence: sequence ${sequenceId} not found in this workspace`;

        const col = target === "contact" ? enrollments.contactId
          : target === "lead" ? enrollments.leadId : enrollments.prospectId;
        const [existing] = await db.select({ id: enrollments.id }).from(enrollments)
          .where(and(
            eq(enrollments.workspaceId, ws),
            eq(enrollments.sequenceId, sequenceId),
            eq(col, ctx.relatedId),
          )).limit(1);
        if (existing) return null; // already enrolled — not an error, just a no-op

        await db.insert(enrollments).values({
          workspaceId: ws,
          sequenceId,
          contactId: target === "contact" ? ctx.relatedId : null,
          leadId: target === "lead" ? ctx.relatedId : null,
          prospectId: target === "prospect" ? ctx.relatedId : null,
          status: "active",
          currentStep: 0,
          nextActionAt: new Date(),
        } as never);
        return null;
      }

      case "update_field": {
        const field = String(p.field ?? "").trim();
        const raw = String(p.value ?? "").trim();
        if (!field) return "update_field: no field set";
        if (!ctx.relatedId) return "update_field: no record to update";

        // Strict per-entity whitelist. Params are user input and this writes
        // to the DB, so an allowlist is the only safe shape here — never
        // interpolate a caller-supplied column name.
        const ALLOWED: Record<string, Record<string, "string" | "number">> = {
          opportunity: { stage: "string", value: "number", winProb: "number", ownerUserId: "number", nextStep: "string" },
          lead:        { status: "string", score: "number", ownerUserId: "number" },
          contact:     { title: "string", ownerUserId: "number" },
        };
        const entity = ctx.relatedType ?? "";
        const allowed = ALLOWED[entity];
        if (!allowed) return `update_field: not supported for ${entity || "this record type"}`;
        const kind = allowed[field];
        if (!kind) {
          return `update_field: "${field}" is not updatable on a ${entity} (allowed: ${Object.keys(allowed).join(", ")})`;
        }
        let val: string | number = raw;
        if (kind === "number") {
          const n = Number(raw);
          if (!Number.isFinite(n)) return `update_field: "${raw}" is not a number`;
          val = n;
        }
        const table = entity === "opportunity" ? opportunities : entity === "lead" ? leads : contacts;
        const idCol = entity === "opportunity" ? opportunities.id : entity === "lead" ? leads.id : contacts.id;
        const wsCol = entity === "opportunity" ? opportunities.workspaceId : entity === "lead" ? leads.workspaceId : contacts.workspaceId;
        await db.update(table)
          .set({ [field]: val } as never)
          .where(and(eq(idCol, ctx.relatedId), eq(wsCol, ws)));
        return null;
      }

      case "send_email_draft": {
        if (!ctx.relatedId) return "send_email_draft: no record to write to";
        const entity = ctx.relatedType ?? "";
        if (entity !== "contact" && entity !== "lead") {
          return `send_email_draft: needs a contact or lead, got ${entity || "nothing"}`;
        }
        const table = entity === "contact" ? contacts : leads;
        const idCol = entity === "contact" ? contacts.id : leads.id;
        const wsCol = entity === "contact" ? contacts.workspaceId : leads.workspaceId;
        const [rec] = await db.select().from(table)
          .where(and(eq(idCol, ctx.relatedId), eq(wsCol, ws))).limit(1);
        if (!rec?.email) return "send_email_draft: record has no email address";

        const goal = String(p.goal ?? "follow up").slice(0, 500);
        const tone = String(p.tone ?? "professional").slice(0, 40);
        let subject = "";
        let body = "";
        try {
          const out = await invokeLLM({
            workspaceId: ws,
            maxTokens: 700,
            temperature: 0.7,
            messages: [
              {
                role: "system",
                content: `You write short B2B emails. Tone: ${tone}. Use {{firstName}} and {{senderName}} as literal placeholder tokens — they are substituted per recipient later, so never invent a real name. Do not fabricate facts or metrics.`,
              },
              { role: "user", content: `Write the email. Goal: ${goal}` },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "email_draft", strict: true,
                schema: {
                  type: "object",
                  properties: { subject: { type: "string" }, body: { type: "string" } },
                  required: ["subject", "body"], additionalProperties: false,
                },
              },
            },
          });
          const content = out.choices?.[0]?.message?.content;
          const parsed = typeof content === "string" ? JSON.parse(content) : content;
          subject = String(parsed?.subject ?? "").trim();
          body = String(parsed?.body ?? "").trim();
        } catch (e) {
          return `send_email_draft: generation failed — ${(e as Error).message}`;
        }
        // Same rule as the sequence engine: never queue an empty email.
        if (!body) return "send_email_draft: generation returned nothing";

        await db.insert(emailDrafts).values({
          workspaceId: ws,
          subject: subject || "Following up",
          body,
          toContactId: entity === "contact" ? ctx.relatedId : null,
          toLeadId: entity === "lead" ? ctx.relatedId : null,
          toEmail: rec.email,
          status: "pending_review",
          aiGenerated: true,
          aiPrompt: goal,
        } as never);
        return null;
      }

      default:
        // Previously `return null` — an unknown action reported SUCCESS while
        // doing nothing, so a misconfigured rule looked like it worked. Fail
        // loudly instead; the error surfaces on the run record.
        return `unsupported action type "${action.type}"`;
    }
  } catch (e) {
    return `${action.type}: ${(e as Error).message}`;
  }
}

/**
 * Run every action on a rule, returning the list of per-action error strings
 * (empty = all succeeded). Fetches the workspace's Slack/Teams webhook config
 * once. Shared by the runtime dispatcher and operations' manual testFire so both
 * execute the SAME action set (webhook/slack/teams + create_task/notify).
 */
export async function executeRuleActions(
  workspaceId: number,
  rule: { id?: number; name?: string; description?: string | null; actions?: unknown },
  ctx: FireContext,
): Promise<string[]> {
  const db = await getDb();
  if (!db) return ["database unavailable"];
  const [wsSettings] = await db
    .select({ slackWebhookUrl: workspaceSettings.slackWebhookUrl, teamsWebhookUrl: workspaceSettings.teamsWebhookUrl })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId));
  const actions = Array.isArray(rule.actions) ? (rule.actions as Action[]) : [];
  const errors: string[] = [];
  for (const a of actions) {
    const err = await runAction(db, workspaceId, rule, a, wsSettings, ctx);
    if (err) errors.push(err);
  }
  return errors;
}

/**
 * Evaluate + fire all enabled rules for `triggerType` against `ctx`. Returns how
 * many rules matched their conditions and how many were fired (executed). Never
 * throws — safe to call fire-and-forget from any event site.
 */
export async function fireWorkflowRules(
  workspaceId: number,
  triggerType: WorkflowTrigger,
  ctx: FireContext,
): Promise<{ matched: number; fired: number }> {
  try {
    const db = await getDb();
    if (!db) return { matched: 0, fired: 0 };

    const rules = await db
      .select()
      .from(workflowRules)
      .where(and(
        eq(workflowRules.workspaceId, workspaceId),
        eq(workflowRules.enabled, true),
        eq(workflowRules.triggerType, triggerType as never),
      ));
    if (rules.length === 0) return { matched: 0, fired: 0 };

    const [wsSettings] = await db
      .select({ slackWebhookUrl: workspaceSettings.slackWebhookUrl, teamsWebhookUrl: workspaceSettings.teamsWebhookUrl })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId));

    let matched = 0;
    let fired = 0;
    for (const rule of rules) {
      const cfg = (rule.triggerConfig ?? {}) as Record<string, any>;
      // signal_received: optional signal-name gate (e.g. only "job_change").
      if (triggerType === "signal_received" && cfg.signal && cfg.signal !== ctx.payload.signal) continue;
      // Optional entity gate shared by record_* / field_equals rules.
      if (cfg.entity && ctx.payload.entity && cfg.entity !== ctx.payload.entity) continue;
      if (!evalConditions(normalizeConditions(rule.conditions), ctx.payload)) continue;
      matched++;

      const actions = Array.isArray(rule.actions) ? (rule.actions as Action[]) : [];
      const errors: string[] = [];
      for (const a of actions) {
        const err = await runAction(db, workspaceId, rule, a, wsSettings, ctx);
        if (err) errors.push(err);
      }

      try {
        await db.insert(workflowRuns).values({
          workspaceId, ruleId: rule.id,
          triggeredBy: `signal:${String(triggerType).slice(0, 40)}`,
          status: errors.length === 0 ? "success" : "failed",
          actionsRun: rule.actions,
          errorMessage: errors.length ? errors.join("; ").slice(0, 1000) : null,
        } as never);
        await db
          .update(workflowRules)
          .set({ fireCount: (rule.fireCount ?? 0) + 1, lastFiredAt: new Date() })
          .where(eq(workflowRules.id, rule.id));
      } catch (e) {
        console.error(`[WorkflowEngine] ws ${workspaceId} rule ${rule.id} run-log failed:`, (e as Error).message);
      }
      fired++;
    }
    return { matched, fired };
  } catch (e) {
    console.error(`[WorkflowEngine] ws ${workspaceId} ${triggerType} failed:`, (e as Error).message);
    return { matched: 0, fired: 0 };
  }
}
