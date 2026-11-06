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
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, gate: null as null | Promise<void>, calls: 0 }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async () => {
    h.calls++;
    if (h.gate) await h.gate;
    return { choices: [{ message: { content: JSON.stringify({ industry: "Nonprofit", country: "United States", confidence: 80, reasoning: "r" }) } }] };
  },
}));

import { AI_INFERENCE_CONFIDENCE, AI_INFERENCE_VENDOR, INDUSTRIES } from "./services/firmographicInference";
import { CONFIDENCE } from "./services/enrichment/fieldMerge";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

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
    // 2026-11-06 (audit P156): the pass now starts through
    // startFirmographicInference, which refuses a second one for the same
    // workspace; it is still fire-and-forget, and audited when done.
    expect(proc).toContain("const pass = startFirmographicInference(ws, { limit });");
    expect(proc).toContain("void pass.then(async (t) => {");
    expect(proc).toContain('entityType: "firmographic_inference"');
    expect(router).toContain("firmographicStatus: workspaceProcedure.query");
  });
});

/* ── P156: one pass at a time, and a dry run calls no model ─────────────── */

const WS = 2;
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

describe("firmographic inference spends once (audit 2026-10-20, P156)", () => {
  beforeEach(() => {
    h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
    h.calls = 0;
    h.gate = null;
    h.db.rowsOf("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
    h.db.rowsOf("accounts").push(
      { id: 1, workspaceId: WS, name: "Acme Foundation", domain: "acme.example", industry: null, hqCountry: null },
      { id: 2, workspaceId: WS, name: "Beta Trust", domain: "beta.example", industry: null, hqCountry: null },
    );
  });

  it("a dry run counts what a pass would send to the model and calls it for none", async () => {
    const r = await caller().companies.inferFirmographics({ dryRun: true });
    expect(r).toMatchObject({ started: false, sample: { companiesTried: 2, companiesFilled: 0 } });
    expect(h.calls).toBe(0);
    expect(h.db.rowsOf("accounts").every((a: any) => a.industry === null)).toBe(true);
  });

  it("a second click while a pass runs starts nothing; once it ends, one can start again", async () => {
    let release!: () => void;
    h.gate = new Promise<void>((r) => { release = r; });
    expect(await caller().companies.inferFirmographics({})).toMatchObject({ started: true });
    expect(await caller().companies.inferFirmographics({})).toMatchObject({ started: false, alreadyRunning: true });
    release();
    await vi.waitFor(() => expect(h.db.rowsOf("accounts").every((a: any) => a.industry === "Nonprofit")).toBe(true), { timeout: 15000 });
    expect(h.calls).toBe(2);
    await vi.waitFor(async () => expect(await caller().companies.inferFirmographics({})).toMatchObject({ started: true }), { timeout: 15000 });
  });
});
