/**
 * The monthly prospect-data allowance at the points where people enter a
 * workspace (owner approved 2026-11-25): the Revenue Engine's discovery, Find
 * prospects, and Source search promote (which the Search box save goes
 * through). The email lookups are pinned at their one choke point in
 * prospectAllowance.test.ts.
 *
 * What each point must do, the executor's partial-reservation shape:
 *   - with nothing left, skip the shared source BEFORE calling it, and say why
 *     where that run reports skipped sources;
 *   - with a little left, ask for no more than that, count what came in new,
 *     and give back the rest;
 *   - on the workspace's own key, run as before and count nothing.
 *
 * The real engine, discovery fan-out, promote and consolidation run against
 * the SQL-evaluating fake. QuickEnrich is stubbed at its HTTP-calling
 * functions (and its key, which plays a key another workspace lends); no
 * vendor is called.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "e".repeat(64);
  return { db: null as any, qe: [] as any[], people: [] as any[] };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/enrichment/fieldHistory", async (a) => ({ ...(await a<typeof import("./services/enrichment/fieldHistory")>()), recordFieldHistory: async () => {} }));
vi.mock("./services/company/associationService", async (a) => ({
  ...(await a<typeof import("./services/company/associationService")>()),
  associateUnlinkedProspects: async () => ({ linked: 0, created: 0, needsReview: 0, missing: 0 }),
}));
vi.mock("./services/personLink", async (a) => ({
  ...(await a<typeof import("./services/personLink")>()),
  linkUnlinkedQueueRows: async () => ({ linked: 0, created: 0, skippedNoIdentity: 0 }),
}));
vi.mock("./services/reoon", async (a) => ({
  ...(await a<typeof import("./services/reoon")>()),
  // The member's own verification key: never part of the allowance.
  getReoonKey: async () => "own-reoon-key",
  reoonCheckBalance: async () => ({ remaining_daily_credits: 100 }),
  reoonVerifySingle: async () => ({ status: "safe" }),
}));
vi.mock("./services/quickenrich", async (a) => ({
  ...(await a<typeof import("./services/quickenrich")>()),
  // The key a lending workspace's share resolves to: not this workspace's own.
  getQuickEnrichKey: async () => "lent-qe-key",
  getQuickenrichDailyPullCap: async () => 500,
  quickenrichPulledToday: async () => 0,
  getQuickenrichIndustries: async () => null,
  quickenrichContactFinder: async (_k: string, body: any) => { h.qe.push(body); return { ok: true, people: h.people }; },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { encryptSecret } from "./_core/crypto";
import { runDiscovery as runEngineDiscovery, __resetEngineLogRepeatsForTests } from "./areEngine";
import { runDiscovery as runFindProspects } from "./services/discovery";
import { promoteResults } from "./services/prospectSources/searchRuns";
import { queueIdentityColumns } from "./services/are/queueIdentity";
import { sweepWorkspace } from "./services/enrichmentSweeper";

const WS = 5, CAMPAIGN = 7;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const settings = () => rows("workspace_settings").find((r) => r.workspaceId === WS);
const usage = () => rows("prospect_allowance_usage").find((r) => r.workspaceId === WS)?.used;
const setUsed = (used: number) => {
  rows("prospect_allowance_usage").length = 0;
  rows("prospect_allowance_usage").push({ id: 1, workspaceId: WS, period: new Date().toISOString().slice(0, 7), used });
};
const person = (i: number) => ({
  firstName: "Pat", lastName: `Person${i}`, title: "Chief Financial Officer", linkedinUrl: `https://www.linkedin.com/in/pat-person-${i}`,
  companyName: `Company ${i}`, companyDomain: `company${i}.example`, hasEmail: true, locality: null, city: null,
});
const engineLogs = () => rows("are_engine_logs").map((r) => String(r.message));

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.qe = [];
  h.people = Array.from({ length: 10 }, (_, i) => person(i + 1));
  __resetEngineLogRepeatsForTests();
  rows("workspaces").push({ id: WS, name: "Member", slug: "m", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("workspace_settings").push({
    workspaceId: WS, membershipPlan: "trial", areSourceOrder: null, icpFallback: null,
    areScraperSources: { quickenrich: true, apollo: false, warmysender: false, linkedin: false, google_business: false, news: false, leadocean: false, internal: false },
  });
  rows("are_campaigns").push({
    id: CAMPAIGN, workspaceId: WS, name: "CFOs", status: "active", targetProspectCount: 10,
    prospectSources: ["quickenrich"], icpOverrides: { targetTitles: ["Chief Financial Officer"] },
    discoveryQueryState: null, researchSectorId: null, researchPersonaId: null,
  });
});

const campaign = () => rows("are_campaigns").find((c) => c.id === CAMPAIGN);

describe("Revenue Engine discovery", () => {
  it("with the month used up, the shared source is skipped before it is called, and the run says why", async () => {
    setUsed(250);
    const added = await runEngineDiscovery(campaign() as never, 10);
    expect(added).toBe(0);
    expect(h.qe).toEqual([]);
    expect(rows("prospect_queue")).toEqual([]);
    // Campaign logs name a prospect source "Source N", never its vendor (phase 2).
    expect(engineLogs().some((m) => /^Source \d+ skipped — Prospect data for this month is used up \(250 of 250\)\. It resets on 1 [A-Z][a-z]+\. Add your own key under Data sources to keep going\.$/.test(m))).toBe(true);
    // The per-source breakdown (the campaign's source health reads it) carries the reason too.
    const summary = rows("are_engine_logs").find((r) => String(r.message).startsWith("Discovery slice"));
    expect(summary.details.perSource.quickenrich.skipped).toMatch(/^Prospect data for this month is used up/);
    // It looked nowhere, so it is not a run that came back empty: no rest.
    expect(campaign().discoveryQueryState?.lastRunNew ?? null).toBeNull();
    expect(usage()).toBe(250);
  });

  it("with a little left, queues no more than that and counts exactly the people queued", async () => {
    setUsed(247);
    const added = await runEngineDiscovery(campaign() as never, 10);
    expect(h.qe).toHaveLength(1);
    expect(added).toBe(3);
    expect(rows("prospect_queue")).toHaveLength(3);
    expect(usage()).toBe(250);
    expect(engineLogs().some((m) => /^Source \d+: Only 3 of the 10 asked for fit/.test(m))).toBe(true);
  });

  it("people already in the workspace are not counted: the hold gives back what dedupe dropped", async () => {
    setUsed(100);
    // Two of the ten are queued in another campaign already.
    for (const i of [1, 2]) {
      const p = { firstName: "Pat", lastName: `Person${i}`, linkedinUrl: `https://www.linkedin.com/in/pat-person-${i}`, companyName: `Company ${i}`, companyDomain: `company${i}.example` };
      rows("prospect_queue").push({ id: 100 + i, workspaceId: WS, campaignId: 99, sequenceStatus: "pending", ...p, ...queueIdentityColumns(p) });
    }
    await runEngineDiscovery(campaign() as never, 10);
    expect(rows("prospect_queue").filter((r) => r.campaignId === CAMPAIGN)).toHaveLength(8);
    expect(usage()).toBe(108);
  });

  it("on the workspace's own key it runs as before and counts nothing", async () => {
    setUsed(250);
    settings().quickenrichApiKeyEnc = encryptSecret("lent-qe-key-but-own");
    const added = await runEngineDiscovery(campaign() as never, 10);
    expect(added).toBe(10);
    expect(usage()).toBe(250);
  });

  it("with no plan it runs as before and writes no usage", async () => {
    settings().membershipPlan = null;
    const added = await runEngineDiscovery(campaign() as never, 10);
    expect(added).toBe(10);
    expect(rows("prospect_allowance_usage")).toEqual([]);
  });
});

describe("Find prospects", () => {
  it("with the month used up, the shared source does not search and the run log says why", async () => {
    setUsed(250);
    const r = await runFindProspects(WS, 1, "person", { jobTitle: "Chief Financial Officer" }, null, { sources: ["quickenrich"] });
    expect(h.qe).toEqual([]);
    expect(r.perSource.quickenrich).toMatchObject({ found: 0 });
    expect(String((r.perSource.quickenrich as { note?: string }).note)).toMatch(/^Prospect data for this month is used up \(250 of 250\)/);
    expect(rows("discovery_logs").some((l) => /^Source \d+ returned 0 finds — Prospect data for this month is used up/.test(String(l.message)))).toBe(true);
    expect(usage()).toBe(250);
  });

  it("counts only the finds the workspace did not already have, once each, and keeps no more than what was left", async () => {
    setUsed(240);
    rows("prospects").push({ id: 50, workspaceId: WS, firstName: "Pat", lastName: "Person1", linkedinUrl: "https://www.linkedin.com/in/pat-person-1", company: "Company 1", companyDomain: "company1.example" });
    const r = await runFindProspects(WS, 1, "person", { jobTitle: "Chief Financial Officer" }, null, { sources: ["quickenrich"] });
    // Ten were left and ten asked: all ten kept, one already in People.
    expect(r.rawFindCount).toBe(10);
    expect(usage()).toBe(249);
    setUsed(247);
    h.people = Array.from({ length: 10 }, (_, i) => person(i + 20));
    const r2 = await runFindProspects(WS, 1, "person", { jobTitle: "Chief Financial Officer", keywords: ["second"] }, null, { sources: ["quickenrich"] });
    expect(r2.rawFindCount).toBe(3);
    expect(usage()).toBe(250);
  });

  it("finds held for review are counted when found, not again when saved", async () => {
    setUsed(0);
    const r = await runFindProspects(WS, 1, "person", { jobTitle: "Chief Financial Officer" }, null, { sources: ["quickenrich"], holdForReview: true });
    expect(r.heldForReview).toBe(true);
    expect(usage()).toBe(10);
  });
});

describe("Source search promote (and the Search box save, which goes through it)", () => {
  const RUN = 31;
  beforeEach(() => {
    rows("prospect_search_runs").push({ id: RUN, workspaceId: WS, userId: 1, status: "complete" });
    for (const i of [1, 2, 3]) {
      const rec = { externalId: `https://www.linkedin.com/in/pat-person-${i}`, firstName: "Pat", lastName: `Person${i}`, jobTitle: "CFO", companyName: `Company ${i}`, companyDomain: `company${i}.example`, linkedinUrl: `https://www.linkedin.com/in/pat-person-${i}`, email: null, emailIsMasked: true, rawSourcePayload: {} };
      rows("prospect_search_results").push({
        id: i, workspaceId: WS, runId: RUN, sourceSlug: "quickenrich", externalId: rec.externalId, wasCharged: false, emailIsMasked: true,
        promotedProspectId: null, promoteClaim: null, promoteClaimedAt: null, normalized: rec,
      });
    }
  });

  it("saves only what is left of the month, says why for the rest, and counts the new People records", async () => {
    setUsed(249);
    const r = await promoteResults(WS, 1, RUN, [1, 2, 3]);
    expect(r.promoted).toBe(1);
    expect(r.errors.join(" ")).toMatch(/2 not saved: Only 1 of the 3 asked for fit in this month's prospect data/);
    expect(rows("prospects")).toHaveLength(1);
    expect(usage()).toBe(250);
    // The rows left behind are free to save later (released, not promoted).
    expect(rows("prospect_search_results").filter((x) => x.promotedProspectId == null && x.promoteClaim == null)).toHaveLength(2);
  });

  it("an update of someone already in People is not counted", async () => {
    setUsed(10);
    rows("prospects").push({ id: 60, workspaceId: WS, firstName: "Pat", lastName: "Person2", linkedinUrl: "https://www.linkedin.com/in/pat-person-2", company: "Company 2", companyDomain: "company2.example", verificationStatus: "verified", fieldProvenance: {} });
    const r = await promoteResults(WS, 1, RUN, [1, 2, 3]);
    expect(r.promoted).toBe(3);
    expect(usage()).toBe(12);
  });

  it("used up, nothing is saved from the shared source", async () => {
    setUsed(250);
    const r = await promoteResults(WS, 1, RUN, [1, 2, 3]);
    expect(r.promoted).toBe(0);
    expect(r.errors.join(" ")).toMatch(/3 not saved: Prospect data for this month is used up/);
    expect(rows("prospects")).toEqual([]);
    expect(usage()).toBe(250);
  });

  it("on the workspace's own key everything is saved and nothing counted", async () => {
    setUsed(250);
    settings().quickenrichApiKeyEnc = encryptSecret("own-qe-key");
    const r = await promoteResults(WS, 1, RUN, [1, 2, 3]);
    expect(r.promoted).toBe(3);
    expect(usage()).toBe(250);
  });
});

describe("the enrichment sweep's email lookups", () => {
  const fetched: string[] = [];
  beforeEach(() => {
    fetched.length = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(String(url));
      return new Response(JSON.stringify({ data: { email: "pat@company.example" } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    for (const i of [1, 2]) {
      rows("prospect_queue").push({
        id: 200 + i, workspaceId: WS, campaignId: CAMPAIGN, firstName: "Pat", lastName: `Sweep${i}`, sequenceStatus: "sourcing",
        enrichmentStatus: "pending", email: null, companyDomain: null, linkedinUrl: `https://www.linkedin.com/in/pat-sweep-${i}`,
        enrichmentError: null, enrichedAt: null, personProspectId: null, companyName: null,
      });
    }
  });

  it("stop at the month's number: the rest are left untouched for later, and the result says why", async () => {
    setUsed(249);
    const r = await sweepWorkspace(WS, { limit: 10 });
    expect(r.quickenrichFound).toBe(1);
    expect(r.quickenrichAttempted).toBe(1);
    expect(r.quickenrichStopped).toMatch(/^Prospect data for this month is used up \(250 of 250\)/);
    expect(fetched).toHaveLength(1);
    expect(usage()).toBe(250);
    const left = rows("prospect_queue").find((x) => x.id === 202);
    expect(left).toMatchObject({ email: null, enrichmentError: null, enrichedAt: null, enrichmentStatus: "pending" });
    vi.unstubAllGlobals();
  });
});
