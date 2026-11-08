/**
 * The Scraper tab's discovery launch searches the whole targeting, and its
 * people go to the campaign (audit 2026-10-20, A56).
 *
 * It searched only the campaign's first title, industry and place, and saved
 * what it found to People alone. Now Apollo and QuickEnrich take every value
 * in their one search each; LinkedIn takes them paired in step, one search a
 * pair, each against today's allowance, stopping at the first refusal; and
 * the saved people are added to the campaign through pushPeopleIntoCampaign.
 *
 * Executed against the SQL-evaluating fake through the persisted job's worker
 * (runQueuedDiscovery). Every vendor and the push are mocked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "e".repeat(64);
  return { db: null as any, li: [] as string[], liRefuseAt: -1, apollo: [] as any[], qe: [] as any[], pushes: [] as Array<{ campaignId: number; ids: number[] }> };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/linkedinLookup", async (a) => ({
  ...(await a<typeof import("./services/linkedinLookup")>()),
  searchLinkedInProfiles: async (o: { keywords: string }) => {
    const i = h.li.length;
    h.li.push(o.keywords);
    if (i === h.liRefuseAt) return { ok: false, message: "today's LinkedIn lookup allowance is used up" };
    return { ok: true, hits: [{ firstName: "Pat", lastName: `Person${i}`, headline: "CFO", company: "Acme", linkedinUrl: `https://www.linkedin.com/in/pat-${i}`, location: "Ohio" }] };
  },
}));
vi.mock("./services/apollo", async (a) => ({
  ...(await a<typeof import("./services/apollo")>()),
  getApolloDailyCap: async () => 100,
  apolloPulledToday: async () => 0,
  apolloSearchPeople: async (_ws: number, input: any) => { h.apollo.push(input); return { ok: true, prospects: [], totalAvailable: 0, pageCount: 0 }; },
}));
vi.mock("./services/quickenrich", async (a) => ({
  ...(await a<typeof import("./services/quickenrich")>()),
  getQuickEnrichKey: async () => "qe-test",
  getQuickenrichDailyPullCap: async () => 100,
  quickenrichPulledToday: async () => 0,
  getQuickenrichIndustries: async () => null,
  quickenrichContactFinder: async (_k: string, body: any) => { h.qe.push(body); return { ok: true, people: [] }; },
}));
vi.mock("./routers/are/scraper", async (a) => ({ ...(await a<typeof import("./routers/are/scraper")>()), scrapeNews: async () => [] }));
vi.mock("./services/are/pushPeople", async (a) => ({
  ...(await a<typeof import("./services/are/pushPeople")>()),
  pushPeopleIntoCampaign: async (_ws: number, campaignId: number, ids: number[]) => {
    h.pushes.push({ campaignId, ids });
    return { added: ids.slice(1).map((prospectId, i) => ({ prospectId, queueId: 900 + i })), skipped: ids.slice(0, 1).map((prospectId) => ({ prospectId, reason: "Already in another campaign (id 3)" })) };
  },
}));
vi.mock("./services/company/associationService", async () => ({ associateUnlinkedProspects: async () => ({ linked: 0, created: 0, needsReview: 0, missing: 0 }) }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { personQueries, runQueuedDiscovery, type DiscoveryJobPayload } from "./services/discovery";
import { campaignLaunchSearches, CAMPAIGN_RUN_MAX_QUERIES } from "@shared/discoveryQueries";

const WS = 2, ME = 20, CAMPAIGN = 7;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "me@example.com", name: "Me", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const LAUNCH = { jobTitles: ["CFO", "Controller", "Treasurer"], industries: ["Nonprofit Organization Management"], locations: ["Ohio", "Kentucky"] };

/** A queued run, as discovery.search leaves it, worked by the job. */
const work = async (input: Record<string, unknown>, extra: Partial<DiscoveryJobPayload> = {}) => {
  rows("discovery_runs").push({ id: 50, workspaceId: WS, userId: ME, campaignId: CAMPAIGN, mode: "person", input, status: "running", fanOutStartedAt: null, startedAt: new Date() });
  return runQueuedDiscovery(WS, { runId: 50, mode: "person", input: input as never, campaignId: CAMPAIGN, sources: null, fingerprint: "f", ...extra });
};

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  h.li = []; h.liRefuseAt = -1; h.apollo = []; h.qe = []; h.pushes = [];
  rows("workspace_settings").push({ workspaceId: WS, areSourceOrder: null, areScraperSources: null });
  rows("are_campaigns").push({ id: CAMPAIGN, workspaceId: WS, name: "Ohio nonprofits", status: "active", icpOverrides: {} });
});

describe("a campaign launch searches every title, industry and place", () => {
  it("LinkedIn: one search per pair, so each value is in one; Apollo and QuickEnrich: one search with all", async () => {
    await work(LAUNCH, { addToCampaign: true });
    expect(h.li).toEqual([
      "CFO Nonprofit Organization Management Ohio",
      "Controller Nonprofit Organization Management Kentucky",
      "Treasurer Nonprofit Organization Management Ohio",
    ]);
    expect(h.apollo).toHaveLength(1);
    expect(h.apollo[0]).toMatchObject({ titles: LAUNCH.jobTitles, industries: LAUNCH.industries, locations: LAUNCH.locations });
    expect(h.qe.length).toBeGreaterThanOrEqual(1);
    for (const t of LAUNCH.jobTitles) expect(JSON.stringify(h.qe[0])).toContain(t);
  });

  it("stops LinkedIn at the first refusal, and says how far it got", async () => {
    h.liRefuseAt = 1;
    await work(LAUNCH, { addToCampaign: true });
    expect(h.li).toHaveLength(2);
    expect(rows("discovery_logs").some((l) => /stopped after 1 of 3 searches: today's LinkedIn lookup allowance is used up/.test(String(l.message)))).toBe(true);
  });

  it("caps LinkedIn searches, and the launcher counts the same number", () => {
    const many = { jobTitles: Array.from({ length: 14 }, (_, i) => `T${i}`), industries: ["X"], locations: ["Ohio"] };
    expect(personQueries(many).queries).toHaveLength(CAMPAIGN_RUN_MAX_QUERIES);
    expect(personQueries(many).total).toBe(14);
    expect(campaignLaunchSearches({ titles: many.jobTitles, industries: many.industries, places: many.locations })).toEqual({ searches: CAMPAIGN_RUN_MAX_QUERIES, total: 14 });
    expect(campaignLaunchSearches({ titles: LAUNCH.jobTitles, industries: LAUNCH.industries, places: LAUNCH.locations })).toEqual({ searches: personQueries(LAUNCH).queries.length, total: 3 });
  });

  it("a plain search is the one query it always was", async () => {
    expect(personQueries({ jobTitle: "CFO", industry: "Retail", location: "Ohio", seniority: "VP" }).queries).toEqual(["CFO VP Retail Ohio"]);
    await work({ jobTitle: "CFO", industry: "Retail", location: "Ohio" });
    expect(h.li).toEqual(["CFO Retail Ohio"]);
    expect(h.apollo[0]).toMatchObject({ titles: ["CFO"], industries: ["Retail"], locations: ["Ohio"] });
  });
});

describe("a campaign launch's people go to the campaign as well as People", () => {
  it("the saved people are pushed into that campaign, and the run says how many it took", async () => {
    const r = await work(LAUNCH, { addToCampaign: true });
    expect(r?.status).toBe("complete");
    const saved = rows("prospects").map((p) => p.id).sort((a, b) => a - b);
    expect(saved.length).toBe(3);
    expect(h.pushes).toEqual([{ campaignId: CAMPAIGN, ids: expect.arrayContaining(saved) }]);
    expect(rows("discovery_runs")[0]).toMatchObject({ addedToCampaign: 2, notAddedToCampaign: 1 });
    expect(r).toMatchObject({ addedToCampaign: 2, notAddedToCampaign: 1 });
    expect(rows("discovery_logs").some((l) => /Added 2 of 3 saved people to campaign 7 \(1 not added — 1: Already in another campaign/.test(String(l.message)))).toBe(true);
  });

  it("a run that is not a campaign launch pushes nobody", async () => {
    await work(LAUNCH);
    expect(h.pushes).toEqual([]);
    expect(rows("discovery_runs")[0].addedToCampaign ?? null).toBeNull();
  });

  it("the router asks for the push only with a campaign of this workspace", async () => {
    const one = await caller().discovery.search({ mode: "person", campaignId: CAMPAIGN, addToCampaign: true, input: LAUNCH });
    expect((rows("bulk_jobs").find((j) => j.id === one.jobId).payload as DiscoveryJobPayload).addToCampaign).toBe(true);
    const two = await caller().discovery.search({ mode: "person", addToCampaign: true, input: { jobTitle: "CFO" } });
    expect((rows("bulk_jobs").find((j) => j.id === two.jobId).payload as DiscoveryJobPayload).addToCampaign).toBeUndefined();
    rows("are_campaigns").push({ id: 8, workspaceId: 9, name: "Theirs", status: "active" });
    await expect(caller().discovery.search({ mode: "person", campaignId: 8, addToCampaign: true, input: LAUNCH })).rejects.toThrow(/not in this workspace/);
  });
});

describe("the launcher", () => {
  const ROOT = join(__dirname, "..");
  const page = readFileSync(join(ROOT, "client/src/pages/usip/ARECampaignDetail.tsx"), "utf8").replace(/\r\n/g, "\n");
  const launcher = page.slice(page.indexOf("function CampaignDiscoveryLauncher("), page.indexOf("function LogsTab"));
  it("sends every value and asks for the campaign push", () => {
    expect(launcher).toContain("jobTitles: titles,");
    expect(launcher).toContain("locations: geos,");
    expect(launcher).toContain("addToCampaign: true,");
    expect(launcher).not.toContain("jobTitle: titles[0]");
  });
  it("says how many searches it makes and asks before running", () => {
    expect(launcher).toContain("campaignLaunchSearches({ titles, industries, places: geos })");
    expect(launcher).toContain('title: "Run discovery for this campaign?"');
    expect(launcher).toContain("New people are saved to People and added to this campaign; nothing is sent.");
    expect(launcher).toContain("onClick={run}");
  });
  it("the run summary names the campaign push", () => {
    const lib = readFileSync(join(ROOT, "client/src/lib/discoveryRun.ts"), "utf8");
    expect(lib).toContain("added to this campaign");
  });
});
