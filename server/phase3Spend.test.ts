/**
 * Phase 3 of the 2026-10-20 audit, part 1 — spend you can see and stop —
 * against the real funnels, routers and services and the SQL-evaluating fake.
 *
 *   every model call and every stream is counted against its workspace, by
 *   meter, model and paying key, and a call with no workspace is counted as
 *   unattributed · streams obey the monthly budget and the burst ceiling ·
 *   signal enhancement is off (A38) · ICP regeneration is metered, one at a
 *   time, and all-or-nothing (A39) · the deployment's Reoon and QuickEnrich
 *   keys are opt-in per workspace and capped (owner 2026-10-27, A58, P10) ·
 *   bulk verification needs ids or an admin, one job at a time, at most
 *   BULK_VERIFY_MAX (P10) · QuickEnrich hits are counted (P84) · previews do
 *   not spend the daily caps (P69) · nothing is acquired that the free
 *   filters would drop (A33) · the cost report and the owner's switches.
 *
 * Time is frozen at T0 — Wednesday 2026-11-18, 15:00 UTC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  // _core/env.ts and crypto read these at module load.
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    calls: [] as Array<{ key: string; stream?: boolean; params: any }>,
    reply: "ok",
    model: "claude-opus-5-5-20261001",
    usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 300 } as Record<string, number>,
    streamEvents: [] as any[],
    audits: [] as any[],
  };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages: any;
    constructor(opts: { apiKey: string }) {
      this.messages = {
        create: async (params: any) => {
          h.calls.push({ key: opts.apiKey, params });
          return { id: "m", model: h.model, content: [{ type: "text", text: h.reply }], stop_reason: "end_turn", usage: { ...h.usage } };
        },
        stream: (params: any) => {
          h.calls.push({ key: opts.apiKey, params, stream: true });
          const events = h.streamEvents;
          return { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } };
        },
      };
    }
  },
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async (x: unknown) => { h.audits.push(x); } }));
vi.mock("./_core/env", async (a) => {
  const actual = await a<typeof import("./_core/env")>();
  return { ...actual, ENV: { ...actual.ENV, anthropicApiKey: "env-anthropic", aiDefaultProvider: "anthropic" } };
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { findLlmCallSites } from "./__fakes__/llmCallSites";
import { appRouter } from "./routers";
import { encryptSecret } from "./_core/crypto";
import { invokeLLM, __resetLlmBurstForTests } from "./_core/llm";
import { streamLLM } from "./_core/llmStream";
import { getRequestFeature, runWithRequestContext } from "./_core/requestContext";
import { publicProcedure, router } from "./_core/trpc";
import { recordSpend, __resetSpendWarningsForTests } from "./services/spend";
import { getReoonKey, reoonCreateBulkTask, reoonVerifySingle } from "./services/reoon";
import { getQuickEnrichKey, quickenrichContactFinder, quickenrichFindEmailByLinkedIn } from "./services/quickenrich";
import { runIcpInference } from "./routers/are/icp";
import { runDailyVerificationMaintenance } from "./routers/emailVerification";
import { runWaterfall } from "./services/prospectSources/executor";
import { Deduper } from "./services/prospectSources/dedupe";
import { summarizeSpend, unitCostUsd, dayRange } from "@shared/spendReport";
import { BULK_VERIFY_MAX } from "@shared/verificationLimits";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const LSI = 2;
const CF = 4;
const ADMIN = 20;
const REP = 21;
const OWNER = 30; // platform owner: users.role = 'admin'
const T0 = new Date("2026-11-18T15:00:00Z").getTime();
const TODAY = "2026-11-18";

const rows = (t: string) => h.db.rowsOf(t) as any[];
const ledger = (filter: Record<string, unknown> = {}) =>
  rows("spend_ledger").filter((r) => Object.entries(filter).every(([k, v]) => r[k] === v));
const qty = (filter: Record<string, unknown>) => ledger(filter).reduce((a, r) => a + Number(r.quantity), 0);

function seed() {
  rows("workspaces").push(
    { id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" },
    { id: CF, name: "CommunityForce", slug: "cf", ownerUserId: ADMIN, archivedAt: null, plan: "trial" },
  );
  const user = (id: number, mail: string, role = "user") => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: mail, loginMethod: "password", role,
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN, "admin@lsi.example"), user(REP, "rep@lsi.example"), user(OWNER, "owner@velocity.example", "admin"));
  const member = (id: number, ws: number, userId: number, role: string) => ({
    id, workspaceId: ws, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, LSI, ADMIN, "admin"), member(2, LSI, REP, "rep"), member(3, LSI, OWNER, "super_admin"));
  rows("workspace_settings").push(
    { workspaceId: LSI, reoonVerificationEnabled: true, sharedReoonKey: false, sharedQuickenrichKey: false, sharedReoonDailyCap: null, sharedQuickenrichDailyCap: null, llmMonthlyTokenCap: null },
    { workspaceId: CF, reoonVerificationEnabled: true, sharedReoonKey: false, sharedQuickenrichKey: false, sharedReoonDailyCap: null, sharedQuickenrichDailyCap: null, llmMonthlyTokenCap: null },
  );
}
const settings = (ws: number) => rows("workspace_settings").find((s) => s.workspaceId === ws);

function caller(userId: number, ws = LSI) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

/** Reoon/QuickEnrich HTTP, answered from a table; every request is recorded. */
const http = { calls: [] as Array<{ url: string; body: any }>, reoonStatus: 200 };
function stubVendors() {
  http.calls = [];
  http.reoonStatus = 200;
  vi.stubGlobal("fetch", async (url: string, init?: any) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    http.calls.push({ url: String(url), body });
    const json = (status: number, b: unknown) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), json: async () => b, text: async () => JSON.stringify(b) });
    if (String(url).includes("reoon")) {
      if (http.reoonStatus !== 200) return json(http.reoonStatus, {});
      if (String(url).includes("create-bulk")) return json(200, { task_id: 77, count_submitted: body.emails.length, count_duplicates_removed: 0, count_processing: body.emails.length });
      return json(200, { email: "x", status: "safe", overall_score: 90 });
    }
    if (String(url).includes("quickenrich")) {
      if (String(url).includes("employees/search")) {
        return String(url).includes("hit") ? json(200, { data: { email: "jo@county.gov" } }) : json(404, {});
      }
      return json(200, { data: [] });
    }
    return json(404, {});
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true });
  h.calls = [];
  h.reply = "ok";
  h.model = "claude-opus-5-5-20261001";
  h.usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 300 };
  h.streamEvents = [];
  h.audits = [];
  process.env.REOON_API_KEY = "env-reoon";
  process.env.QUICKENRICH_API_KEY = "env-qe";
  __resetLlmBurstForTests();
  __resetSpendWarningsForTests();
  stubVendors();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.REOON_API_KEY;
  delete process.env.QUICKENRICH_API_KEY;
});

/* ── The ledger ─────────────────────────────────────────────────────────── */

describe("the spend ledger", () => {
  it("adds to one row per workspace, day, vendor, meter, model, key and feature", async () => {
    await recordSpend({ workspaceId: LSI, vendor: "reoon", meter: "daily_credits", quantity: 1, keySource: "shared", feature: "f" });
    await recordSpend({ workspaceId: LSI, vendor: "reoon", meter: "daily_credits", quantity: 2, keySource: "shared", feature: "f" });
    await recordSpend({ workspaceId: LSI, vendor: "reoon", meter: "daily_credits", quantity: 1, keySource: "workspace", feature: "f" });
    await recordSpend({ workspaceId: LSI, vendor: "reoon", meter: "daily_credits", quantity: 0, keySource: "shared", feature: "f" });
    expect(ledger({ keySource: "shared" })).toEqual([expect.objectContaining({ day: TODAY, quantity: 3, calls: 2 })]);
    expect(ledger({ keySource: "workspace" })).toHaveLength(1);
  });

  it("counts a call with no workspace as unattributed, never drops it", async () => {
    await recordSpend({ workspaceId: undefined, vendor: "anthropic", meter: "input_tokens", quantity: 5, keySource: "shared", feature: "x" });
    expect(ledger({ workspaceId: 0 })).toEqual([expect.objectContaining({ quantity: 5, feature: "x" })]);
  });
});

/* ── Every AI call metered ──────────────────────────────────────────────── */

describe("every model call is counted against its workspace", () => {
  it("splits a call by meter, records the model, the paying key and the feature", async () => {
    await invokeLLM({ workspaceId: LSI, feature: "test.feature", messages: [{ role: "user", content: "hi" }] });
    const base = { workspaceId: LSI, vendor: "anthropic", model: "claude-opus-5-5-20261001", keySource: "shared", feature: "test.feature", day: TODAY };
    expect(qty({ ...base, meter: "input_tokens" })).toBe(1000);
    expect(qty({ ...base, meter: "output_tokens" })).toBe(200);
    expect(qty({ ...base, meter: "cache_write_tokens" })).toBe(50);
    expect(qty({ ...base, meter: "cache_read_tokens" })).toBe(300);
    // The monthly budget's counter is unchanged in meaning (input + output).
    expect(rows("usage_counters")[0]).toEqual(expect.objectContaining({ workspaceId: LSI, llmTokens: 1200 }));
  });

  it("says 'workspace' when the workspace's own key paid", async () => {
    settings(LSI).anthropicApiKeyEnc = encryptSecret("ws-anthropic");
    await invokeLLM({ workspaceId: LSI, messages: [{ role: "user", content: "hi" }] });
    expect(h.calls[0].key).toBe("ws-anthropic");
    expect(ledger({ meter: "input_tokens" })).toEqual([expect.objectContaining({ keySource: "workspace" })]);
  });

  it("names a request's call by its tRPC path, and an engine's call 'background'", async () => {
    const r = router({ probe: publicProcedure.query(() => getRequestFeature() ?? null) });
    const c = r.createCaller({ req: { headers: {}, socket: { remoteAddress: "127.0.0.1" } } } as any);
    expect(await c.probe()).toBe("probe");
    await runWithRequestContext({ workspaceId: LSI, feature: "aiFeatures.suggestNextAction" }, () =>
      invokeLLM({ messages: [{ role: "user", content: "hi" }] }));
    await invokeLLM({ workspaceId: CF, messages: [{ role: "user", content: "hi" }] });
    expect(ledger({ workspaceId: LSI, meter: "input_tokens" })[0].feature).toBe("aiFeatures.suggestNextAction");
    expect(ledger({ workspaceId: CF, meter: "input_tokens" })[0].feature).toBe("background");
  });

  it("counts a call that found no workspace as unattributed", async () => {
    await invokeLLM({ messages: [{ role: "user", content: "hi" }], feature: "orphan" });
    expect(qty({ workspaceId: 0, meter: "input_tokens", feature: "orphan" })).toBe(1000);
  });
});

describe("streams are metered and bounded like every other model call", () => {
  const events = (opts: { output?: number } = {}) => [
    { type: "message_start", message: { model: "claude-sonnet-5-5-20261001", usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
    ...(opts.output === undefined ? [] : [{ type: "message_delta", usage: { output_tokens: opts.output } }]),
  ];
  const drain = async (it: AsyncGenerator<string>, stopAfter = Infinity) => {
    let out = "";
    let n = 0;
    for await (const d of it) { out += d; if (++n >= stopAfter) break; }
    return out;
  };

  it("records what the provider reports at the end of the stream", async () => {
    h.streamEvents = events({ output: 40 });
    const text = await drain(streamLLM({ workspaceId: LSI, feature: "stream test", messages: [{ role: "user", content: "hi" }] }));
    expect(text).toBe("Hello");
    const base = { workspaceId: LSI, model: "claude-sonnet-5-5-20261001", feature: "stream test" };
    expect(qty({ ...base, meter: "input_tokens" })).toBe(500);
    expect(qty({ ...base, meter: "output_tokens" })).toBe(40);
    expect(qty({ ...base, meter: "cache_read_tokens" })).toBe(100);
    expect(rows("usage_counters")[0].llmTokens).toBe(540);
  });

  it("still records a stream the reader stopped early: the provider billed it", async () => {
    h.streamEvents = events();
    expect(await drain(streamLLM({ workspaceId: LSI, messages: [{ role: "user", content: "hi" }] }), 1)).toBe("Hel");
    expect(qty({ workspaceId: LSI, meter: "input_tokens" })).toBe(500);
  });

  it("refuses before the provider is called when the month's budget is spent", async () => {
    const WS = 91; // its own workspace: the budget check caches per workspace
    rows("workspace_settings").push({ workspaceId: WS, llmMonthlyTokenCap: 100 });
    rows("usage_counters").push({ id: 1, workspaceId: WS, month: "2026-11", llmTokens: 100, emailsSent: 0 });
    h.streamEvents = events({ output: 1 });
    await expect(drain(streamLLM({ workspaceId: WS, messages: [{ role: "user", content: "hi" }] }))).rejects.toThrow(/monthly AI budget/);
    expect(h.calls).toHaveLength(0);
  });

  it("holds a signed-in user to the per-minute ceiling", async () => {
    h.streamEvents = events({ output: 1 });
    for (let i = 0; i < 30; i++) await drain(streamLLM({ workspaceId: LSI, userId: 555, messages: [{ role: "user", content: "hi" }] }));
    await expect(drain(streamLLM({ workspaceId: LSI, userId: 555, messages: [{ role: "user", content: "hi" }] }))).rejects.toThrow(/LLM rate limit/);
  });

  it("every SSE route names the user and the feature", () => {
    for (const f of ["server/_core/streamHelpers.ts", "server/accountBriefsStreamRoute.ts", "server/emailBuilderStreamRoute.ts", "server/proposalsStreamRoute.ts", "server/llmStreamRoute.ts"]) {
      const src = read(f);
      const call = src.slice(src.indexOf("streamLLM({"));
      expect(call.slice(0, 600), f).toMatch(/userId/);
      expect(call.slice(0, 600), f).toMatch(/feature: /);
    }
  });
});

describe("background model calls name their workspace", () => {
  /** Calls that pass no workspaceId, each with why the request supplies one. */
  const REQUEST_SCOPED = "Inside a workspace procedure: the request context supplies the workspace.";
  const ALLOWED: Record<string, string> = {
    "server/llmStreamRoute.ts::/api/llm/stream": "Passes the route's workspaceId inside params.",
    "server/routers/researchPipeline.ts::llmJson": "Called only from researchPipeline.start, a workspace procedure.",
  };
  for (const k of [
    "accountBriefs.ts::generate", "aiFeatures.ts::scoreChurnRisk", "aiFeatures.ts::bulkScoreChurnRisk", "aiFeatures.ts::suggestNextAction",
    "aiFeatures.ts::scoreRelStrength", "aiFeatures.ts::suggestPricing", "aiFeatures.ts::generateCommentary", "aiFeatures.ts::triageThread",
    "aiFeatures.ts::bulkTriage", "aiPipeline.ts::regenerateDraft", "aiPipeline.ts::scoreDraft", "calendar.ts::summarizeMeeting",
    "crm.ts::enrich", "crm.ts::rescore", "cs.ts::generateQbrPrep", "emailBuilder.ts::rewriteBlock", "emailBuilder.ts::generate",
    "helpCenter.ts::askAI", "helpCenter.ts::generateArticleDraft", "mailbox.ts::aiDraftReply", "mailbox.ts::aiDraftForward",
    "opportunityIntelligence.ts::generateIntelligence", "proposals.ts::generateSectionContent", "subjectAB.ts::generate",
  ]) ALLOWED[`server/routers/${k}`] = REQUEST_SCOPED;

  it("every call outside a request passes workspaceId; the list is checked both ways", () => {
    const missing = findLlmCallSites().filter((s) => !/\bworkspaceId\b/.test(s.args)).map((s) => s.key);
    expect(missing.filter((k) => !ALLOWED[k]), "a new model call with no workspaceId").toEqual([]);
    expect(Object.keys(ALLOWED).filter((k) => !missing.includes(k)), "allowed entries whose call is gone or now passes it").toEqual([]);
  });

  it("signal enhancement is off: nothing calls it, and an email open notifies once (A38)", () => {
    const exec = read("server/routers/are/execution.ts");
    expect(exec).not.toMatch(/runSignalEnhancement\(/);
    expect(exec).not.toMatch(/Hook enhancement is running/);
  });
});

/* ── A39: ICP regeneration ──────────────────────────────────────────────── */

const icpJson = JSON.stringify({
  targetIndustries: [], targetCompanySizeMin: 1, targetCompanySizeMax: 10, targetRevenueMin: 0, targetRevenueMax: 0,
  targetTitles: [], targetGeographies: [], targetTechStack: [], antiPatterns: [], topConversionSignals: [], aiRationale: "r",
});

describe("ICP regeneration is metered, one at a time, and all-or-nothing (A39)", () => {
  it("bills the workspace, and a second run while one is going is refused", async () => {
    h.reply = icpJson;
    const first = runIcpInference(LSI);
    const second = await refusal(runIcpInference(LSI));
    await first;
    expect(second.code).toBe("CONFLICT");
    expect(qty({ workspaceId: LSI, feature: "are.icpInference", meter: "input_tokens" })).toBe(1000);
    expect(rows("icp_profiles").filter((p) => p.isActive)).toHaveLength(1);
    await runIcpInference(LSI); // the lock is released
    expect(rows("icp_profiles").map((p) => [p.version, p.isActive])).toEqual([[1, false], [2, true]]);
  });

  it("a restore that fails half-way leaves the active version active", async () => {
    let updates = 0;
    h.db = makeSqlFakeDb({ realMembers: true, beforeUpdate: (t) => { if (t === "icp_profiles" && ++updates === 2) throw new Error("lost connection"); } });
    seed();
    rows("icp_profiles").push(
      { id: 1, workspaceId: LSI, version: 1, isActive: false, confidenceScore: 10 },
      { id: 2, workspaceId: LSI, version: 2, isActive: true, confidenceScore: 20 },
    );
    await expect(caller(ADMIN).are.icp.restore({ id: 1 })).rejects.toThrow(/lost connection/);
    expect(rows("icp_profiles").map((p) => [p.id, p.isActive])).toEqual([[1, false], [2, true]]);
  });
});

/* ── Shared keys: opt-in per workspace (owner 2026-10-27) ───────────────── */

describe("the deployment's Reoon and QuickEnrich keys are opt-in per workspace", () => {
  it("Reoon: own key first; the shared key only when allowed and under the cap; never without a workspace", async () => {
    expect(await getReoonKey(LSI)).toBe("");
    settings(LSI).sharedReoonKey = true;
    expect(await getReoonKey(LSI)).toBe("env-reoon");
    settings(LSI).sharedReoonDailyCap = 2;
    // Only the shared key's own units count toward its cap.
    await recordSpend({ workspaceId: LSI, vendor: "reoon", meter: "daily_credits", quantity: 5, keySource: "workspace", feature: "x" });
    await recordSpend({ workspaceId: LSI, vendor: "reoon", meter: "daily_credits", quantity: 1, keySource: "shared", feature: "x" });
    expect(await getReoonKey(LSI)).toBe("env-reoon");
    await recordSpend({ workspaceId: LSI, vendor: "reoon", meter: "bulk_emails", quantity: 1, keySource: "shared", feature: "x" });
    expect(await getReoonKey(LSI)).toBe("");
    settings(LSI).reoonApiKeyEnc = encryptSecret("ws-reoon");
    expect(await getReoonKey(LSI)).toBe("ws-reoon");
    settings(LSI).reoonVerificationEnabled = false;
    expect(await getReoonKey(LSI)).toBe("");
    expect(await getReoonKey(undefined)).toBe("");
    expect(await getReoonKey(CF)).toBe("");
  });

  it("QuickEnrich: the same rule", async () => {
    expect(await getQuickEnrichKey(LSI)).toBe("");
    settings(LSI).sharedQuickenrichKey = true;
    expect(await getQuickEnrichKey(LSI)).toBe("env-qe");
    settings(LSI).quickenrichApiKeyEnc = encryptSecret("ws-qe");
    expect(await getQuickEnrichKey(LSI)).toBe("ws-qe");
    expect(await getQuickEnrichKey(null)).toBe("");
  });

  it("the settings cards say which key is in use, and why the shared one is not", async () => {
    const card = await caller(ADMIN).reoon.get();
    expect(card).toEqual(expect.objectContaining({ configured: false, source: "none", sharedKeyNote: expect.stringMatching(/not allowed the shared one/) }));
    settings(LSI).sharedReoonKey = true;
    expect(await caller(ADMIN).reoon.get()).toEqual(expect.objectContaining({ configured: true, source: "env", sharedKeyNote: null }));
    expect(await caller(ADMIN).quickenrich.get()).toEqual(expect.objectContaining({ source: "none", sharedKeyNote: expect.any(String) }));
  });

  it("the migration switches shared Reoon on for workspaces 2, 4 and 5 only, and only where they have no key", () => {
    const m = read("server/_core/rawMigrations.ts");
    const block = m.slice(m.indexOf('name: "0215_spend_ledger.sql"'));
    expect(block).toMatch(/SET `sharedReoonKey` = true WHERE `workspaceId` IN \(2, 4, 5\) AND \(`reoonApiKeyEnc` IS NULL OR `reoonApiKeyEnc` = ''\)/);
    expect(block.slice(0, block.indexOf("},"))).not.toMatch(/sharedQuickenrichKey` = true/);
  });
});

describe("Reoon and QuickEnrich calls are counted where they are paid for", () => {
  it("a single verification is one credit from the pool its mode draws on, billed to the key that paid", async () => {
    await reoonVerifySingle("a@x.example", "env-reoon", "power", { workspaceId: LSI, feature: "t" });
    await reoonVerifySingle("a@x.example", "env-reoon", "quick", { workspaceId: LSI, feature: "t" });
    await reoonVerifySingle("a@x.example", "ws-reoon", "power", { workspaceId: LSI, feature: "t" });
    expect(qty({ meter: "daily_credits", keySource: "shared" })).toBe(1);
    expect(qty({ meter: "instant_credits", keySource: "shared" })).toBe(1);
    expect(qty({ meter: "daily_credits", keySource: "workspace" })).toBe(1);
    http.reoonStatus = 500;
    await expect(reoonVerifySingle("a@x.example", "env-reoon", "power", { workspaceId: LSI, feature: "t" })).rejects.toThrow();
    expect(qty({ meter: "daily_credits" })).toBe(2);
  });

  it("a bulk task counts the addresses Reoon will check", async () => {
    await reoonCreateBulkTask(["a@x.example", "b@x.example"], "env-reoon", { workspaceId: LSI, feature: "t" });
    expect(qty({ meter: "bulk_emails", keySource: "shared" })).toBe(2);
  });

  it("a QuickEnrich lookup counts a credit only when an address comes back (P84); a search is counted free", async () => {
    await quickenrichFindEmailByLinkedIn("ws-qe", "https://linkedin.com/in/miss", { workspaceId: LSI, feature: "t" });
    expect(qty({ vendor: "quickenrich", meter: "email_hits" })).toBe(0);
    const hit = await quickenrichFindEmailByLinkedIn("ws-qe", "https://linkedin.com/in/hit", { workspaceId: LSI, feature: "t" });
    expect(hit.email).toBe("jo@county.gov");
    expect(ledger({ vendor: "quickenrich", meter: "email_hits" })).toEqual([expect.objectContaining({ quantity: 1, keySource: "workspace" })]);
    await quickenrichContactFinder("env-qe", { title: { include: ["x"] } }, { workspaceId: LSI, feature: "t" });
    expect(ledger({ vendor: "quickenrich", meter: "searches" })).toEqual([expect.objectContaining({ quantity: 1, keySource: "shared" })]);
  });

  it("every paid vendor call passes who pays (a new call site cannot spend uncounted)", () => {
    const files = [
      "server/routers/are/prospects.ts", "server/routers/prospects.ts", "server/routers/emailVerification.ts",
      "server/services/enrichment/comprehensivePass.ts", "server/services/enrichmentSweeper.ts", "server/services/scraper/index.ts",
      "server/areEngine.ts", "server/services/discovery/index.ts", "server/services/prospectSources/adapters/quickenrich.ts",
      "server/services/prospectSources/adapters/apollo.ts", "server/services/apollo.ts",
    ];
    const argCount = (src: string, open: number) => {
      let depth = 0, n = 1;
      for (let i = open; i < src.length; i++) {
        const c = src[i];
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) { depth--; if (depth === 0) return n; }
        else if (c === "," && depth === 1) n++;
      }
      return -1;
    };
    const want: Record<string, number> = { reoonVerifySingle: 4, reoonCreateBulkTask: 3, quickenrichFindEmailByLinkedIn: 3, quickenrichContactFinder: 3, apolloSearchPeople: 3 };
    for (const f of files) {
      const src = read(f);
      for (const [fn, n] of Object.entries(want)) {
        const re = new RegExp(`\\b${fn}\\(`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(src))) {
          if (/function\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
          expect(argCount(src, m.index + fn.length), `${f}: ${fn} at ${m.index}`).toBe(n);
        }
      }
    }
  });
});

/* ── P10: bulk verification ─────────────────────────────────────────────── */

const contact = (id: number, email: string | null, over: Record<string, unknown> = {}) => rows("contacts").push({
  id, workspaceId: LSI, accountId: null, firstName: `C${id}`, lastName: "Lee", email, isPrimary: false,
  emailVerificationStatus: "unknown", emailVerifiedAt: null, createdAt: new Date("2026-10-01T12:00:00Z"), ...over,
});
const bulkCreates = () => http.calls.filter((c) => c.url.includes("create-bulk"));

describe("bulk verification needs ids or an admin, runs one job at a time, and stays in the cap (P10)", () => {
  beforeEach(() => { settings(LSI).reoonApiKeyEnc = encryptSecret("ws-reoon"); });

  it("a rep verifies what they selected, each address once; the whole workspace is for admins", async () => {
    contact(1, "Jo@County.gov"); contact(2, "jo@county.gov"); contact(3, "al@county.gov");
    expect((await refusal(caller(REP).emailVerification.verifyBulk({}))).code).toBe("FORBIDDEN");
    const r = await caller(REP).emailVerification.verifyBulk({ contactIds: [1, 2, 3] });
    expect(r.totalEmails).toBe(2);
    expect(bulkCreates()[0].body.emails).toEqual(["Jo@County.gov", "al@county.gov"]);
    expect(qty({ workspaceId: LSI, meter: "bulk_emails", keySource: "workspace", feature: "emailVerification.verifyBulk" })).toBe(2);
  });

  it("refuses a second job while one is running, and more than BULK_VERIFY_MAX ids", async () => {
    contact(1, "a@county.gov");
    await caller(ADMIN).emailVerification.verifyBulk({});
    const again = await refusal(caller(ADMIN).emailVerification.verifyBulk({ contactIds: [1] }));
    expect(again.code).toBe("CONFLICT");
    expect(again.message).toMatch(/already running/);
    expect(bulkCreates()).toHaveLength(1);
    const ids = Array.from({ length: BULK_VERIFY_MAX + 1 }, (_, i) => i + 1);
    expect((await refusal(caller(ADMIN).emailVerification.verifyBulk({ contactIds: ids }))).code).toBe("BAD_REQUEST");
  });

  it("a job lost by Reoon for a day no longer blocks the next", async () => {
    contact(1, "a@county.gov");
    rows("email_verification_jobs").push({ id: 9, workspaceId: LSI, reoonTaskId: "1", status: "running", totalEmails: 10, checkedEmails: 0, progressPct: "0", createdAt: new Date(T0 - 25 * 3600_000) });
    await caller(ADMIN).emailVerification.verifyBulk({ contactIds: [1] });
    expect(bulkCreates()).toHaveLength(1);
  });

  it("stays inside the shared key's daily cap", async () => {
    delete settings(LSI).reoonApiKeyEnc;
    Object.assign(settings(LSI), { sharedReoonKey: true, sharedReoonDailyCap: 1 });
    contact(1, "a@county.gov"); contact(2, "b@county.gov");
    const r = await refusal(caller(ADMIN).emailVerification.verifyBulk({ contactIds: [1, 2] }));
    expect(r.code).toBe("PRECONDITION_FAILED");
    expect(r.message).toMatch(/room for 1 more/);
    expect(bulkCreates()).toHaveLength(0);
  });

  it("'Run now' is for admins and says what it did; the schedule skips archived workspaces", async () => {
    expect((await refusal(caller(REP).emailVerification.triggerReverifyNow())).code).toBe("FORBIDDEN");
    expect(await caller(ADMIN).emailVerification.triggerReverifyNow()).toEqual({ started: false, emails: 0, reason: "the re-verify schedule is off" });
    Object.assign(settings(LSI), { reverifyIntervalDays: 30, reverifyStatuses: ["risky"] });
    contact(1, "a@county.gov", { emailVerificationStatus: "risky" });
    // A job already running: the schedule does not start a second.
    rows("email_verification_jobs").push({ id: 5, workspaceId: LSI, reoonTaskId: "5", status: "running", totalEmails: 3, checkedEmails: 0, progressPct: "0", createdAt: new Date(T0 - 3600_000) });
    expect(await caller(ADMIN).emailVerification.triggerReverifyNow()).toEqual({ started: false, emails: 0, reason: "a verification job is already running" });
    expect(bulkCreates()).toHaveLength(0);
    rows("email_verification_jobs").find((j) => j.id === 5).status = "completed";
    rows("workspaces").find((w) => w.id === LSI).archivedAt = new Date("2026-11-01T00:00:00Z");
    await runDailyVerificationMaintenance();
    expect(bulkCreates()).toHaveLength(0);
    rows("workspaces").find((w) => w.id === LSI).archivedAt = null;
    await runDailyVerificationMaintenance();
    expect(bulkCreates()).toHaveLength(1);
    expect(qty({ meter: "bulk_emails", feature: "emailVerification.reverify" })).toBe(1);
  });
});

/* ── P69, A33: the source waterfall ─────────────────────────────────────── */

describe("previews spend no caps, and nothing is bought that the free filters drop", () => {
  const rec = (id: string, over: Record<string, unknown> = {}) => ({
    externalId: id, firstName: "A", lastName: id, jobTitle: "County Administrator", seniority: null, companyName: "County",
    companyDomain: "county.gov", email: null, emailIsMasked: true, emailVerifiedAt: null, mobilePhone: null, businessPhone: null,
    linkedinUrl: null, city: null, stateProvince: null, country: null, industry: null, headcount: null, rawSourcePayload: {}, ...over,
  });
  function source(records: any[]) {
    const used: number[] = [];
    const acquired: string[][] = [];
    const s: any = {
      slug: "warmysender", displayName: "W", docsUrl: "", credentialMode: "table", acquisition: "on_demand",
      capabilities: () => ({ maxBatchSize: 100 }), budgetPeriods: () => [],
      search: async () => ({ ok: true, records, nextCursor: null, alreadyCharged: false, unitsSpent: 0 }),
      acquire: async (ids: string[]) => { acquired.push(ids); return { ok: true, records: ids.map((i) => ({ ...rec(i), email: `${i}@county.gov`, emailIsMasked: false })), unitsSpent: ids.length, failedExternalIds: [] }; },
      recordUsage: async (_ws: number, n: number) => { used.push(n); },
    };
    const eligible: any = { source: s, credentials: { slug: "warmysender", workspaceId: LSI, secrets: { apiKey: "k" }, config: {} }, capabilities: { maxBatchSize: 100 }, match: { verdict: "full" }, leadsRemaining: null };
    return { eligible, used, acquired };
  }

  it("a preview writes nothing to the pull ledger the daily caps read (P69)", async () => {
    const { eligible, used } = source([rec("1"), rec("2")]);
    await runWaterfall({ workspaceId: LSI, criteria: {} as any, target: 5, sources: [eligible], deduper: new Deduper(), mode: "preview" });
    expect(used).toEqual([]);
    await runWaterfall({ workspaceId: LSI, criteria: {} as any, target: 5, sources: [eligible], deduper: new Deduper(), mode: "acquire" });
    expect(used).toEqual([2]);
  });

  it("the screen runs on the free preview, before the paid export (A33)", async () => {
    const { eligible, acquired } = source([rec("keep"), rec("never", { jobTitle: "Intern" }), rec("bare", { jobTitle: null, companyDomain: null })]);
    const res = await runWaterfall({
      workspaceId: LSI, criteria: {} as any, target: 5, sources: [eligible], deduper: new Deduper(), mode: "acquire",
      screen: (r) => (/intern/i.test(r.jobTitle ?? "") ? "never-target" : !r.jobTitle && !r.companyDomain ? "no anchor" : null),
    });
    expect(acquired).toEqual([["keep"]]);
    expect(res.perSource[0]).toEqual(expect.objectContaining({ netNew: 1, acquired: 1, screened: 2 }));
  });

  it("the engine screens with the campaign's never-target words and the anchor rule, and keeps to its open slots (A32)", () => {
    const eng = read("server/areEngine.ts");
    const reg = eng.slice(eng.indexOf("async function discoverViaRegistrySource("), eng.indexOf("async function discoverViaApollo("));
    expect(reg).toMatch(/screen: \(rec\) => \{[\s\S]*neverTargetHit\(neverTarget,[\s\S]*no company domain or title/);
    expect(eng).toMatch(/apollo: \(remaining\) =>\s*discoverViaApollo\([^)]*remaining\)/);
    expect(eng).toMatch(/quickenrich: \(remaining\) =>\s*discoverViaQuickenrich\([^)]*remaining\)/);
    expect(eng).toMatch(/const kept = ready\.slice\(0, Math\.max\(0, Math\.min\(headroom, remaining\)\)\);/);
    expect(eng).toMatch(/const kept = ranked\.slice\(0, Math\.max\(0, Math\.min\(headroom, remaining\)\)\);/);
  });
});

/* ── The cost report and the owner's switches ───────────────────────────── */

describe("the cost report", () => {
  it("prices only what has a list price on file", () => {
    expect(unitCostUsd("anthropic", "input_tokens", "claude-opus-5-5-20261001", 1_000_000)).toBe(4);
    expect(unitCostUsd("anthropic", "output_tokens", "claude-opus-5-5", 1_000_000)).toBe(20);
    expect(unitCostUsd("anthropic", "web_searches", "", 100)).toBe(1);
    expect(unitCostUsd("anthropic", "input_tokens", "claude-haiku-4-5-20251001", 1_000_000)).toBeNull();
    expect(unitCostUsd("reoon", "daily_credits", "", 10)).toBeNull();
  });

  it("puts each vendor unit on one line with a column per UTC day", () => {
    const days = dayRange("2026-11-16", TODAY);
    expect(days).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
    const base = { workspaceId: LSI, vendor: "reoon", meter: "daily_credits", model: "", keySource: "shared", calls: 1 };
    const s = summarizeSpend([
      { ...base, day: "2026-11-16", feature: "a", quantity: 3 },
      { ...base, day: "2026-11-18", feature: "b", quantity: 2 },
      { ...base, day: "2026-11-01", feature: "a", quantity: 99 },
    ], days);
    expect(s.lines).toEqual([expect.objectContaining({ perDay: { "2026-11-16": 3, "2026-11-18": 2 }, total: 5, calls: 2, estUsd: null })]);
    expect(s.features.map((f) => [f.feature, f.total])).toEqual([["a", 3], ["b", 2]]);
  });

  it("shows the workspace its own week; only the platform owner sees every workspace and switches the keys", async () => {
    await recordSpend({ workspaceId: LSI, vendor: "reoon", meter: "daily_credits", quantity: 4, keySource: "shared", feature: "x" });
    await recordSpend({ workspaceId: CF, vendor: "reoon", meter: "daily_credits", quantity: 9, keySource: "shared", feature: "x" });
    const mine = await caller(ADMIN).spend.report({ days: 7 });
    expect(mine.days).toHaveLength(7);
    expect(mine.lines).toEqual([expect.objectContaining({ total: 4 })]);

    // A workspace super_admin is not the platform owner.
    expect((await refusal(caller(ADMIN).spend.platform({ days: 7 }))).code).toBe("FORBIDDEN");
    expect((await refusal(caller(ADMIN).spend.setSharedKey({ workspaceId: LSI, vendor: "reoon", allowed: true, dailyCap: null }))).code).toBe("FORBIDDEN");

    const p = await caller(OWNER).spend.platform({ days: 7 });
    expect(p.sharedKeys.lines).toEqual([expect.objectContaining({ total: 13 })]);
    expect(p.workspaces.map((w) => [w.id, w.sharedReoonKey, w.summary.lines[0]?.total])).toEqual([[LSI, false, 4], [CF, false, 9]]);

    await caller(OWNER).spend.setSharedKey({ workspaceId: CF, vendor: "reoon", allowed: true, dailyCap: 500 });
    expect(settings(CF)).toEqual(expect.objectContaining({ sharedReoonKey: true, sharedReoonDailyCap: 500 }));
    expect(h.audits).toEqual([expect.objectContaining({ workspaceId: CF, actorUserId: OWNER, entityType: "workspace_settings" })]);
    expect(await getReoonKey(CF)).toBe("env-reoon");
  });
});
