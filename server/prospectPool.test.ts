/**
 * Phase 2 of the prospect allowance (owner decisions, 2026-11-25):
 *
 *   A. each person counts once per workspace, ever — discovered, then
 *      enriched, is ONE unit
 *   B. the daily cap for shared use is ceil(plan monthly / 10), replacing the
 *      vendors' lower caps for shared use only; own keys keep theirs
 *   C. one shared pool: own key → loan → pool → environment key; a monthly
 *      platform ceiling per source, consumed together with the workspace's
 *      allowance (both or neither)
 *   D. one prospect source per workspace on a plan; a workspace with no plan
 *      keeps its waterfall
 *
 * Real services against the SQL-evaluating fake; only vendor HTTP is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "a".repeat(64);
  return { db: null as any, apollo: [] as any[], qe: [] as any[], people: [] as any[] };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./services/personLink", async (a) => ({
  ...(await a<typeof import("./services/personLink")>()),
  linkUnlinkedQueueRows: async () => ({ linked: 0, created: 0, skippedNoIdentity: 0 }),
}));
vi.mock("./services/apollo", async (a) => ({
  ...(await a<typeof import("./services/apollo")>()),
  apolloPulledToday: async () => 0,
  apolloSearchPeople: async (_ws: number, input: any) => { h.apollo.push(input); return { ok: true, prospects: [], totalAvailable: 0, pageCount: 0 }; },
}));
vi.mock("./services/quickenrich", async (a) => ({
  ...(await a<typeof import("./services/quickenrich")>()),
  quickenrichPulledToday: async () => 0,
  getQuickenrichIndustries: async () => null,
  quickenrichContactFinder: async (_k: string, body: any) => { h.qe.push(body); return { ok: true, people: h.people }; },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { encryptSecret } from "./_core/crypto";
import { PLAN_MONTHLY_LIMIT, MEMBERSHIP_PLANS, planDailyCap } from "@shared/prospectAllowance";
import { numberSources, sourceUsedUpMessage } from "@shared/sourceNames";
import { holdAllowance, personKeys, personCounted, keyOriginDetail, effectiveDailyCap } from "./services/prospectAllowance";
import { invalidatePoolCache, poolConfig, poolUsedThisMonth, setPoolSource, setPoolWorkspace, sourceNamesFor } from "./services/prospectPool";
import { applySingleSource, defaultSourceFor, singleSourceFor } from "./services/prospectSourceChoice";
import { getQuickEnrichKey, getQuickenrichDailyPullCap, quickenrichFindEmailByLinkedIn } from "./services/quickenrich";
import { getApolloDailyCap } from "./services/apollo";
import { loadCredentials } from "./services/prospectSources/credentials";
import { getSource, periodsFor } from "./services/prospectSources/registry";
import { runDiscovery, __resetEngineLogRepeatsForTests } from "./areEngine";
import { startRun } from "./services/prospectSources/searchRuns";

const WS = 5, POOL = 1, OTHER = 7;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const settings = (ws: number) => {
  let r = rows("workspace_settings").find((x) => x.workspaceId === ws);
  if (!r) { r = { workspaceId: ws }; rows("workspace_settings").push(r); }
  return r;
};
const month = () => new Date().toISOString().slice(0, 7);
const used = (ws = WS) => rows("prospect_allowance_usage").find((r) => r.workspaceId === ws && r.period === month())?.used ?? 0;
const pooled = (slug: string) => rows("prospect_pool_usage").find((r) => r.slug === slug && r.period === month())?.used ?? 0;
const pool = (slug: string, over: Record<string, unknown> = {}) => {
  rows("prospect_pool_sources").push({ slug, shared: true, monthlyCeiling: null, sourceNumber: null, description: null, ...over });
  invalidatePoolCache();
};
const person = (i: number) => ({
  firstName: "Pat", lastName: `Person${i}`, title: "Chief Financial Officer", linkedinUrl: `https://www.linkedin.com/in/pat-${i}`,
  companyName: `Company ${i}`, companyDomain: `company${i}.example`, hasEmail: true, locality: null, city: null,
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.apollo = []; h.qe = []; h.people = [];
  invalidatePoolCache();
  __resetEngineLogRepeatsForTests();
  delete process.env.QUICKENRICH_API_KEY;
  for (const id of [POOL, WS, OTHER]) rows("workspaces").push({ id, name: `W${id}`, slug: `w${id}`, ownerUserId: 1, archivedAt: null, plan: "trial" });
  settings(POOL).quickenrichApiKeyEnc = encryptSecret("pool-qe-key");
  settings(POOL).apolloApiKeyEnc = encryptSecret("pool-apollo-key");
  rows("prospect_source_credentials").push({ id: 1, workspaceId: POOL, sourceSlug: "warmysender", status: "valid", credentialsEnc: encryptSecret(JSON.stringify({ apiKey: "pool-ws-key" })), config: { monthlyLeadAllowance: 3000 } });
  rows("platform_settings").push({ settingKey: "prospectPool", value: { workspaceId: POOL } });
  settings(WS);
  // Each looked-up profile has its own address: pat-1 → pat-1@company.example.
  vi.stubGlobal("fetch", async (u: string) => {
    const slug = decodeURIComponent(String(u)).match(/\/in\/([^&/]+)/)?.[1] ?? "x";
    return new Response(JSON.stringify({ data: { email: `${slug}@company.example` } }), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("A. each person counts once per workspace, ever", () => {
  beforeEach(() => { settings(WS).membershipPlan = "member"; pool("quickenrich"); });

  it("keys a person by LinkedIn profile and email, and by name and company only when there is neither", () => {
    expect(personKeys({ linkedinUrl: "https://www.LinkedIn.com/in/Pat-1/", email: "Pat@Acme.example" })).toEqual(["li:pat-1", "e:pat@acme.example"]);
    expect(personKeys({ firstName: "Pat", lastName: "Lee", companyName: "Acme" })).toEqual(["n:pat lee@acme"]);
    expect(personKeys({ firstName: "Pat", lastName: "Lee", companyName: "Acme", email: "pat@acme.example" })).toEqual(["e:pat@acme.example"]);
    expect(personKeys({})).toEqual([]);
  });

  it("a person discovered from shared data and then enriched by it counts ONE", async () => {
    const found = { linkedinUrl: "https://www.linkedin.com/in/pat-1", firstName: "Pat", lastName: "Person1" };
    const hold = await holdAllowance(WS, "quickenrich", 10);
    expect(hold.metered).toBe(true);
    await hold.settle([found]);
    expect(used()).toBe(1);
    // The email lookup for the same person: found, and free.
    const r = await quickenrichFindEmailByLinkedIn("pool-qe-key", found.linkedinUrl, { workspaceId: WS, feature: "test" });
    expect(r.reason).toBe("found");
    expect(used()).toBe(1);
    // …and the email is now one of their keys: found again by email, still free.
    expect(await personCounted(WS, { email: "pat-1@company.example" })).toBe(true);
    // Someone new costs one.
    await quickenrichFindEmailByLinkedIn("pool-qe-key", "https://www.linkedin.com/in/someone-else", { workspaceId: WS, feature: "test" });
    expect(used()).toBe(2);
  });

  it("an email found first and the same person added later count ONE", async () => {
    await quickenrichFindEmailByLinkedIn("pool-qe-key", "https://www.linkedin.com/in/pat-9", { workspaceId: WS, feature: "test" });
    expect(used()).toBe(1);
    const hold = await holdAllowance(WS, "quickenrich", 5);
    await hold.settle([{ linkedinUrl: "https://linkedin.com/in/pat-9/", firstName: "Pat", lastName: "Nine" }]);
    expect(used()).toBe(1);
  });

  it("someone already counted can be enriched even when the month is used up", async () => {
    await (await holdAllowance(WS, "quickenrich", 1)).settle([{ linkedinUrl: "https://www.linkedin.com/in/pat-3" }]);
    rows("prospect_allowance_usage").find((r) => r.workspaceId === WS).used = PLAN_MONTHLY_LIMIT.member;
    const known = await quickenrichFindEmailByLinkedIn("pool-qe-key", "https://www.linkedin.com/in/pat-3", { workspaceId: WS, feature: "test" });
    expect(known.reason).toBe("found");
    const stranger = await quickenrichFindEmailByLinkedIn("pool-qe-key", "https://www.linkedin.com/in/stranger", { workspaceId: WS, feature: "test" });
    expect(stranger.reason).toBe("allowance_exhausted");
  });

  it("two settles that both deliver one person count them once", async () => {
    const a = await holdAllowance(WS, "quickenrich", 1);
    const b = await holdAllowance(WS, "quickenrich", 1);
    await Promise.all([a.settle([{ linkedinUrl: "https://www.linkedin.com/in/twin" }]), b.settle([{ linkedinUrl: "https://www.linkedin.com/in/twin" }])]);
    expect(used()).toBe(1);
  });
});

describe("B. the daily cap for shared use", () => {
  it("is a tenth of the month, rounded up", () => {
    expect(MEMBERSHIP_PLANS.map((p) => planDailyCap(p))).toEqual([25, 100, 300, 500, 600]);
  });

  it("holds a plan's shared use to the day's cap, and says so", async () => {
    settings(WS).membershipPlan = "trial";
    pool("quickenrich");
    const hold = await holdAllowance(WS, "quickenrich", 40);
    expect(hold.granted).toBe(25);
    await hold.settle(Array.from({ length: 25 }, (_, i) => ({ linkedinUrl: `https://www.linkedin.com/in/d-${i}` })));
    const next = await holdAllowance(WS, "quickenrich", 1);
    expect(next.granted).toBe(0);
    expect(next.reason).toMatch(/^Source \d+ has reached today's limit for your plan \(25 a day\)/);
  });

  it("replaces the vendors' own lower caps for shared use only; an own key keeps its cap", async () => {
    settings(WS).membershipPlan = "contributor";
    pool("apollo"); pool("quickenrich");
    expect(await getApolloDailyCap(WS)).toBe(300);
    expect(await getQuickenrichDailyPullCap(WS)).toBe(300);
    settings(WS).apolloApiKeyEnc = encryptSecret("own-apollo");
    settings(WS).apolloDailyPullCap = 40;
    expect(await getApolloDailyCap(WS)).toBe(40);
    expect(await effectiveDailyCap(OTHER, "apollo", 50)).toBe(50); // no plan: its own cap
  });

  it("a borrowed table-mode key carries the plan's cap, and pool use leaves the lender's ledger alone", async () => {
    settings(WS).membershipPlan = "steward";
    pool("warmysender");
    const creds = await loadCredentials(WS, getSource("warmysender"));
    expect(creds).toMatchObject({ origin: "pool", dailyCapOverride: 500 });
    expect(periodsFor(getSource("warmysender"), creds!)).toEqual([]);
    const own = await loadCredentials(POOL, getSource("warmysender"));
    expect(own?.origin).toBe("own");
    expect(periodsFor(getSource("warmysender"), own!).length).toBeGreaterThan(0);
  });
});

describe("C. one shared pool", () => {
  it("resolves own key → loan → pool → environment key, for every workspace with no step of its own", async () => {
    process.env.QUICKENRICH_API_KEY = "env-qe-key";
    settings(WS).sharedQuickenrichKey = true;
    pool("quickenrich", { shared: false });
    expect(await getQuickEnrichKey(WS)).toBe("env-qe-key"); // switched off
    rows("prospect_pool_sources").find((r) => r.slug === "quickenrich").shared = true;
    invalidatePoolCache();
    expect(await getQuickEnrichKey(WS)).toBe("pool-qe-key");
    expect(await keyOriginDetail(WS, "quickenrich")).toBe("pool");
    rows("workspace_settings").push({ workspaceId: 9, quickenrichApiKeyEnc: encryptSecret("lender-qe") });
    rows("workspaces").push({ id: 9, name: "L", slug: "l", ownerUserId: 1, archivedAt: null, plan: "trial" });
    rows("workspace_key_shares").push({ id: 1, ownerWorkspaceId: 9, targetWorkspaceId: WS, keyKind: "quickenrich" });
    expect(await getQuickEnrichKey(WS)).toBe("lender-qe");
    expect(await keyOriginDetail(WS, "quickenrich")).toBe("loan");
    settings(WS).quickenrichApiKeyEnc = encryptSecret("own-qe");
    expect(await getQuickEnrichKey(WS)).toBe("own-qe");
    expect(await keyOriginDetail(WS, "quickenrich")).toBe("own");
    // The pool workspace uses its keys as its own.
    expect(await keyOriginDetail(POOL, "quickenrich")).toBe("own");
    // A source switched off is not shared.
    pool("apollo", { shared: false });
    expect(await keyOriginDetail(OTHER, "apollo")).toBe("none");
  });

  it("serves table-mode sources from the pool, and a pooled key verifies nothing", async () => {
    pool("warmysender");
    const creds = await loadCredentials(OTHER, getSource("warmysender"));
    expect(creds).toMatchObject({ origin: "pool", secrets: { apiKey: "pool-ws-key" } });
    const { warmySenderSecondOpinion } = await import("./services/secondVerifier");
    const fetches: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => { fetches.push(String(u)); return new Response("{}", { status: 200 }); });
    expect(await warmySenderSecondOpinion(OTHER, "pat@acme.example", "test", null)).toEqual({ decided: false, why: "no_key" });
    expect(fetches).toEqual([]);
  });

  it("LeadOcean works from the pool: the pool's key, its own viewed list per borrower, and the plan's daily cap", async () => {
    rows("prospect_source_credentials").push({ id: 2, workspaceId: POOL, sourceSlug: "leadocean", status: "valid", credentialsEnc: encryptSecret(JSON.stringify({ apiKey: "lo_live_pool" })), config: { dailyPeopleCap: 40 } });
    pool("leadocean");
    settings(WS).membershipPlan = "member";
    const creds = await loadCredentials(WS, getSource("leadocean"));
    expect(creds).toMatchObject({ origin: "pool", secrets: { apiKey: "lo_live_pool" }, dailyCapOverride: 100, workspaceId: WS });
    const { viewedSetFor } = await import("./services/prospectSources/adapters/leadocean");
    expect(viewedSetFor(creds!.workspaceId)).toBe(`velocity-ws-${WS}`);
    // No plan: the lender's own cap stays, and the ceiling governs.
    expect((await loadCredentials(OTHER, getSource("leadocean")))?.dailyCapOverride ?? null).toBeNull();
    expect(await keyOriginDetail(OTHER, "leadocean")).toBe("pool");
  });

  it("counts every workspace's pool use against the ceiling, and refuses past it with the members' sentence", async () => {
    pool("quickenrich", { monthlyCeiling: 3, sourceNumber: 2 });
    const a = await holdAllowance(OTHER, "quickenrich", 2); // no plan: only the ceiling
    expect(a).toMatchObject({ metered: true, granted: 2 });
    await a.settle(2);
    const b = await holdAllowance(OTHER, "quickenrich", 5);
    expect(b.granted).toBe(1);
    await b.settle(0);
    expect(pooled("quickenrich")).toBe(2);
    await (await holdAllowance(OTHER, "quickenrich", 1)).settle(1);
    const c = await holdAllowance(WS, "quickenrich", 1);
    expect(c.granted).toBe(0);
    expect(c.reason).toBe(sourceUsedUpMessage("Source 2"));
    expect(c.reason).toBe("Source 2 is used up for this month. Choose another source in Settings → Data sources.");
  });

  it("holds the workspace's allowance and the ceiling together: both or neither", async () => {
    settings(WS).membershipPlan = "member";
    pool("quickenrich", { monthlyCeiling: 4 });
    rows("prospect_pool_usage").push({ id: 1, slug: "quickenrich", period: month(), used: 4 });
    const hold = await holdAllowance(WS, "quickenrich", 10);
    expect(hold.granted).toBe(0);
    expect(used()).toBe(0); // the workspace's units were given back
  });

  it("numbers sources by descending ceiling, a listed source last, the owner's numbers first", async () => {
    expect(numberSources(["a", "b", "c"], { a: { ceiling: 100 }, b: { ceiling: 900 }, c: {} })).toEqual({ b: 1, a: 2, c: 3 });
    expect(numberSources(["a", "b", "c"], { a: { ceiling: 100 }, b: { ceiling: 900 }, c: {} }, ["b"])).toEqual({ a: 1, c: 2, b: 3 });
    expect(numberSources(["a", "b", "c"], { a: { ceiling: 100, number: 2 }, b: { ceiling: 900 }, c: {} })).toEqual({ a: 2, b: 1, c: 3 });
    await setPoolSource("warmysender", { number: 1 });
    await setPoolSource("apollo", { number: 2 });
    const cfg = await poolConfig();
    expect([cfg.sources.warmysender.number, cfg.sources.apollo.number]).toEqual([1, 2]);
  });

  it("only the platform owner reads the true names", async () => {
    pool("apollo", { sourceNumber: 3, description: "People and companies" });
    const members = await sourceNamesFor({ platformOwner: false });
    expect(members.find((n) => n.slug === "apollo")).toMatchObject({ label: "Source 3", description: "People and companies" });
    expect(JSON.stringify(members.map((n) => [n.label, n.description]))).not.toMatch(/apollo|quick\s?enrich|warmy\s?sender|lead\s?ocean/i);
    const owner = await sourceNamesFor({ platformOwner: true });
    expect(owner.find((n) => n.slug === "apollo")?.label).toMatch(/Apollo/);
  });

  it("the setter names and clears the pool workspace", async () => {
    await setPoolWorkspace(OTHER);
    expect((await poolConfig()).poolWorkspaceId).toBe(OTHER);
    await setPoolWorkspace(null);
    expect((await poolConfig()).poolWorkspaceId).toBeNull();
  });
});

describe("E. the owner's seed (2026-11-25)", () => {
  const SEEDED = {
    leadocean: "Over a billion profiles at 73 million companies, with a deliverability status on every email.",
    quickenrich: "Contact details matched to LinkedIn profiles, with emails and phone numbers.",
    warmysender: "A database of over 200 million B2B contacts in the US and Canada.",
    apollo: "People and company search by title, seniority and company size; emails are found separately.",
  };
  const poolLeadOceanKey = () => rows("prospect_source_credentials").push({ id: 2, workspaceId: POOL, sourceSlug: "leadocean", status: "valid", credentialsEnc: encryptSecret(JSON.stringify({ apiKey: "lo_live_pool" })), config: {} });

  it("every source is shared once the pool workspace is named and holds its key; the switch still turns one off", async () => {
    expect(await keyOriginDetail(OTHER, "quickenrich")).toBe("pool");
    expect(await keyOriginDetail(OTHER, "apollo")).toBe("pool");
    expect(await keyOriginDetail(OTHER, "warmysender")).toBe("pool");
    expect(await keyOriginDetail(OTHER, "leadocean")).toBe("none"); // the pool holds no key for it
    poolLeadOceanKey();
    expect(await keyOriginDetail(OTHER, "leadocean")).toBe("pool");
    await setPoolSource("quickenrich", { shared: false });
    expect(await keyOriginDetail(OTHER, "quickenrich")).toBe("none");
    await setPoolWorkspace(null);
    expect(await keyOriginDetail(OTHER, "apollo")).toBe("none"); // no pool workspace, nothing shared
  });

  it("starts from the known ceilings and the approved descriptions, word for word", async () => {
    const cfg = await poolConfig();
    expect(Object.fromEntries(Object.values(cfg.sources).map((s) => [s.slug, s.monthlyCeiling]))).toEqual({ leadocean: 214_000, aleads: 100_000, clugtm: 25_000, quickenrich: 6_000, warmysender: null, apollo: null });
    for (const [slug, text] of Object.entries(SEEDED)) expect(cfg.sources[slug].description).toBe(text);
    const { POOL_SOURCE_SEED } = await import("./services/prospectPoolSeed");
    expect(POOL_SOURCE_SEED.aleads).toEqual({ monthlyCeiling: 100_000, description: "Verified B2B contacts, checked for catch-all domains." });
    expect(POOL_SOURCE_SEED.clugtm).toEqual({ monthlyCeiling: 25_000, description: "Over a billion profiles drawn from more than 25 providers and refreshed every 30 days." });
    // No description names a vendor.
    expect(JSON.stringify(Object.values(POOL_SOURCE_SEED).map((x) => x.description))).not.toMatch(/apollo|quick\s?enrich|warmy\s?sender|lead\s?ocean|a-?leads|clu\s?gtm|cleanlist/i);
  });

  it("numbers by ceiling: LeadOcean, A-Leads, CluGTM, QuickEnrich, then WarmySender; Apollo always last", async () => {
    const cfg = await poolConfig();
    expect(Object.fromEntries(Object.values(cfg.sources).map((s) => [s.slug, s.number]))).toEqual({ leadocean: 1, aleads: 2, clugtm: 3, quickenrich: 4, warmysender: 5, apollo: 6 });
    // The seed alone, in any order:
    const { POOL_SOURCE_SEED, ALWAYS_LAST_SOURCES } = await import("./services/prospectPoolSeed");
    const all = ["warmysender", "quickenrich", "apollo", "leadocean", "aleads", "clugtm"];
    expect(numberSources(all, Object.fromEntries(all.map((s) => [s, { ceiling: POOL_SOURCE_SEED[s].monthlyCeiling }])), ALWAYS_LAST_SOURCES))
      .toEqual({ leadocean: 1, aleads: 2, clugtm: 3, quickenrich: 4, warmysender: 5, apollo: 6 });
  });

  it("WarmySender takes its place once its ceiling is set; Apollo stays last whatever its ceiling; the owner's number wins until cleared", async () => {
    await setPoolSource("warmysender", { monthlyCeiling: 30_000 });
    await setPoolSource("apollo", { monthlyCeiling: 10_000_000 });
    let cfg = await poolConfig();
    expect(Object.fromEntries(Object.values(cfg.sources).map((s) => [s.slug, s.number]))).toEqual({ leadocean: 1, aleads: 2, warmysender: 3, clugtm: 4, quickenrich: 5, apollo: 6 });
    await setPoolSource("quickenrich", { number: 1 });
    cfg = await poolConfig();
    expect([cfg.sources.quickenrich.number, cfg.sources.leadocean.number]).toEqual([1, 2]);
    await setPoolSource("quickenrich", { number: null });
    cfg = await poolConfig();
    expect([cfg.sources.leadocean.number, cfg.sources.quickenrich.number]).toEqual([1, 5]);
  });

  it("changing one field keeps the seeded others", async () => {
    await setPoolSource("quickenrich", { shared: false });
    const row = rows("prospect_pool_sources").find((r) => r.slug === "quickenrich");
    expect(row).toMatchObject({ shared: false, monthlyCeiling: 6_000, sourceNumber: null, description: SEEDED.quickenrich });
    await setPoolSource("leadocean", { description: "Edited by the owner" });
    const cfg = await poolConfig();
    expect(cfg.sources.leadocean).toMatchObject({ shared: true, monthlyCeiling: 214_000, description: "Edited by the owner" });
    // Clearing a ceiling the owner wrote means "not set" from then on.
    await setPoolSource("leadocean", { monthlyCeiling: null });
    expect((await poolConfig()).sources.leadocean.monthlyCeiling).toBeNull();
  });

  it("the default is LeadOcean once the pool holds its key; Apollo is never the default while another source has room", async () => {
    settings(WS).membershipPlan = "member";
    expect(await defaultSourceFor(WS)).toBe("quickenrich"); // LeadOcean skipped: no key to run it
    poolLeadOceanKey();
    expect(await defaultSourceFor(WS)).toBe("leadocean");
    expect(await singleSourceFor(WS)).toEqual({ slug: "leadocean", chosen: false });
    await setPoolSource("apollo", { monthlyCeiling: 10_000_000 });
    expect(await defaultSourceFor(WS)).toBe("leadocean");
    rows("prospect_pool_usage").push({ id: 9, slug: "leadocean", period: month(), used: 214_000 }, { id: 10, slug: "quickenrich", period: month(), used: 6_000 });
    expect(await defaultSourceFor(WS)).toBe("apollo"); // nothing else has room
  });
});

describe("D. one prospect source per workspace on a plan", () => {
  it("no plan: no rule, the waterfall is left as it is", async () => {
    expect(await singleSourceFor(OTHER)).toBeNull();
    expect(applySingleSource(["internal", "quickenrich", "apollo", "news"], null)).toEqual(["internal", "quickenrich", "apollo", "news"]);
  });

  it("the default is the shared source with the most room, ties by number; without ceilings, the workspace's own first source", async () => {
    settings(WS).membershipPlan = "member";
    settings(WS).areSourceOrder = ["apollo", "quickenrich", "warmysender"];
    // No ceilings anywhere (the owner cleared the seeded ones): the workspace's own first prospect database.
    pool("leadocean", { monthlyCeiling: null }); pool("quickenrich", { monthlyCeiling: null });
    expect(await defaultSourceFor(WS)).toBe("apollo");
    rows("prospect_pool_sources").splice(0);
    pool("leadocean", { monthlyCeiling: null });
    pool("quickenrich", { monthlyCeiling: 2000, sourceNumber: 2 });
    pool("warmysender", { monthlyCeiling: 2000, sourceNumber: 1 });
    pool("apollo", { monthlyCeiling: 500, sourceNumber: 3 });
    expect(await defaultSourceFor(WS)).toBe("warmysender");
    rows("prospect_pool_usage").push({ id: 1, slug: "warmysender", period: month(), used: 2000 });
    expect(await defaultSourceFor(WS)).toBe("quickenrich");
    expect(await singleSourceFor(WS)).toEqual({ slug: "quickenrich", chosen: false });
    settings(WS).prospectSource = "apollo";
    expect(await singleSourceFor(WS)).toEqual({ slug: "apollo", chosen: true });
  });

  it("puts the chosen source where the prospect databases stood, and leaves the member's own channels", () => {
    expect(applySingleSource(["internal", "quickenrich", "linkedin", "apollo", "news"], { slug: "warmysender" })).toEqual(["internal", "warmysender", "linkedin", "news"]);
    expect(applySingleSource(["linkedin", "news"], { slug: "apollo" })).toEqual(["linkedin", "news"]);
  });

  it("campaign discovery asks only the chosen source; a workspace with no plan asks both", async () => {
    pool("apollo"); pool("quickenrich");
    h.people = [person(1), person(2)];
    const campaign = (ws: number, id: number) => ({
      id, workspaceId: ws, name: "C", status: "active", targetProspectCount: 10, prospectSources: ["apollo", "quickenrich"],
      icpOverrides: { targetTitles: ["Chief Financial Officer"] }, discoveryQueryState: null, researchSectorId: null, researchPersonaId: null,
    });
    for (const [ws, id] of [[WS, 70], [OTHER, 71]]) {
      settings(ws).areScraperSources = { quickenrich: true, apollo: true, warmysender: false, linkedin: false, google_business: false, news: false, leadocean: false, internal: false };
      rows("are_campaigns").push(campaign(ws, id));
    }
    settings(WS).membershipPlan = "member";
    settings(WS).prospectSource = "quickenrich";
    await runDiscovery(campaign(WS, 70) as never, 10);
    expect(h.apollo).toHaveLength(0);
    expect(h.qe.length).toBeGreaterThan(0);
    expect(used()).toBe(2);
    // The engine's own sentences ("… returned 2 people …") reach the log as "Source N".
    const logs = rows("are_engine_logs").filter((r) => r.campaignId === 70).map((r) => String(r.message));
    expect(logs.some((m) => /^Finding people through Source \d+ only/.test(m))).toBe(true);
    expect(logs.some((m) => /^Source \d+ returned 2 people/.test(m))).toBe(true);
    expect(logs.join(" | ")).not.toMatch(/apollo|quick\s?enrich|warmy\s?sender|lead\s?ocean/i);
    h.apollo = []; h.qe = [];
    await runDiscovery(campaign(OTHER, 71) as never, 10);
    expect(h.apollo).toHaveLength(1);
    expect(h.qe.length).toBeGreaterThan(0);
  });

  it("Source search and the Search box run the chosen source only", async () => {
    settings(WS).membershipPlan = "member";
    settings(WS).prospectSource = "warmysender";
    const { runId } = await startRun(WS, 1, { jobTitles: ["CFO"], seniorities: [], departments: [], industries: [], countries: [], stateProvinces: [], cities: [], postalCodes: [], companyNames: [], companyDomains: [], keywords: [], technologies: [] } as never, 5, ["apollo", "quickenrich"]);
    await new Promise((r) => setTimeout(r, 30));
    const run = rows("prospect_search_runs").find((r) => r.id === runId);
    const perSource = run?.perSource ?? {};
    for (const slug of ["apollo", "quickenrich", "leadocean"]) {
      if (perSource[slug]) expect(perSource[slug].skipped ?? perSource[slug].detail ?? "").toMatch(/not_selected|not selected/);
    }
  });
});
