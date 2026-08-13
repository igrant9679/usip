/**
 * Adopt brand-directory NAME matches into empty account domains
 * (owner directive 2026-08-13: "piece domains together from company names that
 * exist on the contact record, LinkedIn, QuickEnrich, and/or pulling the URL
 * from Brandfetch or the web if necessary").
 *
 * The reconciler already searches Brandfetch and stores what it saw, but by
 * the owner's earlier spec a name-only hit is capped below the auto band and
 * so writes NOTHING: with no domain on the account there is nothing for a hit
 * to be domain-exact against, and the account's own records must corroborate
 * before a domain is written. Measured on live data that gate leaves 706 of
 * 709 domain-less accounts unresolvable — only 3 have contacts that could
 * ever corroborate.
 *
 * This module is the deliberate, LOWER-trust path the owner asked for, and it
 * is careful about the difference:
 *
 *  - It never touches `brand_verified_at`. A name match is not a verified
 *    identity, and the reconciler's meaning is left intact.
 *  - It writes through the account ledger at `brandSearchName` (60), BELOW
 *    the `preexisting` baseline and below every evidence source. It fills a
 *    blank; it can never displace something we actually know.
 *  - Any later real evidence overrides it silently and correctly — which
 *    matters, because a name match can be wrong: Brandfetch's best hit for
 *    "aarp" is aarp.info, while AARP is really aarp.org.
 *  - Fuzzy hits are refused outright. Only `name_exact` (the 80–94 band) is
 *    adopted; a 60–79 fuzzy guess is not worth poisoning a record for.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { accounts, brandObservations, organizationEnrichmentEvents } from "../../../drizzle/schema";
import { normalizeDomain } from "./normalize";
import { faviconUrlForDomain } from "./logoService";
import { mergeAccountField, type AccountProvenanceMap } from "./accountProvenance";
import { BRAND_PROVIDER, BRAND_THRESHOLDS } from "./brandReconciler";
import { CONFIDENCE } from "../enrichment/fieldMerge";

export interface DomainAdoptSummary {
  examined: number;
  filled: number;
  /** Had an observation, but it was fuzzy/domainless/too weak to adopt. */
  rejected: number;
  /** The ledger declined it — something stronger already holds the field. */
  heldByStronger: number;
}

/** Adopt stored brand observations into empty domains for ONE workspace. */
export async function adoptBrandDomains(
  workspaceId: number,
  opts: { limit?: number } = {},
): Promise<DomainAdoptSummary> {
  const summary: DomainAdoptSummary = { examined: 0, filled: 0, rejected: 0, heldByStronger: 0 };
  const db = await getDb();
  if (!db) return summary;

  const targets = await db
    .select({ id: accounts.id, name: accounts.name, domain: accounts.domain, websiteUrl: accounts.websiteUrl, logoUrl: accounts.logoUrl, logoStatus: accounts.logoStatus, fieldProvenance: accounts.fieldProvenance, brandOverride: accounts.brandOverride, globalOrganizationId: accounts.globalOrganizationId })
    .from(accounts)
    .where(and(
      eq(accounts.workspaceId, workspaceId),
      isNull(accounts.archivedAt),
      or(isNull(accounts.domain), sql`${accounts.domain} = ''`),
    ))
    .limit(opts.limit ?? 1000);
  if (targets.length === 0) return summary;

  // Latest observation per account, one query for the whole batch.
  const latest = new Map<number, { domain: string | null; confidence: number | null; basis: string | null }>();
  const obs = await db
    .select({ accountId: brandObservations.accountId, normalizedDomain: brandObservations.normalizedDomain, matchConfidence: brandObservations.matchConfidence, matchBasis: brandObservations.matchBasis, observedAt: brandObservations.observedAt })
    .from(brandObservations)
    .where(and(
      eq(brandObservations.workspaceId, workspaceId),
      eq(brandObservations.provider, BRAND_PROVIDER),
      inArray(brandObservations.accountId, targets.map((t) => t.id)),
    ))
    .orderBy(desc(brandObservations.observedAt));
  for (const o of obs) {
    if (!latest.has(o.accountId)) latest.set(o.accountId, { domain: o.normalizedDomain, confidence: o.matchConfidence, basis: o.matchBasis });
  }

  const nowIso = new Date().toISOString();
  for (const acct of targets) {
    const seen = latest.get(acct.id);
    if (!seen) continue; // never searched — the sweep's job, not ours
    summary.examined++;

    const domain = normalizeDomain(seen.domain);
    // Only an exact NAME match earns adoption. Fuzzy hits and answers with no
    // domain are not evidence, they are noise.
    if (!domain || seen.basis !== "name_exact" || (seen.confidence ?? 0) < BRAND_THRESHOLDS.corroborated) {
      summary.rejected++;
      continue;
    }
    // An owner pin on `domain` is final, whatever the directory says.
    const overridden = Object.keys((acct.brandOverride ?? {}) as Record<string, unknown>);
    if (overridden.includes("domain")) { summary.heldByStronger++; continue; }

    const ledger = { ...((acct.fieldProvenance ?? {}) as AccountProvenanceMap) };
    const decision = mergeAccountField(
      "domain",
      { value: acct.domain, provenance: ledger.domain },
      { value: domain, source: "brand_search", confidence: CONFIDENCE.brandSearchName, at: nowIso },
    );
    if (decision.action !== "filled" && decision.action !== "replaced") { summary.heldByStronger++; continue; }

    ledger.domain = decision.provenance;
    const patch: Record<string, unknown> = {
      domain: decision.value.slice(0, 200),
      normalizedDomain: normalizeDomain(decision.value),
      fieldProvenance: ledger,
    };
    if (!acct.websiteUrl) patch.websiteUrl = `https://${decision.value}`;
    // An icon the moment a domain exists — the whole point of the exercise.
    if (!acct.logoUrl || acct.logoStatus !== "available") {
      const fav = faviconUrlForDomain(decision.value);
      if (fav) {
        patch.logoUrl = fav;
        patch.logoSourceType = "website_favicon";
        patch.logoStatus = "available";
        patch.logoLastVerifiedAt = new Date();
      }
    }
    await db.update(accounts).set(patch as never)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, acct.id)));

    await db.insert(organizationEnrichmentEvents).values({
      workspaceId, accountId: acct.id, globalOrganizationId: acct.globalOrganizationId ?? null,
      sourceVendor: "brandfetch", sourceType: "company_identification",
      status: "enriched", fieldsUpdated: ["domain"],
    } as never);
    summary.filled++;
  }
  return summary;
}
