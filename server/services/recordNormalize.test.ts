/**
 * recordNormalize rewrites CRM data in bulk on every save path, so most of
 * these cases exist to prove RESTRAINT: representation is corrected, meaning
 * is never touched, and intentional casing survives.
 */
import { describe, it, expect } from "vitest";
import {
  canonicalizeCompanyDisplayName,
  cleanPlaceholder,
  normalizeJobTitle,
  parseLinkedInLocation,
} from "./enrichment/recordNormalize";

describe("cleanPlaceholder — QC junk gate", () => {
  it("nulls the classic import placeholders", () => {
    for (const junk of ["N/A", "n/a", "none", "NULL", "-", "--", "unknown", "TBD", "  "]) {
      expect(cleanPlaceholder(junk)).toBeNull();
    }
  });
  it("collapses whitespace on real values", () => {
    expect(cleanPlaceholder("  Acme   Corp  ")).toBe("Acme Corp");
  });
});

describe("canonicalizeCompanyDisplayName", () => {
  it("repairs informationless casing", () => {
    expect(canonicalizeCompanyDisplayName("ACME HOLDINGS CORP")).toBe("Acme Holdings Corp.");
    expect(canonicalizeCompanyDisplayName("acme holdings")).toBe("Acme Holdings");
  });

  it("keeps short all-caps tokens — acronym odds beat word odds", () => {
    expect(canonicalizeCompanyDisplayName("MSA HEALTHCARE")).toBe("MSA Healthcare");
    expect(canonicalizeCompanyDisplayName("IBM CONSULTING")).toBe("IBM Consulting");
  });

  it("treats mixed-case input as intentional", () => {
    expect(canonicalizeCompanyDisplayName("eBay Inc.")).toBe("eBay Inc.");
    expect(canonicalizeCompanyDisplayName("McKinsey & Company")).toBe("McKinsey & Company");
    expect(canonicalizeCompanyDisplayName("Perfusion Medical, Inc.")).toBe("Perfusion Medical, Inc.");
  });

  it("standardizes legal-suffix spelling without adding or removing one", () => {
    expect(canonicalizeCompanyDisplayName("Acme inc")).toBe("Acme Inc.");
    expect(canonicalizeCompanyDisplayName("Lifecycle Construction Services, llc")).toBe("Lifecycle Construction Services, LLC");
    expect(canonicalizeCompanyDisplayName("Thornbury ltd")).toBe("Thornbury Ltd.");
    // No suffix → none invented.
    expect(canonicalizeCompanyDisplayName("Avalon Foundation")).toBe("Avalon Foundation");
  });

  it("fixes punctuation spacing", () => {
    expect(canonicalizeCompanyDisplayName("Acme ,Inc.")).toBe("Acme, Inc.");
    expect(canonicalizeCompanyDisplayName("Acme,Inc.")).toBe("Acme, Inc.");
    expect(canonicalizeCompanyDisplayName('"Acme Corp."')).toBe("Acme Corp.");
  });

  it("small words stay small mid-name", () => {
    expect(canonicalizeCompanyDisplayName("BANK OF THE WEST")).toBe("Bank of the West");
  });

  it("junk in, null out", () => {
    expect(canonicalizeCompanyDisplayName("n/a")).toBeNull();
    expect(canonicalizeCompanyDisplayName("")).toBeNull();
  });
});

describe("normalizeJobTitle", () => {
  it("repairs informationless casing with role acronyms intact", () => {
    expect(normalizeJobTitle("VICE PRESIDENT OF OPERATIONS")).toBe("Vice President of Operations");
    expect(normalizeJobTitle("vp of sales")).toBe("VP of Sales");
    expect(normalizeJobTitle("chief financial officer")).toBe("Chief Financial Officer");
  });

  it("fixes acronym casing even in otherwise-intentional input", () => {
    expect(normalizeJobTitle("Vp of Sales")).toBe("VP of Sales");
    expect(normalizeJobTitle("Ceo")).toBe("CEO");
    expect(normalizeJobTitle("Svp, Business Operations")).toBe("SVP, Business Operations");
  });

  it("never rewrites words — meaning and seniority are untouchable", () => {
    expect(normalizeJobTitle("VP Sales")).toBe("VP Sales"); // not "Vice President of Sales"
    expect(normalizeJobTitle("Senior Vice President of Business Operations"))
      .toBe("Senior Vice President of Business Operations");
  });

  it("strips trailing separator noise", () => {
    expect(normalizeJobTitle("VP of Sales |")).toBe("VP of Sales");
    expect(normalizeJobTitle("Director -")).toBe("Director");
  });

  it("junk in, null out", () => {
    expect(normalizeJobTitle("N/A")).toBeNull();
  });
});

describe("parseLinkedInLocation", () => {
  it("splits the three-segment form", () => {
    expect(parseLinkedInLocation("Austin, Texas, United States"))
      .toEqual({ city: "Austin", state: "Texas", country: "United States" });
  });
  it("two segments: city + country", () => {
    expect(parseLinkedInLocation("London, United Kingdom"))
      .toEqual({ city: "London", state: null, country: "United Kingdom" });
  });
  it("one segment lands in city verbatim", () => {
    expect(parseLinkedInLocation("Greater Boston"))
      .toEqual({ city: "Greater Boston", state: null, country: null });
  });
  it("four segments keep the last as country", () => {
    expect(parseLinkedInLocation("Brooklyn, New York, New York, United States"))
      .toEqual({ city: "Brooklyn", state: "New York", country: "United States" });
  });
  it("junk in, all-null out", () => {
    expect(parseLinkedInLocation("n/a")).toEqual({ city: null, state: null, country: null });
  });
});
