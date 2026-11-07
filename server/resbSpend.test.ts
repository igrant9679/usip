/**
 * Spend said before it happens (audit 2026-10-20, batch RESB: F8, U16, and
 * F43's accept-all skip, which Run Now's count includes). Against the real
 * routers and the SQL fake; vendors are mocked and never called.
 *
 *   U16  spend.budgets: each paid source's allowance left today, from the caps
 *        and ledgers the sources enforce · the launcher line and the AI-call
 *        estimate, pinned to the code that makes the calls
 *   F8   an estimate and a ceiling per research run: the estimate, the
 *        ceiling stored on the run, and the engine stopping under it · the
 *        monthly spend card · Run now's preview is the run's own plan
 *   F43  a re-verify skips addresses at domains that answered accept-all
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  apolloKey: "",
  qeKey: "",
  reoonKey: "",
  accounts: [] as any[],
  calls: [] as any[],
  script: [] as any[],
  enqueued: [] as number[],
  bulk: [] as string[][],
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/apollo", async (a) => ({ ...(await a<typeof import("./services/apollo")>()), getApolloKey: async () => h.apolloKey }));
vi.mock("./services/quickenrich", async (a) => ({ ...(await a<typeof import("./services/quickenrich")>()), getQuickEnrichKey: async () => h.qeKey }));
vi.mock("./services/reoon", async (a) => ({
  ...(await a<typeof import("./services/reoon")>()),
  getReoonKey: async () => h.reoonKey,
  reoonCreateBulkTask: async (emails: string[]) => { h.bulk.push(emails); return { task_id: 9, count_processing: emails.length }; },
}));
vi.mock("./services/linkedinLookup", async (a) => ({ ...(await a<typeof import("./services/linkedinLookup")>()), listUsableAccounts: async () => h.accounts }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  workspaceAnthropicKey: async () => "sk-ant-test",
  runAnthropicServerTools: async (args: any) => {
    h.calls.push(args);
    const next = h.script.shift();
    if (!next) throw new Error("unscripted Anthropic call");
    return next;
  },
}));
vi.mock("./services/research/engine", async (a) => ({
  ...(await a<typeof import("./services/research/engine")>()),
  enqueueResearchJob: (id: number) => { h.enqueued.push(id); },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { runResearchJob } from "./services/research/engine";
import { spendDay } from "./services/spend";
import { usageMonthKey } from "./usageCounters";
import {
  AI_CALLS_PER_SOURCE, ENRICH_FULLY_MAX, aiCallEstimate, aiCallText, enrichFullyText, launcherBudgetLine, paidLookupText,
} from "@shared/spendPreview";
import { DEFAULT_RESEARCH_CEILING_USD, TYPICAL_RESEARCH_USAGE, requestCostUsd, researchEstimate } from "@shared/researchModels";

const WS = 2;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.apolloKey = ""; h.qeKey = ""; h.reoonKey = "";
  h.accounts = []; h.calls = []; h.script = []; h.enqueued = []; h.bulk = [];
  delete process.env.REOON_API_KEY;
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
});

describe("each source's allowance left today, before running (U16)", () => {
  it("reads the caps and ledgers the sources enforce", async () => {
    h.apolloKey = "apollo-test";
    h.reoonKey = "shared-reoon";
    process.env.REOON_API_KEY = "shared-reoon";
    h.accounts = [{ unipileAccountId: "a", remainingToday: 80 }, { unipileAccountId: "b", remainingToday: 100 }];
    rows("workspace_settings").push({ workspaceId: WS, apolloDailyPullCap: 500, quickenrichDailyPullCap: 300, sharedReoonKey: true, sharedReoonDailyCap: 1000, llmMonthlyTokenCap: 2_000_000 });
    rows("are_scrape_jobs").push(
      { id: 1, workspaceId: WS, campaignId: null, sourceType: "apollo", resultCount: 300, scrapedAt: new Date() },
      { id: 2, workspaceId: WS, campaignId: 4, sourceType: "apollo", resultCount: 80, scrapedAt: new Date() },
      // Yesterday's pulls are yesterday's.
      { id: 3, workspaceId: WS, campaignId: null, sourceType: "apollo", resultCount: 50, scrapedAt: new Date(Date.now() - 2 * 86_400_000) },
    );
    rows("spend_ledger").push({ id: 1, workspaceId: WS, day: spendDay(), vendor: "reoon", meter: "daily_credits", model: "", keySource: "shared", feature: "x", quantity: 240, calls: 240 });
    rows("usage_counters").push({ id: 1, workspaceId: WS, month: usageMonthKey(), llmTokens: 120_000, emailsSent: 0 });

    const b = await caller().spend.budgets();
    expect(b.apollo).toEqual({ configured: true, allowance: { used: 380, cap: 500 } });
    expect(b.quickenrich).toEqual({ configured: false, allowance: { used: 0, cap: 300 } });
    expect(b.linkedin).toEqual({ accounts: 2, left: 180, cap: 200 });
    expect(b.reoon).toEqual({ configured: true, keySource: "shared", allowance: { used: 240, cap: 1000 } });
    expect(b.ai).toEqual({ used: 120_000, cap: 2_000_000 });

    // The launcher's line, in the owner's words.
    expect(launcherBudgetLine(["linkedin", "news", "apollo", "quickenrich"], b)).toBe(
      "Apollo: 120 of 500 left today · QuickEnrich: no key, skipped · LinkedIn: 180 of 200 lookups left today · up to 1 AI call",
    );
  });

  it("the AI-call estimate matches the sources that make model calls", () => {
    expect(aiCallEstimate(["linkedin", "apollo", "quickenrich"])).toBe(0);
    expect(aiCallEstimate(["google_business", "news", "apollo"])).toBe(4);
    const scraper = read("server/routers/are/scraper.ts");
    const gbFrom = scraper.slice(scraper.indexOf("export async function scrapeGoogleBusiness("));
    const gb = gbFrom.slice(0, gbFrom.indexOf("\n}\n"));
    expect(gb).toContain(`pages = ${AI_CALLS_PER_SOURCE.google_business},`);
    expect(gb.match(/invokeLLM\(/g)).toHaveLength(1);
    const news = scraper.slice(scraper.indexOf("export async function scrapeNews("));
    const newsBody = news.slice(0, news.indexOf("\n}\n"));
    expect(newsBody.match(/invokeLLM\(/g)).toHaveLength(AI_CALLS_PER_SOURCE.news);
  });

  it("Enrich fully's ceiling per person matches what the pass can spend", () => {
    expect(read("server/services/scraper/emailPatterns.ts").match(/\{ email: `/g)).toHaveLength(ENRICH_FULLY_MAX.reoonInstant);
    expect(ENRICH_FULLY_MAX.reoonDaily).toBe(ENRICH_FULLY_MAX.reoonInstant + 1);
    expect(read("server/services/enrichment/comprehensivePass.ts")).toContain("credits.power += 1;");
    expect(enrichFullyText(10)).toContain("For 10 people that is at most 10 QuickEnrich, 30 + 40 Reoon and 10 LinkedIn.");
  });

  it("a paid lookup's confirmation names the count, the unit and what today has left", () => {
    expect(paidLookupText({ vendor: "Reoon", count: 40, unit: "bulk credit", allowance: { used: 690, cap: 1000 } }))
      .toBe("This spends up to 40 Reoon bulk credits. 310 of today's 1,000 are left.");
    expect(paidLookupText({ vendor: "LinkedIn", count: 30, unit: "profile lookup", allowance: { used: 180, cap: 200 } }))
      .toContain("Only 20 of today's 200 are left");
    expect(aiCallText(1, { used: 5, cap: null })).toBe("This makes 1 AI call, billed to this workspace's AI provider. This month: 5 tokens used (no monthly budget set).");
  });
});

describe("the monthly spend card (F8)", () => {
  it("sums this calendar month only", async () => {
    const today = spendDay();
    const first = `${today.slice(0, 8)}01`;
    const lastMonth = new Date(Date.parse(`${first}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    rows("spend_ledger").push(
      { id: 1, workspaceId: WS, day: first, vendor: "reoon", meter: "daily_credits", model: "", keySource: "workspace", feature: "a", quantity: 30, calls: 30 },
      { id: 2, workspaceId: WS, day: today, vendor: "reoon", meter: "daily_credits", model: "", keySource: "workspace", feature: "b", quantity: 12, calls: 12 },
      { id: 3, workspaceId: WS, day: lastMonth, vendor: "reoon", meter: "daily_credits", model: "", keySource: "workspace", feature: "a", quantity: 999, calls: 1 },
      { id: 4, workspaceId: 4, day: today, vendor: "reoon", meter: "daily_credits", model: "", keySource: "workspace", feature: "a", quantity: 7, calls: 1 },
    );
    const m = await caller().spend.month();
    expect(m.month).toBe(today.slice(0, 7));
    expect(m.lines).toHaveLength(1);
    expect(m.lines[0].total).toBe(42);
  });
});

describe("an estimate and a ceiling per research run (F8)", () => {
  it("estimates from list price with no history, and from the middle of finished runs with some", async () => {
    let e = await caller().research.runs.estimate();
    expect(e).toMatchObject({ model: "claude-opus-5-5", basis: "list_price", runs: 0, defaultCeilingUsd: DEFAULT_RESEARCH_CEILING_USD });
    expect(e.usd).toBeCloseTo(requestCostUsd("claude-opus-5-5", TYPICAL_RESEARCH_USAGE), 6);
    for (const [i, c] of [["1.00", 1], ["3.00", 2], ["2.00", 3], ["9.00", 4], ["0", 5]] as const) {
      rows("research_jobs").push({ id: c, workspaceId: WS, userId: 1, kind: "market", subject: "M", status: c === 5 ? "failed" : "done", model: "claude-opus-5-5", costUsd: i, createdAt: new Date(), updatedAt: new Date() });
    }
    rows("research_jobs").push({ id: 9, workspaceId: 4, userId: 1, kind: "market", subject: "M", status: "done", model: "claude-opus-5-5", costUsd: "50", createdAt: new Date(), updatedAt: new Date() });
    e = await caller().research.runs.estimate();
    expect(e).toMatchObject({ basis: "history", runs: 4, usd: 2.5 });
    expect(researchEstimate("claude-opus-5-5", [4, 1, 2])).toMatchObject({ usd: 2, runs: 3 });
  });

  it("a run stores the ceiling it was started with, the default when none is given", async () => {
    const a = await caller().research.runs.start({ kind: "market", subject: "Water utilities" });
    expect(Number(rows("research_jobs").find((j) => j.id === a.id).costCeilingUsd)).toBe(DEFAULT_RESEARCH_CEILING_USD);
    rows("research_jobs").find((j) => j.id === a.id).status = "done";
    const b = await caller().research.runs.start({ kind: "market", subject: "Ports", costCeilingUsd: 2.5 });
    expect(Number(rows("research_jobs").find((j) => j.id === b.id).costCeilingUsd)).toBe(2.5);
    await expect(caller().research.runs.start({ kind: "market", subject: "Rail", costCeilingUsd: 0.1 })).rejects.toThrow();
  });

  it("the engine stops researching near the ceiling and drafts from what it has", async () => {
    rows("research_jobs").push({ id: 1, workspaceId: WS, userId: 1, kind: "market", marketId: null, sectorId: null, subject: "Ports", status: "queued", model: "claude-opus-5-5", costUsd: "0", costCeilingUsd: "1.0000", searches: 0, fetches: 0, createdAt: new Date(), updatedAt: new Date() });
    // One research part costs $0.80 at Opus list price (200k input): with the
    // draft's reserve that is past a $1 ceiling, so no second part is asked.
    h.script = [
      { content: [{ type: "text", text: "Found some." }], stop_reason: "pause_turn", usage: { input_tokens: 200_000, output_tokens: 10, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } } },
      { content: [{ type: "tool_use", id: "t", name: "record_market", input: { overview: "x" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 10 } },
    ];
    await runResearchJob(1, new AbortController().signal);
    const job = rows("research_jobs")[0];
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1].params.tools.map((t: any) => t.name)).toEqual(["record_market"]);
    expect(job.status).toBe("done");
    expect(job.progress.map((p: any) => p.line).join("\n")).toContain("near its $1.00 ceiling");
  });

  it("a run queued before ceilings existed runs as it did", async () => {
    rows("research_jobs").push({ id: 1, workspaceId: WS, userId: 1, kind: "market", marketId: null, sectorId: null, subject: "Ports", status: "queued", model: "claude-opus-5-5", costUsd: "0", costCeilingUsd: null, searches: 0, fetches: 0, createdAt: new Date(), updatedAt: new Date() });
    h.script = [
      { content: [{ type: "text", text: "Part one." }], stop_reason: "pause_turn", usage: { input_tokens: 200_000, output_tokens: 10, server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } } },
      { content: [{ type: "text", text: "Part two." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 } },
      { content: [{ type: "tool_use", id: "t", name: "record_market", input: { overview: "x" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 10 } },
    ];
    await runResearchJob(1, new AbortController().signal);
    expect(h.calls).toHaveLength(3);
  });
});

describe("Run now's count is the run's own plan, without accept-all domains (F8, F43)", () => {
  const contact = (id: number, email: string, status: string, verifiedDaysAgo: number | null) => rows("contacts").push({
    id, workspaceId: WS, email, emailVerificationStatus: status,
    emailVerifiedAt: verifiedDaysAgo === null ? null : new Date(Date.now() - verifiedDaysAgo * 86_400_000),
  });

  it("previews the addresses it will send and leaves out those at a domain that answered accept-all", async () => {
    h.reoonKey = "own-key";
    rows("workspace_settings").push({ workspaceId: WS, reverifyIntervalDays: 30, reverifyStatuses: ["risky", "accept_all"] });
    contact(1, "a@risky.example", "risky", 40);
    contact(2, "b@catchall.example", "accept_all", 40);
    contact(3, "c@new.example", "accept_all", null);
    // Another address at catchall.example answered accept-all last week.
    contact(4, "d@catchall.example", "accept_all", 7);
    // A person at new.example answered accept-all too long ago to count.
    rows("prospects").push({ id: 1, workspaceId: WS, email: "e@new.example", emailStatus: "accept_all", emailVerifiedAt: new Date(Date.now() - 60 * 86_400_000) });

    const p = await caller().emailVerification.reverifyPreview();
    expect(p).toMatchObject({ ok: true, emails: 2, due: 3, skippedAcceptAll: 1 });

    const r = await caller().emailVerification.triggerReverifyNow();
    expect(r).toMatchObject({ started: true, emails: 2, skippedAcceptAll: 1 });
    expect(h.bulk[0].sort()).toEqual(["a@risky.example", "c@new.example"]);
  });

  it("a person's recent accept-all counts for the domain as a contact's does", async () => {
    h.reoonKey = "own-key";
    rows("workspace_settings").push({ workspaceId: WS, reverifyIntervalDays: 30, reverifyStatuses: ["accept_all"] });
    contact(1, "b@catchall.example", "accept_all", 40);
    rows("prospects").push({ id: 1, workspaceId: WS, email: "x@catchall.example", emailStatus: "accept_all", emailVerifiedAt: new Date(Date.now() - 2 * 86_400_000) });
    const p = await caller().emailVerification.reverifyPreview();
    expect(p).toMatchObject({ ok: false, emails: 0, due: 1, skippedAcceptAll: 1 });
    expect(p.reason).toContain("accept-all domains");
    const r = await caller().emailVerification.triggerReverifyNow();
    expect(r.started).toBe(false);
    expect(h.bulk).toHaveLength(0);
  });
});
