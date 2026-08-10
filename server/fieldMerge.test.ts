import { describe, it, expect } from "vitest";
import { CONFIDENCE, mergeField, mergeAll, normalizeForCompare } from "./services/enrichment/fieldMerge";

/**
 * The reconciliation rules the owner specified, as executable facts:
 * combine partial data, reconcile conflicts by source quality + recency +
 * cross-source agreement, preserve provenance, and never overwrite
 * higher-confidence data with weaker information.
 */
const at = (s: string) => `${s}T00:00:00.000Z`;

describe("mergeField — the reconciliation rules", () => {
  it("fills an empty field from any source, recording provenance", () => {
    const d = mergeField({ value: null }, { field: "company", value: "Acme", source: "apollo", confidence: 75, at: at("2026-08-10") });
    expect(d.action).toBe("filled");
    expect(d.value).toBe("Acme");
    expect(d.provenance).toMatchObject({ source: "apollo", confidence: 75 });
  });

  it("weaker data NEVER overwrites stronger data", () => {
    const d = mergeField(
      { value: "Acme Corp", provenance: { source: "linkedin", confidence: 85, at: at("2026-08-01") } },
      { field: "company", value: "Acme Holdings", source: "apollo", confidence: 75, at: at("2026-08-10") },
    );
    expect(d.action).toBe("kept");
    expect(d.value).toBe("Acme Corp");
  });

  it("stronger data corrects weaker data", () => {
    const d = mergeField(
      { value: "Acme Holdings", provenance: { source: "apollo", confidence: 75, at: at("2026-08-01") } },
      { field: "company", value: "Acme Corp", source: "linkedin", confidence: 85, at: at("2026-08-10") },
    );
    expect(d.action).toBe("replaced");
    expect(d.value).toBe("Acme Corp");
    expect(d.previous?.value).toBe("Acme Holdings");
  });

  it("legacy values without a ledger get baseline protection — correctable by high-quality sources, safe from guesses", () => {
    const strong = mergeField({ value: "Old Co" }, { field: "company", value: "New Co", source: "linkedin", confidence: CONFIDENCE.linkedinProfile, at: at("2026-08-10") });
    expect(strong.action).toBe("replaced"); // 85 > 70 baseline
    const weak = mergeField({ value: "Old Co" }, { field: "company", value: "Guess Co", source: "headline_parse", confidence: CONFIDENCE.headlineParse, at: at("2026-08-10") });
    expect(weak.action).toBe("kept"); // 60 < 70 baseline
  });

  it("cross-source agreement raises confidence instead of churning the value", () => {
    const d = mergeField(
      { value: "acme.com", provenance: { source: "apollo", confidence: 75, at: at("2026-08-01") } },
      { field: "companyDomain", value: "https://www.acme.com/", source: "linkedin", confidence: 85, at: at("2026-08-10") },
    );
    expect(d.action).toBe("corroborated");
    expect(d.value).toBe("acme.com"); // original form kept
    expect(d.provenance.confidence).toBe(90); // max(75,85)+5
    expect(d.provenance.corroboratedBy).toContain("linkedin");
  });

  it("recency wins WITHIN a source at equal confidence — people change jobs", () => {
    const d = mergeField(
      { value: "VP Sales at Oldco", provenance: { source: "linkedin", confidence: 85, at: at("2026-01-01") } },
      { field: "title", value: "CRO at Newco", source: "linkedin", confidence: 85, at: at("2026-08-10") },
    );
    expect(d.action).toBe("replaced");
    expect(d.value).toBe("CRO at Newco");
  });

  it("a Reoon-valid email yields only to another Reoon-valid email", () => {
    const cur = { value: "jane@acme.com", provenance: { source: "pattern_reoon", confidence: 90, at: at("2026-08-01"), verification: "valid" } };
    const guess = mergeField(cur, { field: "email" as const, value: "jane.doe@acme.com", source: "quickenrich", confidence: 92, at: at("2026-08-10"), verification: "accept_all" });
    expect(guess.action).toBe("kept"); // higher confidence, but not `valid`
    const proven = mergeField(cur, { field: "email" as const, value: "jane.doe@acme.com", source: "quickenrich", confidence: 92, at: at("2026-08-10"), verification: "valid" });
    expect(proven.action).toBe("replaced");
  });
});

describe("normalizeForCompare — agreement isn't fooled by formatting", () => {
  it("domains: protocol, www, paths and case don't break agreement", () => {
    expect(normalizeForCompare("companyDomain", "https://WWW.Acme.com/about")).toBe("acme.com");
  });
  it("companies: legal suffixes and punctuation don't break agreement", () => {
    expect(normalizeForCompare("company", "Acme, Inc.")).toBe(normalizeForCompare("company", "acme"));
  });
});

describe("mergeAll — a pass's candidates settle in order", () => {
  it("later stronger candidates can replace earlier weaker winners in one pass", () => {
    const out = mergeAll(
      { company: null },
      {},
      [
        { field: "company", value: "Acme Holdings", source: "apollo", confidence: 75, at: at("2026-08-10") },
        { field: "company", value: "Acme Corp", source: "linkedin", confidence: 85, at: at("2026-08-10") },
      ],
    );
    expect(out.fields.company).toBe("Acme Corp");
    expect(out.ledger.company?.source).toBe("linkedin");
    expect(out.decisions.map((d) => d.action)).toEqual(["filled", "replaced"]);
  });
});
