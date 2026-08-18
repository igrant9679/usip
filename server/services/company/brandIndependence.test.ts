/**
 * The self-corroboration loop (2026-08-18) and its repair, through the REAL
 * pure functions: providerIndependentEvidence → pickBestHit →
 * decideBrandReconcile, and redecideFromObservation on top of them.
 *
 * The loop: a name-only hit is stored as a candidate; domainAdopt fills the
 * empty domain from it at 60 (and sets websiteUrl to it); the next pass
 * scores the same hit domain_exact against that adopted domain and stamps
 * brand_verified_at. "Triumph Academy" was verified at an Australian school
 * that way, "Golden Bridge" in Vietnam, "Arena Hall" in Belarus.
 */
import { describe, it, expect } from "vitest";
import { providerIndependentEvidence, pickBestHit, decideBrandReconcile, BRAND_THRESHOLDS } from "./brandReconciler";
import { redecideFromObservation } from "./brandVerificationRepair";
import type { BrandSearchHit } from "../brand/brandfetch";

const hit = (name: string, domain: string, claimed = false): BrandSearchHit => ({ name, domain, icon: null, brandId: null, claimed });

const adopted = {
  name: "Triumph Academy",
  domain: "triumphacademy.com.au",
  websiteUrl: "https://triumphacademy.com.au",
  legalName: null,
  brandOverride: null,
  fieldProvenance: { domain: { source: "brand_search", confidence: 60, at: "2026-08-14T00:00:00Z" } },
};

describe("providerIndependentEvidence", () => {
  it("strips a provider-sourced domain AND the websiteUrl that mirrors it", () => {
    expect(providerIndependentEvidence(adopted)).toEqual({ domain: null, websiteUrl: null, domainDependent: true });
  });
  it("keeps a websiteUrl that does not mirror the dependent domain (it came from somewhere else)", () => {
    const e = providerIndependentEvidence({ ...adopted, websiteUrl: "https://www.triumphyouthservices.com" });
    expect(e).toEqual({ domain: null, websiteUrl: "https://www.triumphyouthservices.com", domainDependent: true });
  });
  it("leaves an imported / pre-existing / user domain alone", () => {
    for (const source of ["preexisting", "user", "linkedin", "prospect_import", undefined]) {
      const e = providerIndependentEvidence({ domain: "marquette.edu", websiteUrl: "https://marquette.edu", fieldProvenance: source ? { domain: { source } } : {} });
      expect(e).toEqual({ domain: "marquette.edu", websiteUrl: "https://marquette.edu", domainDependent: false });
    }
  });
  it("a reconcile-written (brandfetch) domain is provider-sourced too", () => {
    const e = providerIndependentEvidence({ ...adopted, fieldProvenance: { domain: { source: "brandfetch", confidence: 88 } } });
    expect(e.domainDependent).toBe(true);
  });
});

describe("the loop no longer verifies", () => {
  it("same hit against the adopted domain scores name-only, and without corroboration stays a candidate", () => {
    const indep = providerIndependentEvidence(adopted);
    const scored = pickBestHit({ name: adopted.name, domain: indep.domain }, [hit("Triumph Academy", "triumphacademy.com.au", true)]);
    expect(scored?.basis).toBe("name_exact");
    expect(scored!.confidence).toBeLessThan(BRAND_THRESHOLDS.auto);
    const d = decideBrandReconcile({ name: adopted.name, domain: indep.domain, legalName: null, brandOverride: null }, scored, /* corroborators */ []);
    expect(d.action).toBe("candidate");
    expect(d.verified).toBe(false);
  });

  it("…but a PERSON's mailbox at the hit's domain corroborates it honestly", () => {
    const indep = providerIndependentEvidence(adopted);
    const scored = pickBestHit({ name: adopted.name, domain: indep.domain }, [hit("Triumph Academy", "triumphacademy.com.au")]);
    const d = decideBrandReconcile({ name: adopted.name, domain: indep.domain, legalName: null, brandOverride: null }, scored, ["triumphacademy.com.au"]);
    expect(d.action).toBe("corroborated");
    expect(d.verified).toBe(true);
  });

  it("a corroborated hit at a DIFFERENT domain may replace the provider's earlier guess", () => {
    // People at triumphyouthservices.com; provider now returns that brand.
    const indep = providerIndependentEvidence(adopted);
    const scored = pickBestHit({ name: adopted.name, domain: indep.domain }, [hit("Triumph Academy", "triumphyouthservices.com")]);
    const d = decideBrandReconcile({ name: adopted.name, domain: indep.domain, legalName: null, brandOverride: null }, scored, ["triumphyouthservices.com"]);
    expect(d.verified).toBe(true);
    expect(d.changes.domain).toBe("triumphyouthservices.com"); // the ledger (60 → 88) lets it through
  });

  it("an independent domain still verifies by domain_exact as before", () => {
    const acc = { name: "Marquette University", domain: "marquette.edu", websiteUrl: null, fieldProvenance: { domain: { source: "preexisting" } } };
    const indep = providerIndependentEvidence(acc);
    const scored = pickBestHit({ name: acc.name, domain: indep.domain }, [hit("Marquette University", "marquette.edu")]);
    expect(scored?.basis).toBe("domain_exact");
    const d = decideBrandReconcile({ name: acc.name, domain: indep.domain, legalName: null, brandOverride: null }, scored, []);
    expect(d.action).toBe("applied");
    expect(d.verified).toBe(true);
  });
});

describe("redecideFromObservation (the repair's core)", () => {
  it("un-verifies a laundered stamp: adopted domain, same stored hit, no independent corroborator", () => {
    const r = redecideFromObservation(adopted, { rawName: "Triumph Academy", rawDomain: "triumphacademy.com.au", claimed: true }, []);
    expect(r.verified).toBe(false);
    expect(r.hitDomain).toBe("triumphacademy.com.au");
  });
  it("keeps a stamp a person's mailbox corroborates", () => {
    const r = redecideFromObservation(adopted, { rawName: "Triumph Academy", rawDomain: "triumphacademy.com.au", claimed: true }, ["triumphacademy.com.au"]);
    expect(r.verified).toBe(true);
  });
  it("no stored observation → not verified, nothing to reason from", () => {
    expect(redecideFromObservation(adopted, null, ["triumphacademy.com.au"]).verified).toBe(false);
  });
});
