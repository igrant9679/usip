/**
 * Find prospects saves what it says, to the people it means, and spends once
 * (audit 2026-10-20, batch Pd) — against the real router and services and the
 * SQL-evaluating fake. No vendor is called: the one source a test runs is a
 * stubbed LinkedIn search.
 *
 *   P61  the toast and the run count the people SAVED, and say what was not
 *   P64  a find matches someone by address or LinkedIn profile only; a name
 *        never updates a person · the LinkedIn import dedupes the same way
 *   P65  location and industry reach People
 *   P74  nobody suppressed or opted out comes in; bounced and free-mail
 *        addresses stay out
 *   P72  the same search already running is joined, not started (and paid
 *        for) again
 *   P143 a failed save, or a crash, marks the run failed; an orphan reads failed
 *   P145 a campaign id from another workspace is refused
 *   P147 a run's log reads in the order it happened
 *
 * The LinkedIn card (P75, P76, P149) is pinned in linkedinCardImport.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  linkedin: null as null | ((opts: any) => Promise<any>),
  linkedinCalls: 0,
  associate: 0,
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/enrichment/fieldHistory", async (a) => ({ ...(await a<typeof import("./services/enrichment/fieldHistory")>()), recordFieldHistory: async () => {} }));
vi.mock("./services/company/associationService", async (a) => ({
  ...(await a<typeof import("./services/company/associationService")>()),
  associateUnlinkedProspects: async () => { h.associate++; return { linked: 0, created: 0, needsReview: 0, missing: 0 }; },
}));
vi.mock("./services/linkedinLookup", async (a) => ({
  ...(await a<typeof import("./services/linkedinLookup")>()),
  searchLinkedInProfiles: async (opts: any) => { h.linkedinCalls++; return h.linkedin!(opts); },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { workspaceSettings } from "../drizzle/schema";
import { appRouter } from "./routers";
import { DISCOVERY_ORPHAN_MS, runDiscovery } from "./services/discovery";
import { persistAsProspects, placeParts, processRun, type ScoredCandidate } from "./services/discovery/consolidate";

const WS = 2;
const OTHER = 4;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

const candidate = (over: Partial<ScoredCandidate>): ScoredCandidate => ({
  firstName: "Ann", lastName: "Lee", title: "VP", companyName: "Acme", companyDomain: "acme.example",
  linkedinUrl: null, email: null, phone: null, location: null, sourceUrls: [], sourceRows: [],
  sources: new Set(["web"]), conflicts: {}, score: 90, tier: "high", status: "verified", notes: [], linkedinUrlVerified: false,
  ...over,
} as ScoredCandidate);
const person = (id: number, over: Record<string, unknown>) => rows("prospects").push({
  id, workspaceId: WS, firstName: "Ann", lastName: "Lee", company: "Acme", email: null, title: "Old title", phone: null,
  companyDomain: null, linkedinUrl: null, city: null, state: null, country: null, industry: null,
  fieldProvenance: {}, verificationStatus: "needs_review", verificationSetBy: "discovery", ...over,
});
const find = (id: number, runId: number, over: Record<string, unknown>) => rows("raw_finds").push({
  id, workspaceId: WS, runId, source: "news", firstName: null, lastName: null, title: null, companyName: null,
  companyDomain: null, linkedinUrl: null, email: null, phone: null, location: null, sourceUrl: null, snippet: null, rawJson: {}, ...over,
});
const run = (id: number, over: Record<string, unknown> = {}) => rows("discovery_runs").push({
  id, workspaceId: WS, userId: 1, campaignId: null, mode: "person", input: {}, status: "running", rawFindCount: 0,
  prospectsCreated: 0, prospectsUpdated: 0, prospectsSkipped: 0, accountsCreated: 0, highConfidenceCount: 0,
  mediumConfidenceCount: 0, lowConfidenceCount: 0, durationMs: 0, errorMessage: null, startedAt: new Date(), completedAt: null, ...over,
});
/** Only LinkedIn may run: every other source is off in Settings. */
const onlyLinkedIn = () => rows("workspace_settings").push({
  workspaceId: WS, areSourceOrder: null,
  areScraperSources: { linkedin: true, news: false, apollo: false, quickenrich: false, google_business: false, warmysender: false, leadocean: false, web: false, internal: false },
});
const hit = (first: string, last: string, slug: string) => ({ firstName: first, lastName: last, headline: "Director", company: "Acme", linkedinUrl: `https://www.linkedin.com/in/${slug}`, location: "Austin, Texas, United States" });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.linkedin = async () => ({ ok: true, hits: [] });
  h.linkedinCalls = 0;
  h.associate = 0;
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
});

/* ── P64 ──────────────────────────────────────────────────────────────── */

describe("a find is matched by address or LinkedIn profile, never by name alone (P64)", () => {
  it("a same-named stranger is not updated, case and URL shape still match, and name-only twins are held back", async () => {
    person(1, { firstName: "Jane", lastName: "Doe", company: "Acme" });
    person(2, { firstName: "John", lastName: "Roe", email: "JOHN@ACME.EXAMPLE", linkedinUrl: null });
    person(3, { firstName: "Bo", lastName: "Ng", linkedinUrl: "https://www.linkedin.com/in/Bo-Ng/" });
    person(4, { firstName: "Ann", lastName: "Lee", company: "Acme" });
    const r = await persistAsProspects(WS, 9, [
      // No company: the old fallback updated ANY Jane Doe.
      candidate({ firstName: "Jane", lastName: "Doe", companyName: null, companyDomain: null, linkedinUrl: "https://linkedin.com/in/jane-doe-77", title: "Stranger's title" }),
      candidate({ firstName: "John", lastName: "Roe", email: "john@acme.example", title: "CFO" }),
      candidate({ firstName: "Bo", lastName: "Ng", linkedinUrl: "linkedin.com/in/bo-ng?trk=x", title: "COO" }),
      // Same name and company as person 4, nothing to prove it is them.
      candidate({ firstName: "Ann", lastName: "Lee", email: "ann.lee@acme.example", title: "CEO" }),
    ]);
    expect(row("prospects", 1).title).toBe("Old title");
    // Updated (a scrape-tier title never displaces one already there, so the run id shows it).
    expect(row("prospects", 2).lastDiscoveryRunId).toBe(9);
    expect(row("prospects", 3).lastDiscoveryRunId).toBe(9);
    expect(row("prospects", 1).lastDiscoveryRunId).toBeUndefined();
    expect(row("prospects", 4)).toMatchObject({ title: "Old title", email: null });
    expect(row("prospects", 4).lastDiscoveryRunId).toBeUndefined();
    expect(r).toMatchObject({ prospectsCreated: 1, prospectsUpdated: 2, prospectsSkippedNameOnly: 1 });
    // The stranger's find is a person of its own.
    const jane = rows("prospects").filter((p) => p.firstName === "Jane");
    expect(jane).toHaveLength(2);
    expect(jane.find((p) => p.id !== 1)).toMatchObject({ title: "Stranger's title", linkedinUrl: "https://linkedin.com/in/jane-doe-77" });
  });
});

/* ── P74 ──────────────────────────────────────────────────────────────── */

describe("nobody who said no is imported, and no address that cannot be mailed (P74)", () => {
  it("skips the unsubscribed and the do-not-contact, keeps a bounced or free-mail person without the address", async () => {
    rows("email_suppressions").push(
      { id: 1, workspaceId: WS, email: "gone@acme.example", reason: "unsubscribe" },
      { id: 2, workspaceId: WS, email: "dead@acme.example", reason: "bounce" },
      // Another workspace's list does not apply here.
      { id: 3, workspaceId: OTHER, email: "fine@acme.example", reason: "unsubscribe" },
    );
    rows("are_suppression_list").push({ id: 1, workspaceId: WS, email: null, linkedinUrl: null, companyDomain: "blocked.example", reason: "do_not_contact" });
    // Already in People and now unsubscribed: not touched either.
    person(7, { firstName: "Old", lastName: "Friend", email: "gone@acme.example" });
    const r = await persistAsProspects(WS, 9, [
      candidate({ firstName: "Gone", lastName: "Away", email: "gone@acme.example" }),
      candidate({ firstName: "Old", lastName: "Friend", email: "gone@acme.example", title: "New title" }),
      candidate({ firstName: "Block", lastName: "Ed", companyName: "Blocked", companyDomain: "blocked.example" }),
      candidate({ firstName: "Dead", lastName: "Box", email: "dead@acme.example" }),
      candidate({ firstName: "Free", lastName: "Mail", companyName: "Gmail Co", email: "free.mail@gmail.com", companyDomain: "gmail.com" }),
      candidate({ firstName: "Fine", lastName: "Here", email: "fine@acme.example" }),
    ]);
    expect(r.prospectsSkippedSuppressed).toBe(3);
    const by = (first: string) => rows("prospects").find((p) => p.firstName === first);
    expect(by("Gone")).toBeUndefined();
    expect(by("Block")).toBeUndefined();
    expect(row("prospects", 7).lastDiscoveryRunId).toBeUndefined();
    expect(by("Dead")).toMatchObject({ email: null, verificationNotes: expect.stringContaining("Address left out") });
    expect(by("Free")).toMatchObject({ email: null, companyDomain: null, verificationNotes: expect.stringContaining("Personal address (gmail.com) left out") });
    expect(by("Fine").email).toBe("fine@acme.example");
  });
});

/* ── P65 ──────────────────────────────────────────────────────────────── */

describe("location and industry reach People (P65)", () => {
  it("splits a place string, keeps a vendor's parts, and fills blanks without replacing", async () => {
    expect(placeParts("Austin, Texas, United States")).toEqual({ city: "Austin", state: "Texas", country: "United States" });
    expect(placeParts("Austin, TX")).toEqual({ city: "Austin", state: "TX", country: null });
    expect(placeParts("Ontario, Canada")).toEqual({ city: null, state: "Ontario", country: "Canada" });
    expect(placeParts("London, United Kingdom")).toEqual({ city: "London", state: null, country: "United Kingdom" });
    expect(placeParts("United States")).toEqual({ city: null, state: null, country: "United States" });
    expect(placeParts("San Francisco Bay Area")).toEqual({ city: "San Francisco Bay Area", state: null, country: null });
    expect(placeParts(null)).toEqual({ city: null, state: null, country: null });

    run(9);
    find(1, 9, { firstName: "Ann", lastName: "Lee", companyName: "Acme", location: "Austin, Texas, United States", rawJson: { industry: "Nonprofit" } });
    // Source search's shape: the parts as the vendor gave them.
    find(2, 9, { source: "warmysender", firstName: "Bo", lastName: "Ng", companyName: "Beta", location: "Reno, NV, US", rawJson: { city: "Reno", stateProvince: "Nevada", country: "US", industry: "Retail" } });
    // Already in People with an industry and no city.
    person(5, { firstName: "Cy", lastName: "Fox", email: "cy@gamma.example", industry: "Government" });
    find(3, 9, { firstName: "Cy", lastName: "Fox", companyName: "Gamma", email: "cy@gamma.example", location: "Denver, Colorado, United States", rawJson: { industry: "Retail" } });
    await processRun(WS, 9, "person");
    const by = (first: string) => rows("prospects").find((p) => p.firstName === first);
    expect(by("Ann")).toMatchObject({ city: "Austin", state: "Texas", country: "United States", industry: "Nonprofit" });
    expect(by("Bo")).toMatchObject({ city: "Reno", state: "Nevada", country: "US", industry: "Retail" });
    expect(row("prospects", 5)).toMatchObject({ city: "Denver", state: "Colorado", industry: "Government" });
  });
});

/* ── P61 ──────────────────────────────────────────────────────────────── */

describe("the run and the toast count what was saved (P61)", () => {
  it("tiers count saved people only, and the run records updated, not saved and companies", async () => {
    run(9);
    find(1, 9, { firstName: "Ann", lastName: "Lee", companyName: "Acme", email: "ann@acme.example" });
    // Only a first name: found, never saved.
    find(2, 9, { firstName: "Cher", lastName: null, companyName: "Music Co" });
    // Matches an archived person: left alone.
    person(6, { firstName: "Arch", lastName: "Ived", email: "arch@acme.example", verificationStatus: "rejected", verificationSetBy: "human" });
    find(3, 9, { firstName: "Arch", lastName: "Ived", companyName: "Acme", email: "arch@acme.example" });
    // Matches someone to update.
    person(8, { firstName: "Up", lastName: "Dated", email: "up@acme.example" });
    find(4, 9, { firstName: "Up", lastName: "Dated", companyName: "Acme", email: "up@acme.example" });
    const r = await processRun(WS, 9, "person");
    expect(r).toMatchObject({ prospectsCreated: 1, prospectsUpdated: 1, prospectsSkippedNoName: 1, prospectsSkippedArchived: 1 });
    expect(r.highConfidenceCount + r.mediumConfidenceCount + r.lowConfidenceCount).toBe(2);
    expect(row("discovery_runs", 9)).toMatchObject({ prospectsCreated: 1, prospectsUpdated: 1, prospectsSkipped: 2 });
    const tiers = row("discovery_runs", 9);
    expect(tiers.highConfidenceCount + tiers.mediumConfidenceCount + tiers.lowConfidenceCount).toBe(2);
    const done = rows("discovery_logs").find((l) => l.phase === "persist.complete");
    expect(done.message).toContain("not saved: 1 archived left alone, 1 with no full name");
    expect(done.details.saved).toBeUndefined();
  });

  it("account mode puts the companies it saved on the run", async () => {
    run(9, { mode: "account" });
    find(1, 9, { source: "google_business", companyName: "Beta Bakery", companyDomain: "beta.example" });
    await processRun(WS, 9, "account");
    expect(row("discovery_runs", 9).accountsCreated).toBe(1);
  });
});

/* ── P72, P143 ────────────────────────────────────────────────────────── */

describe("one search runs once, and a run that cannot finish says so (P72, P143)", () => {
  it("the same search already running is joined: one run, one vendor call, both answered with it", async () => {
    onlyLinkedIn();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    h.linkedin = async () => { await gate; return { ok: true, hits: [hit("Ann", "Lee", "ann-lee")] }; };
    const input = { jobTitle: "Director", keywords: ["grants"] };
    const first = runDiscovery(WS, 1, "person", input, null, { sources: ["linkedin"] });
    // A retry after a lost response: same fields, spelled a little differently.
    const second = runDiscovery(WS, 1, "person", { keywords: [" grants "], jobTitle: "Director ", industry: "" }, null, { sources: ["linkedin"] });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(h.linkedinCalls).toBe(1);
    expect(rows("discovery_runs")).toHaveLength(1);
    expect(b.runId).toBe(a.runId);
    expect(b.joinedRunning).toBe(true);
    expect(a.joinedRunning).toBeUndefined();
    expect(a).toMatchObject({ status: "complete", prospectsCreated: 1 });
    await vi.waitFor(() => expect(h.associate).toBe(1), { timeout: 15000 });
    // Asked again once it has finished is a new run, as the person meant.
    await runDiscovery(WS, 1, "person", input, null, { sources: ["linkedin"] });
    expect(rows("discovery_runs")).toHaveLength(2);
    expect(h.linkedinCalls).toBe(2);
  });

  it("a different search is not joined", async () => {
    onlyLinkedIn();
    h.linkedin = async () => ({ ok: true, hits: [] });
    await Promise.all([
      runDiscovery(WS, 1, "person", { jobTitle: "Director" }, null, { sources: ["linkedin"] }),
      runDiscovery(WS, 1, "person", { jobTitle: "Treasurer" }, null, { sources: ["linkedin"] }),
    ]);
    expect(rows("discovery_runs")).toHaveLength(2);
  });

  it("a save that fails marks the run failed with the reason; a crash does too", async () => {
    onlyLinkedIn();
    person(3, { firstName: "Bo", lastName: "Ng", linkedinUrl: "https://www.linkedin.com/in/bo-ng" });
    h.linkedin = async () => ({ ok: true, hits: [hit("Bo", "Ng", "bo-ng")] });
    h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS, beforeUpdate: (t) => { if (t === "prospects") throw new Error("disk full"); } });
    rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
    onlyLinkedIn();
    person(3, { firstName: "Bo", lastName: "Ng", linkedinUrl: "https://www.linkedin.com/in/bo-ng" });
    const r = await runDiscovery(WS, 1, "person", { jobTitle: "COO" }, null, { sources: ["linkedin"] });
    expect(r.status).toBe("failed");
    expect(rows("discovery_runs")[0]).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("disk full") });
    expect(rows("raw_finds")).toHaveLength(1);

    // An exception outside the save: the run is failed, and the error goes on up.
    h.linkedin = async () => { throw new Error("unreachable"); };
    rows("workspace_settings").splice(0);
    const select = h.db.select;
    h.db.select = (p?: unknown) => { const b = select(p); const from = b.from; b.from = (t: unknown) => { if (t === workspaceSettings) throw new Error("settings table gone"); return from(t); }; return b; };
    await expect(runDiscovery(WS, 1, "person", { jobTitle: "CFO" }, null, { sources: ["linkedin"] })).rejects.toThrow();
    expect(rows("discovery_runs").find((x) => x.input?.jobTitle === "CFO")).toMatchObject({ status: "failed", errorMessage: expect.any(String) });
  });

  it("a run a restart cut off reads failed, and Re-score completes a failed save", async () => {
    run(31, { startedAt: new Date(Date.now() - DISCOVERY_ORPHAN_MS - 60_000) });
    run(32, { startedAt: new Date(Date.now() - 60_000) });
    const list = await caller().discovery.listRuns({ limit: 10 });
    expect(list.find((x: any) => x.id === 31)).toMatchObject({ status: "failed", errorMessage: expect.stringContaining("Stopped before it finished") });
    expect(list.find((x: any) => x.id === 32).status).toBe("running");

    run(33, { status: "failed", rawFindCount: 1, errorMessage: "Saving the finds failed: x" });
    find(1, 33, { firstName: "Ann", lastName: "Lee", companyName: "Acme" });
    const r = await caller().discovery.reprocess({ runId: 33 });
    expect(r.prospectsCreated).toBe(1);
    expect((r as any).saved).toBeUndefined();
    expect(row("discovery_runs", 33)).toMatchObject({ status: "complete", errorMessage: null });
  });
});

/* ── P145, P147 ───────────────────────────────────────────────────────── */

describe("a campaign id must be this workspace's (P145); logs read in order (P147)", () => {
  it("refuses another workspace's campaign before anything runs", async () => {
    onlyLinkedIn();
    rows("are_campaigns").push({ id: 70, workspaceId: OTHER, name: "Theirs" }, { id: 71, workspaceId: WS, name: "Ours" });
    await expect(caller().discovery.search({ mode: "person", input: { jobTitle: "CFO" }, campaignId: 70, sources: ["linkedin"] }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows("discovery_runs")).toHaveLength(0);
    const ok = await caller().discovery.search({ mode: "person", input: { jobTitle: "CFO" }, campaignId: 71, sources: ["linkedin"] });
    expect(row("discovery_runs", ok.runId).campaignId).toBe(71);
  });

  it("returns the newest lines, oldest first", async () => {
    run(9);
    const t0 = Date.now() - 10_000;
    for (let i = 0; i < 5; i++) rows("discovery_logs").push({ id: 100 + i, workspaceId: WS, runId: 9, phase: `p${i}`, level: "info", message: `line ${i}`, details: null, createdAt: new Date(t0 + i * 1000) });
    const all = await caller().discovery.getLogs({ runId: 9 });
    expect(all.map((l: any) => l.message)).toEqual(["line 0", "line 1", "line 2", "line 3", "line 4"]);
    const latest = await caller().discovery.getLogs({ runId: 9, limit: 2 });
    expect(latest.map((l: any) => l.message)).toEqual(["line 3", "line 4"]);
  });
});
