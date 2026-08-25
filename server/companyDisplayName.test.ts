/**
 * normalizeCompanyDisplayName rewrites COMPANY NAMES, so — exactly like
 * personName.test.ts — half these cases exist to prove restraint. Live rows
 * from both workspaces seeded the examples (2026-08-25 survey: LSI carries
 * 331 lowercase URL-slug names; CF's shapeless set was one real acronym).
 */
import { describe, it, expect } from "vitest";
import { normalizeCompanyDisplayName } from "./services/company/normalize";

describe("normalizeCompanyDisplayName", () => {
  it("title-cases lowercase slug names (the LSI repair leftovers)", () => {
    expect(normalizeCompanyDisplayName("scuter")).toBe("Scuter");
    expect(normalizeCompanyDisplayName("argosidentity")).toBe("Argosidentity");
    expect(normalizeCompanyDisplayName("azul energy")).toBe("Azul Energy");
  });

  it("never touches mixed-case names — that shape is deliberate", () => {
    expect(normalizeCompanyDisplayName("QuickBooks")).toBe("QuickBooks");
    expect(normalizeCompanyDisplayName("eBay")).toBe("eBay");
    expect(normalizeCompanyDisplayName("McKinsey & Company")).toBe("McKinsey & Company");
    expect(normalizeCompanyDisplayName("UNICEF USA Foundation")).toBe("UNICEF USA Foundation");
  });

  it("a lowercase WORD inside a mixed name is deliberate — the whole name must be lowercase to repair", () => {
    // All four damaged the first prod run (2026-08-25) and were reverted:
    expect(normalizeCompanyDisplayName("Journey into Education & Teaching")).toBe("Journey into Education & Teaching");
    expect(normalizeCompanyDisplayName("Andrés y María Cárdenas Family Foundation")).toBe("Andrés y María Cárdenas Family Foundation");
    expect(normalizeCompanyDisplayName("The Miller Institute for Learning with Technology")).toBe("The Miller Institute for Learning with Technology");
    expect(normalizeCompanyDisplayName("Bangor Children’s Home d/b/a Hilltop School")).toBe("Bangor Children’s Home d/b/a Hilltop School");
    // And d/b/a stays down even in a fully lowercase name being repaired:
    expect(normalizeCompanyDisplayName("bangor children's home d/b/a hilltop school"))
      .toBe("Bangor Children's Home d/b/a Hilltop School");
  });

  it("keeps short ALL-CAPS tokens — acronym-shaped (SAP, CDW, AAMC, IBM)", () => {
    expect(normalizeCompanyDisplayName("SAP")).toBe("SAP");
    expect(normalizeCompanyDisplayName("AAMC")).toBe("AAMC");
    expect(normalizeCompanyDisplayName("IBM CORPORATION")).toBe("IBM Corporation");
  });

  it("a fully shouted name is an import artifact — words title-case, connectors drop", () => {
    expect(normalizeCompanyDisplayName("MICROSOFT")).toBe("Microsoft");
    expect(normalizeCompanyDisplayName("COMMUNITY FOUNDATION OF GREATER ATLANTA"))
      .toBe("Community Foundation of Greater Atlanta");
    expect(normalizeCompanyDisplayName("THE UNIVERSITY OF GEORGIA")).toBe("The University of Georgia");
  });

  it("legal suffixes take their conventional casing", () => {
    expect(normalizeCompanyDisplayName("acme inc")).toBe("Acme Inc");
    expect(normalizeCompanyDisplayName("acme llc")).toBe("Acme LLC");
    expect(normalizeCompanyDisplayName("ACME LLC")).toBe("ACME LLC");
    expect(normalizeCompanyDisplayName("segro plc")).toBe("Segro PLC");
  });

  it("connectors stay lowercase mid-name, capitalize when first", () => {
    expect(normalizeCompanyDisplayName("bank of america")).toBe("Bank of America");
    expect(normalizeCompanyDisplayName("the summit foundation")).toBe("The Summit Foundation");
  });

  it("apostrophes, hyphens, and Mc re-cap", () => {
    expect(normalizeCompanyDisplayName("o'reilly media")).toBe("O'Reilly Media");
    expect(normalizeCompanyDisplayName("hewlett-packard")).toBe("Hewlett-Packard");
    expect(normalizeCompanyDisplayName("mcdonald's")).toBe("McDonald's");
  });

  it("placeholders and URLs pass through untouched — garbage is not a name", () => {
    expect(normalizeCompanyDisplayName("<unknown>")).toBe("<unknown>");
    expect(normalizeCompanyDisplayName("https://facebook.com/fanatics")).toBe("https://facebook.com/fanatics");
  });

  it("null-in/null-out; never empties non-empty input", () => {
    expect(normalizeCompanyDisplayName(null)).toBeNull();
    expect(normalizeCompanyDisplayName("  ")).toBeNull();
    // Single letters sit below the shapeless threshold — untouched.
    expect(normalizeCompanyDisplayName("x")).toBe("x");
  });
});
