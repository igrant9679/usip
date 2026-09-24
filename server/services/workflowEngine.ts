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
 * Action coverage is now the FULL builder list: webhook / post_slack /
 * notify_teams (outbound alerts, same logic as testFire) plus the CRM actions
 * create_task, notify (aliased from the builder's `notify_user`),
 * enroll_sequence, update_field and send_email_draft. An unrecognised action
 * type returns an error string — it used to return null, i.e. report success
 * while doing nothing, which is how four of the eight builder actions stayed
 * dead without anyone noticing.
 *
 * Trigger dispatch sites (a trigger with no site here can never fire).
 * 2026-09-20 trigger inventory — each row was verified against the code, and
 * the gaps it found are now closed:
 *   record_created  → routers/crm.ts (leads.create, contacts.create,
 *                     opportunities.create, leads.convert ×2) via
 *                     fireRecordCreated; plus the single-record capture paths
 *                     routers/forms.ts, landingPages.ts, bookingLinks.ts,
 *                     chatAgents.ts and prospects.ts (promoteToLead /
 *                     promoteToContact, only when they really insert)
 *   record_updated  → routers/crm.ts (leads.update, contacts.update,
 *                     opportunities.update, leads.convert) via fireRecordUpdated
 *   stage_changed   → FIVE doors write opportunities.stage, and until now only
 *                     the first fired: routers/crm.ts setStage,
 *                     routers/pipelineAlerts.ts moveDealStage,
 *                     routers/opportunityIntelligence.ts reviewStageChange, and
 *                     both proposal-accept paths in routers/proposals.ts
 *   signal_received → services/linkedinEnrichment/jobChangeReengagement.ts,
 *                     services/company/brandReconciler.ts, routers/are/execution.ts
 *   task_overdue    → runTaskOverdueCron below, registered in _core/index.ts
 *   deal_stuck      → routers/operations.ts checkDealAging (separate path)
 * If you add a trigger to the builder, add its dispatch site in the same
 * commit — otherwise it saves, shows active, and sits at fireCount 0 forever.
 *
 * A dispatch site is not enough on its own: the record_* payloads are built by
 * buildRecordPayload from RECORD_FIELDS in @shared/workflowTriggers, which is
 * also what the rule builder offers as condition fields. They were two
 * separate hand-written lists with NO keys in common, so a record_created rule
 * with any condition on it evaluated against `undefined` and never matched —
 * a fired trigger and a dead rule look identical from the UI (2026-09-20).
 *
 * What must NEVER dispatch: bulk and engine paths. A 5,000-row CSV import that
 * fired 5,000 rules would POST 5,000 webhooks; the imports, prospect-import,
 * LinkedIn/Places/scraper finders, discovery consolidation, leadBridge,
 * personLink, crmMatching.findOrCreateAccount, prospectPromotion (shared with
 * the enrichment cron) and ARE promotion paths therefore carry no fire. Note
 * that "one tRPC mutation = one record" is NOT a structural guarantee here:
 * routers/are/prospectsBulk.ts builds an appRouter.createCaller and loops it
 * over a whole campaign, so anything reachable from such a loop counts as bulk.
 *
 * Best-effort throughout: a single action or rule failing never throws into
 * the caller's event path.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../db";
import { archivedWorkspaceIds, isWorkspaceArchived } from "../_core/workspaceArchive";
import { notifyIfEnabled } from "./policyNotify";
import {
  contacts, emailDrafts, enrollments, leads, notifications, opportunities,
  sequences, tasks, workflowRules, workflowRuns, workspaceSettings,
} from "../../drizzle/schema";
import { invokeLLM } from "../_core/llm";
import { RECORD_FIELDS } from "@shared/workflowTriggers";

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
      /**
       * The condition editor has offered "in list" since it was written, and
       * this switch had no case for it — so it fell to `default: return false`
       * and every rule using it evaluated false forever. In an `all` group that
       * means the rule never fires, with no error and nothing in the UI to
       * suggest anything is wrong. seed.ts's "Flag stalled deals" sample rule
       * uses it too.
       *
       * Two shapes reach here and both must work: the editor stores `value` as
       * a STRING (a user types "proposal, negotiation"), while seed.ts and the
       * AI generator store a real array. Compared as trimmed strings because
       * the payload side is frequently a number (stage ids, scores) against a
       * list typed by hand.
       */
      case "in": {
        const list = Array.isArray(b)
          ? b
          : String(b ?? "").split(",");
        const needle = String(a ?? "").trim();
        return list.some((v) => String(v ?? "").trim() === needle);
      }
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

/**
 * Bare-array conditions (`[{field,op,value}]`) → `{all:[…]}` so evalConditions
 * applies them. Exported because the deal_stuck loops in routers/operations.ts
 * read `rule.conditions` straight off the row too, and a rule saved by the
 * builder (a bare array) would otherwise evaluate as an empty spec there.
 */
export function normalizeConditions(raw: unknown): { all?: any[]; any?: any[] } {
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
            sendersBrand: true,
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
 * Burst cap. forms.submit, landingPages.submit, chatAgents and bookingLinks are
 * PUBLIC endpoints with no rate limiting of any kind, and every one of them now
 * creates a lead that dispatches record_created. Without a valve, a form-spam
 * run turns straight into an outbound webhook flood against a customer's
 * endpoint — the app attacking someone on the spammer's behalf.
 *
 * Per-PROCESS, deliberately: Railway may run more than one instance, so this is
 * a safety valve, not a quota. A plain object rather than a Map because the
 * ES5 target refuses for-of/spread over a Map (TS2802).
 */
const BURST_MAX = 50;              // events per workspace+trigger per window
const BURST_WINDOW_MS = 60_000;
const burst: Record<string, { windowStart: number; count: number; logged: boolean }> = {};

/**
 * Count this event; `capped` once the window is over its cap, `firstOverflow`
 * only on the transition INTO the capped state. Exported so the suite can
 * exercise the window arithmetic directly — the dispatcher it guards needs a
 * database and therefore cannot be driven from a unit test.
 */
export function burstExceeded(workspaceId: number, triggerType: string): { capped: boolean; firstOverflow: boolean } {
  const key = `${workspaceId}:${triggerType}`;
  const now = Date.now();
  let w = burst[key];
  if (!w || now - w.windowStart >= BURST_WINDOW_MS) {
    w = { windowStart: now, count: 0, logged: false };
    burst[key] = w;
  }
  w.count++;
  if (w.count <= BURST_MAX) return { capped: false, firstOverflow: false };
  // Log the suppression ONCE per window. Logging per rule per event would make
  // the valve cost more DB writes than the webhooks it is preventing.
  const firstOverflow = !w.logged;
  w.logged = true;
  return { capped: true, firstOverflow };
}

/** Test seam: the cap is process-global state, so a suite must be able to clear it. */
export function __resetBurstWindows(): void {
  const keys = Object.keys(burst);
  for (let i = 0; i < keys.length; i++) delete burst[keys[i]!];
}

/**
 * The entity gate. For the record_* triggers an ABSENT entity means "lead"
 * (2026-09-20): leads.create/update was their only dispatch site until the
 * inventory above widened it, so every rule saved before that was authored
 * against leads and nothing ever set `entity`. Treating absent as "any" would
 * have made a "task a rep on a new inbound lead" rule start tasking someone on
 * every opportunity too.
 *
 * Defaulted at READ time rather than backfilled into a column: a backfill only
 * covers the rows that exist the day it runs, and three writers keep creating
 * entity-less rules afterwards — the builder, workflows.create in
 * routers/operations.ts, and the AI generator's apply path.
 *
 * Exported as a pure predicate because the dispatcher it guards needs a
 * database, so this is the only place the semantics can actually be tested.
 */
export function entityGateAllows(triggerType: string, cfgEntity: unknown, payloadEntity: unknown): boolean {
  const cfg = typeof cfgEntity === "string" && cfgEntity ? cfgEntity : null;
  if (triggerType === "record_created" || triggerType === "record_updated") {
    const want = cfg ?? "lead";
    return want === "any" || want === payloadEntity;
  }
  // Every other trigger keeps the legacy shape: an entity is an optional
  // filter, never a default — a legacy AI-authored signal_received rule may
  // carry a stray `entity` that must not turn into a hard filter.
  if (!cfg || typeof payloadEntity !== "string" || !payloadEntity) return true;
  return cfg === payloadEntity;
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

    // An archived workspace must stop sending, spending and creating records.
    // This is one of the three paths that could previously POST to a customer's
    // webhook from a frozen workspace (the others: runTaskOverdueCron and
    // operations.checkDealAging, both guarded in the same commit).
    if (await isWorkspaceArchived(workspaceId)) return { matched: 0, fired: 0 };

    const rules = await db
      .select()
      .from(workflowRules)
      .where(and(
        eq(workflowRules.workspaceId, workspaceId),
        eq(workflowRules.enabled, true),
        eq(workflowRules.triggerType, triggerType as never),
      ));
    if (rules.length === 0) return { matched: 0, fired: 0 };

    // Counted only once a workspace actually HAS rules for this trigger, so the
    // common no-rules case costs nothing and cannot poison a later window.
    const cap = burstExceeded(workspaceId, triggerType);
    if (cap.capped) {
      if (cap.firstOverflow) {
        console.warn(`[WorkflowEngine] ws ${workspaceId} ${triggerType}: >${BURST_MAX} events in 60s — suppressing for the rest of the window`);
        try {
          await db.insert(workflowRuns).values({
            workspaceId, ruleId: rules[0]!.id,
            triggeredBy: "burst_cap",
            status: "skipped",
            actionsRun: null,
            errorMessage: `burst cap: >${BURST_MAX} ${triggerType} events in 60s — suppressed`,
            relatedType: ctx.relatedType ?? null,
            relatedId: ctx.relatedId ?? null,
          } as never);
        } catch (e) {
          console.error(`[WorkflowEngine] ws ${workspaceId} burst-cap log failed:`, (e as Error).message);
        }
      }
      return { matched: 0, fired: 0 };
    }

    const [wsSettings] = await db
      .select({ slackWebhookUrl: workspaceSettings.slackWebhookUrl, teamsWebhookUrl: workspaceSettings.teamsWebhookUrl })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId));

    let matched = 0;
    let fired = 0;
    for (const rule of rules) {
      const cfg = (rule.triggerConfig ?? {}) as Record<string, any>;
      if (!entityGateAllows(triggerType, cfg.entity, ctx.payload.entity)) continue;
      // signal_received: optional signal-name gate (e.g. only "job_change").
      // Kept permissive — a legacy AI-authored signal rule may carry a stray
      // `entity` that the branch above must not turn into a hard filter.
      if (triggerType === "signal_received" && cfg.signal && cfg.signal !== ctx.payload.signal) continue;
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
          // Which record set it off. The columns have existed since the table
          // was added and every writer left them null, so the run history read
          // "success via signal:record_created" with no way to tell WHICH lead.
          relatedType: ctx.relatedType ?? null,
          relatedId: ctx.relatedId ?? null,
        } as never);
        await db
          .update(workflowRules)
          // Atomic: `rule` was loaded before the actions ran, and this engine is
          // dispatched from event sites that fire concurrently — two events
          // matching one rule both read N and both write N+1, so a rule that
          // fired twice reports once. Found by the counter scan, not by hand.
          .set({ fireCount: sql`${workflowRules.fireCount} + 1`, lastFiredAt: new Date() })
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

/**
 * The three record-event helpers below exist so every dispatch site builds the
 * SAME payload shape. Before them, leads.create and leads.update each hand-rolled
 * an object literal and no other site had one at all — which is how the builder
 * came to offer "when a record is created" while only a lead could ever trigger
 * it. Fire-and-forget and never throwing: a workflow rule must not be able to
 * fail a user's save.
 *
 * Every caller is a SINGLE-record, human-originated path. Do not call these from
 * an array insert or from anything a per-row createCaller loop can reach — see
 * the do-not-fire list in this file's header.
 */

/**
 * The flat payload for a created record: every key @shared/workflowTriggers
 * declares for that entity, null where the seam does not know one, and NOTHING
 * else.
 *
 * One builder rather than a literal per site, for two reasons. The rule
 * builder generates its condition list from the same declaration, so the two
 * can never drift into the empty intersection that made every conditioned
 * record_created rule dead (2026-09-20). And the payload goes verbatim into a
 * webhook action's POST body (runAction above), so no site can spread a whole
 * tRPC input — names, phone numbers — at a customer-configured URL.
 */
export function buildRecordPayload(entity: string, recordId: number, fields: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { entity, id: recordId };
  const keys = RECORD_FIELDS[entity] ?? [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    out[k] = fields[k] === undefined ? null : fields[k];
  }
  return out;
}

export async function fireRecordCreated(
  workspaceId: number,
  entity: "lead" | "contact" | "opportunity",
  recordId: number,
  fields: Record<string, any>,
  ownerUserId: number | null,
): Promise<void> {
  if (!recordId) return;
  try {
    const payload = buildRecordPayload(entity, recordId, fields);
    payload.ownerUserId = ownerUserId;
    await fireWorkflowRules(workspaceId, "record_created", {
      payload, relatedType: entity, relatedId: recordId, ownerUserId,
    });
  } catch (e) {
    console.error(`[WorkflowEngine] record_created fire failed for ${entity} ${recordId}:`, (e as Error).message);
  }
}

export async function fireRecordUpdated(
  workspaceId: number,
  entity: "lead" | "contact" | "opportunity",
  recordId: number,
  before: Record<string, any>,
  patch: Record<string, any>,
  ownerUserId: number | null,
): Promise<void> {
  if (!recordId) return;
  try {
    // Merged post-update row plus `changed` (the patched field names), so a rule
    // can condition on what actually MOVED and not merely on the new value.
    const payload: Record<string, any> = {};
    const beforeKeys = Object.keys(before ?? {});
    for (let i = 0; i < beforeKeys.length; i++) payload[beforeKeys[i]!] = before[beforeKeys[i]!];
    const patchKeys = Object.keys(patch ?? {});
    for (let i = 0; i < patchKeys.length; i++) payload[patchKeys[i]!] = patch[patchKeys[i]!];
    payload.entity = entity;
    payload.id = recordId;
    payload.ownerUserId = ownerUserId;
    payload.changed = patchKeys;
    await fireWorkflowRules(workspaceId, "record_updated", {
      payload, relatedType: entity, relatedId: recordId, ownerUserId,
    });
  } catch (e) {
    console.error(`[WorkflowEngine] record_updated fire failed for ${entity} ${recordId}:`, (e as Error).message);
  }
}

/**
 * stage_changed. FIVE endpoints write opportunities.stage and until 2026-09-20
 * only crm.setStage announced it — so "when a deal is WON", the single most
 * valuable rule anyone builds, was silently dead on both proposal-accept paths,
 * on the Alerts page's move control and on the manager approval queue.
 */
export async function fireStageChanged(
  workspaceId: number,
  opportunityId: number,
  fromStage: string | null,
  toStage: string,
  extra: { value?: number; winProb?: number; isWon?: boolean; isLost?: boolean; name?: string | null },
  ownerUserId: number | null,
): Promise<void> {
  if (!opportunityId) return;
  try {
    const payload: Record<string, any> = {};
    const keys = Object.keys(extra ?? {});
    for (let i = 0; i < keys.length; i++) payload[keys[i]!] = (extra as Record<string, any>)[keys[i]!];
    payload.entity = "opportunity";
    payload.id = opportunityId;
    payload.stage = toStage;
    payload.fromStage = fromStage;
    await fireWorkflowRules(workspaceId, "stage_changed", {
      payload, relatedType: "opportunity", relatedId: opportunityId, ownerUserId,
    });
  } catch (e) {
    console.error(`[WorkflowEngine] stage_changed fire failed for opportunity ${opportunityId}:`, (e as Error).message);
  }
}

/**
 * task_overdue trigger — cron dispatcher.
 *
 * This trigger was selectable in the rule builder from the start but nothing
 * ever fired it, so any rule built on "When a task becomes overdue" sat at
 * fireCount 0 permanently.
 *
 * Fires once per task, at the moment it crosses its due date: the scan window
 * is [now - intervalMs, now), so a task is only picked up by the single tick
 * whose window contains its dueAt. That avoids needing an "already fired" column
 * while also not re-alerting on the same task every hour forever.
 */
export async function runTaskOverdueCron(intervalMs: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const now = Date.now();
  const windowStart = new Date(now - intervalMs);
  const windowEnd = new Date(now);

  const due = await db
    .select({
      id: tasks.id,
      workspaceId: tasks.workspaceId,
      title: tasks.title,
      type: tasks.type,
      priority: tasks.priority,
      dueAt: tasks.dueAt,
      ownerUserId: tasks.ownerUserId,
      relatedType: tasks.relatedType,
      relatedId: tasks.relatedId,
    })
    .from(tasks)
    .where(and(
      eq(tasks.status, "open"),
      gte(tasks.dueAt, windowStart),
      lt(tasks.dueAt, windowEnd),
    ));

  if (due.length === 0) return;
  console.log(`[WorkflowEngine] task_overdue: ${due.length} task(s) crossed their due date`);

  // Cross-workspace scan, so the archive gate is this cron's own responsibility
  // — workspaceProcedure never sees it. An archived workspace must not notify
  // anyone or POST to a webhook (2026-09-20).
  const archivedWs = await archivedWorkspaceIds();

  for (const t of due) {
    if (archivedWs.has(t.workspaceId)) continue;
    /**
     * Tell the task's OWNER, which is separate from firing workflow rules and
     * had no implementation at all — "One of my tasks is overdue" was a switch
     * in Settings → Notifications with nothing behind it. This cron already
     * finds exactly the right rows, once each, on the tick containing their due
     * date, so there is nothing to dedupe.
     *
     * ⚠️ INHERITS THIS SCAN'S `status = "open"`, which is one of the two sites
     * deliberately allowlisted in 9f2e78f — whether an `in_progress` task should
     * fire "overdue" is a product decision and `snoozed` certainly should not.
     * The notification therefore has exactly the same reach as the trigger, and
     * widening one without the other would be the drift that guard exists for.
     */
    await notifyIfEnabled({
      workspaceId: t.workspaceId,
      userId: t.ownerUserId,
      event: "taskOverdue",
      kind: "task_due",
      title: `Task overdue: ${t.title}`,
      body: `"${t.title}" passed its due date${t.priority ? ` (priority: ${t.priority})` : ""}.`,
      relatedType: "task",
      relatedId: t.id,
    }).catch((e) => console.error(`[WorkflowEngine] task_overdue notify failed for task ${t.id}:`, e));

    await fireWorkflowRules(t.workspaceId, "task_overdue", {
      payload: {
        entity: "task",
        taskId: t.id,
        title: t.title,
        type: t.type,
        priority: t.priority,
        dueAt: t.dueAt,
      },
      // Point actions at the record the task is ABOUT (so create_task /
      // update_field / enroll_sequence act on the deal or person), falling
      // back to the task itself when it isn't linked to anything.
      relatedType: t.relatedType ?? "task",
      relatedId: t.relatedId ?? t.id,
      ownerUserId: t.ownerUserId ?? null,
    }).catch((e) => console.error(`[WorkflowEngine] task_overdue fire failed for task ${t.id}:`, e));
  }
}
