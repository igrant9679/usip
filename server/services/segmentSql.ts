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
import { contacts } from "../../drizzle/schema";
import { SEGMENT_FIELDS, SEGMENT_OPERATORS, type SegmentRule } from "@shared/segmentRules";

const COLUMNS: Record<string, MySqlColumn> = {
  email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName, title: contacts.title,
  phone: contacts.phone, linkedinUrl: contacts.linkedinUrl, seniority: contacts.seniority, city: contacts.city,
  emailVerificationStatus: contacts.emailVerificationStatus, isPrimary: contacts.isPrimary, createdAt: contacts.createdAt,
};

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);
const DAY = 86_400_000;

/** One rule as a condition, or null when it can match nobody. */
export function ruleSql(rule: SegmentRule): SQL | null {
  const col = COLUMNS[rule.field];
  const kind = SEGMENT_FIELDS[rule.field];
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
    const day = Date.parse(`${rule.value}T00:00:00Z`);
    if (Number.isNaN(day)) return null;
    return rule.operator === "gt" ? gte(col, new Date(day + DAY)) : lt(col, new Date(day));
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

/** The whole segment as a condition on contacts, or null when it matches nobody. */
export function segmentSql(rules: SegmentRule[], matchType: "all" | "any"): SQL | null {
  if (!rules.length) return null;
  const parts = rules.map(ruleSql);
  if (matchType === "all") return parts.some((p) => p == null) ? null : and(...(parts as SQL[]))!;
  const live = parts.filter((p): p is SQL => p != null);
  return live.length ? or(...live)! : null;
}

/** Contacts of this workspace in the segment, as a WHERE clause; null when none can be. */
export function segmentWhere(ws: number, rules: SegmentRule[], matchType: "all" | "any"): SQL | null {
  const seg = segmentSql(rules, matchType);
  return seg ? and(eq(contacts.workspaceId, ws), seg)! : null;
}

type Db = { select: (...a: any[]) => any };

/** How many contacts of this workspace the segment holds, counted in SQL. */
export async function countSegment(db: Db, ws: number, rules: SegmentRule[], matchType: "all" | "any"): Promise<number> {
  const where = segmentWhere(ws, rules, matchType);
  if (!where) return 0;
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(contacts).where(where);
  return Number(n);
}
