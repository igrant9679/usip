/**
 * CompanySearchService — server-side workspace-account search: text + firmographic
 * filters, score filter, sorting, pagination, and per-row contact counts. Powers
 * the Apollo-style company table. Only filters on data Velocity actually has.
 *
 * Two steps (audit 2026-10-20, X4.1): the filter, sort and page run over
 * account ids alone, then the page's rows are read by id. Sorting whole rows
 * carried every column of every match through the sort — the inline logo
 * images (about 20 KB an account, 76 MB in LSI Media), notes, custom fields —
 * and the first search after a quiet spell took 2.7–5 s for 50 rows.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, lte, or, sql, exists, type SQL } from "drizzle-orm";
import { getDb } from "../../db";
import { accounts, contactAccountLinks, scoreResults } from "../../../drizzle/schema";
import { RESEARCH_SOURCES } from "@shared/researchSource";
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
  research?: "sourced" | "in_sector";
  researchSectorIds?: number[];
}
export interface CompanySort { field: "name" | "employeeCount" | "revenue" | "score" | "lastEnriched" | "createdAt" | "contactCount"; direction: "asc" | "desc"; }

/** What one row of the company table shows; the page reads only these. */
const PAGE_COLUMNS = {
  id: accounts.id, name: accounts.name, domain: accounts.domain, normalizedDomain: accounts.normalizedDomain,
  websiteUrl: accounts.websiteUrl, linkedinCompanyUrl: accounts.linkedinCompanyUrl,
  industry: accounts.industry, employeeCount: accounts.employeeCount, employeeBand: accounts.employeeBand,
  revenue: accounts.revenue, revenueBand: accounts.revenueBand,
  region: accounts.region, hqCity: accounts.hqCity, hqState: accounts.hqState, hqCountry: accounts.hqCountry,
  ownerUserId: accounts.ownerUserId, accountStage: accounts.accountStage,
  accountScore: accounts.accountScore, accountRating: accounts.accountRating,
  lastEnrichedAt: accounts.lastEnrichedAt, dataStatus: accounts.dataStatus,
  sourceType: accounts.sourceType, researchSectorId: accounts.researchSectorId,
  logoUrl: accounts.logoUrl, logoSourceType: accounts.logoSourceType, logoStatus: accounts.logoStatus,
  logoLastVerifiedAt: accounts.logoLastVerifiedAt,
};

/**
 * ORDER BY for a search: the chosen field, then the id the same way, so rows
 * that tie (most accounts have no contacts, many share a created date) keep
 * one order and a row is never on two pages or on none.
 *
 * "Most contacts" is ordered in SQL across every match, not after fetching:
 * it once sorted only the 50 newest accounts among themselves, so page 1
 * never showed the workspace's top companies by contact count.
 */
export function searchOrder(ws: number, sort?: CompanySort): SQL[] {
  const dir = sort?.direction === "asc" ? asc : desc;
  const field = sort?.field ?? "createdAt";
  const col = field === "contactCount"
    ? sql<number>`(
        SELECT COUNT(*) FROM \`contact_account_links\` cal
        WHERE cal.\`workspaceId\` = ${ws} AND cal.\`account_id\` = \`accounts\`.\`id\`
      )`
    : ({
        name: accounts.name, employeeCount: accounts.employeeCount, revenue: accounts.revenue,
        score: accounts.accountScore, lastEnriched: accounts.lastEnrichedAt, createdAt: accounts.createdAt,
      }[field] ?? accounts.createdAt);
  return [dir(col), dir(accounts.id)];
}

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
  if (f.research === "sourced") conds.push(inArray(accounts.sourceType, Object.values(RESEARCH_SOURCES)));
  if (f.research === "in_sector") conds.push(isNotNull(accounts.researchSectorId));
  if (f.researchSectorIds?.length) conds.push(inArray(accounts.researchSectorId, f.researchSectorIds));
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
    const set: ("fair" | "good" | "excellent")[] = f.minRating === "excellent" ? ["excellent"] : f.minRating === "good" ? ["good", "excellent"] : ["fair", "good", "excellent"];
    conds.push(exists(db.select({ x: sql`1` }).from(scoreResults)
      .where(and(eq(scoreResults.workspaceId, ws), eq(scoreResults.objectType, "company"),
        eq(scoreResults.objectId, accounts.id), inArray(scoreResults.rating, set)))));
  }

  const where = and(...conds);
  // The page's ids in order, and the total, side by side.
  const [pageIds, [{ total }]] = await Promise.all([
    db.select({ id: accounts.id }).from(accounts).where(where)
      .orderBy(...searchOrder(ws, opts.sort)).limit(perPage).offset((page - 1) * perPage),
    db.select({ total: sql<number>`count(*)` }).from(accounts).where(where),
  ]);
  const ids = pageIds.map((r) => r.id);
  if (!ids.length) return { data: [], total: Number(total), page, perPage };

  // Those rows, and their contact counts.
  const [rows, cc] = await Promise.all([
    db.select(PAGE_COLUMNS).from(accounts).where(and(eq(accounts.workspaceId, ws), inArray(accounts.id, ids))),
    db.select({ accountId: contactAccountLinks.accountId, n: sql<number>`count(*)` })
      .from(contactAccountLinks)
      .where(and(eq(contactAccountLinks.workspaceId, ws), inArray(contactAccountLinks.accountId, ids)))
      .groupBy(contactAccountLinks.accountId),
  ]);
  const counts = new Map<number, number>();
  for (const r of cc) counts.set(r.accountId, Number(r.n));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // In the order the sort chose; a row archived or moved in between drops out.
  const data = ids.flatMap((id) => byId.get(id) ?? []).map((a) => {
    const logo = resolveCompanyLogo(a);
    return {
      id: a.id, name: a.name, domain: a.domain, websiteUrl: a.websiteUrl, linkedinCompanyUrl: a.linkedinCompanyUrl,
      industry: a.industry, employeeCount: a.employeeCount, employeeBand: a.employeeBand,
      revenue: a.revenue == null ? null : Number(a.revenue), revenueBand: a.revenueBand,
      region: a.region, hqCity: a.hqCity, hqState: a.hqState, hqCountry: a.hqCountry,
      ownerUserId: a.ownerUserId, accountStage: a.accountStage,
      accountScore: a.accountScore == null ? null : Number(a.accountScore), accountRating: a.accountRating,
      lastEnrichedAt: a.lastEnrichedAt, dataStatus: a.dataStatus,
      sourceType: a.sourceType, researchSectorId: a.researchSectorId,
      logo: { url: logo.url, faviconUrl: faviconUrlForDomain(a.normalizedDomain || a.domain), status: logo.status },
      contactCount: counts.get(a.id) ?? 0,
    };
  });

  return { data, total: Number(total), page, perPage };
}
