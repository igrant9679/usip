/**
 * Lead-routing conditions, typed (audit 2026-10-20, P42), and the strategy
 * names a person reads (P124). The rule editor and the router share this
 * module so what can be built is what is evaluated.
 *
 * Routing ran rules through the workflow engine's evaluator, which compares
 * whatever the editor stored: "equals" was `===`, so "Webform" never matched
 * "webform" and a Score typed into the box (a string) never equalled a score
 * (a number); and "contains" with a blank value matched every lead.
 */

export type RoutingFieldType = "text" | "number";

export const ROUTING_FIELDS: ReadonlyArray<{ v: string; l: string; type: RoutingFieldType }> = [
  { v: "title", l: "Title", type: "text" },
  { v: "company", l: "Company", type: "text" },
  { v: "source", l: "Source", type: "text" },
  { v: "industry", l: "Industry", type: "text" },
  { v: "country", l: "Country", type: "text" },
  { v: "state", l: "State", type: "text" },
  { v: "score", l: "Score", type: "number" },
];

export const ROUTING_OPS: Record<RoutingFieldType, ReadonlyArray<{ v: string; l: string }>> = {
  text: [
    { v: "eq", l: "equals" },
    { v: "neq", l: "not equals" },
    { v: "contains", l: "contains" },
  ],
  number: [
    { v: "eq", l: "=" },
    { v: "neq", l: "≠" },
    { v: "gt", l: ">" },
    { v: "gte", l: ">=" },
    { v: "lt", l: "<" },
    { v: "lte", l: "<=" },
  ],
};

export const ROUTING_STRATEGY_LABEL: Record<string, string> = {
  round_robin: "Round robin",
  direct: "Direct",
  geography: "Geography",
  industry: "Industry",
};

export type RoutingCondition = { field: string; op: string; value: unknown };
export type RoutingConditionSpec = { all?: RoutingCondition[]; any?: RoutingCondition[] };

export function routingFieldType(field: string): RoutingFieldType {
  return ROUTING_FIELDS.find((f) => f.v === field)?.type ?? "text";
}

const isBlank = (v: unknown) => v == null || String(v).trim() === "";

/** Why a condition can't be saved, or null (P42). */
export function routingConditionProblem(c: RoutingCondition): string | null {
  const field = ROUTING_FIELDS.find((f) => f.v === c.field);
  if (!field) return `Unknown field "${c.field}".`;
  if (!ROUTING_OPS[field.type].some((o) => o.v === c.op)) return `${field.l} can't use "${c.op}".`;
  if (isBlank(c.value)) return `${field.l} needs a value; a blank one would match every lead.`;
  if (field.type === "number" && !Number.isFinite(Number(c.value))) return `${field.l} needs a number.`;
  return null;
}

/** The first problem among a rule's conditions, or null. */
export function routingConditionsProblem(spec: RoutingConditionSpec): string | null {
  for (const c of [...(spec.all ?? []), ...(spec.any ?? [])]) {
    const p = routingConditionProblem(c);
    if (p) return p;
  }
  return null;
}

function compare(c: RoutingCondition, actual: unknown): boolean {
  if (routingFieldType(c.field) === "number") {
    const a = Number(actual), b = Number(c.value);
    // A missing score is not zero.
    if (actual == null || actual === "" || !Number.isFinite(a) || !Number.isFinite(b)) return false;
    switch (c.op) {
      case "eq": return a === b;
      case "neq": return a !== b;
      case "gt": return a > b;
      case "gte": return a >= b;
      case "lt": return a < b;
      case "lte": return a <= b;
      default: return false;
    }
  }
  const a = String(actual ?? "").trim().toLowerCase();
  const b = String(c.value ?? "").trim().toLowerCase();
  switch (c.op) {
    case "eq": return a === b;
    case "neq": return a !== b;
    case "contains": return a.includes(b);
    // Rules saved before the editor offered only text operators on text.
    case "gt": return Number(a) > Number(b);
    case "gte": return Number(a) >= Number(b);
    case "lt": return Number(a) < Number(b);
    case "lte": return Number(a) <= Number(b);
    default: return false;
  }
}

/**
 * Whether a lead matches a rule's conditions: every `all` condition, and one
 * of the `any` conditions when there are any. A condition with a blank value
 * can no longer be saved; one saved before is left out rather than matching
 * everything or nothing, so an existing rule routes as it did, and the page
 * flags it.
 */
export function routingConditionsMatch(spec: RoutingConditionSpec, payload: Record<string, unknown>): boolean {
  const live = (cs: RoutingCondition[] | undefined) => (cs ?? []).filter((c) => !isBlank(c.value));
  const all = live(spec.all);
  const any = live(spec.any);
  if (!all.every((c) => compare(c, payload[c.field]))) return false;
  if (any.length > 0 && !any.some((c) => compare(c, payload[c.field]))) return false;
  return true;
}

/** Conditions saved with a blank value, which the router leaves out. */
export function blankRoutingConditions(spec: RoutingConditionSpec): number {
  return [...(spec.all ?? []), ...(spec.any ?? [])].filter((c) => isBlank(c.value)).length;
}

/** Bare-array conditions (the oldest rules) as an `all` group. */
export function normalizeRoutingConditions(raw: unknown): RoutingConditionSpec {
  if (Array.isArray(raw)) return { all: raw as RoutingCondition[] };
  if (raw && typeof raw === "object") return raw as RoutingConditionSpec;
  return {};
}
