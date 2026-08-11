/**
 * Intelligence-engine roadmap Phase 2 — company-side provenance + sync:
 *
 *  2.1 accounts.field_provenance (migration 0154, declared BOTH places);
 *      account merges route through fieldMerge.mergeField via the adapter
 *      (never-downgrade holds: a user pin blocks brandfetch, agreement
 *      corroborates instead of churning); manual pins record user·100.
 *  2.2 mergeAccounts repoints the evidence tables — no more orphaned
 *      brand observations / enrichment events / logo assets.
 *  2.3 a company change re-runs the per-prospect associator, so linked
 *      prospects follow their person to the new employer.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeAccountField, userPinProvenance } from "./services/company/accountProvenance";
import { CONFIDENCE } from "./services/enrichment/fieldMerge";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("migration 0154 is declared in both places", () => {
  it("rawMigrations has the 0154 block", () => {
    const src = read("server/_core/rawMigrations.ts");
    expect(src).toContain("0154_account_field_provenance.sql");
    expect(src).toMatch(/ALTER TABLE `accounts` ADD COLUMN `field_provenance` json NULL/);
  });
  it("drizzle declares the column on accounts (distinct from prospects')", () => {
    const src = read("drizzle/schema.ts");
    expect(src.match(/fieldProvenance: json\("field_provenance"\)/g)!.length).toBe(2);
  });
});

describe("mergeAccountField — the SAME rules, account fields", () => {
  const at = "2026-08-11T21:00:00.000Z";
  const brand = (value: string, confidence = 95) => ({ value, source: "brandfetch", confidence, at });

  it("fills an empty field", () => {
    const d = mergeAccountField("legalName", { value: null }, brand("Acme, Inc."));
    expect(d.action).toBe("filled");
    expect(d.value).toBe("Acme, Inc.");
    expect(d.provenance.source).toBe("brandfetch");
  });

  it("replaces a legacy value (preexisting·70 baseline) at higher confidence", () => {
    const d = mergeAccountField("domain", { value: "acme.org" }, brand("acme.com", 95));
    expect(d.action).toBe("replaced");
    expect(d.value).toBe("acme.com");
  });

  it("a user pin at 100 is never displaced by a DIFFERENT value", () => {
    const d = mergeAccountField("name", { value: "ACME", provenance: userPinProvenance(at) }, brand("Initech", 99));
    expect(d.action).toBe("kept");
    expect(d.value).toBe("ACME");
    expect(d.provenance.confidence).toBe(100);
  });

  it("an AGREEING observation corroborates a pin without demoting its confidence", () => {
    // "ACME" vs "Acme" share a normalized identity → corroboration path;
    // fieldMerge's 99 cap must not quietly lower the user·100 pin.
    const d = mergeAccountField("name", { value: "ACME", provenance: userPinProvenance(at) }, brand("Acme", 99));
    expect(d.action).toBe("corroborated");
    expect(d.value).toBe("ACME");
    expect(d.provenance.confidence).toBe(100);
    expect(d.provenance.corroboratedBy).toContain("brandfetch");
  });

  it("agreement corroborates instead of churning — company-name normalization applies", () => {
    // "Acme Corp." vs "Acme Corp" — same normalized company identity.
    const d = mergeAccountField(
      "name",
      { value: "Acme Corp.", provenance: { source: "user_import", confidence: CONFIDENCE.preexisting, at } },
      brand("Acme Corp", 90),
    );
    expect(d.action).toBe("corroborated");
    expect(d.value).toBe("Acme Corp.");
    expect(d.provenance.corroboratedBy).toContain("brandfetch");
  });

  it("domain comparison ignores protocol/www noise", () => {
    const d = mergeAccountField(
      "domain",
      { value: "acme.com", provenance: { source: "csv", confidence: 70, at } },
      brand("https://www.acme.com", 95),
    );
    expect(d.action).toBe("corroborated");
  });
});

describe("the writers are wired (structural)", () => {
  it("brandReconciler routes its changes through the adapter", () => {
    const src = read("server/services/company/brandReconciler.ts");
    expect(src).toContain("mergeAccountField(");
    expect(src).toContain("existing provenance outranks this observation");
  });
  it("setBrandOverride records the pin at user·100", () => {
    const src = read("server/routers/companies.ts");
    expect(src).toContain("userPinProvenance(override.at)");
  });
});

describe("2.2 mergeAccounts repoints the evidence tables", () => {
  it("brand observations, enrichment events, and logo assets follow the merge", () => {
    const src = read("server/services/company/mergeService.ts");
    const fn = src.slice(src.indexOf("export async function mergeAccounts"));
    expect(fn).toContain("db.update(brandObservations)");
    expect(fn).toContain("db.update(organizationEnrichmentEvents)");
    expect(fn).toContain("db.update(companyLogoAssets)");
  });
});

describe("2.3 job change re-runs the associator", () => {
  it("onJobChangeDetected calls the per-prospect associator on company change", () => {
    const src = read("server/services/linkedinEnrichment/jobChangeReengagement.ts");
    const anchor = src.indexOf("export async function onJobChangeDetected");
    const body = src.slice(anchor, src.indexOf("export async function maybeCreateJobChangeReengagement"));
    expect(body).toContain("associateProspectToCompany(p, { sourceType: \"job_change\" })");
  });
});
