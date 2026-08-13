/**
 * URL-as-name account repair (owner ask 2026-08-13: "all companies have the
 * proper URLs attached... and icons").
 *
 * A historic import wrote social-profile URLs into account NAMES —
 * "https://facebook.com/fanatics" as the company name. Those can never
 * match a Brandfetch search, never resolve a domain, never show an icon.
 * The pure helpers here were built (and dry-run-calibrated on live data)
 * for the old dataCleanup router and are recovered from its history —
 * the router died with the paid-Apollo removal; the LOGIC was sound.
 *
 *  - name:   "https://facebook.com/fanatics" → "fanatics" (lowercase slug,
 *            honest — casing is not invented)
 *  - domain: only when the URL is the company's OWN site. A social host
 *            ("facebook.com") is never written: a wrong domain poisons
 *            matching, linking, and email-pattern enrichment; an empty one
 *            just waits for the reconciler.
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { accounts } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { normalizedAccountFields } from "./normalize";

/**
 * Hosts that identify a social/profile site, never the company's own domain.
 * The leading boundary is load-bearing: unanchored, the `x` alternative makes
 * "netflix.com", "equifax.com" and every other company whose name ends in x
 * read as a social host — their real domain would be silently discarded.
 * `(?:^|\.)` keeps the subdomain forms ("uk.linkedin.com") matching.
 */
const SOCIAL_HOST = /(?:^|\.)(facebook|linkedin|twitter|instagram|youtube|crunchbase|x)\.com$/i;

export function companyDomainFromUrl(url?: string | null): string | null {
  const s = (url ?? "").trim();
  if (!s) return null;
  const host = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0]?.toLowerCase();
  if (!host || !host.includes(".")) return null;
  if (SOCIAL_HOST.test(host)) return null;
  return host.slice(0, 200);
}

/** Does this look like a URL rather than a company name? */
export function looksLikeUrl(value?: string | null): boolean {
  const s = (value ?? "").trim();
  if (!s) return false;
  return /^https?:\/\//i.test(s) || /^www\./i.test(s) || /^[a-z0-9-]+\.[a-z]{2,}(\/|$)/i.test(s);
}

/** Best-effort company name from a URL. "https://facebook.com/mongodb" → "mongodb". */
export function companyFromUrl(url?: string | null): string | null {
  const s = (url ?? "").trim();
  if (!s) return null;
  const cleaned = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  // Same boundary rule as SOCIAL_HOST — unanchored, "netflix.com/jobs" would
  // be read as a profile URL and named "jobs".
  const SOCIAL = /(?:^|\.)(facebook|linkedin|twitter|x|instagram|youtube|crunchbase)\./i;
  if (parts.length > 1 && SOCIAL.test(parts[0])) {
    const slug = parts[parts.length - 1].replace(/^(company|in|pages)$/i, "");
    return slug ? slug.replace(/[-_]+/g, " ").trim().slice(0, 200) || null : null;
  }
  const host = parts[0];
  const label = host.split(".")[0];
  return label ? label.replace(/[-_]+/g, " ").trim().slice(0, 200) || null : null;
}

export interface UrlNameRepairSummary {
  scanned: number;
  renamed: number;
  domainsDerived: number;
  skippedOverride: number;
}

/**
 * Repair every account in a workspace whose NAME is a URL. Idempotent (a
 * repaired name no longer looks like a URL); brand-pinned accounts are never
 * touched — an override is the owner's word. The original URL is preserved
 * in websiteUrl when it was the company's own site and that field was empty.
 */
export async function repairUrlNamedAccounts(workspaceId: number): Promise<UrlNameRepairSummary> {
  const summary: UrlNameRepairSummary = { scanned: 0, renamed: 0, domainsDerived: 0, skippedOverride: 0 };
  const db = await getDb();
  if (!db) return summary;

  const rows = await db
    .select({ id: accounts.id, name: accounts.name, domain: accounts.domain, websiteUrl: accounts.websiteUrl, brandOverride: accounts.brandOverride })
    .from(accounts)
    .where(and(
      eq(accounts.workspaceId, workspaceId),
      isNull(accounts.archivedAt),
      // Cheap SQL prefilter; looksLikeUrl is the real judge below.
      or(sql`${accounts.name} LIKE 'http%'`, sql`${accounts.name} LIKE 'www.%'`),
    ))
    .limit(1000);

  for (const a of rows) {
    if (!looksLikeUrl(a.name)) continue;
    summary.scanned++;
    if (a.brandOverride) { summary.skippedOverride++; continue; }
    const newName = companyFromUrl(a.name);
    if (!newName) continue;
    const ownDomain = companyDomainFromUrl(a.name);
    const patch: Record<string, unknown> = {
      name: newName,
      ...normalizedAccountFields(newName, ownDomain ?? a.domain ?? null),
      // A brand identity derived from a URL slug is a guess the reconciler
      // should re-examine — clear the verification stamp so the next sweep
      // picks the account up with its NEW, searchable name.
      brandVerifiedAt: null,
    };
    if (ownDomain && !a.domain) { patch.domain = ownDomain; summary.domainsDerived++; }
    if (ownDomain && !a.websiteUrl) patch.websiteUrl = a.name.trim();
    await db.update(accounts).set(patch as never)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, a.id)));
    summary.renamed++;
  }
  return summary;
}
