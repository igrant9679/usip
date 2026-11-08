/**
 * A workflow rule tried against a chosen record (audit 2026-10-20, F46).
 *
 * The Test in workflowDryRun.ts reads the rule alone. This takes a real record
 * from the workspace, builds the payload its trigger's dispatch site would
 * build (the engine's own builders), runs the same gates and condition
 * predicate the engine runs, and says what each action would do TO THAT
 * RECORD: which task, for whom, which field from what to what, which sequence
 * and whether the enrolment would be skipped. It reads only. No row is
 * written, nothing is sent, no model is called, and no run is logged.
 */
import { and, eq } from "drizzle-orm";
import { contacts, enrollments, leads, opportunities, sequences, tasks, users, workspaceMembers, workspaceSettings } from "../../drizzle/schema";
import {
  buildDealStuckPayload, buildRecordPayload, buildRecordUpdatedPayload, buildStageChangedPayload, buildTaskOverduePayload,
  entityGateAllows, evalConditions, normalizeConditions, pickedUserId,
} from "./workflowEngine";
import { isOutboundPaused } from "./outboundPause";
import { hostOf } from "./workflowDryRun";
import { stageResolver } from "../_core/stageSemantics";
import { UPDATE_FIELD_ALLOWED, dryRunRecordTypesFor, payloadField, type DryRunRecordType } from "@shared/workflowTriggers";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Action = { type?: string; params?: Record<string, any> };

// The record types a trigger is tried against live in @shared/workflowTriggers,
// so the editor offers exactly the ones this accepts.
export type { DryRunRecordType };
export { dryRunRecordTypesFor };

export type DryRunRule = {
  triggerType: string;
  triggerConfig?: Record<string, any> | null;
  conditions?: unknown;
  actions?: unknown;
};

export type DryRunStep = { action: string; ok: boolean; text: string };
export type DryRunCheck = { label: string; pass: boolean; detail: string };
export type DryRunConditionResult = { field: string; label: string; op: string; value: unknown; actual: unknown; pass: boolean };

export type RecordDryRun = {
  record: { type: DryRunRecordType; id: number; label: string };
  payload: Record<string, any>;
  gates: DryRunCheck[];
  conditions: DryRunConditionResult[];
  wouldFire: boolean;
  steps: DryRunStep[];
  notes: string[];
};

/** A refusal the router turns into BAD_REQUEST: the person picked something that can't be tried. */
export class DryRunRefusal extends Error {}

const personName = (r: { firstName?: string | null; lastName?: string | null; email?: string | null }) =>
  [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email || "";

async function memberName(db: Db, workspaceId: number, userId: unknown): Promise<string | null> {
  const id = Number(userId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const [m] = await db.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, id))).limit(1);
  if (!m) return null;
  const [u] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, id)).limit(1);
  return u?.name || u?.email || `user ${id}`;
}

/** The record, read in this workspace only. */
async function loadRecord(db: Db, workspaceId: number, type: DryRunRecordType, id: number): Promise<Record<string, any> | null> {
  if (type === "lead") {
    const [row] = await db.select().from(leads).where(and(eq(leads.id, id), eq(leads.workspaceId, workspaceId))).limit(1);
    return (row as Record<string, any>) ?? null;
  }
  if (type === "contact") {
    const [row] = await db.select().from(contacts).where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId))).limit(1);
    return (row as Record<string, any>) ?? null;
  }
  if (type === "opportunity") {
    const [row] = await db.select().from(opportunities).where(and(eq(opportunities.id, id), eq(opportunities.workspaceId, workspaceId))).limit(1);
    return (row as Record<string, any>) ?? null;
  }
  const [row] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId))).limit(1);
  return (row as Record<string, any>) ?? null;
}

export function recordLabel(type: DryRunRecordType, r: Record<string, any>): string {
  if (type === "opportunity") return r.name || `Deal ${r.id}`;
  if (type === "task") return r.title || `Task ${r.id}`;
  return personName(r) || `${type === "lead" ? "Lead" : "Contact"} ${r.id}`;
}

export async function dryRunRuleAgainstRecord(
  db: Db,
  workspaceId: number,
  rule: DryRunRule,
  target: { recordType: DryRunRecordType; recordId: number; signal?: string | null; fromStage?: string | null },
  nowMs = Date.now(),
): Promise<RecordDryRun> {
  const cfg = (rule.triggerConfig ?? {}) as Record<string, any>;
  const allowedTypes = dryRunRecordTypesFor(rule.triggerType, cfg.entity);
  if (allowedTypes.indexOf(target.recordType) < 0) {
    throw new DryRunRefusal(allowedTypes.length
      ? `This rule is tried against a ${allowedTypes.join(" or ")}, not a ${target.recordType}.`
      : `"${rule.triggerType}" never fires, so there is nothing to try.`);
  }
  const r = await loadRecord(db, workspaceId, target.recordType, target.recordId);
  if (!r) throw new DryRunRefusal("That record isn't in this workspace.");
  const notes: string[] = [];
  const owner = (r.ownerUserId ?? null) as number | null;

  // The payload the trigger's dispatch site builds, from the engine's builders.
  let payload: Record<string, any>;
  let relatedType: string = target.recordType;
  let relatedId: number = r.id;
  switch (rule.triggerType) {
    case "record_created":
      payload = buildRecordPayload(target.recordType, r.id, r);
      payload.ownerUserId = owner;
      notes.push("Built as if this record had just been created.");
      break;
    case "record_updated":
      payload = buildRecordUpdatedPayload(target.recordType, r.id, r, {}, owner);
      notes.push('Built as if this record had just been saved with no field changed, so "changed" is empty.');
      break;
    case "stage_changed": {
      const meta = (await stageResolver(db, workspaceId)).resolve(r.pipelineId ?? null, r.stage);
      payload = buildStageChangedPayload(r.id, target.fromStage ?? null, r.stage, {
        value: Number(r.value ?? 0), winProb: r.winProb, isWon: meta.isWon, isLost: meta.isLost, name: r.name ?? null,
      });
      notes.push(`Built as if this deal had just moved${target.fromStage ? ` from "${target.fromStage}"` : ""} into "${r.stage}", its current stage.`);
      break;
    }
    case "deal_stuck":
      payload = buildDealStuckPayload({ id: r.id, name: r.name, stage: r.stage, daysInStage: r.daysInStage, value: r.value, winProb: r.winProb, ownerId: r.ownerUserId });
      break;
    case "task_overdue":
      payload = buildTaskOverduePayload({ id: r.id, title: r.title, type: r.type, priority: r.priority, dueAt: r.dueAt });
      relatedType = r.relatedType ?? "task";
      relatedId = r.relatedId ?? r.id;
      notes.push("Built as if this task had just passed its due date.");
      break;
    default: {
      // signal_received
      const signal = String(cfg.signal || target.signal || "job_change");
      payload = { signal, entity: target.recordType, name: personName(r) || null, title: r.title ?? null };
      notes.push(`A sample "${signal}" signal about this person: keys only a real signal carries (old and new company, campaign, sentiment) are empty.`);
    }
  }

  // The engine's gates, in its order.
  const gates: DryRunCheck[] = [];
  if (rule.triggerType === "record_created" || rule.triggerType === "record_updated") {
    const ok = entityGateAllows(rule.triggerType, cfg.entity, payload.entity);
    gates.push({ label: "Record type", pass: ok, detail: ok ? `This rule covers ${cfg.entity || "lead"} records.` : `This rule covers ${cfg.entity || "lead"} records, not ${payload.entity}s.` });
  }
  if (rule.triggerType === "signal_received" && cfg.signal) {
    const ok = cfg.signal === payload.signal;
    gates.push({ label: "Signal", pass: ok, detail: ok ? `Reacts to "${cfg.signal}".` : `Reacts to "${cfg.signal}" only.` });
  }
  if (rule.triggerType === "deal_stuck") {
    const minDays = Number(cfg.days ?? 7) || 7;
    const days = Number(r.daysInStage ?? 0);
    gates.push({ label: "Days in stage", pass: days >= minDays, detail: `${days} day${days === 1 ? "" : "s"} in "${r.stage}"; the rule waits for ${minDays}.` });
    if (cfg.stage) {
      const ok = cfg.stage === r.stage;
      gates.push({ label: "Stage", pass: ok, detail: ok ? `In "${cfg.stage}".` : `The rule watches "${cfg.stage}" only.` });
    }
  }
  if (rule.triggerType === "task_overdue") {
    const open = r.status === "open";
    const due = r.dueAt ? new Date(r.dueAt).getTime() : null;
    gates.push({ label: "Open task", pass: open, detail: open ? "The task is open." : `The task is ${r.status}; only open tasks fire.` });
    gates.push({ label: "Has a due date", pass: due != null, detail: due == null ? "No due date, so it never becomes overdue." : due <= nowMs ? "Its due date has passed." : "Its due date is still ahead." });
  }

  // Each condition, with the value the payload actually holds.
  const spec = normalizeConditions(rule.conditions);
  const condList = [...(spec.all ?? []), ...(spec.any ?? [])] as Array<{ field: string; op: string; value: any }>;
  const conditions: DryRunConditionResult[] = condList.map((c) => ({
    field: c.field, label: payloadField(c.field).label, op: c.op, value: c.value,
    actual: payload[c.field] === undefined ? null : payload[c.field],
    pass: evalConditions({ all: [c] }, payload),
  }));
  const wouldFire = gates.every((g) => g.pass) && evalConditions(spec, payload);

  // What each action would do to this record. Nothing below writes.
  const steps: DryRunStep[] = [];
  const actions = Array.isArray(rule.actions) ? (rule.actions as Action[]) : [];
  if (actions.length === 0) steps.push({ action: "none", ok: false, text: "This rule has no actions." });
  const [ws] = await db.select({ slack: workspaceSettings.slackWebhookUrl, teams: workspaceSettings.teamsWebhookUrl })
    .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)).limit(1);
  const sameRecord = relatedType === target.recordType && relatedId === r.id;
  for (const a of actions) {
    const p = a?.params ?? {};
    const type = String(a?.type ?? "");
    switch (type) {
      case "create_task": {
        const days = Number.isFinite(Number(p.dueInDays)) && String(p.dueInDays ?? "").trim() !== "" ? Math.max(0, Math.min(30, Math.round(Number(p.dueInDays)))) : null;
        const who = await memberName(db, workspaceId, pickedUserId(p.ownerUserId) ?? owner);
        steps.push({ action: type, ok: true, text: `Would create the task "${String(p.title ?? "Workflow task").slice(0, 120)}"${days == null ? "" : `, due in ${days} day${days === 1 ? "" : "s"}`}, for ${who ?? "no one in particular"}, linked to this ${relatedType}.` });
        break;
      }
      case "notify":
      case "notify_user": {
        const uid = pickedUserId(p.userId) ?? owner;
        const who = await memberName(db, workspaceId, uid);
        steps.push(uid
          ? (who
            ? { action: type, ok: true, text: `Would notify ${who}${p.message ? `: "${String(p.message).slice(0, 120)}"` : ""}.` }
            : { action: type, ok: false, text: "Would notify someone who is not a member of this workspace." })
          : { action: type, ok: true, text: "No one to notify: the rule names no one and the record has no owner, so this step would do nothing." });
        break;
      }
      case "update_field": {
        const field = String(p.field ?? "").trim();
        const allowed = UPDATE_FIELD_ALLOWED[relatedType];
        if (!field) { steps.push({ action: type, ok: false, text: "No field is set." }); break; }
        if (!allowed) { steps.push({ action: type, ok: false, text: `A ${relatedType} has no fields this action can set.` }); break; }
        const kind = allowed[field];
        if (!kind) { steps.push({ action: type, ok: false, text: `"${field}" can't be set on a ${relatedType} (allowed: ${Object.keys(allowed).join(", ")}).` }); break; }
        const raw = String(p.value ?? "").trim();
        if (kind === "number" && !Number.isFinite(Number(raw))) { steps.push({ action: type, ok: false, text: `"${raw}" is not a number.` }); break; }
        const shown = field === "ownerUserId" ? (await memberName(db, workspaceId, raw)) ?? raw : raw;
        const was = sameRecord ? (field === "ownerUserId" ? (await memberName(db, workspaceId, r[field])) ?? r[field] : r[field]) : undefined;
        steps.push({ action: type, ok: true, text: `Would set ${payloadField(field).label.toLowerCase()} ${was !== undefined ? `from "${was ?? ""}" ` : ""}to "${shown}".` });
        break;
      }
      case "enroll_sequence": {
        const sequenceId = Number(p.sequenceId);
        if (!(sequenceId > 0)) { steps.push({ action: type, ok: false, text: "No sequence is chosen." }); break; }
        if (relatedType !== "lead" && relatedType !== "contact" && relatedType !== "prospect") {
          steps.push({ action: type, ok: false, text: `Can't enrol a ${relatedType}: it needs a contact, lead or prospect.` });
          break;
        }
        const [seq] = await db.select({ id: sequences.id, name: sequences.name }).from(sequences)
          .where(and(eq(sequences.id, sequenceId), eq(sequences.workspaceId, workspaceId))).limit(1);
        if (!seq) { steps.push({ action: type, ok: false, text: "The chosen sequence is not in this workspace." }); break; }
        if (await isOutboundPaused(workspaceId)) { steps.push({ action: type, ok: false, text: `Would skip "${seq.name}": outbound is paused for this workspace.` }); break; }
        const col = relatedType === "contact" ? enrollments.contactId : relatedType === "lead" ? enrollments.leadId : enrollments.prospectId;
        const [already] = await db.select({ id: enrollments.id }).from(enrollments)
          .where(and(eq(enrollments.workspaceId, workspaceId), eq(enrollments.sequenceId, sequenceId), eq(col, relatedId))).limit(1);
        steps.push(already
          ? { action: type, ok: true, text: `Already in "${seq.name}": nothing would change.` }
          : { action: type, ok: true, text: `Would enrol this ${relatedType} in "${seq.name}".` });
        break;
      }
      case "send_email_draft": {
        if (relatedType !== "lead" && relatedType !== "contact") { steps.push({ action: type, ok: false, text: `Needs a contact or lead, not a ${relatedType}.` }); break; }
        const email = sameRecord ? r.email : null;
        steps.push(email
          ? { action: type, ok: true, text: `Would write an AI email draft to ${email} for review. Nothing is sent without approval.` }
          : { action: type, ok: false, text: "The record has no email address, so no draft would be written." });
        break;
      }
      case "webhook": {
        const host = hostOf(p.url);
        steps.push(host ? { action: type, ok: true, text: `Would POST this payload to ${host}.` } : { action: type, ok: false, text: p.url ? "The webhook URL is not an http(s) URL." : "No webhook URL is set." });
        break;
      }
      case "post_slack":
        steps.push(ws?.slack ? { action: type, ok: true, text: "Would post a message to Slack." } : { action: type, ok: false, text: "No Slack webhook is configured." });
        break;
      case "notify_teams":
        steps.push(ws?.teams ? { action: type, ok: true, text: "Would post a message to Teams." } : { action: type, ok: false, text: "No Teams webhook is configured." });
        break;
      default:
        steps.push({ action: type || "unknown", ok: false, text: `"${type}" is not an action the engine runs.` });
    }
  }
  if (!wouldFire) notes.push("The rule would not fire for this record, so none of the steps would run.");
  return { record: { type: target.recordType, id: r.id, label: recordLabel(target.recordType, r) }, payload, gates, conditions, wouldFire, steps, notes };
}
