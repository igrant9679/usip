/**
 * Segment rules as SQL (audit 2026-10-20, P52, X4.1).
 *
 * Every create, update, preview and refresh loaded every contact in the
 * workspace, whole rows, and ran matchesSegment (@shared/segmentRules) over
 * them in JavaScript; getContacts returned them all. Now the rules become one
 * WHERE clause and the database counts. The clause means what
 * applySegmentRule means, case for case:
 *
 *   text and email status: equals / not equals ignore case, an empty value
 *     is "" (so "not equals x" includes the empty ones); contains / does not
 *     contain the same; is empty means NULL or "".
 *   isPrimary: "Yes" is true; "No" is false or unset.
 *   createdAt: "after" a day starts at the next day; "before" a day ends
 *     before it (UTC, as the evaluator reads them).
 *   An unknown field or operator matches nobody, never everybody, and no
 *   rules match nobody.
 *
 * The shared evaluator stays the definition; server/phase4Queries.test.ts runs
 * both over the same contacts and requires the same answer.
 */
import { and, eq, gte, isNotNull, isNull, like, lt, ne, notLike, or, sql, type SQL } from "drizzle-orm";
import type { MySqlColumn } from "drizzle-orm/mysql-core";
import { contacts, prospects } from "../../drizzle/schema";
import { SEGMENT_OPERATORS, segmentFieldsFor, type SegmentRule, type SegmentSubject } from "@shared/segmentRules";
import { startOfCalendarDay } from "./calendarDeadline";
import { getWorkspaceTimezone } from "./workspaceTimezone";

const CONTACT_COLUMNS: Record<string, MySqlColumn> = {
  email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName, title: contacts.title,
  phone: contacts.phone, linkedinUrl: contacts.linkedinUrl, seniority: contacts.seniority, city: contacts.city,
  emailVerificationStatus: contacts.emailVerificationStatus, isPrimary: contacts.isPrimary, createdAt: contacts.createdAt,
};

/**
 * The People field map as columns (audit 2026-10-20, P21, F42): a People
 * segment reads the prospects table. Email status is prospects.emailStatus,
 * which the same verifier writes with the same five values.
 */
const PEOPLE_COLUMNS: Record<string, MySqlColumn> = {
  email: prospects.email, firstName: prospects.firstName, lastName: prospects.lastName, title: prospects.title,
  phone: prospects.phone, linkedinUrl: prospects.linkedinUrl, seniority: prospects.seniority, company: prospects.company,
  industry: prospects.industry, city: prospects.city, state: prospects.state, country: prospects.country,
  emailVerificationStatus: prospects.emailStatus, createdAt: prospects.createdAt,
};

const columnsFor = (subject: SegmentSubject) => (subject === "people" ? PEOPLE_COLUMNS : CONTACT_COLUMNS);

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);
const DAY = 86_400_000;

/** One rule as a condition, or null when it can match nobody (a field this subject does not have among them). */
export function ruleSql(rule: SegmentRule, tz: string = "UTC", subject: SegmentSubject = "contacts"): SQL | null {
  const col = columnsFor(subject)[rule.field];
  const kind = segmentFieldsFor(subject)[rule.field];
  if (!col || !kind) return null;
  // Read before the operator list, for every kind, as the evaluator does.
  const textual = kind === "text" || kind === "select";
  const empty = textual ? or(isNull(col), eq(col, ""))! : isNull(col);
  if (rule.operator === "is_empty") return empty;
  if (rule.operator === "is_not_empty") return textual ? and(isNotNull(col), ne(col, ""))! : isNotNull(col);
  if (!SEGMENT_OPERATORS[kind].includes(rule.operator)) return null;
  if (kind === "boolean") {
    const yes = (rule.value === "true") === (rule.operator === "equals");
    return yes ? eq(col, true) : or(isNull(col), eq(col, false))!;
  }
  if (kind === "date") {
    // A date in a rule is a day in the workspace's zone, read as the evaluator
    // reads it. It was a UTC day, so "created after the 2nd" in New York started at
    // 7pm on the 2nd. "After" starts where the next day does, however long this one is.
    const start = startOfCalendarDay(rule.value ?? "", tz);
    if (!start || Number.isNaN(Date.parse(`${rule.value}T00:00:00Z`))) return null;
    if (rule.operator !== "gt") return lt(col, start);
    const next = new Date(Date.parse(`${rule.value}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
    return gte(col, startOfCalendarDay(next, tz)!);
  }
  const want = (rule.value ?? "").toLowerCase();
  const pattern = `%${escapeLike(want)}%`;
  // An empty value (a preview before it is typed): "" equals the empty ones,
  // and every value contains "".
  if (want === "") {
    if (rule.operator === "equals") return empty;
    if (rule.operator === "not_equals") return and(isNotNull(col), ne(col, ""))!;
    if (rule.operator === "contains") return or(isNull(col), isNotNull(col))!;
    return null;
  }
  switch (rule.operator) {
    case "equals": return sql`lower(${col}) = ${want}`;
    case "not_equals": return or(isNull(col), sql`lower(${col}) <> ${want}`)!;
    case "contains": return like(col, pattern);
    case "not_contains": return or(isNull(col), notLike(col, pattern))!;
    default: return null;
  }
}

/** The whole segment as a condition on its table, or null when it matches nobody. */
export function segmentSql(rules: SegmentRule[], matchType: "all" | "any", tz: string = "UTC", subject: SegmentSubject = "contacts"): SQL | null {
  if (!rules.length) return null;
  const parts = rules.map((r) => ruleSql(r, tz, subject));
  if (matchType === "all") return parts.some((p) => p == null) ? null : and(...(parts as SQL[]))!;
  const live = parts.filter((p): p is SQL => p != null);
  return live.length ? or(...live)! : null;
}

/**
 * The segment's members in this workspace, as a WHERE clause on its table;
 * null when none can be. People who are archived (verificationStatus
 * "rejected", R64) are in no segment, as they are hidden everywhere else.
 */
export function segmentWhere(ws: number, rules: SegmentRule[], matchType: "all" | "any", tz: string, subject: SegmentSubject = "contacts"): SQL | null {
  const seg = segmentSql(rules, matchType, tz, subject);
  if (!seg) return null;
  if (subject === "people") {
    return and(eq(prospects.workspaceId, ws), or(isNull(prospects.verificationStatus), ne(prospects.verificationStatus, "rejected"))!, seg)!;
  }
  return and(eq(contacts.workspaceId, ws), seg)!;
}

type Db = { select: (...a: any[]) => any };

/** How many members of this workspace the segment holds, counted in SQL on its table. */
export async function countSegment(db: Db, ws: number, rules: SegmentRule[], matchType: "all" | "any", subject: SegmentSubject = "contacts"): Promise<number> {
  const where = segmentWhere(ws, rules, matchType, await getWorkspaceTimezone(ws), subject);
  if (!where) return 0;
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(subject === "people" ? prospects : contacts).where(where);
  return Number(n);
}
