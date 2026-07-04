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
import { notifications, tasks, workflowRules, workflowRuns, workspaceSettings } from "../../drizzle/schema";
import { evalConditions } from "../routers/operations";

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
      case "notify": {
        const uid = p.userId ?? ctx.ownerUserId;
        if (!uid) return null; // no explicit target — skip quietly (team alerts use slack/teams/webhook)
        await db.insert(notifications).values({
          workspaceId: ws, userId: Number(uid), kind: "workflow_fired",
          title: String(p.title ?? `Rule fired: ${rule.name}`).slice(0, 240),
          body: p.message ?? null,
        } as never);
        return null;
      }
      default:
        return null; // update_field / enroll / etc. — unsupported here, skip silently
    }
  } catch (e) {
    return `${action.type}: ${(e as Error).message}`;
  }
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
