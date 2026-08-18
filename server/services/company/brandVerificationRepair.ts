/**
 * Repair brand verifications the reconciler stamped on its own guesses
 * (2026-08-18; see brandReconciler.ts header, INDEPENDENCE).
 *
 * The signature of a laundered verification is: `brand_verified_at` is set
 * AND the account's domain ledger says the PROVIDER supplied the domain
 * (`brand_search` from domainAdopt, or `brandfetch` from a reconcile). Such
 * an account was verified by domain_exact against its own adopted domain,
 * or "corroborated" by the websiteUrl adopt wrote alongside it.
 *
 * For each, re-decide from the LATEST stored observation — the same hit the
 * verification came from — with provider-sourced evidence stripped and the
 * corroborators read the corrected way (People + Contacts mailboxes, plus a
 * websiteUrl only when it is not the mirrored guess). No new search: the
 * question is whether the evidence we hold supports the stamp, not what the
 * provider says today.
 *
 *  - decision.verified   → the account's own records corroborate the domain
 *                          (a person's mailbox, an independent website):
 *                          KEEP the stamp.
 *  - otherwise           → clear brand_verified_at (and brandConfidence to
 *                          the re-decided value); the reconciler's next pass
 *                          re-earns it or leaves it a candidate. The domain
 *                          itself is NOT touched — it stays a guess with its
 *                          ledger confidence, exactly as adopt left it, and
 *                          the matcher already treats an unverified domain
 *                          as one that cannot veto a name match.
 *
 * Dry run by default; `apply` must be passed. Every change is written to
 * organization_enrichment_events so the account's history shows it.
 */
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "../../db";
import { accounts, brandObservations, organizationEnrichmentEvents } from "../../../drizzle/schema";
import {
  BRAND_PROVIDER, PROVIDER_SOURCES, providerIndependentEvidence, pickBestHit, decideBrandReconcile,
  corroboratorDomainsFor, type BrandOverride,
} from "./brandReconciler";
import type { BrandSearchHit } from "../brand/brandfetch";

export interface BrandVerificationRepairPlan {
  applied: boolean;
  /** Verified accounts whose domain the provider supplied. */
  examined: number;
  /** Their own records (mailbox / independent website) still corroborate. */
  kept: number;
  /** Stamp cleared (or would be). */
  unverified: number;
  /** No stored observation to re-decide from — left alone, listed. */
  noObservation: number;
  sample: Array<{ accountId: number; name: string; domain: string | null; hitDomain: string | null; corroborators: string[]; outcome: "kept" | "unverified" | "no_observation" }>;
}

/** Pure: re-decide one account from its stored observation. Exported for tests. */
export function redecideFromObservation(
  acc: { name: string; domain: string | null; websiteUrl: string | null; legalName: string | null; brandOverride: BrandOverride | null; fieldProvenance: unknown },
  obs: { rawName: string | null; rawDomain: string | null; claimed: boolean } | null,
  corroboratorsIndependent: string[],
): { verified: boolean; confidence: number; hitDomain: string | null } {
  if (!obs) return { verified: false, confidence: 0, hitDomain: null };
  const indep = providerIndependentEvidence(acc);
  const hit: BrandSearchHit = { name: obs.rawName, domain: obs.rawDomain, icon: null, brandId: null, claimed: obs.claimed };
  const scored = pickBestHit({ name: acc.name, domain: indep.domain }, [hit]);
  const decision = decideBrandReconcile(
    { name: acc.name, domain: indep.domain, legalName: acc.legalName, brandOverride: acc.brandOverride },
    scored,
    corroboratorsIndependent,
  );
  return { verified: decision.verified, confidence: decision.brandConfidence, hitDomain: scored?.hit.domain ?? null };
}

export async function repairBrandVerifications(
  workspaceId: number,
  opts: { apply?: boolean; limit?: number } = {},
): Promise<BrandVerificationRepairPlan> {
  const plan: BrandVerificationRepairPlan = { applied: false, examined: 0, kept: 0, unverified: 0, noObservation: 0, sample: [] };
  const db = await getDb();
  if (!db) return plan;

  const rows = await db
    .select({
      id: accounts.id, name: accounts.name, domain: accounts.domain, websiteUrl: accounts.websiteUrl,
      legalName: accounts.legalName, brandOverride: accounts.brandOverride, fieldProvenance: accounts.fieldProvenance,
      globalOrganizationId: accounts.globalOrganizationId,
    })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), isNull(accounts.archivedAt), isNotNull(accounts.brandVerifiedAt)))
    .limit(opts.limit ?? 5000);

  const suspects = rows.filter((r) => {
    const src = ((r.fieldProvenance ?? {}) as { domain?: { source?: string } }).domain?.source;
    return !!src && PROVIDER_SOURCES.has(src);
  });
  plan.examined = suspects.length;
  if (suspects.length === 0) return plan;

  // Latest provider observation per suspect.
  const obsById = new Map<number, { rawName: string | null; rawDomain: string | null; claimed: boolean }>();
  const ids = suspects.map((s) => s.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const obs = await db
      .select({ accountId: brandObservations.accountId, rawName: brandObservations.rawName, rawDomain: brandObservations.rawDomain, claimed: brandObservations.claimed, observedAt: brandObservations.observedAt })
      .from(brandObservations)
      .where(and(eq(brandObservations.workspaceId, workspaceId), eq(brandObservations.provider, BRAND_PROVIDER), inArray(brandObservations.accountId, chunk)))
      .orderBy(desc(brandObservations.observedAt));
    for (const o of obs) if (!obsById.has(o.accountId)) obsById.set(o.accountId, { rawName: o.rawName, rawDomain: o.rawDomain, claimed: !!o.claimed });
  }

  const toClear: Array<{ id: number; confidence: number; globalOrganizationId: number | null; note: string }> = [];
  for (const a of suspects) {
    const obs = obsById.get(a.id) ?? null;
    const indep = providerIndependentEvidence(a);
    const corroborators = await corroboratorDomainsFor(workspaceId, a.id, indep.websiteUrl);
    const r = redecideFromObservation(
      { name: a.name, domain: a.domain, websiteUrl: a.websiteUrl, legalName: a.legalName, brandOverride: (a.brandOverride ?? null) as BrandOverride | null, fieldProvenance: a.fieldProvenance },
      obs, corroborators,
    );
    const outcome: "kept" | "unverified" | "no_observation" = !obs ? "no_observation" : r.verified ? "kept" : "unverified";
    if (outcome === "kept") plan.kept++;
    else if (outcome === "no_observation") plan.noObservation++;
    else {
      plan.unverified++;
      toClear.push({ id: a.id, confidence: r.confidence, globalOrganizationId: a.globalOrganizationId ?? null, note: `verified against provider-sourced domain ${a.domain}; hit ${r.hitDomain ?? "—"}; corroborators [${corroborators.join(", ")}]` });
    }
    if (plan.sample.length < 60) plan.sample.push({ accountId: a.id, name: a.name, domain: a.domain, hitDomain: r.hitDomain, corroborators, outcome });
  }

  if (!opts.apply || toClear.length === 0) return plan;
  plan.applied = true;
  for (const c of toClear) {
    await db.update(accounts)
      .set({ brandVerifiedAt: null, brandConfidence: c.confidence } as never)
      .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, c.id)));
    await db.insert(organizationEnrichmentEvents).values({
      workspaceId, accountId: c.id, globalOrganizationId: c.globalOrganizationId,
      sourceVendor: BRAND_PROVIDER, sourceType: "brand_reconcile", status: "unverified",
      fieldsUpdated: ["brandVerifiedAt"],
      rawSummary: { reason: "self-corroboration repair 2026-08-18", note: c.note },
    } as never);
  }
  return plan;
}
