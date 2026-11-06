/**
 * Discovery and the queue (audit 2026-10-20, batch E1).
 *
 *   A12 the same person is queued once: claimed as each row of a batch is kept,
 *       the manual full scrape saves its sources in turn, and enrolment refuses
 *       a second copy of someone already in a sequence
 *   A34 a discovery run reads the workspace's queue once, not again for every
 *       source it saves; the screen pass writes its verdicts in groups
 *   A26 "queue full" says how many of the working rows are staged out of sight
 *   A77 the CRM source leaves out customers and people in an open deal; the
 *       LinkedIn source searches one target title at a time and pages on
 *
 * Against the SQL-evaluating fake. Only the sources each test names are
 * unmasked, and LinkedIn is mocked, so nothing reaches a vendor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    indexReads: 0,
    searches: [] as any[],
    searchReply: null as null | ((p: any) => any),
    profileHits: [] as any[],
    stall: null as any,
  };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./routers/are/notify", async (a) => ({ ...(await a<typeof import("./routers/are/notify")>()), areNotify: async () => {} }));
vi.mock("./services/are/queueIdentity", async (a) => {
  const real = await a<typeof import("./services/are/queueIdentity")>();
  return { ...real, workspaceQueueIdentityIndex: async (ws: number) => { h.indexReads++; return real.workspaceQueueIdentityIndex(ws); } };
});
vi.mock("./services/linkedin/activityGate", async (a) => ({
  ...(await a<typeof import("./services/linkedin/activityGate")>()),
  pickAccountForAction: async (i: any) => ({ unipileAccountId: i.candidates[0] ?? null, verdict: null }),
  recordLinkedInAction: async () => {},
}));
vi.mock("./services/linkedinLookup", async (a) => ({
  ...(await a<typeof import("./services/linkedinLookup")>()),
  listUsableAccounts: async () => [{ unipileAccountId: "acct-1" }],
  searchLinkedInProfiles: async () => ({ ok: true, hits: h.profileHits }),
}));
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  searchLinkedInPeople: async (_acct: string, p: any) => { h.searches.push(p); return h.searchReply ? h.searchReply(p) : { items: [] }; },
}));
vi.mock("@/lib/trpc", () => ({ trpc: { are: { campaigns: { stallReasons: { useQuery: () => ({ data: h.stall, isLoading: false, isError: false }) } } } } }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { enrolledElsewhere, runAreEngine, runDiscovery, __resetEngineLogRepeatsForTests } from "./areEngine";
import { saveScrapeJobAndQueue } from "./routers/are/scraper";
import { CampaignStallPanel } from "../client/src/components/usip/are/CampaignStallPanel";

const WS = 2;
const ADMIN = 20;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const queued = () => rows("prospect_queue").filter((p) => p.campaignId === 7);
const logs = () => rows("are_engine_logs").map((l) => String(l.message));
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const caller = () => appRouter.createCaller({
  user: { id: ADMIN, openId: "u", email: "a@example.com", name: "A", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const MASK = { quickenrich: false, warmysender: false, linkedin: false, apollo: false, google_business: false, news: false, leadocean: false, internal: false };

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.indexReads = 0;
  h.searches = [];
  h.searchReply = null;
  h.profileHits = [];
  __resetEngineLogRepeatsForTests();
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  rows("workspace_settings").push({ workspaceId: WS, areSourceOrder: null, icpFallback: null, timezone: "UTC", areScraperSources: { ...MASK, internal: true } });
  rows("are_campaigns").push({
    id: 7, workspaceId: WS, name: "Counties", status: "active", targetProspectCount: 10, prospectSources: ["internal"], ownerUserId: ADMIN,
    icpOverrides: { targetTitles: ["County Administrator"] }, discoveryQueryState: null, researchSectorId: null, researchPersonaId: null,
    channelsEnabled: { email: true }, dailySendCap: 50, autonomyMode: "batch_approval",
  });
});

describe("the same person, queued once (A12)", () => {
  it("one batch holding someone twice queues them once", async () => {
    await saveScrapeJobAndQueue(WS, 7, "linkedin_people", "q", [
      { firstName: "Dana", lastName: "Reyes", title: "Clerk", linkedinUrl: "https://www.linkedin.com/in/dana-reyes" },
      { firstName: "Dana", lastName: "Reyes", title: "Clerk", linkedinUrl: "https://linkedin.com/in/dana-reyes/" },
      { firstName: "Sam", lastName: "Stone", title: "Clerk", email: "SAM@acme.example" },
      { firstName: "Sam", lastName: "Stone", title: "Clerk", email: "sam@acme.example" },
    ]);
    expect(queued().map((p) => p.firstName).sort()).toEqual(["Dana", "Sam"]);
  });

  it("the full scrape saves its sources in turn, so two that found the same person queue one", async () => {
    h.profileHits = [{ firstName: "Dana", lastName: "Reyes", headline: "Clerk", company: "Acme", linkedinUrl: "https://www.linkedin.com/in/dana-reyes", location: "Richmond" }];
    await caller().are.scraper.runFullScrape({ campaignId: 7, queries: { linkedinCompany: "acme", linkedinPeople: "clerk acme" } });
    expect(queued()).toHaveLength(1);
  });

  it("enrolment finds a second copy of someone already in a sequence, by address or profile", async () => {
    rows("prospect_queue").push(
      { id: 1, workspaceId: WS, campaignId: 5, email: "dana@acme.example", linkedinUrl: null, sequenceStatus: "enrolled" },
      { id: 2, workspaceId: WS, campaignId: 7, email: "dana@acme.example", linkedinUrl: null, sequenceStatus: "approved" },
      { id: 3, workspaceId: WS, campaignId: 6, email: null, linkedinUrl: "https://www.linkedin.com/in/sam-stone", sequenceStatus: "replied" },
      { id: 4, workspaceId: WS, campaignId: 7, email: null, linkedinUrl: "https://www.linkedin.com/in/sam-stone", sequenceStatus: "approved" },
      { id: 5, workspaceId: WS, campaignId: 7, email: "new@acme.example", linkedinUrl: null, sequenceStatus: "approved" },
      // Rejected, or another workspace's: not a sequence anyone is in here.
      { id: 6, workspaceId: WS, campaignId: 5, email: "new@acme.example", linkedinUrl: null, sequenceStatus: "skipped" },
      { id: 7, workspaceId: 4, campaignId: 9, email: "new@acme.example", linkedinUrl: null, sequenceStatus: "enrolled" },
    );
    const pq = (id: number) => rows("prospect_queue").find((r) => r.id === id);
    expect(await enrolledElsewhere(h.db, WS, pq(2))).toBe(1);
    expect(await enrolledElsewhere(h.db, WS, pq(4))).toBe(3);
    expect(await enrolledElsewhere(h.db, WS, pq(5))).toBeNull();
  });

  it("the enrolment pass asks before it mints steps", () => {
    const engine = read("server/areEngine.ts");
    const enrol = engine.slice(engine.indexOf("async function enrollApprovedForCampaignUnlocked"), engine.indexOf("async function tickCampaign"));
    const ask = enrol.indexOf("const twin = await enrolledElsewhere(db, wsId, row);");
    expect(ask).toBeGreaterThan(-1);
    expect(enrol.slice(ask, ask + 900)).toContain('sequenceStatus: "skipped"');
    expect(enrol.indexOf("await db.insert(areExecutionQueue)")).toBeGreaterThan(ask);
  });
});

describe("a discovery run's reads (A34)", () => {
  it("reads the workspace's queue once for the run, not again when it saves", async () => {
    rows("leads").push({ id: 60, workspaceId: WS, firstName: "Sam", lastName: "Stranger", email: "sam@example.com", title: "County Administrator", company: "Acme", status: "new" });
    await runDiscovery(rows("are_campaigns")[0], 5);
    expect(queued().map((p) => p.email)).toEqual(["sam@example.com"]);
    expect(h.indexReads).toBe(0);
  });

  it("and still never queues someone already in the queue", async () => {
    rows("prospect_queue").push({ id: 1, workspaceId: WS, campaignId: 5, email: "sam@example.com", sequenceStatus: "enrolled" });
    rows("leads").push({ id: 60, workspaceId: WS, firstName: "Sam", lastName: "Stranger", email: "sam@example.com", title: "County Administrator", company: "Acme", status: "new" });
    await runDiscovery(rows("are_campaigns")[0], 5);
    expect(queued()).toHaveLength(0);
  });
});

describe("the screen pass's writes (A34)", () => {
  it("writes each verdict once for the group, not once per prospect, and the verdicts are the same", async () => {
    Object.assign(rows("are_campaigns")[0], { autonomyMode: "full", autoApproveThreshold: 70, targetProspectCount: 0 });
    for (const [id, score] of [[1, 80], [2, 90], [3, 50], [4, 50], [5, 20]] as const) {
      rows("prospect_queue").push({ id, workspaceId: WS, campaignId: 7, email: `p${id}@example.com`, title: "Clerk", sequenceStatus: "pending", enrichmentStatus: "complete", icpMatchScore: score });
    }
    // A person approves prospect 4 by hand while the pass is running: it stands.
    let writes = 0;
    const real = h.db.update;
    h.db.update = (t: any) => {
      const chain = real(t);
      const set = chain.set;
      chain.set = (v: any) => { if (v && "sequenceStatus" in v && t === h.db.__pq) writes++; return set.call(chain, v); };
      return chain;
    };
    const { prospectQueue } = await import("../drizzle/schema");
    h.db.__pq = prospectQueue;
    const realSelect = h.db.select;
    let primed = false;
    h.db.select = (p?: any) => {
      const b = realSelect(p);
      if (!primed && !p) {
        const then = b.then;
        b.then = (res: any, rej: any) => then.call(b, (v: any) => { if (Array.isArray(v) && v.some((r: any) => r.id === 4 && r.enrichmentStatus === "complete")) { primed = true; rows("prospect_queue").find((r) => r.id === 4).sequenceStatus = "approved"; } res(v); }, rej);
      }
      return b;
    };
    await runAreEngine({ workspaceId: WS });
    const status = (id: number) => rows("prospect_queue").find((r) => r.id === id);
    expect([1, 2].map((id) => status(id).sequenceStatus)).toEqual(["approved", "approved"]);
    expect(status(3)).toMatchObject({ sequenceStatus: "skipped", rejectionReason: "Auto-screened: ICP match 50/100 below approve threshold 70" });
    expect(status(4).sequenceStatus).toBe("approved");
    expect(status(5)).toMatchObject({ sequenceStatus: "skipped", rejectionReason: "Auto-screened: ICP match 20/100 below approve threshold 70" });
    // One approve, one per distinct reason.
    expect(writes).toBe(3);
  });
});

describe("queue full while the list looks empty (A26)", () => {
  beforeEach(() => {
    rows("are_campaigns")[0].targetProspectCount = 3;
    for (const [id, s] of [[1, "sourcing"], [2, "sourcing"], [3, "pending"], [4, "skipped"]] as const) {
      rows("prospect_queue").push({ id, workspaceId: WS, campaignId: 7, email: s === "sourcing" ? null : `p${id}@example.com`, sequenceStatus: s, enrichmentStatus: "pending", icpMatchScore: 0 });
    }
  });

  it("the stall panel's numbers count the staged rows apart", async () => {
    const r = await caller().are.campaigns.stallReasons({ campaignId: 7 });
    expect(r.gates.queue).toMatchObject({ working: 3, staged: 2, rejected: 1, full: true });
  });

  it("the engine's log line says so", async () => {
    await runAreEngine({ workspaceId: WS });
    expect(logs().join("\n")).toContain("Discovery skipped — queue full (3/3 working, 2 of them staged while an email address is found, so not on the Prospects list; 1 rejected row excluded)");
  });

  it("the panel shows it", () => {
    h.stall = {
      checkedAt: new Date().toISOString(), timezone: "UTC", topReason: "queueFull",
      sending: { windowOpen: true, windowDescription: "Mon–Fri", nextOpenAt: null, dueNow: 0, poolSpent: null, poolLogRetentionDays: 30 },
      gates: {
        noEmail: 0, enrichmentFailed: { count: 0, reasons: [] }, noDossier: 0, unusableSequence: 0, copyHeld: { count: 0, reasons: [] },
        cap: { cap: 50, sentToday: 0, remaining: 50 }, paused: { workspaceOutbound: false, campaignStatus: "active", prospects: 0 },
        queue: { working: 3, target: 3, rejected: 1, staged: 2, full: true, discoveryRestingUntil: null },
      },
    };
    const html = renderToStaticMarkup(createElement(CampaignStallPanel, { campaignId: 7 }));
    expect(html).toContain("2 of them are staged while an email address is found");
  });
});

describe("the CRM source (A77)", () => {
  beforeEach(() => {
    rows("accounts").push({ id: 1, workspaceId: WS, name: "Customer Co" }, { id: 2, workspaceId: WS, name: "Deal Co" }, { id: 3, workspaceId: WS, name: "Lost Co" }, { id: 4, workspaceId: WS, name: "Open Co" });
    rows("customers").push({ id: 1, workspaceId: WS, accountId: 1 });
    rows("opportunities").push({ id: 1, workspaceId: WS, accountId: 2, stage: "proposal" }, { id: 2, workspaceId: WS, accountId: 3, stage: "lost" });
    const c = (id: number, accountId: number | null, email: string) => ({ id, workspaceId: WS, accountId, firstName: `C${id}`, lastName: "X", title: "County Administrator", email, companyName: "Co" });
    rows("contacts").push(c(1, 1, "cust@example.com"), c(2, 2, "deal@example.com"), c(3, 3, "lost@example.com"), c(4, 4, "open@example.com"), c(5, null, "free@example.com"));
  });

  it("leaves out a customer's people and people in an open deal", async () => {
    await runDiscovery(rows("are_campaigns")[0], 10);
    expect(queued().map((p) => p.email).sort()).toEqual(["free@example.com", "lost@example.com", "open@example.com"]);
  });
});

describe("the LinkedIn source (A77)", () => {
  beforeEach(() => {
    rows("workspace_settings")[0].areScraperSources = { ...MASK, linkedin: true };
    Object.assign(rows("are_campaigns")[0], {
      prospectSources: ["linkedin"],
      icpOverrides: { targetTitles: ["County Administrator", "City Manager"], targetIndustries: ["Government"], targetGeographies: ["Virginia"] },
    });
  });
  const hit = (n: number) => ({ first_name: "Pat", last_name: `L${n}`, headline: "County Administrator", public_identifier: `pat-l${n}` });

  it("searches a title on its own, not the whole slice", async () => {
    await runDiscovery(rows("are_campaigns")[0], 10);
    expect(h.searches).toHaveLength(1);
    expect(h.searches[0].keywords).toBe("County Administrator");
  });

  it("pages on through a title, then moves to the next", async () => {
    h.searchReply = (p) => (p.cursor ? { items: [hit(2)], cursor: undefined } : { items: [hit(1)], cursor: "page-2" });
    const camp = () => rows("are_campaigns")[0];
    await runDiscovery(camp(), 10);
    expect(camp().discoveryQueryState.li).toEqual({ title: "County Administrator", cursor: "page-2" });
    camp().discoveryQueryState.lastRunAt = 0; // not resting
    await runDiscovery(camp(), 10);
    expect(h.searches[1]).toMatchObject({ keywords: "County Administrator", cursor: "page-2" });
    expect(camp().discoveryQueryState.li).toEqual({ title: "County Administrator", cursor: null });
    camp().discoveryQueryState.lastRunAt = 0;
    await runDiscovery(camp(), 10);
    expect(h.searches[2]).toMatchObject({ keywords: "City Manager" });
    expect(h.searches[2].cursor).toBeUndefined();
  });

  it("a page that fails drops its cursor instead of asking for it again", async () => {
    h.searchReply = (p) => { if (p.cursor) throw new Error("cursor expired"); return { items: [hit(1)], cursor: "page-2" }; };
    const camp = () => rows("are_campaigns")[0];
    await runDiscovery(camp(), 10);
    camp().discoveryQueryState.lastRunAt = 0;
    await runDiscovery(camp(), 10);
    expect(camp().discoveryQueryState.li).toEqual({ title: "County Administrator", cursor: null });
  });
});
