/**
 * Roadmap Phases 3–5 + Clodura retirement + the Reoon toggle + company
 * identification (owner directives, 2026-08-11):
 *
 *  - Clodura: tables dropped by 0155, zero live code references remain;
 *  - Reoon: optional FINAL verification step, enforced at the getReoonKey
 *    choke point (0157) — off behaves exactly as key-absent;
 *  - Company identification: LinkedIn + QuickEnrich evidence, written
 *    through the account ledger (owner: single source of truth);
 *  - P3: field history persisted by every mergeAll consumer (0156);
 *    brand changes and high-intent ARE signals fire workflow rules;
 *  - P5: sweeper stale re-attempt, one free-mail vocabulary, Unipile
 *    email/calendar pacing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { corporateDomainOf } from "./services/leadBridge";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("Clodura is retired (owner-approved removal)", () => {
  it("migration 0155 drops every execution table", () => {
    const src = read("server/_core/rawMigrations.ts");
    expect(src).toContain("0155_retire_clodura_tables.sql");
    for (const t of ["clodura_reveal_jobs", "clodura_saved_searches", "clodura_search_cache", "clodura_enrichment_jobs", "clodura_enrichment_settings", "contact_enrichment_history"]) {
      expect(src).toContain(`DROP TABLE IF EXISTS \`${t}\``);
    }
  });
  it("no live code references the removed tables", () => {
    const schema = read("drizzle/schema.ts");
    expect(schema).not.toContain("cloduraRevealJobs = mysqlTable");
    expect(schema).not.toContain("contactEnrichmentHistory = mysqlTable");
    const crm = read("server/routers/crm.ts");
    expect(crm).not.toContain("cloduraEnrichmentJobs");
    expect(crm).not.toContain("contactEnrichmentHistory");
  });
});

describe("Reoon is the optional FINAL verification step (0157)", () => {
  it("migration + schema declare the toggle, default ON", () => {
    expect(read("server/_core/rawMigrations.ts")).toContain("0157_reoon_verification_toggle.sql");
    expect(read("drizzle/schema.ts")).toMatch(/reoonVerificationEnabled: boolean\("reoon_verification_enabled"\)\.default\(true\)/);
  });
  it("enforced at the ONE choke point — getReoonKey returns '' when off", () => {
    const src = read("server/services/reoon.ts");
    const fn = src.slice(src.indexOf("export async function getReoonKey"));
    expect(fn).toContain('if (row && row.enabled === false) return ""');
  });
  it("the settings surface exists (no inert toggle)", () => {
    expect(read("server/routers/reoon.ts")).toContain("setVerificationEnabled");
    expect(read("client/src/components/usip/settings/ReoonVerifierCard.tsx")).toContain("trpc.reoon.setVerificationEnabled.useMutation");
  });
});

describe("company identification = LinkedIn + QuickEnrich evidence (P2.4)", () => {
  it("enrichCompany derives identity through the account ledger", () => {
    const src = read("server/services/company/enrichmentService.ts");
    expect(src).toContain("mergeAccountField(");
    expect(src).toContain("prospectLinkedinEnrichments");
    expect(src).toMatch(/source: "linkedin_quickenrich"/);
    // ≥2 votes earn LinkedIn tier; single sightings enter at candidate tier.
    expect(src).toContain("votes >= 2 ? CONFIDENCE.linkedinProfile : CONFIDENCE.headlineParse");
  });
});

describe("P3 — signals & field history", () => {
  it("0156 declared in both places", () => {
    expect(read("server/_core/rawMigrations.ts")).toContain("0156_prospect_field_history.sql");
    expect(read("drizzle/schema.ts")).toMatch(/prospectFieldHistory = mysqlTable\(\s*\n?\s*"prospect_field_history"/);
  });
  it("every mergeAll consumer records field history", () => {
    for (const rel of [
      "server/services/enrichment/comprehensivePass.ts",
      "server/services/linkedinEnrichment/enrichmentService.ts",
      "server/services/personLink.ts",
      "server/services/discovery/consolidate.ts",
    ]) {
      expect(read(rel), `${rel} must record field history`).toContain("recordFieldHistory");
    }
  });
  it("brand changes fire the workflow signal job-change already fires", () => {
    const src = read("server/services/company/brandReconciler.ts");
    expect(src).toContain('signal: "brand_change"');
    expect(src).toContain('fireWorkflowRules(workspaceId, "signal_received"');
  });
  it("high-intent ARE signals bridge to workflow rules — allow-list only", () => {
    const src = read("server/routers/are/execution.ts");
    expect(src).toContain('new Set(["meeting_booked", "email_reply"])');
    expect(src).toContain("WORKFLOW_BRIDGED_SIGNALS.has(signalType)");
  });
});

describe("P4.1 — provider effectiveness is a read-layer report", () => {
  it("the procedure aggregates the ledger, zero new writes", () => {
    const src = read("server/routers/dataHealth.ts");
    const fn = src.slice(src.indexOf("providerEffectiveness"));
    expect(fn).toContain("fieldProvenance");
    expect(fn).not.toContain(".insert(");
    expect(fn).not.toContain(".update(");
  });
  it("the Data Health card renders it", () => {
    expect(read("client/src/pages/usip/DataHealth.tsx")).toContain("providerEffectiveness.useQuery");
  });
});

describe("P5 — housekeeping", () => {
  it("5.1 the sweeper re-attempts stale no-email rows (lastEnrichedAt finally gates)", () => {
    const src = read("server/services/enrichmentSweeper.ts");
    expect(src).toContain("STALE_RETRY_MS = 60 * 86_400_000");
    expect(src).toContain("lastEnrichedAt");
  });
  it("5.2 one free-mail vocabulary — leadBridge delegates to the shared list", () => {
    expect(corporateDomainOf("jane@acme.com")).toBe("acme.com");
    expect(corporateDomainOf("jane@gmail.com")).toBeNull();
    expect(corporateDomainOf("jane@hey.com")).toBeNull(); // was MISSING from the private copy
    const src = read("server/services/leadBridge.ts");
    expect(src).not.toContain("const FREE_MAIL");
  });
  it("5.3 Unipile email/calendar calls are paced with a 429 retry", () => {
    const src = read("server/lib/unipile.ts");
    expect(src).toContain("PACED_PATHS = /^\\/(emails|folders|calendars)/");
    expect(src).toContain("res.status === 429 && PACED_PATHS.test(path)");
  });
  it("5.4 the vocabulary doc exists and names all four scales", () => {
    const doc = read("docs/intelligence-engine/confidence-vocabularies.md");
    for (const anchor of ["fieldMerge.CONFIDENCE", "BRAND_THRESHOLDS", "matchingService", "contactAccountLinks.confidence"]) {
      expect(doc).toContain(anchor);
    }
  });
});
