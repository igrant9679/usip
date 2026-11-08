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

import { zonedDayKey } from "./availability";

export type SegmentFieldKind = "text" | "select" | "boolean" | "date";

/** The fields a CRM-contact segment filters on (the table segments read until P21). */
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

/**
 * Segments on People (audit 2026-10-20, P21, F42). What a segment reads:
 * "people" (the prospects table, the sitewide record) or "contacts" (the CRM
 * contacts table every segment read before migration 0363). A stored segment
 * with no subject is a contacts one.
 */
export type SegmentSubject = "people" | "contacts";

export function segmentSubjectOf(v: unknown): SegmentSubject {
  return v === "people" ? "people" : "contacts";
}

/**
 * The People field map: the fields a People segment filters on. A contact
 * rule keeps its field name where People has the same thing (Email status is
 * People's emailStatus, written by the same verifier with the same values);
 * People adds company, industry, state and country.
 */
export const PEOPLE_SEGMENT_FIELDS: Record<string, SegmentFieldKind> = {
  email: "text",
  firstName: "text",
  lastName: "text",
  title: "text",
  phone: "text",
  linkedinUrl: "text",
  seniority: "text",
  company: "text",
  industry: "text",
  city: "text",
  state: "text",
  country: "text",
  emailVerificationStatus: "select",
  createdAt: "date",
};

/**
 * Each contact field's People field, or null where People has none ("Is
 * primary contact" is a contact's place on an account). A saved rule on a
 * field with no People equivalent is KEPT, unchanged, and flagged: under
 * "match all" it makes the segment match nobody until someone edits it, and
 * auto-enrol refuses the segment meanwhile.
 */
export const CONTACT_TO_PEOPLE_FIELD: Record<string, string | null> = {
  email: "email", firstName: "firstName", lastName: "lastName", title: "title", phone: "phone",
  linkedinUrl: "linkedinUrl", seniority: "seniority", city: "city",
  emailVerificationStatus: "emailVerificationStatus", createdAt: "createdAt", isPrimary: null,
};

export const SEGMENT_FIELD_LABELS: Record<string, string> = {
  email: "Email", firstName: "First name", lastName: "Last name", title: "Job title", phone: "Phone",
  linkedinUrl: "LinkedIn URL", seniority: "Seniority", company: "Company", industry: "Industry", city: "City",
  state: "State", country: "Country", emailVerificationStatus: "Email status", isPrimary: "Is primary contact",
  createdAt: "Created date",
};

export function segmentFieldsFor(subject: SegmentSubject): Record<string, SegmentFieldKind> {
  return subject === "people" ? PEOPLE_SEGMENT_FIELDS : SEGMENT_FIELDS;
}

/** The kind of a field, on either table. */
export function segmentFieldKind(field: string): SegmentFieldKind | undefined {
  return PEOPLE_SEGMENT_FIELDS[field] ?? SEGMENT_FIELDS[field];
}

/** Saved rules this subject has no field for: kept as they are, and flagged. */
export function unmappedRules(rules: SegmentRule[], subject: SegmentSubject): SegmentRule[] {
  const fields = segmentFieldsFor(subject);
  return (rules ?? []).filter((r) => !fields[r.field]);
}

/** "Is primary contact" — the flag's wording for a segment's unmapped rules. */
export function unmappedSentence(rules: SegmentRule[]): string {
  const names = Array.from(new Set(rules.map((r) => SEGMENT_FIELD_LABELS[r.field] ?? r.field)));
  return `${names.join(", ")} ${names.length === 1 ? "is not a field People have" : "are not fields People have"}`;
}

export const SEGMENT_OPERATORS: Record<SegmentFieldKind, string[]> = {
  text: ["equals", "not_equals", "contains", "not_contains", "is_empty", "is_not_empty"],
  select: ["equals", "not_equals", "is_empty", "is_not_empty"],
  boolean: ["equals", "not_equals"],
  date: ["gt", "lt", "is_empty", "is_not_empty"],
};

/** What verification writes (services/reoon.ts); "unknown" is a result too (audit 2026-10-20, P140). */
export const EMAIL_STATUS_VALUES = ["valid", "accept_all", "risky", "invalid", "unknown"];

export type SegmentRule = { field: string; operator: string; value: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const needsValue = (op: string) => op !== "is_empty" && op !== "is_not_empty";

/** Why a rule cannot be saved, or null. */
export function segmentRuleProblem(rule: SegmentRule, subject: SegmentSubject = "contacts"): string | null {
  const kind = segmentFieldsFor(subject)[rule.field];
  if (!kind) {
    return subject === "people" && SEGMENT_FIELDS[rule.field]
      ? `"${SEGMENT_FIELD_LABELS[rule.field] ?? rule.field}" is a contact field People don't have. Remove that rule or pick a People field.`
      : `"${rule.field}" is not a field a segment can filter on.`;
  }
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
export function segmentProblem(rules: SegmentRule[], subject: SegmentSubject = "contacts"): string | null {
  if (rules.length === 0) return `A segment needs at least one rule — with none it matches every ${subject === "people" ? "person" : "contact"}.`;
  for (const r of rules) {
    const p = segmentRuleProblem(r, subject);
    if (p) return p;
  }
  return null;
}

const timeOf = (v: unknown): number => {
  if (v instanceof Date) return v.getTime();
  if (v == null || v === "") return NaN;
  return new Date(String(v)).getTime();
};

/** `tz` is the workspace's: a date in a rule is a day there. */
export function applySegmentRule(contact: Record<string, unknown>, rule: SegmentRule, tz: string = "UTC"): boolean {
  const raw = contact[rule.field];
  const kind = segmentFieldKind(rule.field) ?? "text";
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
    if (Number.isNaN(t) || !ISO_DAY.test(rule.value ?? "") || Number.isNaN(Date.parse(`${rule.value}T00:00:00Z`))) return false;
    // "after" the 1st means from the 2nd; "before" the 1st means up to the 31st.
    // Compared as days in the workspace's zone, because these strings sort as dates.
    const day = zonedDayKey(tz, t);
    if (rule.operator === "gt") return day > rule.value!;
    if (rule.operator === "lt") return day < rule.value!;
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
export function matchesSegment(contact: Record<string, unknown>, rules: SegmentRule[], matchType: "all" | "any", tz: string = "UTC"): boolean {
  if (rules.length === 0) return false;
  return matchType === "any" ? rules.some((r) => applySegmentRule(contact, r, tz)) : rules.every((r) => applySegmentRule(contact, r, tz));
}
