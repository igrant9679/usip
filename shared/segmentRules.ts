/**
 * Segment rules — which operators and values each field takes, and the one
 * evaluator (audit 2026-10-20, P1, P19).
 *
 * 🔴 THE BUGS. The builder kept "contains" when the field changed, and the
 * server took any operator for any field: "Is primary contact contains Yes"
 * matched everyone, "Email status contains valid" matched "invalid", "Yes"
 * saved as an empty value, and "Created contains 2026-11-01" never matched. An
 * unknown operator evaluated to true. And a segment with no rules matched
 * every contact — which a linked auto-enrol rule then enrolled. The evaluator
 * also existed twice (segments.ts and segmentRules.ts), so a fix to one left
 * the hourly enrolment on the other.
 */

export type SegmentFieldKind = "text" | "select" | "boolean" | "date";

export const SEGMENT_FIELDS: Record<string, SegmentFieldKind> = {
  email: "text",
  firstName: "text",
  lastName: "text",
  title: "text",
  phone: "text",
  linkedinUrl: "text",
  seniority: "text",
  city: "text",
  emailVerificationStatus: "select",
  isPrimary: "boolean",
  createdAt: "date",
};

export const SEGMENT_OPERATORS: Record<SegmentFieldKind, string[]> = {
  text: ["equals", "not_equals", "contains", "not_contains", "is_empty", "is_not_empty"],
  select: ["equals", "not_equals", "is_empty", "is_not_empty"],
  boolean: ["equals", "not_equals"],
  date: ["gt", "lt", "is_empty", "is_not_empty"],
};

export const EMAIL_STATUS_VALUES = ["valid", "accept_all", "risky", "invalid"];

export type SegmentRule = { field: string; operator: string; value: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const needsValue = (op: string) => op !== "is_empty" && op !== "is_not_empty";

/** Why a rule cannot be saved, or null. */
export function segmentRuleProblem(rule: SegmentRule): string | null {
  const kind = SEGMENT_FIELDS[rule.field];
  if (!kind) return `"${rule.field}" is not a field a segment can filter on.`;
  if (!SEGMENT_OPERATORS[kind].includes(rule.operator)) return `"${rule.operator}" does not apply to ${rule.field}.`;
  if (!needsValue(rule.operator)) return null;
  const v = (rule.value ?? "").trim();
  if (!v) return `The rule on ${rule.field} needs a value.`;
  if (kind === "boolean" && v !== "true" && v !== "false") return `${rule.field} is Yes or No.`;
  if (kind === "select" && !EMAIL_STATUS_VALUES.includes(v)) return `"${v}" is not an email status.`;
  if (kind === "date" && (!ISO_DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) return `"${v}" is not a date.`;
  return null;
}

/** Why a segment cannot be saved, or null. */
export function segmentProblem(rules: SegmentRule[]): string | null {
  if (rules.length === 0) return "A segment needs at least one rule — with none it matches every contact.";
  for (const r of rules) {
    const p = segmentRuleProblem(r);
    if (p) return p;
  }
  return null;
}

const timeOf = (v: unknown): number => {
  if (v instanceof Date) return v.getTime();
  if (v == null || v === "") return NaN;
  return new Date(String(v)).getTime();
};

export function applySegmentRule(contact: Record<string, unknown>, rule: SegmentRule): boolean {
  const raw = contact[rule.field];
  const kind = SEGMENT_FIELDS[rule.field] ?? "text";
  const empty = raw === null || raw === undefined || raw === "";
  if (rule.operator === "is_empty") return empty;
  if (rule.operator === "is_not_empty") return !empty;
  if (kind === "boolean") {
    const isTrue = raw === true || raw === 1 || raw === "1" || raw === "true";
    const want = rule.value === "true";
    if (rule.operator === "equals") return isTrue === want;
    if (rule.operator === "not_equals") return isTrue !== want;
    return false;
  }
  if (kind === "date") {
    const t = timeOf(raw);
    const day = Date.parse(`${rule.value}T00:00:00Z`);
    if (Number.isNaN(t) || Number.isNaN(day)) return false;
    // "after" the 1st means from the 2nd; "before" the 1st means up to the 31st.
    if (rule.operator === "gt") return t >= day + 86_400_000;
    if (rule.operator === "lt") return t < day;
    return false;
  }
  const val = empty ? "" : String(raw).toLowerCase();
  const want = (rule.value ?? "").toLowerCase();
  switch (rule.operator) {
    case "equals": return val === want;
    case "not_equals": return val !== want;
    case "contains": return kind === "text" && val.includes(want);
    case "not_contains": return kind === "text" && !val.includes(want);
    // An operator the field does not take matches nobody, never everybody.
    default: return false;
  }
}

/** A contact in the segment. No rules matches nobody. */
export function matchesSegment(contact: Record<string, unknown>, rules: SegmentRule[], matchType: "all" | "any"): boolean {
  if (rules.length === 0) return false;
  return matchType === "any" ? rules.some((r) => applySegmentRule(contact, r)) : rules.every((r) => applySegmentRule(contact, r));
}
