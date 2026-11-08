/**
 * workflowTriggers.ts — the ONE definition of workflow rule triggers.
 *
 * Written for the same reason as areSources.ts, after the same failure: three
 * places disagreed about which triggers exist, and the disagreement was
 * invisible because a rule with a dead trigger looks exactly like a healthy one.
 *
 *   • the Workflows page offered   6 triggers, and kept its own private
 *                                  DEAD_TRIGGERS set for 3 more it knew were
 *                                  dead but that old rules still carried
 *   • the AI rule generator        advertised "schedule" to the model as a
 *                                  VALID value — under a prompt line that
 *                                  literally reads "anything else is ignored
 *                                  by the engine" — and its accept path let
 *                                  nps_submitted and field_equals through too
 *   • the engine actually fired    record_created, record_updated,
 *                                  stage_changed, task_overdue,
 *                                  signal_received, deal_stuck
 *
 * So the AI could propose a rule, the user could accept it, it would save
 * cleanly, never run, and then be greyed out as dead on the page that created
 * it. The app manufactured its own dead wiring.
 *
 * Rule going forward: a trigger may appear in LIVE_TRIGGERS ONLY if something
 * actually dispatches it. If you add one, add its dispatch site in the same
 * commit — a trigger that never fires is worse than no trigger, because the
 * rule built on it looks configured and simply never happens.
 */

/** Triggers something actually dispatches. Each entry names its dispatch site. */
export const LIVE_TRIGGERS = [
  { id: "record_created", label: "When a record is created" },   // routers/crm.ts
  { id: "record_updated", label: "When a record is updated" },   // routers/crm.ts
  { id: "stage_changed", label: "When opportunity stage changes" }, // routers/crm.ts
  { id: "task_overdue", label: "When a task becomes overdue" },  // services/workflowEngine.ts
  { id: "signal_received", label: "When a buying signal fires" }, // services/linkedinEnrichment/jobChangeReengagement.ts
  { id: "deal_stuck", label: "When a deal is stuck in a stage" }, // routers/operations.ts (its own path, not fireWorkflowRules)
] as const;

export const LIVE_TRIGGER_IDS = LIVE_TRIGGERS.map((t) => t.id);

/**
 * Triggers that exist on rules saved before this was tightened, but which
 * nothing dispatches. Kept ONLY so saved rules can still be read back and
 * flagged in the UI — never offered as a choice, and never accepted from the
 * AI generator. Delete an entry once no workspace has a rule using it.
 */
export const DEAD_TRIGGERS = ["nps_submitted", "field_equals", "schedule"] as const;

export const ALL_TRIGGER_IDS = [...LIVE_TRIGGER_IDS, ...DEAD_TRIGGERS];

export type LiveTrigger = (typeof LIVE_TRIGGERS)[number]["id"];
export type WorkflowTriggerId = (typeof ALL_TRIGGER_IDS)[number];

export function isDeadTrigger(id: string): boolean {
  return (DEAD_TRIGGERS as readonly string[]).includes(id);
}

/**
 * Condition operators the engine implements.
 *
 * `in` was offered by the Workflows condition editor while evalConditions had
 * no case for it, so it fell to `default: return false` — every rule using it
 * evaluated false forever, silently, while looking perfectly healthy. Same
 * rule as above: an operator belongs here only if evalConditions handles it.
 */
export const CONDITION_OPS = [
  { id: "eq", label: "equals" },
  { id: "neq", label: "not equal" },
  { id: "gt", label: "greater than" },
  { id: "lt", label: "less than" },
  { id: "gte", label: "≥" },
  { id: "lte", label: "≤" },
  { id: "contains", label: "contains" },
  { id: "in", label: "in list" },
] as const;

export const CONDITION_OP_IDS = CONDITION_OPS.map((o) => o.id);

/**
 * Which records the record_created / record_updated triggers cover.
 *
 * Same rule as LIVE_TRIGGERS: an entity belongs here only once a dispatch site
 * exists for it. Accounts are deliberately absent — crm.ts creates them and
 * stays silent, because update_field, enroll_sequence and send_email_draft all
 * reject an account, so three of the builder's eight actions would fail on
 * every fire of an account-scoped rule.
 */
export const RECORD_ENTITIES = [
  { id: "lead", label: "Leads" },
  { id: "contact", label: "Contacts" },
  { id: "opportunity", label: "Opportunities" },
  { id: "any", label: "Any of them" },
] as const;

export const RECORD_ENTITY_IDS = RECORD_ENTITIES.map((e) => e.id);

/** The entities a payload can report. `any` is a rule SCOPE, never a record. */
export const RECORD_PAYLOAD_ENTITIES = ["lead", "contact", "opportunity"] as const;

/**
 * The keys a record_created payload carries, per entity — ALWAYS present, null
 * where the creating seam does not know one (buildRecordPayload fills them in).
 *
 * Declared once because the builder's condition list and the dispatch payload
 * had an EMPTY INTERSECTION: the editor offered industry / region /
 * healthScore / npsScore while the dispatch sent company / title / source, so
 * every conditioned record_created rule compared against `undefined` and could
 * never match. The trigger fired, the rule looked healthy, and nothing
 * happened — the same silent shape as a dead trigger (2026-09-20).
 *
 * A key may appear here only if buildRecordPayload declares it, and only if it
 * is known at INSERT time: see RECORD_UPDATE_ONLY_FIELDS for the columns
 * another engine fills in afterwards.
 */
export const RECORD_FIELDS: Record<string, readonly string[]> = {
  lead: ["company", "title", "source", "status", "email"],
  contact: ["title", "email", "accountId", "source"],
  opportunity: ["name", "stage", "value", "winProb", "accountId"],
};

/** On every record payload, whatever the entity. */
export const RECORD_COMMON_FIELDS = ["entity", "id", "ownerUserId"] as const;

/**
 * Columns written AFTER the insert by another engine — leadScoring writes
 * score and grade asynchronously — so a record_created payload can only ever
 * report the column default. "score >= 60 on a new lead" is a rule that can
 * never match, and it shipped as the seeded sample rule for exactly that
 * reason. Offered on record_updated, whose payload is the whole post-update row.
 */
export const RECORD_UPDATE_ONLY_FIELDS: Record<string, readonly string[]> = {
  lead: ["score", "grade"],
  contact: [],
  opportunity: [],
};

/**
 * The condition fields to offer for a record trigger. Scope "any" gets the
 * union: a key the fired entity does not carry is simply absent from its
 * payload, so the condition does not match that entity — which is what
 * scoping to "any" and then conditioning on `stage` is asking for.
 */
export function recordFieldsFor(triggerType: string, entity: string | null | undefined): string[] {
  const scoped = entity && entity !== "any" && RECORD_FIELDS[entity]
    ? [entity]
    : (RECORD_PAYLOAD_ENTITIES as readonly string[]).slice();
  const out: string[] = [];
  const add = (k: string) => { if (out.indexOf(k) < 0) out.push(k); };
  for (let i = 0; i < RECORD_COMMON_FIELDS.length; i++) add(RECORD_COMMON_FIELDS[i]!);
  for (let i = 0; i < scoped.length; i++) {
    const e = scoped[i]!;
    const base = RECORD_FIELDS[e] ?? [];
    for (let j = 0; j < base.length; j++) add(base[j]!);
    if (triggerType === "record_updated") {
      const later = RECORD_UPDATE_ONLY_FIELDS[e] ?? [];
      for (let j = 0; j < later.length; j++) add(later[j]!);
    }
  }
  if (triggerType === "record_updated") add("changed");
  return out;
}

/**
 * The keys each non-record trigger's payload carries, read off its dispatch
 * site (G61: the editor offered one list of nineteen fields for every trigger,
 * so "task overdue where stage = …" or "deal stuck where industry = …" compared
 * against a key the event never carries and could never match).
 *
 *   stage_changed   services/workflowEngine.ts fireStageChanged
 *   deal_stuck      routers/operations.ts checkDealAging (both paths)
 *   task_overdue    services/workflowEngine.ts (the overdue sweep)
 *   signal_received jobChangeReengagement.ts (job_change), brandReconciler.ts
 *                   (brand_change), are/execution.ts (meeting_booked, email_reply);
 *                   each signal carries only its own keys beside `signal`.
 *
 * A key belongs here only if its dispatch site sets it.
 */
export const TRIGGER_FIELDS: Record<string, readonly string[]> = {
  stage_changed: ["entity", "id", "name", "stage", "fromStage", "value", "winProb", "isWon", "isLost"],
  deal_stuck: ["entity", "id", "name", "stage", "daysInStage", "value", "winProb", "ownerUserId"],
  task_overdue: ["entity", "taskId", "title", "type", "priority", "dueAt"],
  signal_received: ["signal", "entity", "name", "title", "oldCompany", "newCompany", "oldName", "newName", "oldDomain", "newDomain", "campaignId", "sentiment"],
};

/** The condition fields to offer for any trigger: what its payload carries. */
export function conditionFieldsFor(triggerType: string, entity: string | null | undefined): string[] {
  if (triggerType === "record_created" || triggerType === "record_updated") return recordFieldsFor(triggerType, entity);
  return (TRIGGER_FIELDS[triggerType] ?? []).slice();
}

/**
 * Which records each action can act on, mirroring the engine's own allowlists
 * (workflowEngine.runAction: update_field's ALLOWED map, enroll_sequence's
 * person check, send_email_draft's contact-or-lead check). `enroll_sequence`
 * also accepts a prospect, which is not a record_* entity and so is not listed.
 *
 * An action a scoped rule cannot run is the same dead wiring as a trigger
 * nothing dispatches: the rule saves, fires, and logs "cannot enroll a
 * opportunity" on every run while looking perfectly healthy. Any action absent
 * from this map works on every entity.
 */
export const ACTION_ENTITY_SUPPORT: Record<string, readonly string[]> = {
  update_field: ["lead", "contact", "opportunity"],
  enroll_sequence: ["lead", "contact"],
  send_email_draft: ["lead", "contact"],
};

/**
 * The fields update_field may write, per record type, and as what: the
 * engine's allowlist (workflowEngine.runAction), the dry run's (F46) and the
 * editor's field picker (G71). Never a caller-supplied column name.
 */
export const UPDATE_FIELD_ALLOWED: Record<string, Record<string, "string" | "number">> = {
  opportunity: { stage: "string", value: "number", winProb: "number", ownerUserId: "number", nextStep: "string" },
  lead: { status: "string", score: "number", ownerUserId: "number" },
  contact: { title: "string", ownerUserId: "number" },
};

export function actionSupportsEntity(actionType: string, entity: string | null | undefined): boolean {
  // "any" and the non-record triggers cover at least one entity the action
  // handles, so the builder must not grey it out there.
  if (!entity || entity === "any") return true;
  const list = ACTION_ENTITY_SUPPORT[actionType];
  return !list || list.indexOf(entity) >= 0;
}

/* ── Declared payload schemas (audit 2026-10-20, F46) ────────────────────
 *
 * The key lists above say WHICH keys each trigger's payload carries. This
 * says what each key IS: its label, its type, and what a value refers to, so
 * the editor can offer a name picker instead of an id box, the AI rule
 * generator's prompt can describe every trigger from the same declaration
 * instead of a hand-written paragraph, and the tests can check every
 * dispatch site against it. A key in any list above must have an entry here
 * (server/pubF46WorkflowSchemas.test.ts fails otherwise).
 */

export type PayloadFieldType = "text" | "number" | "boolean" | "date" | "id" | "list";
/** What an id or a fixed value refers to, for the editor's picker. */
export type PayloadFieldRef = "user" | "account" | "stage" | "campaign" | "record";

export type PayloadField = {
  key: string;
  label: string;
  type: PayloadFieldType;
  ref?: PayloadFieldRef;
  /** The fixed set of values the key can hold, when there is one. */
  values?: readonly string[];
  /** One line for people and for the model. */
  hint?: string;
};

export const LEAD_STATUSES = ["new", "working", "qualified", "unqualified", "converted"] as const;
export const TASK_TYPES = ["call", "email", "meeting", "linkedin", "todo", "follow_up", "social_touch", "manual_email", "meeting_prep", "crm_update", "generic_action"] as const;
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
/** Every signal a signal_received dispatch site sends (see TRIGGER_FIELDS' sites). */
export const SIGNAL_NAMES = ["job_change", "brand_change", "meeting_booked", "email_reply"] as const;

export const PAYLOAD_FIELDS: Record<string, Omit<PayloadField, "key">> = {
  entity: { label: "Record type", type: "text", hint: "lead, contact, opportunity, task, or the signal's subject" },
  id: { label: "Record", type: "id", ref: "record" },
  ownerUserId: { label: "Owner", type: "id", ref: "user" },
  company: { label: "Company", type: "text" },
  title: { label: "Title", type: "text", hint: "a person's job title, or a task's title" },
  source: { label: "Source", type: "text", hint: "e.g. webform, booking_link, landing:<slug>" },
  status: { label: "Lead status", type: "text", values: LEAD_STATUSES },
  email: { label: "Email", type: "text" },
  accountId: { label: "Account", type: "id", ref: "account" },
  name: { label: "Name", type: "text", hint: "the deal's or the person's name" },
  stage: { label: "Stage", type: "text", ref: "stage" },
  fromStage: { label: "Previous stage", type: "text", ref: "stage" },
  value: { label: "Deal value", type: "number" },
  winProb: { label: "Win %", type: "number" },
  isWon: { label: "Is won", type: "boolean" },
  isLost: { label: "Is lost", type: "boolean" },
  daysInStage: { label: "Days in stage", type: "number" },
  score: { label: "Lead score", type: "number", hint: "0–100, written after a lead is created" },
  grade: { label: "Lead grade", type: "text", values: ["A", "B", "C", "D"] },
  changed: { label: "Changed fields", type: "list", hint: "names of the fields this update changed" },
  taskId: { label: "Task", type: "id", ref: "record" },
  type: { label: "Task type", type: "text", values: TASK_TYPES },
  priority: { label: "Task priority", type: "text", values: TASK_PRIORITIES },
  dueAt: { label: "Due", type: "date" },
  signal: { label: "Signal", type: "text", values: SIGNAL_NAMES },
  oldCompany: { label: "Old company", type: "text" },
  newCompany: { label: "New company", type: "text" },
  oldName: { label: "Old brand name", type: "text" },
  newName: { label: "New brand name", type: "text" },
  oldDomain: { label: "Old domain", type: "text" },
  newDomain: { label: "New domain", type: "text" },
  campaignId: { label: "Revenue Engine campaign", type: "id", ref: "campaign" },
  sentiment: { label: "Reply sentiment", type: "text" },
};

/** One key's declaration, with a plain fallback for a key saved before it was declared. */
export function payloadField(key: string): PayloadField {
  const d = PAYLOAD_FIELDS[key];
  return d ? { key, ...d } : { key, label: key, type: "text" };
}

/** The declared payload of a trigger (scoped to an entity for the record triggers). */
export function payloadSchemaFor(triggerType: string, entity: string | null | undefined): PayloadField[] {
  return conditionFieldsFor(triggerType, entity).map(payloadField);
}

export type DryRunRecordType = "lead" | "contact" | "opportunity" | "task";
export const DRY_RUN_RECORD_TYPES: readonly DryRunRecordType[] = ["lead", "contact", "opportunity", "task"];

/**
 * Which records a rule's dry run (F46) can be pointed at: the records its
 * trigger's events are about. The editor offers these; the server refuses
 * anything else.
 */
export function dryRunRecordTypesFor(triggerType: string, entity: string | null | undefined): DryRunRecordType[] {
  switch (triggerType) {
    case "record_created":
    case "record_updated": {
      const e = entity || "lead";
      if (e === "any") return ["lead", "contact", "opportunity"];
      return (DRY_RUN_RECORD_TYPES as readonly string[]).indexOf(e) >= 0 ? [e as DryRunRecordType] : [];
    }
    case "stage_changed":
    case "deal_stuck":
      return ["opportunity"];
    case "task_overdue":
      return ["task"];
    case "signal_received":
      return ["contact", "lead"];
    default:
      return [];
  }
}

/** What each trigger is, for people and for the model, beside its payload. */
const TRIGGER_NOTES: Record<string, string> = {
  record_created: `a lead, contact or opportunity was created. ALWAYS set triggerConfig.entity to "lead", "contact", "opportunity" or "any". A lead's score and grade are written after creation, so never condition on them here.`,
  record_updated: `a lead, contact or opportunity was saved; the payload is the record after the change plus "changed". Set triggerConfig.entity as for record_created.`,
  stage_changed: "an opportunity moved stage.",
  deal_stuck: "a deal sat in one stage too long; set triggerConfig.days (default 7) and optionally triggerConfig.stage. Fires once per stay in a stage.",
  task_overdue: "an open task passed its due date.",
  signal_received: `an intent signal; set triggerConfig.signal to one of ${SIGNAL_NAMES.join(", ")} to react to one kind. Each signal carries only its own keys beside "signal".`,
};

/**
 * Every live trigger and its declared payload, one line each, for the AI
 * rule generator's prompt (routers/aiFeatures.ts). Generated, so the model is
 * told exactly what the editor offers and the engine sends.
 */
export function describeTriggerPayloadsForPrompt(): string {
  const fieldText = (f: PayloadField) => `${f.key} (${f.type}${f.values ? `: ${f.values.join("|")}` : ""})`;
  const lines: string[] = [];
  for (const t of LIVE_TRIGGERS) {
    let payload: string;
    if (t.id === "record_created" || t.id === "record_updated") {
      const per = (RECORD_PAYLOAD_ENTITIES as readonly string[]).map((e) => {
        const own = conditionFieldsFor(t.id, e).filter((k) => (RECORD_COMMON_FIELDS as readonly string[]).indexOf(k) < 0);
        return `${e}: ${own.map((k) => fieldText(payloadField(k))).join(", ")}`;
      });
      payload = `always ${RECORD_COMMON_FIELDS.join(", ")}; then ${per.join("; ")}`;
    } else {
      payload = payloadSchemaFor(t.id, null).map(fieldText).join(", ");
    }
    lines.push(`- "${t.id}": ${TRIGGER_NOTES[t.id] ?? t.label} Payload: ${payload}.`);
  }
  return lines.join("\n");
}
