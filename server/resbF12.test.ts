/**
 * The per-source health strip, finished (audit 2026-10-20, F12, batch RESB),
 * against the real engine and router and the SQL fake. The one source that
 * runs is a stubbed News scrape; no vendor or model is called.
 *
 *   tokens per source  a source's model calls are recorded under its own
 *                      feature while it runs for a campaign, and the strip
 *                      sums them
 *   last success       stored when a source returned people that were saved,
 *                      and read back; an empty run does not move it
 *   admitted           of the people a source kept in the queue, how many
 *                      left staging and were not rejected
 *   LinkedIn           its last attempt shows on success (it was keyed by the
 *                      scrape-job name and never found), and its allowance is
 *                      lookups left today
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, news: null as null | ((ws: number) => Promise<any[]>), accounts: [] as any[] }));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./routers/are/scraper", async (a) => ({
  ...(await a<typeof import("./routers/are/scraper")>()),
  scrapeNews: async (ws: number) => h.news!(ws),
}));
vi.mock("./services/prospectSources/registry", async (a) => ({ ...(await a<typeof import("./services/prospectSources/registry")>()), describeSources: async () => [] }));
vi.mock("./services/linkedinLookup", async (a) => ({ ...(await a<typeof import("./services/linkedinLookup")>()), listUsableAccounts: async () => h.accounts }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { DISCOVERY_SOURCE_FEATURE, runDiscovery, __resetEngineLogRepeatsForTests } from "./areEngine";
import { recordSpend, spendDay } from "./services/spend";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const campaign = () => rows("are_campaigns").find((c) => c.id === 7);
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const sourceOf = async (slug: string) => (await caller().are.campaigns.sourceHealth({ campaignId: 7 })).sources.find((s: any) => s.slug === slug)!;

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.accounts = [];
  __resetEngineLogRepeatsForTests();
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("workspace_settings").push({ workspaceId: WS, areScraperSources: null, areSourceOrder: null, icpFallback: null, timezone: "UTC" });
  rows("are_campaigns").push({
    id: 7, workspaceId: WS, name: "Counties", status: "active", targetProspectCount: 10,
    prospectSources: ["news"], icpOverrides: { targetTitles: ["County Administrator"] },
    discoveryQueryState: null, researchSectorId: null, researchPersonaId: null,
  });
  // A model call made inside the source, naming no feature of its own, as the scrapers' calls do.
  h.news = async (ws) => {
    await recordSpend({ workspaceId: ws, vendor: "anthropic", meter: "input_tokens", model: "claude-haiku-4-5", quantity: 1200, keySource: "workspace" });
    await recordSpend({ workspaceId: ws, vendor: "anthropic", meter: "output_tokens", model: "claude-haiku-4-5", quantity: 300, keySource: "workspace" });
    return [{ firstName: "Ann", lastName: "Lee", title: "County Administrator", companyName: "Polk County", companyDomain: "polk.example" }];
  };
});

describe("the strip says what each source earned and spent (F12)", () => {
  it("records a source's tokens under its own feature, stores its last success, and the strip reads both", async () => {
    await runDiscovery(campaign(), 5);
    const ledger = rows("spend_ledger").filter((r) => r.feature === DISCOVERY_SOURCE_FEATURE("news", 7));
    expect(ledger.map((r) => r.meter).sort()).toEqual(["input_tokens", "output_tokens"]);
    expect(campaign().discoveryQueryState.ok.news).toEqual(expect.any(Number));

    const news = await sourceOf("news");
    expect(news.tokensToday).toBe(1500);
    expect(news.lastSuccessAt).toEqual(expect.any(String));
    expect(news.lastAttempt).toMatchObject({ raw: 1, kept: 1 });
    expect(news.yield.kept).toBe(1);
    expect(news.aiCallsPerRun).toBe(1);
    // Another campaign's tokens, or another day's, are not this source's here.
    rows("spend_ledger").push({ id: 99, workspaceId: WS, day: spendDay(), vendor: "anthropic", meter: "input_tokens", model: "", keySource: "workspace", feature: DISCOVERY_SOURCE_FEATURE("news", 8), quantity: 5000, calls: 1 });
    expect((await sourceOf("news")).tokensToday).toBe(1500);
  });

  it("an empty run does not move the last success", async () => {
    await runDiscovery(campaign(), 5);
    const first = campaign().discoveryQueryState.ok.news;
    let asked = 0;
    h.news = async () => { asked++; return []; };
    campaign().discoveryQueryState.lastRunNew = 1; // not resting
    campaign().discoveryQueryState.slices = [];
    await new Promise((r) => setTimeout(r, 5));
    await runDiscovery(campaign(), 5);
    expect(asked).toBe(1);
    expect(campaign().discoveryQueryState.ok.news).toBe(first);
  });

  it("counts the admitted step: queued people who left staging and were not rejected", async () => {
    const q = (id: number, sourceType: string, sequenceStatus: string, campaignId = 7) =>
      rows("prospect_queue").push({ id, workspaceId: WS, campaignId, sourceType, sequenceStatus, firstName: "x", lastName: "y" });
    q(1, "news_event", "pending"); q(2, "news_event", "enrolled"); q(3, "news_event", "sourcing"); q(4, "news_event", "skipped");
    q(5, "apollo", "approved"); q(6, "news_event", "pending", 8);
    expect((await sourceOf("news")).yield).toEqual({ kept: 4, admitted: 2 });
    expect((await sourceOf("apollo")).yield).toEqual({ kept: 1, admitted: 1 });
    expect((await sourceOf("internal")).yield).toEqual({ kept: 0, admitted: 0 });
  });

  it("LinkedIn's successful attempt is found, and its allowance is lookups left today", async () => {
    h.accounts = [{ unipileAccountId: "a", remainingToday: 70 }, { unipileAccountId: "b", remainingToday: 5 }];
    // A summary written before 2026-11-07 keyed LinkedIn by its scrape-job name.
    rows("are_engine_logs").push({ id: 1, workspaceId: WS, campaignId: 7, phase: "discovery", level: "info",
      message: "Discovery slice 1/1 \"x\" → 3 new across 1 sources (waterfall, 5 open slots)",
      details: { perSource: { linkedin_people: { raw: 4, new: 3 } } }, createdAt: new Date(), lastSeenAt: null });
    const li = await sourceOf("linkedin");
    expect(li.lastAttempt).toMatchObject({ raw: 4, kept: 3 });
    expect(li.lookupsLeftToday).toBe(75);
    expect((await sourceOf("news")).lookupsLeftToday).toBeNull();
  });
});
