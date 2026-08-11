/**
 * Intelligence-engine roadmap Phase 1 — the bypass-closures hold:
 *
 *  1.1 Discovery v2 persists through mergeAll (the blind overwrite that
 *      could downgrade a Reoon-verified email is gone);
 *  1.2 the legacy findContactInfo procedure routes through the ONE
 *      comprehensive pass;
 *  1.3 LeadRocks mapping runs the house normalization;
 *  1.4 every account-creation path stamps the identity-index columns;
 *  1.5 the backfill for pre-existing rows is wired;
 *  1.6 the batch-import source value is in the union;
 *  1.7 domain_derived's confidence lives in the CONFIDENCE table.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapLeadRocksRow } from "./services/leadrocks";
import { normalizedAccountFields } from "./services/company/normalize";
import { CONFIDENCE } from "./services/enrichment/fieldMerge";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("1.1 Discovery v2 persists through the merge", () => {
  it("consolidate.ts uses mergeAll and the blind overwrite is gone", () => {
    const src = read("server/services/discovery/consolidate.ts");
    expect(src).toContain("mergeAll(");
    expect(src).toContain('from "../enrichment/fieldMerge"');
    // The exact shape of the old downgrade: a bare candidate landing in .set().
    expect(src).not.toContain("email: c.email ?? undefined");
    expect(src).not.toContain("title: c.title ?? undefined");
  });
});

describe("1.2 findContactInfo routes through the comprehensive pass", () => {
  it("the procedure body calls runComprehensiveEnrichment, not the scraper directly", () => {
    const src = read("server/routers/prospects.ts");
    const start = src.indexOf("findContactInfo: workspaceProcedure");
    const end = src.indexOf("findContactInfoBatch");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, end);
    expect(body).toContain("runComprehensiveEnrichment");
    expect(body).not.toContain("lookupContactInfo(");
  });
});

describe("1.3 LeadRocks mapping runs the house normalization", () => {
  const headers = ["First Name", "Last Name", "Linked Url", "Company Website", "Work Email #1", "Work Email #1 Status", "Job Title", "Company", "Industry"];
  const row = (over: Record<string, string> = {}) => ({
    "First Name": "Jane",
    "Last Name": "Doe, PMP",
    "Linked Url": "https://linkedin.com/in/jane-doe",
    "Company Website": "https://www.acme.com",
    "Work Email #1": "jane@acme.com",
    "Work Email #1 Status": "ok_for_all",
    "Job Title": "vp of operations",
    "Company": "Acme",
    "Industry": "N/A",
    ...over,
  });

  it("strips name credentials, repairs the title, junk-gates industry", () => {
    const m = mapLeadRocksRow(row(), headers);
    expect(m).not.toBeNull();
    expect(m!.lastName).toBe("Doe");
    expect(m!.title).toContain("VP");
    expect(m!.industry).toBeNull(); // "N/A" is placeholder junk
  });

  it("a row whose name is ONLY credentials is not silently emptied", () => {
    // stripNameCredentials never strips to empty — the mapper's own
    // name requirement then decides.
    const m = mapLeadRocksRow(row({ "First Name": "Jane", "Last Name": "MBA" }), headers);
    expect(m).not.toBeNull();
    expect(m!.lastName).toBe("MBA");
  });
});

describe("1.4 identity-index columns on every account path", () => {
  it("normalizedAccountFields computes both columns", () => {
    expect(normalizedAccountFields("ACME Corp.", "https://www.Acme.com/x")).toEqual({
      normalizedName: "acme",
      normalizedDomain: "acme.com",
    });
    expect(normalizedAccountFields(null, null)).toEqual({ normalizedName: null, normalizedDomain: null });
  });

  it.each([
    "server/routers/imports.ts",
    "server/routers/placesSearch.ts",
    "server/routers/crm.ts",
    "server/services/leadBridge.ts",
    "server/services/crmMatching.ts",
  ])("%s stamps normalizedAccountFields at insert", (rel) => {
    expect(read(rel)).toContain("normalizedAccountFields(");
  });

  it("crm.ts covers BOTH the create and the lead-convert inserts", () => {
    const src = read("server/routers/crm.ts");
    expect(src.match(/normalizedAccountFields\(/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("1.5 the backfill for pre-existing rows is wired", () => {
  it("cron registered; backfill never touches display fields", () => {
    const core = read("server/_core/index.ts");
    expect(core).toContain("setInterval(runNormalizedBackfill, 24 * 60 * 60 * 1000)");
    const svc = read("server/services/company/normalizedBackfill.ts");
    const sets = svc.match(/\.set\(([^)]*)\)/g) ?? [];
    expect(sets.length).toBeGreaterThan(0);
    for (const s of sets) expect(s).toContain("fields");
    expect(svc).not.toMatch(/set\([^)]*name:/); // values-only, no display writes
  });
});

describe("1.6 + 1.7 vocabulary fixes", () => {
  it("linkedin_enrichment is a legal ScrapedProspectSource", () => {
    expect(read("server/services/prospectFromSource.ts")).toMatch(/\|\s*"linkedin_enrichment"/);
  });
  it("domain_derived confidence lives in the CONFIDENCE table", () => {
    expect(CONFIDENCE.domainDerived).toBe(40);
    const src = read("server/services/enrichment/comprehensivePass.ts");
    expect(src).toContain("CONFIDENCE.domainDerived");
    expect(src).not.toMatch(/source: "domain_derived", confidence: 40/);
  });
});
