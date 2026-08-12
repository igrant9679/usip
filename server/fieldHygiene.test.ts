/**
 * Scraped-field hygiene — the "<UNKNOWN> <UNKNOWN>" bug (owner screenshot,
 * 2026-08-12). LLM scrapers emit placeholder tokens for unknown values; only
 * NAMES were cleaned at ingest, so placeholders landed in email/phone —
 * where they rendered raw, made every `!prospect.email` gate believe an
 * address existed (blocking enrichment), hid rows from the sweeper's
 * `IS NULL OR = ''` candidate queries, and could cross-link two strangers
 * at personLink's email tier.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  cleanScrapedField,
  isPlaceholderToken,
  usableDomainOrNull,
  usableEmailOrNull,
  usablePhoneOrNull,
} from "@shared/fieldHygiene";

describe("the placeholder vocabulary", () => {
  it("catches the tokens LLMs actually emit, wrapped or bare", () => {
    for (const v of ["<UNKNOWN>", "unknown", "N/A", "n/a", "NA", "none", "NULL", "not available", "Not Found", "-", "---", "(unknown)", "[unknown]", '"N/A"']) {
      expect(isPlaceholderToken(v), `${v} not treated as placeholder`).toBe(true);
    }
  });

  it("does not eat real values that merely contain the words", () => {
    for (const v of ["Unknown Worlds Entertainment", "NA Sales Director", "Nonexecutive Director", "Null Island Coffee"]) {
      expect(isPlaceholderToken(v), `${v} wrongly treated as placeholder`).toBe(false);
    }
  });

  it("cleanScrapedField clamps as well as cleans — the multi-row INSERT guard", () => {
    expect(cleanScrapedField("<UNKNOWN>", 120)).toBeUndefined();
    expect(cleanScrapedField("  Grants Management Officer  ", 120)).toBe("Grants Management Officer");
    expect(cleanScrapedField("x".repeat(300), 120)).toHaveLength(120);
  });
});

describe("shape rules — a field is data only if it is shaped like its type", () => {
  it("an email needs an @ and a dotted domain, and comes back lowercased", () => {
    expect(usableEmailOrNull("<UNKNOWN>")).toBeNull();
    expect(usableEmailOrNull("acme.com")).toBeNull();
    expect(usableEmailOrNull("jane@localhost")).toBeNull();
    expect(usableEmailOrNull("  Jane.Doe@Acme.com ")).toBe("jane.doe@acme.com");
  });

  it("a phone needs a digit", () => {
    expect(usablePhoneOrNull("<UNKNOWN>")).toBeNull();
    expect(usablePhoneOrNull("call the office")).toBeNull();
    expect(usablePhoneOrNull("+1 (301) 555-0100")).toBe("+1 (301) 555-0100");
  });

  it("a domain needs a dot", () => {
    expect(usableDomainOrNull("<UNKNOWN>")).toBeNull();
    expect(usableDomainOrNull("montgomerycountymd")).toBeNull();
    expect(usableDomainOrNull("MontgomeryCountyMD.gov")).toBe("montgomerycountymd.gov");
  });
});

describe("the seams consult the hygiene module", () => {
  it("the scraper ingest maps every prospect field through a cleaner", () => {
    const src = readFileSync("server/routers/are/scraper.ts", "utf8");
    expect(src).toContain('from "@shared/fieldHygiene"');
    expect(src).toContain("email: usableEmailOrNull(p.email) ?? undefined");
    expect(src).toContain("phone: usablePhoneOrNull(p.phone) ?? undefined");
    expect(src).toContain("companyDomain: usableDomainOrNull(p.companyDomain) ?? undefined");
    for (const f of ["title", "companyName", "companySize", "industry", "geography"]) {
      expect(src, `${f} is not placeholder-cleaned at ingest`).toMatch(new RegExp(`${f}: cleanScrapedField\\(p\\.${f}`));
    }
    // The raw clamp helper is gone — a new field cannot quietly bypass
    // cleaning by reaching for it.
    expect(src).not.toContain("clampStr");
  });

  it("personLink's email tier, conflict check, and identity test are all shape-gated", () => {
    const src = readFileSync("server/services/personLink.ts", "utf8");
    expect(src).toContain("const email = usableEmailOrNull(row.email);");
    expect(src).toContain("const rowEmail = usableEmailOrNull(row.email);");
    expect(src).toContain("const personEmail = usableEmailOrNull(person.email);");
    expect(src).toMatch(/return !!\(usableEmailOrNull\(row\.email\)/);
  });

  it("migration 0159 repairs stored rows with the same shape rules", () => {
    const src = readFileSync("server/_core/rawMigrations.ts", "utf8");
    expect(src).toContain("0159_scrub_placeholder_fields.sql");
    expect(src).toContain("`email` NOT LIKE '%@%'");
    expect(src).toContain("`phone` NOT REGEXP '[0-9]'");
    expect(src).toContain("`companyDomain` NOT LIKE '%.%'");
    // The prospects-side email repair must clear the stale verdict with the
    // address, and must not touch names (the "(unknown)" sentinel is
    // load-bearing for isSyntheticNameProspect).
    expect(src).toContain("SET `email` = NULL, `email_status` = NULL");
    const migBlock = src.slice(src.indexOf("0159_scrub_placeholder_fields"));
    expect(migBlock.slice(0, 3000)).not.toMatch(/firstName|lastName/);
  });
});
