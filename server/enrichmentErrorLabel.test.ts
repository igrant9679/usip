/**
 * describeEnrichmentError — the stored machine reason vs what a person reads
 * (owner ask 2026-08-19: "quickenrich: no_match" → "Not in QuickEnrich", brown).
 */
import { describe, it, expect } from "vitest";
import { describeEnrichmentError, ENRICHMENT_TONE_CLASS } from "../shared/enrichmentErrorLabel";

describe("describeEnrichmentError", () => {
  it("no_match in QuickEnrich is information, not a fault", () => {
    expect(describeEnrichmentError("quickenrich: no_match")).toEqual({ label: "Not in QuickEnrich", tone: "info" });
    expect(describeEnrichmentError("QuickEnrich: NO_MATCH")).toEqual({ label: "Not in QuickEnrich", tone: "info" });
    expect(ENRICHMENT_TONE_CLASS.info).toContain("#8B5A2B"); // brown, not red
  });
  it("a transient QuickEnrich transport failure reads as transient", () => {
    expect(describeEnrichmentError("quickenrich: timeout — transport failure, will retry")).toEqual({ label: "QuickEnrich unavailable — will retry", tone: "warn" });
  });
  it("other QuickEnrich reasons are named, other errors stay red verbatim", () => {
    expect(describeEnrichmentError("quickenrich: rate_limited")).toEqual({ label: "QuickEnrich: rate limited", tone: "warn" });
    expect(describeEnrichmentError("LinkedIn profile unavailable")).toEqual({ label: "LinkedIn profile unavailable", tone: "error" });
    expect(describeEnrichmentError("")).toBeNull();
    expect(describeEnrichmentError(null)).toBeNull();
  });
});
