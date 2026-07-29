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
