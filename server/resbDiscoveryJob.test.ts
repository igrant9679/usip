/**
 * Find prospects runs in the background and says who is already in People
 * (audit 2026-10-20, batch RESB) — against the real routers, the real job
 * runner and the SQL-evaluating fake. No vendor is called: the one source a
 * test runs is a stubbed LinkedIn search.
 *
 *   P72  a search answers at once with its run; the fan-out runs in a
 *        bulk_jobs job · the same search queued or running is joined · a run
 *        whose fan-out had already started is never run (and paid for) again
 *        · Re-enrich queues the same way
 *   F38  one duplicate check for the three discovery tools: each raw find is
 *        labelled new / already in People before saving · a run can be kept
 *        for review and saved later · checkInPeople answers the LinkedIn
 *        card · the LinkedIn finder no longer saves someone twice
 *   F43  the LinkedIn search takes the next page's cursor
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  linkedin: null as null | ((opts: any) => Promise<any>),
  linkedinCalls: 0,
  searchCalls: [] as any[],
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/enrichment/fieldHistory", async (a) => ({ ...(await a<typeof import("./services/enrichment/fieldHistory")>()), recordFieldHistory: async () => {} }));
vi.mock("./services/company/associationService", async (a) => ({
  ...(await a<typeof import("./services/company/associationService")>()),
  associateUnlinkedProspects: async () => ({ linked: 0, created: 0, needsReview: 0, missing: 0 }),
}));
vi.mock("./services/linkedinLookup", async (a) => ({
  ...(await a<typeof import("./services/linkedinLookup")>()),
  searchLinkedInProfiles: async (opts: any) => { h.linkedinCalls++; return h.linkedin!(opts); },
}));
vi.mock("./lib/unipile", async (a) => ({
  ...(await a<typeof import("./lib/unipile")>()),
  searchLinkedIn: async (acct: string, params: any) => { h.searchCalls.push({ acct, ...params }); return { items: [{ name: "Ann Lee" }], cursor: params.cursor ? undefined : "page-2" }; },
}));
vi.mock("./services/linkedin/activityGate", async (a) => ({
  ...(await a<typeof import("./services/linkedin/activityGate")>()),
  checkLinkedInAction: async () => ({ allowed: true }),
  recordLinkedInAction: async () => {},
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { DISCOVERY_JOB, DISCOVERY_RESTARTED_ERROR } from "./services/discovery";
import { tickJobs, __resetJobRunnerForTests } from "./services/jobs/runner";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

const onlyLinkedIn = () => rows("workspace_settings").push({
  workspaceId: WS, areSourceOrder: null,
  areScraperSources: { linkedin: true, news: false, apollo: false, quickenrich: false, google_business: false, warmysender: false, leadocean: false, web: false, internal: false },
});
const hit = (first: string, last: string, slug: string) => ({ firstName: first, lastName: last, headline: "Director", company: "Acme", linkedinUrl: `https://www.linkedin.com/in/${slug}`, location: "Austin, Texas, United States" });
const person = (id: number, over: Record<string, unknown>) => rows("prospects").push({
  id, workspaceId: WS, firstName: "Ann", lastName: "Lee", company: "Acme", email: null, title: "Old title", phone: null,
  companyDomain: null, linkedinUrl: null, city: null, state: null, country: null, industry: null,
  fieldProvenance: {}, verificationStatus: "needs_review", verificationSetBy: "discovery", ...over,
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.linkedin = async () => ({ ok: true, hits: [] });
  h.linkedinCalls = 0;
  h.searchCalls = [];
  __resetJobRunnerForTests();
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
});

describe("a search is a background job the page follows (P72)", () => {
  it("answers at once with a running run and no vendor call; the worker runs the fan-out once", async () => {
    onlyLinkedIn();
    h.linkedin = async () => ({ ok: true, hits: [hit("Bo", "Ng", "bo-ng")] });
    const r = await caller().discovery.search({ mode: "person", input: { jobTitle: "Director" }, sources: ["linkedin"] });
    expect(r).toMatchObject({ status: "running", runId: expect.any(Number), jobId: expect.any(Number) });
    expect(h.linkedinCalls).toBe(0);
    expect(row("discovery_runs", r.runId).status).toBe("running");
    expect(rows("bulk_jobs")).toHaveLength(1);
    expect(rows("bulk_jobs")[0]).toMatchObject({ kind: DISCOVERY_JOB, status: "queued", workspaceId: WS });

    await tickJobs(5_000);
    expect(h.linkedinCalls).toBe(1);
    expect(row("discovery_runs", r.runId)).toMatchObject({ status: "complete", prospectsCreated: 1 });
    expect(row("discovery_runs", r.runId).fanOutStartedAt).toBeInstanceOf(Date);
    expect(rows("bulk_jobs")[0].status).toBe("done");
    expect(rows("prospects")).toHaveLength(1);
    // The run's trace is kept, and says it was queued first.
    expect(rows("discovery_logs").some((l) => l.runId === r.runId && l.phase === "discovery.queued")).toBe(true);

    // Polled through getRun, as the page does.
    const polled = await caller().discovery.getRun({ id: r.runId });
    expect(polled.status).toBe("complete");
  });

  it("the same search queued again is joined: one run, one job, one vendor call", async () => {
    onlyLinkedIn();
    h.linkedin = async () => ({ ok: true, hits: [hit("Bo", "Ng", "bo-ng")] });
    const a = await caller().discovery.search({ mode: "person", input: { jobTitle: "Director", keywords: ["grants"] }, sources: ["linkedin"] });
    // A retry after a lost response: same fields, spelled a little differently.
    const b = await caller().discovery.search({ mode: "person", input: { keywords: [" grants "], jobTitle: "Director ", industry: "" }, sources: ["linkedin"] });
    expect(b).toMatchObject({ runId: a.runId, jobId: a.jobId, joinedRunning: true });
    expect(rows("discovery_runs")).toHaveLength(1);
    expect(rows("bulk_jobs")).toHaveLength(1);
    await tickJobs(5_000);
    expect(h.linkedinCalls).toBe(1);
    // Asked again once it has finished is a new run, as the person meant.
    const c = await caller().discovery.search({ mode: "person", input: { jobTitle: "Director", keywords: ["grants"] }, sources: ["linkedin"] });
    expect(c.runId).not.toBe(a.runId);
    expect(c.joinedRunning).toBeUndefined();
  });

  it("a run whose fan-out had started when its worker died is stopped, not paid for again", async () => {
    onlyLinkedIn();
    const r = await caller().discovery.search({ mode: "person", input: { jobTitle: "CFO" }, sources: ["linkedin"] });
    // The worker began (fanOutStartedAt set) and died: the job is back in the queue.
    row("discovery_runs", r.runId).fanOutStartedAt = new Date(Date.now() - 60_000);
    await tickJobs(5_000);
    expect(h.linkedinCalls).toBe(0);
    expect(row("discovery_runs", r.runId)).toMatchObject({ status: "failed", errorMessage: DISCOVERY_RESTARTED_ERROR });
    expect(rows("bulk_jobs")[0].status).toBe("done");
  });

  it("Re-enrich queues a run instead of holding the request", async () => {
    person(5, { firstName: "Cy", lastName: "Oh", title: "COO" });
    const r = await caller().prospects.reEnrich({ id: 5 });
    expect(r).toMatchObject({ status: "running", runId: expect.any(Number) });
    expect(rows("bulk_jobs")).toHaveLength(1);
    expect(h.linkedinCalls).toBe(0);
  });
});

describe("one duplicate check for every discovery tool (F38)", () => {
  it("labels each raw find new or already in People before saving, and counts them on the run", async () => {
    onlyLinkedIn();
    person(7, { firstName: "Bo", lastName: "Ng", linkedinUrl: "https://www.linkedin.com/in/Bo-Ng/" });
    h.linkedin = async () => ({ ok: true, hits: [hit("Bo", "Ng", "bo-ng"), hit("Di", "Ra", "di-ra")] });
    const r = await caller().discovery.search({ mode: "person", input: { jobTitle: "Director" }, sources: ["linkedin"] });
    await tickJobs(5_000);
    const finds = rows("raw_finds").filter((f) => f.runId === r.runId);
    expect(finds.find((f) => f.firstName === "Bo")).toMatchObject({ knownAs: "in_people", knownProspectId: 7 });
    expect(finds.find((f) => f.firstName === "Di")).toMatchObject({ knownAs: "new", knownProspectId: null });
    expect(row("discovery_runs", r.runId).alreadyInPeople).toBe(1);
  });

  it("a run kept for review saves nothing until Save to People, which saves through the same consolidation", async () => {
    onlyLinkedIn();
    h.linkedin = async () => ({ ok: true, hits: [hit("Di", "Ra", "di-ra")] });
    const r = await caller().discovery.search({ mode: "person", input: { jobTitle: "Director" }, sources: ["linkedin"], holdForReview: true });
    expect(r.heldForReview).toBe(true);
    await tickJobs(5_000);
    expect(row("discovery_runs", r.runId)).toMatchObject({ status: "complete", heldForReview: true });
    expect(row("discovery_runs", r.runId).prospectsCreated ?? 0).toBe(0);
    expect(rows("prospects")).toHaveLength(0);
    expect(rows("raw_finds")).toHaveLength(1);

    const saved = await caller().discovery.reprocess({ runId: r.runId });
    expect(saved.prospectsCreated).toBe(1);
    expect(rows("prospects")).toHaveLength(1);
    expect(row("discovery_runs", r.runId).heldForReview).toBe(false);
  });

  it("a held search and the same search saved straight away are different runs", async () => {
    onlyLinkedIn();
    const a = await caller().discovery.search({ mode: "person", input: { jobTitle: "Director" }, sources: ["linkedin"], holdForReview: true });
    const b = await caller().discovery.search({ mode: "person", input: { jobTitle: "Director" }, sources: ["linkedin"] });
    expect(b.runId).not.toBe(a.runId);
  });

  it("checkInPeople answers in People (with the person), in a campaign, or new, by email, profile or name at a company", async () => {
    person(7, { firstName: "Bo", lastName: "Ng", linkedinUrl: "https://www.linkedin.com/in/bo-ng" });
    person(8, { firstName: "Al", lastName: "Fe", email: "AL@ACME.EXAMPLE" });
    rows("are_campaigns").push({ id: 30, workspaceId: WS, name: "C" });
    rows("prospect_queue").push({ id: 1, workspaceId: WS, campaignId: 30, firstName: "Qu", lastName: "Ee", companyName: "Beta", companyDomain: null, email: null, linkedinUrl: null });
    const res = await caller().discovery.checkInPeople({ records: [
      { firstName: "Bo", lastName: "Ng", linkedinUrl: "linkedin.com/in/bo-ng?trk=x" },
      { firstName: "Al", lastName: "Fe", email: "al@acme.example" },
      { firstName: "Qu", lastName: "Ee", companyName: "Beta" },
      { firstName: "No", lastName: "One", companyName: "Gamma" },
    ] });
    expect(res.map((x: any) => x.status)).toEqual(["in_people", "in_people", "in_campaign", "new"]);
    expect(res[0].prospectId).toBe(7);
    expect(res[1].prospectId).toBe(8);
  });

  it("the LinkedIn finder skips someone already in People, and a repeat inside one save", async () => {
    person(7, { firstName: "Bo", lastName: "Ng", linkedinUrl: "https://www.linkedin.com/in/bo-ng" });
    const r = await caller().linkedinFinder.saveSearchHits({ hits: [
      { firstName: "Bo", lastName: "Ng", company: "Acme", linkedinUrl: "https://linkedin.com/in/bo-ng/" },
      { firstName: "Di", lastName: "Ra", company: "Acme", linkedinUrl: "https://linkedin.com/in/di-ra" },
      { firstName: "Di", lastName: "Ra", company: "Acme", linkedinUrl: "https://www.linkedin.com/in/di-ra" },
    ] });
    // The repeat is in People by the time it is reached: the first Di was just saved.
    expect(r).toMatchObject({ created: 1, alreadyInPeople: 2, total: 3 });
    expect(rows("prospects")).toHaveLength(2);

    const one = await caller().linkedinFinder.saveAsProspect({ firstName: "Bo", lastName: "Ng", linkedinUrl: "https://www.linkedin.com/in/bo-ng" });
    expect(one).toMatchObject({ prospectId: 7, alreadyInPeople: true });
    expect(rows("prospects")).toHaveLength(2);
  });
});

describe("LinkedIn result paging (F43)", () => {
  it("passes the previous page's cursor through, and the first page hands one back", async () => {
    rows("unipile_accounts").push({ id: 1, workspaceId: WS, userId: 1, provider: "LINKEDIN", unipileAccountId: "acc-1", status: "OK" });
    const first = await caller().unipile.searchLinkedIn({ api: "classic", category: "people", keywords: "grants", limit: 10 });
    expect(first.cursor).toBe("page-2");
    expect(h.searchCalls[0].cursor).toBeUndefined();
    await caller().unipile.searchLinkedIn({ api: "classic", category: "people", keywords: "grants", limit: 10, cursor: "page-2" });
    expect(h.searchCalls[1].cursor).toBe("page-2");
  });
});
