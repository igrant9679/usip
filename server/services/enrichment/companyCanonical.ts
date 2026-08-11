/**
 * Canonical company naming — converge spelling variations onto the
 * workspace's established record.
 *
 * "Acme", "ACME Corp", "Acme Corp." arriving from three sources should not
 * become three companies. The identity match uses the same normalization
 * vocabulary as account dedupe (services/company/normalize.ts); the DISPLAY
 * spelling returned is, in order of authority:
 *
 *   1. an accounts row matching by domain (strongest key) or normalized name
 *      — the account IS the canonical company record;
 *   2. the most common spelling among existing prospects with the same
 *      normalized name — convergence beats churn even without an account;
 *   3. the incoming name itself (already display-normalized by
 *      recordNormalize) when the workspace has never seen this company.
 *
 * Read-only and best-effort: any failure returns the incoming name — a
 * naming nicety must never fail an enrichment or an import.
 */
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { accounts, prospects } from "../../../drizzle/schema";
import { normalizeCompanyName, normalizeDomain } from "../company/normalize";

export type CompanyCanonicalizer = (name: string, domain?: string | null) => string;

/**
 * Build a resolver over ONE snapshot of the workspace's companies — imports
 * canonicalize hundreds of rows and must not pay two queries per row.
 */
export async function buildCompanyCanonicalizer(workspaceId: number): Promise<CompanyCanonicalizer> {
  const passthrough: CompanyCanonicalizer = (name) => name;
  try {
    const db = await getDb();
    if (!db) return passthrough;

    const accRows = await db
      .select({ name: accounts.name, domain: accounts.domain })
      .from(accounts)
      .where(eq(accounts.workspaceId, workspaceId))
      .limit(500);
    const prospectRows = await db
      .select({ company: prospects.company, n: sql<number>`count(*)` })
      .from(prospects)
      .where(and(eq(prospects.workspaceId, workspaceId), isNotNull(prospects.company), ne(prospects.company, "")))
      .groupBy(prospects.company)
      .orderBy(sql`count(*) desc`)
      .limit(500);

    const accByDomain = new Map<string, string>();
    const accByName = new Map<string, string>();
    for (const a of accRows) {
      const display = a.name?.trim();
      if (!display) continue;
      const d = normalizeDomain(a.domain);
      if (d && !accByDomain.has(d)) accByDomain.set(d, display);
      const n = normalizeCompanyName(a.name);
      if (n && !accByName.has(n)) accByName.set(n, display);
    }
    // prospectRows arrive most-common-first, so first write per identity wins.
    const prospectByName = new Map<string, string>();
    for (const r of prospectRows) {
      const display = r.company?.trim();
      if (!display) continue;
      const n = normalizeCompanyName(r.company);
      if (n && !prospectByName.has(n)) prospectByName.set(n, display);
    }

    return (name, domain) => {
      const norm = normalizeCompanyName(name);
      if (!norm) return name;
      const dom = normalizeDomain(domain);
      if (dom && accByDomain.has(dom)) return accByDomain.get(dom)!;
      return accByName.get(norm) ?? prospectByName.get(norm) ?? name;
    };
  } catch {
    return passthrough;
  }
}

/** Single-name convenience over a fresh snapshot (enrichment events). */
export async function canonicalCompanyNameForWorkspace(
  workspaceId: number,
  name: string,
  domain?: string | null,
): Promise<string> {
  const resolve = await buildCompanyCanonicalizer(workspaceId);
  return resolve(name, domain);
}
