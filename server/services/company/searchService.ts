/**
 * CompanySearchService — server-side workspace-account search: text + firmographic
 * filters, score filter, sorting, pagination, and per-row contact counts. Powers
 * the Apollo-style company table. Only filters on data Velocity actually has.
 */
import { and, asc, desc, eq, gte, inArray, isNull, like, lte, or, sql, exists } from "drizzle-orm";
import { getDb } from "../../db";
import { accounts, contactAccountLinks, scoreResults } from "../../../drizzle/schema";
import { resolveCompanyLogo, faviconUrlForDomain } from "./logoService";

export interface CompanyFilters {
  q?: string;
  industries?: string[];
  ownerIds?: number[];
  accountStages?: string[];
  employeeMin?: number;
  employeeMax?: number;
  revenueMin?: number;
  revenueMax?: number;
  locations?: string[];        // matched against region / hq_country / hq_state
  hasContacts?: boolean;
  minRating?: "fair" | "good" | "excellent";
  includeArchived?: boolean;
}
export interface CompanySort { field: "name" | "employeeCount" | "revenue" | "score" | "lastEnriched" | "createdAt" | "contactCount"; direction: "asc" | "desc"; }

export async function searchWorkspaceAccounts(ws: number, opts: {
  filters?: CompanyFilters; sort?: CompanySort; page?: number; perPage?: number;
}) {
  const db = await getDb();
  if (!db) return { data: [], total: 0, page: 1, perPage: 50 };
  const f = opts.filters ?? {};
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.min(200, Math.max(10, opts.perPage ?? 50));

  const conds = [eq(accounts.workspaceId, ws)];
  if (!f.includeArchived) conds.push(isNull(accounts.archivedAt));
  if (f.q) {
    const s = `%${f.q}%`;
    conds.push(or(like(accounts.name, s), like(accounts.domain, s), like(accounts.normalizedDomain, s))!);
  }
  if (f.industries?.length) conds.push(inArray(accounts.industry, f.industries));
  if (f.ownerIds?.length) conds.push(inArray(accounts.ownerUserId, f.ownerIds));
  if (f.accountStages?.length) conds.push(inArray(accounts.accountStage, f.accountStages));
  if (f.employeeMin != null) conds.push(gte(accounts.employeeCount, f.employeeMin));
  if (f.employeeMax != null) conds.push(lte(accounts.employeeCount, f.employeeMax));
  if (f.revenueMin != null) conds.push(sql`${accounts.revenue} >= ${f.revenueMin}`);
  if (f.revenueMax != null) conds.push(sql`${accounts.revenue} <= ${f.revenueMax}`);
  if (f.locations?.length) {
    const locConds = f.locations.flatMap((loc) => {
      const s = `%${loc}%`;
      return [like(accounts.region, s), like(accounts.hqCountry, s), like(accounts.hqState, s), like(accounts.hqCity, s)];
    });
    conds.push(or(...locConds)!);
  }
  if (f.hasContacts === true) {
    conds.push(exists(db.select({ x: sql`1` }).from(contactAccountLinks)
      .where(and(eq(contactAccountLinks.workspaceId, ws), eq(contactAccountLinks.accountId, accounts.id)))));
  }
  if (f.minRating) {
    const set = f.minRating === "excellent" ? ["excellent"] : f.minRating === "good" ? ["good", "excellent"] : ["fair", "good", "excellent"];
    conds.push(exists(db.select({ x: sql`1` }).from(scoreResults)
      .where(and(eq(scoreResults.workspaceId, ws), eq(scoreResults.objectType, "company"),
        eq(scoreResults.objectId, accounts.id), inArray(scoreResults.rating, set)))));
  }

  const sortCol = {
    name: accounts.name, employeeCount: accounts.employeeCount, revenue: accounts.revenue,
    score: accounts.accountScore, lastEnriched: accounts.lastEnrichedAt, createdAt: accounts.createdAt,
    contactCount: accounts.createdAt, // contactCount sort handled post-fetch
  }[opts.sort?.field ?? "createdAt"] ?? accounts.createdAt;
  const dir = opts.sort?.direction === "asc" ? asc : desc;

  const rows = await db.select().from(accounts).where(and(...conds))
    .orderBy(dir(sortCol)).limit(perPage).offset((page - 1) * perPage);
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(accounts).where(and(...conds));

  // Contact counts for the page.
  const ids = rows.map((r) => r.id);
  const counts = new Map<number, number>();
  if (ids.length) {
    const cc = await db.select({ accountId: contactAccountLinks.accountId, n: sql<number>`count(*)` })
      .from(contactAccountLinks)
      .where(and(eq(contactAccountLinks.workspaceId, ws), inArray(contactAccountLinks.accountId, ids)))
      .groupBy(contactAccountLinks.accountId);
    for (const r of cc) counts.set(r.accountId, Number(r.n));
  }

  let data = rows.map((a) => {
    const logo = resolveCompanyLogo(a);
    return {
      id: a.id, name: a.name, domain: a.domain, websiteUrl: a.websiteUrl, linkedinCompanyUrl: a.linkedinCompanyUrl,
      industry: a.industry, employeeCount: a.employeeCount, employeeBand: a.employeeBand,
      revenue: a.revenue == null ? null : Number(a.revenue), revenueBand: a.revenueBand,
      region: a.region, hqCity: a.hqCity, hqState: a.hqState, hqCountry: a.hqCountry,
      ownerUserId: a.ownerUserId, accountStage: a.accountStage,
      accountScore: a.accountScore == null ? null : Number(a.accountScore), accountRating: a.accountRating,
      lastEnrichedAt: a.lastEnrichedAt, dataStatus: a.dataStatus,
      logo: { url: logo.url, faviconUrl: faviconUrlForDomain(a.normalizedDomain || a.domain), status: logo.status },
      contactCount: counts.get(a.id) ?? 0,
    };
  });

  if (opts.sort?.field === "contactCount") {
    const m = opts.sort.direction === "asc" ? 1 : -1;
    data = data.sort((x, y) => (x.contactCount - y.contactCount) * m);
  }

  return { data, total: Number(total), page, perPage };
}
