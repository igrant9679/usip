/**
 * Pins for inferred firmographics (2026-09-09). The pass writes values no
 * provider verified, so what matters is that it (a) fills blanks only,
 * (b) labels every write as ai_inference at low confidence, (c) never
 * writes "Unknown", (d) remembers what it tried so it does not spend the
 * same model call again for 30 days, and (e) runs serially without a
 * userId so the per-user burst limit does not turn a 700-company pass into
 * 670 silent failures.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AI_INFERENCE_CONFIDENCE, AI_INFERENCE_VENDOR, INDUSTRIES } from "./services/firmographicInference";
import { CONFIDENCE } from "./services/enrichment/fieldMerge";

const src = readFileSync(new URL("./services/firmographicInference.ts", import.meta.url), "utf8");
const router = readFileSync(new URL("./routers/companies.ts", import.meta.url), "utf8");

describe("firmographic inference", () => {
  it("fills blanks only and never displaces another source", () => {
    expect(src).toContain("if (!acct.industry && inf.industry)");
    expect(src).toContain("if (!acct.hqCountry && inf.country)");
    expect(src).toContain("if (!p.industry && inf.industry)");
    expect(src).toContain("if (!p.country && inf.country)");
    expect(src).toContain("or(isNull(accounts.industry), isNull(accounts.hqCountry))");
  });

  it("is labelled honestly: ai_inference at a confidence every real source beats", () => {
    expect(AI_INFERENCE_VENDOR).toBe("ai_inference");
    expect(AI_INFERENCE_CONFIDENCE).toBeLessThan(CONFIDENCE.linkedinProfile);
    expect(src).toContain('sourceType: "model_inference"');
    // People's country goes through the ledger with that source, so a later
    // real source replaces rather than corroborates it.
    expect(src).toContain("source: AI_INFERENCE_VENDOR, confidence: AI_INFERENCE_CONFIDENCE");
  });

  it("never writes Unknown, and remembers no-result companies for 30 days", () => {
    expect(src).toMatch(/!\/\^unknown\$\/i\.test\(countryRaw\)/);
    expect(src).toContain('status: fieldsUpdated.length > 0 ? "enriched" : "no_result"');
    expect(src).toContain("const RETRY_AFTER_DAYS = 30;");
    expect(src).toContain("triedIds.has(a.id)");
  });

  it("uses a fixed taxonomy the model must choose from", () => {
    expect(INDUSTRIES.length).toBeGreaterThan(20);
    expect(INDUSTRIES).toContain("Nonprofit");
    expect(INDUSTRIES).toContain("Government");
    expect(src).toContain('enum: [...INDUSTRIES, "Unknown"]');
  });

  it("runs serially, paced, without a userId, and one failure never stops the run", () => {
    expect(src).not.toMatch(/invokeLLM\(\{[^}]*userId/);
    expect(src).toContain("await new Promise((r) => setTimeout(r, 400));");
    expect(src).toContain("tally.failed++;");
  });

  it("is admin-only, background, observable, and audited when done", () => {
    const proc = router.slice(router.indexOf("inferFirmographics:"), router.indexOf("firmographicStatus:"));
    expect(proc).toContain('requireMinRole(ctx.member.role, "admin"');
    expect(proc).toContain("void runFirmographicInference(ws, { limit })");
    expect(proc).toContain('entityType: "firmographic_inference"');
    expect(router).toContain("firmographicStatus: workspaceProcedure.query");
  });
});
