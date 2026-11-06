import { normalizeRoutingConditions } from "@shared/leadRouting";

export type RuleCond = { field: string; op: string; value: any };
export type EditableConditions = { all: RuleCond[]; any: RuleCond[] };
export type RuleMember = { id: number; name: string | null; email: string | null; deactivatedAt?: Date | string | null };

/**
 * A rule's stored conditions with both groups present, the oldest bare-array
 * form included (audit 2026-10-20, P126). The editor read only `all` and
 * saved `{ all }`, so an "Any" group vanished on the first edit.
 */
export function editableConditions(raw: unknown): EditableConditions {
  const c = normalizeRoutingConditions(raw);
  return { all: (c.all ?? []) as RuleCond[], any: (c.any ?? []) as RuleCond[] };
}

/** What the editor saves: both groups, `any` left out when empty. */
export function conditionsForSave(c: EditableConditions): { all: RuleCond[]; any?: RuleCond[] } {
  return c.any.length ? { all: c.all, any: c.any } : { all: c.all };
}

const isActive = (members: RuleMember[], uid: number) => members.some((m) => m.id === uid && !m.deactivatedAt);

/**
 * Members the target picker offers (P115): people who have left can't be
 * routed to, so they aren't offered; one still ticked on the rule is listed so
 * it can be unticked.
 */
export function pickableMembers(members: RuleMember[], selected: number[]): RuleMember[] {
  return members.filter((m) => !m.deactivatedAt || selected.includes(m.id));
}

export type RuleStatus = "disabled" | "active" | "no_active_targets" | "territory_only";

/**
 * A rule's status as the router sees it (P115). It read Active from the
 * enabled flag alone, while the router skips a rule whose targets have all
 * left. Geography and Industry rules can still assign through a territory
 * owner with no target.
 */
export function ruleStatus(rule: { enabled: boolean; strategy: string; targetUserIds: number[] | null }, members: RuleMember[]): RuleStatus {
  if (!rule.enabled) return "disabled";
  if ((rule.targetUserIds ?? []).some((uid) => isActive(members, uid))) return "active";
  return rule.strategy === "geography" || rule.strategy === "industry" ? "territory_only" : "no_active_targets";
}
