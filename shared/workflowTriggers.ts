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

export function actionSupportsEntity(actionType: string, entity: string | null | undefined): boolean {
  // "any" and the non-record triggers cover at least one entity the action
  // handles, so the builder must not grey it out there.
  if (!entity || entity === "any") return true;
  const list = ACTION_ENTITY_SUPPORT[actionType];
  return !list || list.indexOf(entity) >= 0;
}
