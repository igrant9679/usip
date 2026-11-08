/**
 * The People list's filters as SQL, in one place (audit 2026-10-20, F30).
 *
 * prospects.list built its WHERE inline. "Select all N matching" acts on the
 * same people the list counts, so the bulk actions read the very same
 * conditions: whatever the list shows under a filter is exactly what an
 * action on "all matching" touches, and the confirmation's count is the
 * list's total.
 */
import { and, asc, eq, inArray, isNull, like, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { prospects } from "../../drizzle/schema";
import { getDb } from "../db";

/**
 * A People search term as a LIKE pattern that means what was typed: % and _
 * are literal characters, not wildcards (audit 2026-10-20, R85).
 */
export const escapeLike = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);
export const contains = (v: string) => `%${escapeLike(v)}%`;

/** The filters the People list and its bulk actions share. */
export const PEOPLE_FILTER_SHAPE = {
  emailStatus: z.string().optional(),
  hasEmail: z.boolean().optional(),
  hasPhone: z.boolean().optional(),
  hasLinkedin: z.boolean().optional(),
  promoted: z.boolean().optional(),
  verificationStatus: z.enum(["verified", "needs_review", "rejected"]).optional(),
  discoveryRunId: z.number().int().optional(),
  companyId: z.number().int().positive().optional(),
  enrolled: z.enum(["yes", "no"]).optional(),
  search: z.string().trim().max(200).optional(),
  titleQ: z.string().trim().max(200).optional(),
  companyQ: z.string().trim().max(200).optional(),
  locationQ: z.string().trim().max(200).optional(),
  industryQ: z.string().trim().max(200).optional(),
  educationQ: z.string().trim().max(200).optional(),
  linkedinQ: z.string().trim().max(500).optional(),
  tiers: z.array(z.enum(["high", "medium", "low"])).optional(),
  seniorities: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
};
export const PEOPLE_FILTER = z.object(PEOPLE_FILTER_SHAPE);
export type PeopleFilter = z.infer<typeof PEOPLE_FILTER>;

export function emailStatusCondition(status: string): SQL {
  return status === "unknown"
    ? or(isNull(prospects.emailStatus), eq(prospects.emailStatus, "unknown"))!
    : eq(prospects.emailStatus, status);
}

/**
 * The WHERE of the People list. `promotedConds` is kept apart so the list's
 * Total / Net new / Saved tiles can count across the whole filtered set
 * whichever tile is active; anything acting on the list applies both.
 */
export function peopleFilterConditions(ws: number, input: PeopleFilter): { conditions: SQL[]; promotedConds: SQL[] } {
  const conditions: SQL[] = [eq(prospects.workspaceId, ws)];
  if (input.emailStatus) conditions.push(emailStatusCondition(input.emailStatus));
  // '' counts as missing on BOTH sides: imports write empty strings, and
  // a "has email" filter that returns unmailable rows (or a "missing
  // email" view that hides them) sends the user chasing ghosts.
  if (input.hasEmail === true) conditions.push(sql`${prospects.email} IS NOT NULL AND ${prospects.email} != ''`);
  if (input.hasEmail === false) conditions.push(sql`(${prospects.email} IS NULL OR ${prospects.email} = '')`);
  if (input.hasPhone) conditions.push(sql`${prospects.phone} IS NOT NULL AND ${prospects.phone} <> ''`);
  if (input.hasLinkedin) conditions.push(sql`${prospects.linkedinUrl} IS NOT NULL AND ${prospects.linkedinUrl} <> ''`);
  // "Saved" means promoted to a lead OR a contact — the People page has
  // always counted both, while this filter checked only linkedLeadId and
  // silently dropped contact-only rows from the Saved view. One
  // vocabulary now, and the tiles share it.
  const savedExpr = sql`(${prospects.linkedLeadId} IS NOT NULL OR ${prospects.linkedContactId} IS NOT NULL)`;
  const promotedConds =
    input.promoted === true ? [savedExpr]
      : input.promoted === false ? [sql`(${prospects.linkedLeadId} IS NULL AND ${prospects.linkedContactId} IS NULL)`]
        : [];
  // Archived people stay out of the list unless the Archived stage is
  // asked for (audit 2026-10-20, R64): archiving hid nobody.
  if (input.verificationStatus) conditions.push(eq(prospects.verificationStatus, input.verificationStatus));
  else conditions.push(or(isNull(prospects.verificationStatus), ne(prospects.verificationStatus, "rejected"))!);
  if (input.discoveryRunId) conditions.push(eq(prospects.lastDiscoveryRunId, input.discoveryRunId));
  if (input.companyId) conditions.push(eq(prospects.accountId, input.companyId));
  // Sequence membership — join via enrollments.prospectId (migration 0085).
  if (input.enrolled === "yes") {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM \`enrollments\` \`e\` WHERE \`e\`.\`prospectId\` = ${prospects.id} AND \`e\`.\`workspaceId\` = ${ws})`,
    );
  } else if (input.enrolled === "no") {
    conditions.push(
      sql`NOT EXISTS (SELECT 1 FROM \`enrollments\` \`e\` WHERE \`e\`.\`prospectId\` = ${prospects.id} AND \`e\`.\`workspaceId\` = ${ws})`,
    );
  }
  // Text filters — case-insensitive contains (MySQL default _ci collation).
  if (input.search) {
    const s = contains(input.search);
    conditions.push(
      or(
        like(prospects.firstName, s),
        like(prospects.lastName, s),
        // Full-name search: "Steven Burke" matches neither name column
        // alone, so every full-name query returned nothing — the People
        // search box AND the assistant's people lookup both hit this.
        sql`CONCAT(${prospects.firstName}, ' ', ${prospects.lastName}) LIKE ${s}`,
        like(prospects.title, s),
        like(prospects.company, s),
        like(prospects.email, s),
      )!,
    );
  }
  if (input.titleQ) conditions.push(like(prospects.title, contains(input.titleQ)));
  if (input.companyQ) conditions.push(like(prospects.company, contains(input.companyQ)));
  if (input.industryQ) conditions.push(like(prospects.industry, contains(input.industryQ)));
  if (input.educationQ) conditions.push(like(prospects.education, contains(input.educationQ)));
  if (input.linkedinQ) conditions.push(like(prospects.linkedinUrl, contains(input.linkedinQ)));
  if (input.locationQ) {
    const s = contains(input.locationQ);
    conditions.push(or(like(prospects.city, s), like(prospects.state, s), like(prospects.country, s))!);
  }
  if (input.tiers?.length) conditions.push(inArray(prospects.confidenceTier, input.tiers));
  if (input.seniorities?.length) {
    conditions.push(or(...input.seniorities.map((s) => like(prospects.seniority, contains(s))))!);
  }
  return { conditions, promotedConds };
}

/** The most people one action on "all matching" may take. */
export const PEOPLE_MATCH_MAX = 5000;

/** Every person the list shows under this filter, by id, at most `cap`, and how many match. */
export async function matchingPeopleIds(ws: number, filter: PeopleFilter, cap = PEOPLE_MATCH_MAX): Promise<{ ids: number[]; total: number }> {
  const db = await getDb();
  if (!db) return { ids: [], total: 0 };
  const { conditions, promotedConds } = peopleFilterConditions(ws, filter);
  const where = and(...conditions, ...promotedConds);
  const [rows, [{ total }]] = await Promise.all([
    db.select({ id: prospects.id }).from(prospects).where(where).orderBy(asc(prospects.id)).limit(cap),
    db.select({ total: sql<number>`count(*)` }).from(prospects).where(where),
  ]);
  return { ids: rows.map((r) => r.id), total: Number(total) };
}
