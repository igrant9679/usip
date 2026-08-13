/**
 * Brand-name domain adoption (owner directive 2026-08-13). The rules that make
 * this safe are the ones worth pinning: it fills blanks only, it is weaker
 * than anything we actually know, and it refuses fuzzy guesses.
 *
 * The merge decisions are exercised through the REAL mergeAccountField — the
 * thing the module calls — rather than a restatement of its logic, so this
 * cannot pass while the shipped merge disagrees.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mergeAccountField } from "./services/company/accountProvenance";
import { CONFIDENCE } from "./services/enrichment/fieldMerge";

const AT = "2026-08-13T17:00:00.000Z";
const brand = (value: string) => ({ value, source: "brand_search", confidence: CONFIDENCE.brandSearchName, at: AT });

describe("a brand-name domain is the weakest thing in the vocabulary", () => {
  it("sits below the preexisting baseline and every evidence source", () => {
    expect(CONFIDENCE.brandSearchName).toBeLessThan(CONFIDENCE.preexisting);
    expect(CONFIDENCE.brandSearchName).toBeLessThan(CONFIDENCE.emailDomain);
    expect(CONFIDENCE.brandSearchName).toBeLessThan(CONFIDENCE.linkedinProfile);
    expect(CONFIDENCE.brandSearchName).toBeLessThan(CONFIDENCE.quickenrichVerified);
    expect(CONFIDENCE.brandSearchName).toBeLessThan(CONFIDENCE.user);
  });

  it("fills an empty domain", () => {
    const d = mergeAccountField("domain", { value: null }, brand("siriusxm.com"));
    expect(d.action).toBe("filled");
    expect(d.value).toBe("siriusxm.com");
  });

  it("never displaces a domain we already hold, even a legacy one", () => {
    const d = mergeAccountField(
      "domain",
      { value: "aarp.org", provenance: { source: "crm", confidence: CONFIDENCE.preexisting, at: "2026-01-01T00:00:00.000Z" } },
      brand("aarp.info"),
    );
    expect(d.action).not.toBe("replaced");
    expect(d.value).toBe("aarp.org");
  });

  it("YIELDS to real evidence that arrives later — the aarp.info correction", () => {
    // Brandfetch's best hit for "aarp" is aarp.info; AARP is really aarp.org.
    // A prospect's own business email is what puts that right.
    const adopted = mergeAccountField("domain", { value: null }, brand("aarp.info"));
    expect(adopted.action).toBe("filled");
    const corrected = mergeAccountField(
      "domain",
      { value: adopted.value, provenance: adopted.provenance },
      { value: "aarp.org", source: "email_domain", confidence: CONFIDENCE.emailDomain, at: "2026-08-14T00:00:00.000Z" },
    );
    expect(corrected.action).toBe("replaced");
    expect(corrected.value).toBe("aarp.org");
  });
});

describe("adoption refuses everything that isn't an exact name match", () => {
  const src = readFileSync("server/services/company/domainAdopt.ts", "utf8");

  it("requires name_exact at or above the corroborated band", () => {
    expect(src).toContain('seen.basis !== "name_exact"');
    expect(src).toContain("< BRAND_THRESHOLDS.corroborated");
  });

  it("never stamps brand_verified_at — a name match is not a verified identity", () => {
    expect(src).not.toContain("brandVerifiedAt");
  });

  it("honours an owner pin on the domain", () => {
    expect(src).toContain('overridden.includes("domain")');
  });
});
