/**
 * LeadOcean as a prospect source, against a fake vendor that answers the way
 * https://api.leadocean.io/openapi.json says it does (read 2026-11-02), the real
 * adapter, executor, registry, routers and engine, and the SQL-evaluating fake.
 *
 * The rules being held: a person costs two records and every one is counted · a
 * filter LeadOcean will not apply is reported and nothing is bought for it ·
 * state is the employer's headquarters plus a check of the person's own place ·
 * a pace is held, never read as an empty search · no cursor leaves the adapter ·
 * the key reaches no browser and no other workspace · saving a key touches no
 * campaign and buys no row.
 *
 * Time is frozen at T0 — Wednesday 2026-11-18, 15:00 UTC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { encryptSecret } from "./_core/crypto";
import { runDiscovery, __resetEngineLogRepeatsForTests } from "./areEngine";
import {
  __clearIndustryCacheForTests, addressFrom, buildSearchFilters, createLeadOceanSource, externalIdFor, mapPersonRow,
  parseProfileAddress, summarizeAccount, viewedSetFor,
} from "./services/prospectSources/adapters/leadocean";
import { credentialView, loadCredentials } from "./services/prospectSources/credentials";
import { runWaterfall } from "./services/prospectSources/executor";
import { Deduper } from "./services/prospectSources/dedupe";
import { eligibleFor, getSource } from "./services/prospectSources/registry";
import { estimatePromotion, executeRun, promoteResults, runSourceMaintenance } from "./services/prospectSources/searchRuns";
import { parseTargetPlaces } from "./services/placeFit";
import { setVendorCallLogger } from "./services/prospectSources/vendorHttp";
import type { ProspectSource, SourceCredentials, VendorFailure } from "./services/prospectSources/types";
import {
  LEADOCEAN_CAPABILITIES, emptyCriteria, leadoceanAcceptedStatuses, leadoceanUsesFullLookup, matchCapabilities, type SearchCriteria,
} from "@shared/prospectSources";
import { ARE_DEFAULT_SOURCES, ARE_DEFAULT_SOURCE_ORDER, ARE_OPT_IN_SOURCES, ARE_SOURCE_IDS, normalizeSources, resolveSourceOrder } from "@shared/areSources";
import { METER_LABEL, VENDOR_LABEL } from "@shared/spendReport";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");

const LSI = 2;
const CF = 4;
const ADMIN = 20;
const REP = 21;
const T0 = new Date("2026-11-18T15:00:00Z").getTime();
const LATER = "2026-11-18T18:00:00.000Z";
const KEY_LSI = "lo_live_fixture_lsi_not_a_real_key";
const KEY_CF = "lo_live_fixture_cf_not_a_real_key";

const rows = (t: string) => h.db.rowsOf(t) as any[];
const spent = (meter: string, ws = LSI) =>
  rows("spend_ledger").filter((r) => r.workspaceId === ws && r.vendor === "leadocean" && r.meter === meter).reduce((a, r) => a + Number(r.quantity), 0);

/* ─── The fake vendor ───────────────────────────────────────────────────── */

type Call = { host: string; method: string; path: string; query: URLSearchParams; body: any; apiKey: string | null };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function person(id: number | string, over: { profile?: object; contact?: object; meta?: object } = {}) {
  return {
    profile_data: {
      profile_first_name: "Pat", profile_last_name: `Lee${id}`, profile_full_name: `Pat Lee${id}`,
      profile_url: `https://www.linkedin.com/in/pat-${id}`, profile_address: "Richmond, Virginia, United States", ...over.profile,
    },
    contact_data: {
      has_email: true, email_status: "verified", email_type: "work", has_phone: true,
      contact_current_experiences: [{
        company_name: "Henrico County", company_domain: "www.henrico.gov", company_industry: "Government Administration",
        company_employees: { number_of_employees: 4000, number_of_employees_code: "1001-5000" },
        job_title: "County Administrator", job_seniority: { job_level: "C-Team" },
      }],
      ...over.contact,
    },
    meta: { source_ids: { person_id: String(id), person_group_id: String(id) }, ...over.meta },
  };
}

/** The owner's AppSumo Tier 3, as a fixture: nothing in the adapter may know these numbers. */
function account(over: Record<string, unknown> = {}) {
  return {
    account: { id: "acct_1", email: "holder@example.test", plan: "appsumo_tier_3", fairUse: true, suspended: false },
    key: { id: "key_1", prefix: "lo_live_ab", scopes: ["search", "enrich"], maxDepth: null },
    records: { ceiling: null, used: 1234, remaining: null, addOn: 0, period: "billing", resetsAt: LATER, overLimit: false, whenOver: "never" },
    rate: { rps: 50, rpm: 3000 },
    pace: {
      search: [{ window: "h5", windowLabel: "5 hours", limit: 100000, used: 200, resetsAt: LATER }, { window: "w", windowLabel: "week", limit: 500000, used: 900, resetsAt: LATER }],
      enrich: [{ window: "h5", windowLabel: "5 hours", limit: 10000, used: 50, resetsAt: LATER }],
      paced: null,
    },
    search: { view: "full", maxDepth: 10000 },
    ...over,
  };
}

function vendor(opts: {
  pages?: Array<unknown[] | Response | ((c: Call) => Response)>;
  meta?: Record<string, unknown>;
  sizing?: Record<string, unknown> | Response;
  account?: Record<string, unknown> | Response;
  work?: (c: Call) => Response;
  enrich?: (c: Call) => Response;
  viewed?: Response;
  industries?: string[] | Response;
} = {}) {
  const calls: Call[] = [];
  const pages = [...(opts.pages ?? [])];
  const impl = (async (urlIn: string | URL, init?: RequestInit) => {
    const url = new URL(String(urlIn));
    const method = String(init?.method ?? "GET");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const apiKey = new Headers(init?.headers).get("x-api-key");
    const call: Call = { host: url.hostname, method, path: url.pathname, query: url.searchParams, body, apiKey };
    calls.push(call);
    const route = `${method} ${url.pathname}`;
    if (route === "GET /v1/account") {
      if (opts.account instanceof Response) return opts.account.clone();
      return json({ success: true, data: { ...account(), ...(opts.account ?? {}) } });
    }
    if (route === "GET /v1/usage") {
      return json({ success: true, data: { period: "billing", used: 1234, resetsAt: LATER, plan: { slug: "appsumo_tier_3" }, daily: [
        { day: "2026-11-18", keyId: "key_1", search: 40, enrich: 7 }, { day: "2026-11-17", keyId: "key_1", search: 99, enrich: 99 },
      ] } });
    }
    if (route === "GET /v1/enums/industry") {
      if (opts.industries instanceof Response) return opts.industries.clone();
      const q = String(url.searchParams.get("q") ?? "").toLowerCase();
      const all = opts.industries ?? ["Government Administration", "Government Relations", "Executive Offices"];
      return json({ success: true, data: { name: "industry", total: 534, values: all.filter((v) => v.toLowerCase().includes(q)) } });
    }
    if (route === "POST /v1/people/search" && body?.count) {
      if (opts.sizing instanceof Response) return opts.sizing.clone();
      return json({ success: true, data: [], meta: { total: 41, totalIsExact: true, countOnly: true, credits: 0, ...(opts.sizing ?? {}) } });
    }
    if (route === "POST /v1/people/search") {
      const next = pages.shift() ?? [];
      if (next instanceof Response) return next;
      if (typeof next === "function") return next(call);
      return json({ success: true, data: next, meta: { count: next.length, credits: next.length, nextCursor: null, unsupportedFilters: [], ...(opts.meta ?? {}) } });
    }
    if (url.pathname === "/v1/people/viewed") {
      if (opts.viewed) return opts.viewed.clone();
      return json({ success: true, data: { added: body?.ids?.length ?? 0, total: 1 } });
    }
    if (route === "POST /v2/people/email/work") {
      if (opts.work) return opts.work(call);
      return json({ success: true, data: { email: `p${body.contact_id}@henrico.gov`, status: "verified", verified_batch_date: "2026-09-20" } });
    }
    if (route === "POST /v1/people/enrich") {
      if (opts.enrich) return opts.enrich(call);
      const p = person(body.person_id);
      return json({ success: true, data: {
        ...p,
        contact_data: {
          ...p.contact_data,
          ...(body.reveal_email ? {
            contact_emails: [{ email: `p${body.person_id}@henrico.gov`, type: "work", status: "verified", verified_batch_date: "2026-09-20" }],
            contact_phones: [{ phone: "+18045550100", type: "mobile" }, { phone: "+18045550101", type: "office" }],
          } : {}),
        },
      }, meta: { credits: 1 } });
    }
    throw new Error(`the fake vendor has no route for ${route}`);
  }) as unknown as typeof fetch;
  return {
    impl, calls,
    pageCalls: () => calls.filter((c) => c.path === "/v1/people/search" && !c.body?.count),
    sizingCalls: () => calls.filter((c) => c.path === "/v1/people/search" && c.body?.count),
    leadOcean: () => calls.filter((c) => c.host === "api.leadocean.io"),
    paidCalls: () => calls.filter((c) => (c.path === "/v1/people/search" && !c.body?.count) || c.path === "/v1/people/enrich" || c.path.startsWith("/v2/")),
    viewedCalls: () => calls.filter((c) => c.path === "/v1/people/viewed"),
  };
}

const CRITERIA: SearchCriteria = { ...emptyCriteria(), jobTitles: ["County Administrator"], countries: ["US"] };
const STATES: SearchCriteria = { ...emptyCriteria(), jobTitles: ["County Administrator"], stateProvinces: ["Virginia", "Maryland"], industries: ["Government Administration"] };

const creds = (config: Record<string, unknown> = {}, ws = LSI, key = KEY_LSI): SourceCredentials => ({ slug: "leadocean", workspaceId: ws, secrets: { apiKey: key }, config });
const adapter = (v: ReturnType<typeof vendor>): ProspectSource => createLeadOceanSource({ fetchImpl: v.impl, sleep: async () => {} });
const ok = <T extends { ok: boolean }>(r: T) => { expect(r.ok, JSON.stringify(r)).toBe(true); return r as Extract<T, { ok: true }>; };
const bad = (r: { ok: boolean }) => { expect(r.ok, JSON.stringify(r)).toBe(false); return r as unknown as VendorFailure; };

function addKey(ws: number, key: string, config: Record<string, unknown> = {}, status = "valid") {
  rows("prospect_source_credentials").push({
    id: rows("prospect_source_credentials").length + 1, workspaceId: ws, sourceSlug: "leadocean",
    credentialsEnc: encryptSecret(JSON.stringify({ apiKey: key })), config, status,
    lastValidatedAt: null, validationError: null, consecutiveFailures: 0, circuitOpenUntil: null,
  });
}
const credRow = (ws = LSI) => rows("prospect_source_credentials").find((r) => r.workspaceId === ws && r.sourceSlug === "leadocean");

function seed() {
  rows("workspaces").push(
    { id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" },
    { id: CF, name: "CommunityForce", slug: "cf", ownerUserId: ADMIN, archivedAt: null, plan: "trial" },
  );
  const user = (id: number, mail: string) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: mail, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN, "admin@lsi.example"), user(REP, "rep@lsi.example"));
  const member = (id: number, ws: number, userId: number, role: string) => ({
    id, workspaceId: ws, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, LSI, ADMIN, "admin"), member(2, LSI, REP, "rep"), member(3, CF, ADMIN, "admin"));
  rows("workspace_settings").push(
    { workspaceId: LSI, areScraperSources: null, areSourceOrder: null, icpFallback: null },
    { workspaceId: CF, areScraperSources: null, areSourceOrder: null, icpFallback: null },
  );
}
function caller(userId: number, ws = LSI) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user, req: { protocol: "https", headers: { "x-workspace-id": String(ws) }, socket: { remoteAddress: "127.0.0.1" } }, res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true });
  __resetEngineLogRepeatsForTests();
  __clearIndustryCacheForTests();
  setVendorCallLogger(() => {});
  seed();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ─── Mapping ───────────────────────────────────────────────────────────── */

describe("a search row becomes a masked preview", () => {
  it("maps identity, role, company and place, with the spec's field names", () => {
    const r = mapPersonRow(person(7))!;
    expect(r).toEqual(expect.objectContaining({
      externalId: "leadocean:7", firstName: "Pat", lastName: "Lee7", jobTitle: "County Administrator", seniority: "C-Team",
      companyName: "Henrico County", companyDomain: "henrico.gov", industry: "Government Administration", headcount: "4000",
      linkedinUrl: "https://www.linkedin.com/in/pat-7", city: "Richmond", stateProvince: "Virginia", country: "United States",
    }));
  });

  it("is never an email: masked, null, and no contact point in what is kept for the inspector", () => {
    const row = person(7, { contact: { contact_emails: [{ email: "leak@henrico.gov" }], contact_phones: [{ phone: "+18045550100" }] } });
    const r = mapPersonRow(row)!;
    expect(r.email).toBeNull();
    expect(r.emailIsMasked).toBe(true);
    expect(r.emailVerifiedAt).toBeNull();
    expect(r.mobilePhone).toBeNull();
    expect(JSON.stringify(r.rawSourcePayload)).not.toContain("leak@");
    expect(JSON.stringify(r.rawSourcePayload)).not.toContain("+1804");
    expect(r.rawSourcePayload).toEqual(expect.objectContaining({ personId: "7", hasEmail: true, emailStatus: "verified", emailType: "work", hasPhone: true }));
  });

  it("a row with no person id is not a person", () => {
    expect(mapPersonRow({ profile_data: { profile_full_name: "Nobody" } })).toBeNull();
  });

  it("reads the address whichever way it arrives, and an unreadable one is blank, not a guess", () => {
    expect(parseProfileAddress("Richmond, Virginia, United States")).toEqual({ city: "Richmond", state: "Virginia", country: "United States", place: "Richmond, Virginia, United States" });
    expect(parseProfileAddress("Maryland, United States")).toEqual(expect.objectContaining({ city: null, state: "Maryland", country: "United States" }));
    expect(parseProfileAddress({ city: "Raleigh", state: "North Carolina", country_code: "US" })).toEqual(expect.objectContaining({ city: "Raleigh", state: "North Carolina", country: "US", place: "Raleigh, North Carolina, US" }));
    expect(parseProfileAddress({ formatted: "Austin, Texas, United States" })).toEqual(expect.objectContaining({ state: "Texas", city: "Austin" }));
    expect(parseProfileAddress(null).place).toBe("");
    expect(parseProfileAddress(42).place).toBe("");
  });

  it("a thin row keeps its role, place and id, and says so in its externalId", () => {
    const thin = { person_id: "55", profile_data: { profile_address: "Richmond, Virginia, United States" }, contact_data: { contact_current_experiences: [{ job_title: "Clerk", company_name: "Henrico" }] }, meta: { view: "thin" } };
    const r = mapPersonRow(thin)!;
    expect(r.externalId).toBe("leadocean:55:thin");
    expect(externalIdFor("55", true)).toBe("leadocean:55:thin");
    expect(r.firstName).toBe("");
    expect(r.jobTitle).toBe("Clerk");
    expect(r.rawSourcePayload).toEqual(expect.objectContaining({ thin: true, hasEmail: null, emailStatus: null }));
    // The dedupe keys come from the lookup, and the engine's filter runs after it.
    expect(mapPersonRow(person(9))!.externalId).toBe("leadocean:9");
  });

  it("the id a thin row comes back with is what tells acquire() to find out who it is", async () => {
    const thin = { person_id: "55", profile_data: { profile_address: "Richmond, Virginia, United States" }, contact_data: { contact_current_experiences: [{ job_title: "Clerk", company_name: "Henrico" }] } };
    const v = vendor({ pages: [json({ success: true, data: [thin], meta: { view: "thin", credits: 1, nextCursor: null } })] });
    const s = adapter(v);
    const page = ok(await s.search(CRITERIA, creds(), 5, {}));
    expect(page.note).toContain("thin rows");
    const acq = ok(await s.acquire(page.records.map((r) => r.externalId), creds(), {}));
    expect(v.calls.filter((c) => c.path === "/v1/people/enrich").map((c) => c.body)).toEqual([{ person_id: "55", reveal_email: false }]);
    expect(acq.records[0]).toEqual(expect.objectContaining({ externalId: page.records[0].externalId, firstName: "Pat", email: "p55@henrico.gov" }));
  });
});

/* ─── Metering ──────────────────────────────────────────────────────────── */

describe("every record is counted, truthfully", () => {
  it("search is not the deliverable (alreadyCharged false) and its rows are billed (unitsSpent), from meta.credits", async () => {
    const v = vendor({ pages: [[person(1), person(2)]], meta: { credits: 2 } });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 25, {}));
    expect(r.alreadyCharged).toBe(false);
    expect(r.unitsSpent).toBe(2);
    expect(spent("search_records")).toBe(2);
    expect(r.records.every((x) => x.email === null && x.emailIsMasked)).toBe(true);
  });

  it("the sizing call is free and is not counted; one that came back billed is", async () => {
    const v = vendor({ pages: [[person(1)]], sizing: { total: 9 } });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 25, {}));
    expect(v.sizingCalls()[0].body).toEqual(expect.objectContaining({ count: true, limit: 1 }));
    expect(r.totalAvailable).toBe(9);
    expect(r.unitsSpent).toBe(1);

    const billed = vendor({ pages: [[person(1)]], sizing: { countOnly: undefined, credits: 1 } });
    const r2 = ok(await adapter(billed).search(CRITERIA, creds(), 25, {}));
    expect(r2.unitsSpent).toBe(2);
  });

  it("nobody matching buys nothing and says so", async () => {
    const v = vendor({ sizing: { total: 0 } });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 25, {}));
    expect(v.pageCalls()).toEqual([]);
    expect(r.records).toEqual([]);
    expect(r.note).toContain("nobody matched");
  });

  it("the waterfall adds the search rows to the lookups, and a failed lookup does not un-spend the rows", async () => {
    const v = vendor({ pages: [[person(1), person(2)]] });
    const s = adapter(v);
    const eligible = { source: s, credentials: creds(), capabilities: s.capabilities(), match: { verdict: "full" as const, approximated: [], missing: [] }, leadsRemaining: null };
    const r = await runWaterfall({ workspaceId: LSI, criteria: CRITERIA, target: 2, sources: [eligible], deduper: new Deduper(), mode: "acquire" });
    expect(r.perSource[0]).toEqual(expect.objectContaining({ searched: 2, acquired: 2, unitsSpent: 4 }));
    expect(r.collected.map((c) => c.record.email)).toEqual(["p1@henrico.gov", "p2@henrico.gov"]);
    expect(spent("search_records")).toBe(2);
    expect(spent("lookups")).toBe(2);

    const failing = vendor({ pages: [[person(3)]], work: () => json({ success: false, error: { message: "no" } }, 401) });
    const s2 = adapter(failing);
    const r2 = await runWaterfall({ workspaceId: LSI, criteria: CRITERIA, target: 1, sources: [{ ...eligible, source: s2 }], deduper: new Deduper(), mode: "acquire" });
    expect(r2.perSource[0].errorReason).toBe("unauthorized");
    expect(r2.perSource[0].unitsSpent).toBe(1);
    expect(r2.collected).toEqual([]);
  });

  it("a preview buys rows, not addresses: it reports the bill and leaves the lookup for the promotion", async () => {
    const v = vendor({ pages: [[person(1)]] });
    const s = adapter(v);
    const eligible = { source: s, credentials: creds(), capabilities: s.capabilities(), match: { verdict: "full" as const, approximated: [], missing: [] }, leadsRemaining: null };
    const r = await runWaterfall({ workspaceId: LSI, criteria: CRITERIA, target: 5, sources: [eligible], deduper: new Deduper(), mode: "preview" });
    expect(r.perSource[0].unitsSpent).toBe(1);
    expect(r.collected[0].wasCharged).toBe(false);
    expect(r.collected[0].record.emailIsMasked).toBe(true);
    expect(v.calls.some((c) => c.path.startsWith("/v2/") || c.path === "/v1/people/enrich")).toBe(false);
  });

  it("it does not overfetch: every extra row would be a record nobody can take", async () => {
    const v = vendor({ pages: [[person(1)]] });
    const s = adapter(v);
    const eligible = { source: s, credentials: creds(), capabilities: s.capabilities(), match: { verdict: "full" as const, approximated: [], missing: [] }, leadsRemaining: null };
    await runWaterfall({ workspaceId: LSI, criteria: CRITERIA, target: 10, sources: [eligible], deduper: new Deduper(), mode: "preview" });
    expect(v.pageCalls()[0].body.limit).toBe(10);
  });

  it("the cost report names the vendor and its meters", () => {
    expect(VENDOR_LABEL.leadocean).toBe("LeadOcean");
    expect(METER_LABEL.search_records).toBeTruthy();
    expect(METER_LABEL.lookups).toBeTruthy();
  });
});

/* ─── Paging ────────────────────────────────────────────────────────────── */

describe("paging stays inside one search", () => {
  const paged = (rowsIn: unknown[], nextCursor: string | null, extra: Record<string, unknown> = {}) =>
    json({ success: true, data: rowsIn, meta: { count: rowsIn.length, credits: rowsIn.length, nextCursor, unsupportedFilters: [], ...extra } });
  const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => person(from + i));

  it("sends order=stable and a limit of at most 100 on every page, and passes the cursor back verbatim", async () => {
    const v = vendor({ pages: [paged(many(1, 100), "signed.cursor/one=="), paged(many(101, 100), "signed.cursor/two=="), paged(many(201, 50), null)] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 250, {}));
    const pages = v.pageCalls();
    expect(pages.map((p) => p.body.limit)).toEqual([100, 100, 50]);
    expect(pages.every((p) => p.body.order === "stable")).toBe(true);
    expect(pages.map((p) => p.body.cursor)).toEqual([undefined, "signed.cursor/one==", "signed.cursor/two=="]);
    expect(r.records).toHaveLength(250);
  });

  it("no cursor ever leaves the adapter, and one handed in is never sent: nothing can store one", async () => {
    const v = vendor({ pages: [paged([person(1)], "signed.cursor/one==")] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 1, { cursor: "stale-from-last-week" }));
    expect(r.nextCursor).toBeNull();
    expect(v.pageCalls()[0].body.cursor).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("signed.cursor");
  });

  it("the engine gives it no cursor and keeps none", () => {
    const engine = read("server/areEngine.ts");
    expect(engine).toContain('discoverViaRegistrySource(campaign, "leadocean", { titles, industries, geos, keywords, size }, remaining, null, neverTarget)');
    const block = engine.slice(engine.indexOf("const newState: DiscoveryState = {"), engine.indexOf("try {\n    await db.update(areCampaigns).set({ discoveryQueryState"));
    expect(block).not.toMatch(/leadocean/i);
  });

  it("a short page carrying a cursor is not the end (a large viewed list skips ahead), and the walk is bounded", async () => {
    const v = vendor({ pages: [paged([], "c1", { walkCapped: true, excludedViewed: 80 }), paged([person(1)], "c2", { walkCapped: true }), paged([person(2)], null)] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(r.records.map((x) => x.externalId)).toEqual(["leadocean:1", "leadocean:2"]);

    const endless = vendor({ pages: Array.from({ length: 50 }, (_, i) => paged([], `c${i}`, { walkCapped: true })) });
    ok(await adapter(endless).search(CRITERIA, creds(), 5, {}));
    expect(endless.pageCalls().length).toBeLessThanOrEqual(5);
  });

  it("the depth cap ends the walk and says so", async () => {
    const v = vendor({ pages: [paged([person(1)], null, { depthCapped: true })] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(r.note).toContain("depth cap");
  });

  it("410 walk_snapshot_gone restarts without a cursor, once", async () => {
    const gone = () => json({ success: false, error: { code: "walk_snapshot_gone", message: "start again" } }, 410);
    const v = vendor({ pages: [paged([person(1)], "c1"), gone(), paged([person(2)], null)] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 2, {}));
    expect(v.pageCalls().map((p) => p.body.cursor)).toEqual([undefined, "c1", undefined]);
    expect(r.records).toHaveLength(2);
    expect(r.note).toContain("restarted");

    const twice = vendor({ pages: [paged([person(1)], "c1"), gone(), paged([person(2)], "c2"), gone()] });
    const r2 = ok(await adapter(twice).search(CRITERIA, creds(), 3, {}));
    expect(r2.records).toHaveLength(2);
    expect(r2.note).toContain("stopped after page");
  });
});

/* ─── Filters ───────────────────────────────────────────────────────────── */

/** The people-search body's properties in the spec (additionalProperties: false), plus `count`, which its text allows on the body. */
const SPEC_FIELDS = new Set([
  "q", "profileKeywords", "excludeProfileKeywords", "title", "excludeTitle", "excludeViewed", "viewedSet", "excludeIds", "seniority", "jobLevel", "jobFunction",
  "country", "continent", "salesRegion", "city", "excludeCity", "education", "minConnections", "domain", "companyName", "excludeCompanyName", "companyLinkedin",
  "industry", "excludeIndustry", "companyType", "employeeRange", "minEmployees", "maxEmployees", "minFounded", "maxFounded", "minFollowers", "fundingType", "minFunding",
  "maxFunding", "minLastFundingYear", "maxLastFundingYear", "investors", "sic", "naicsSector", "keywords", "excludeKeywords", "companyKeywords", "hqCountry", "hqCity",
  "hqState", "hqContinent", "hqSalesRegion", "technologies", "technologyCategories", "emailStatus", "emailType", "hasEmail", "hasPhone", "reachable", "cursor", "limit",
  "facets", "facetCompanies", "slim", "fields", "order", "count",
]);

describe("what is asked of LeadOcean", () => {
  const everything: SearchCriteria = {
    ...emptyCriteria(), jobTitles: ["CFO"], seniorities: ["C-level", "VP"], departments: ["Finance", "HR"], industries: ["Government Administration"],
    countries: ["United States"], stateProvinces: ["Virginia"], cities: ["Richmond"], companyNames: ["Henrico"], companyDomains: ["henrico.gov"],
    keywords: ["budget"], technologies: ["Salesforce"], headcountRange: { min: 50, max: 5000 }, hasPhone: true,
  };

  it("uses only fields the spec's closed body allows, and closed lists exactly as spelled", () => {
    const b = buildSearchFilters(everything, ["verified"], LSI, new Map([["government administration", "Government Administration"]]));
    expect(b.refused).toBeNull();
    for (const k of Object.keys(b.filters)) expect(SPEC_FIELDS.has(k), `not in the spec: ${k}`).toBe(true);
    expect(b.filters).toEqual(expect.objectContaining({
      order: "stable", excludeViewed: true, viewedSet: "velocity-ws-2", emailStatus: ["verified"], emailType: ["work"],
      title: ["CFO"], seniority: ["c_suite", "vp"], jobFunction: ["Finance & Accounting", "Human Resources"], industry: ["Government Administration"],
      country: ["US"], city: ["Richmond"], companyName: ["Henrico"], domain: ["henrico.gov"], keywords: ["budget"], technologies: ["Salesforce"],
      minEmployees: 50, maxEmployees: 5000, hasPhone: true,
    }));
  });

  it("a closed-list filter that keeps no value refuses: it would buy a wider audience than the one asked for", async () => {
    for (const bad_ of [{ seniorities: ["Grand Poobah"] }, { departments: ["Wizardry"] }, { countries: ["Atlantis"] }]) {
      const v = vendor();
      const r = bad(await adapter(v).search({ ...CRITERIA, countries: [], ...bad_ }, creds(), 5, {}));
      expect(r.reason).toBe("invalid_params");
      expect(v.calls).toEqual([]);
    }
    // Some values kept: the rest are reported, not silently dropped.
    const v = vendor({ pages: [[person(1)]] });
    const r = ok(await adapter(v).search({ ...CRITERIA, seniorities: ["VP", "Grand Poobah"] }, creds(), 5, {}));
    expect(v.pageCalls()[0].body.seniority).toEqual(["vp"]);
    expect(r.note).toContain("Grand Poobah");
  });

  it("a search on presence alone buys nothing: it would be the whole database", async () => {
    const v = vendor();
    const r = bad(await adapter(v).search({ ...emptyCriteria(), hasEmail: true, hasPhone: true }, creds(), 25, {}));
    expect(r.reason).toBe("invalid_params");
    expect(v.calls).toEqual([]);
  });

  it("industries: exact labels are the hard filter, any free text sends them all as keywords (the two AND), and an unreadable list falls back", async () => {
    const exact = vendor({ pages: [[person(1)]] });
    ok(await adapter(exact).search({ ...CRITERIA, industries: ["government administration"] }, creds(), 5, {}));
    expect(exact.pageCalls()[0].body.industry).toEqual(["Government Administration"]);
    expect(exact.pageCalls()[0].body.companyKeywords).toBeUndefined();

    __clearIndustryCacheForTests();
    const mixed = vendor({ pages: [[person(1)]] });
    ok(await adapter(mixed).search({ ...CRITERIA, industries: ["Government Administration", "county government"] }, creds(), 5, {}));
    expect(mixed.pageCalls()[0].body.companyKeywords).toEqual(["Government Administration", "county government"]);
    expect(mixed.pageCalls()[0].body.industry).toBeUndefined();

    __clearIndustryCacheForTests();
    const down = vendor({ pages: [[person(1)]], industries: json({ success: false, error: { message: "down" } }, 503) });
    ok(await adapter(down).search({ ...CRITERIA, industries: ["Government Administration"] }, creds(), 5, {}));
    expect(down.pageCalls()[0].body.companyKeywords).toEqual(["Government Administration"]);
  });

  it("the industry lookup is public: it carries no key, and is asked per term rather than read truncated", async () => {
    const v = vendor({ pages: [[person(1)]] });
    ok(await adapter(v).search({ ...CRITERIA, industries: ["Executive Offices"] }, creds(), 5, {}));
    const lookup = v.calls.find((c) => c.path === "/v1/enums/industry")!;
    expect(lookup.apiKey).toBeNull();
    expect(lookup.query.get("q")).toBe("Executive Offices");
    // Remembered: a second search asks nothing.
    const again = vendor({ pages: [[person(2)]] });
    ok(await adapter(again).search({ ...CRITERIA, industries: ["Executive Offices"] }, creds(), 5, {}));
    expect(again.calls.some((c) => c.path === "/v1/enums/industry")).toBe(false);
  });
});

/* ─── An unapplied filter ───────────────────────────────────────────────── */

describe("a filter LeadOcean will not apply is reported, and nothing is bought for it", () => {
  const withheld = { total: null, totalIsExact: false, countOnly: true, credits: 0, unsupportedFilters: ["hqState"], totalWithheld: { reason: "unsupported_filters", filters: ["hqState"], employerLimit: 50000, message: "Too many companies match hqState: add an industry." } };

  it("the free sizing call catches it before a row is paid for, in the vendor's own words", async () => {
    const v = vendor({ sizing: withheld, pages: [[person(1)]] });
    const r = bad(await adapter(v).search(STATES, creds(), 25, {}));
    expect(r.reason).toBe("invalid_params");
    expect(r.message).toContain("hqState");
    expect(r.message).toContain("add an industry");
    expect(r.message).toContain("Nothing was bought");
    expect(v.pageCalls()).toEqual([]);
    expect(spent("search_records")).toBe(0);
  });

  it("a total withheld for any other reason is not a refusal: a large viewed list drops no filter", async () => {
    const v = vendor({ sizing: { total: null, totalWithheld: { reason: "viewed_set_too_large" }, unsupportedFilters: [] }, pages: [[person(1)]] });
    const r = ok(await adapter(v).search(STATES, creds(), 25, {}));
    expect(r.totalAvailable).toBeNull();
    expect(r.records).toHaveLength(1);
  });

  it("if a page drops one anyway, the rows are already paid for: they are kept and the note names it", async () => {
    const v = vendor({ pages: [[person(1)]], meta: { unsupportedFilters: ["hqState"] } });
    const r = ok(await adapter(v).search(STATES, creds(), 25, {}));
    expect(r.records).toHaveLength(1);
    expect(r.note).toContain("did not apply hqState");
  });

  it("the refusal does not trip the breaker or call the key bad: the search has to change, not the vendor", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ sizing: withheld });
    const s = adapter(v);
    const eligible = { source: s, credentials: creds(), capabilities: s.capabilities(), match: { verdict: "approximate" as const, approximated: [], missing: [] }, leadsRemaining: null };
    const r = await runWaterfall({ workspaceId: LSI, criteria: STATES, target: 5, sources: [eligible], deduper: new Deduper(), mode: "acquire" });
    expect(r.perSource[0].errorReason).toBe("invalid_params");
    expect(credRow().consecutiveFailures).toBe(0);
    expect(credRow().status).toBe("valid");
  });
});

/* ─── State ─────────────────────────────────────────────────────────────── */

describe("state is the employer's headquarters, then a check of the person's own place", () => {
  it("is declared approximated, so a state search is never shown as a full match", () => {
    expect(LEADOCEAN_CAPABILITIES.approximatedFilters).toContain("stateProvince");
    expect(LEADOCEAN_CAPABILITIES.supportedFilters).not.toContain("stateProvince");
    expect(matchCapabilities(LEADOCEAN_CAPABILITIES, STATES).verdict).toBe("approximate");
  });

  it("sends hqState with hqCountry to pin it, the person's country, and no state field that does not exist", async () => {
    const v = vendor({ pages: [[person(1)]] });
    ok(await adapter(v).search(STATES, creds(), 25, {}));
    const body = v.pageCalls()[0].body;
    expect(body.hqState).toEqual(["Virginia", "Maryland"]);
    expect(body.hqCountry).toEqual(["US"]);
    expect(body.country).toEqual(["US"]);
    expect(body.state).toBeUndefined();
    expect(v.sizingCalls()[0].body.hqState).toEqual(["Virginia", "Maryland"]);
  });

  it("records inside, outside or unknown per person, and counts them in the note", async () => {
    const v = vendor({ pages: [[
      person(1),
      person(2, { profile: { profile_address: "Charleston, West Virginia, United States" } }),
      person(3, { profile: { profile_address: "Greater Richmond Region" } }),
      person(4, { profile: { profile_address: null } }),
      person(5, { profile: { profile_address: "London, England, United Kingdom" } }),
    ]] });
    const r = ok(await adapter(v).search(STATES, creds(), 25, {}));
    expect(r.records.map((x) => x.rawSourcePayload.placeCheck)).toEqual(["inside", "outside", "unknown", "unknown", "outside"]);
    expect(r.note).toContain("place check: 1 inside, 2 outside, 2 unknown");
  });

  it("a paid row it cannot read is said, with its keys, so a renamed field is not mistaken for nobody", async () => {
    const v = vendor({ pages: [[{ profile: { name: "x" }, ids: { person: 1 } }, person(2)]] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(r.records.map((x) => x.externalId)).toEqual(["leadocean:2"]);
    expect(r.unitsSpent).toBe(2);
    expect(r.note).toContain("1 row with no person id");
    expect(r.note).toContain("row keys: profile, ids");
  });

  it("an answer with no list in it is a failure, not an empty search", async () => {
    const v = vendor({ pages: [json({ success: true, meta: {} })] });
    expect(bad(await adapter(v).search(CRITERIA, creds(), 5, {})).reason).toBe("unavailable");
  });

  it("no state searched, no verdict recorded", async () => {
    const v = vendor({ pages: [[person(1)]] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 25, {}));
    expect(r.records[0].rawSourcePayload.placeCheck).toBeUndefined();
    expect(r.note ?? "").not.toContain("place check");
    expect(mapPersonRow(person(1), { targets: parseTargetPlaces(["Virginia"]) })!.rawSourcePayload.placeCheck).toBe("inside");
  });
});

/* ─── Pacing ────────────────────────────────────────────────────────────── */

describe("a pace is held or paced, never an empty result", () => {
  const paced429 = () => json(
    { success: false, error: { code: "fair_use_paced", message: "slowed", details: { kind: "search", window: "h5", windowLimit: 100000, windowUsed: 100000, resetsAt: LATER } } },
    429, { "retry-after": "60", "x-quota-state": "paced", "x-quota-reset": LATER },
  );

  it("the account read says paced: nothing is bought, and it says until when", async () => {
    const v = vendor({ pages: [[person(1)]], account: { pace: { search: [], enrich: [], paced: { kind: "search", window: "h5", windowLabel: "5 hours", limit: 100000, used: 100000, resetsAt: LATER } } } });
    const r = bad(await adapter(v).search(CRITERIA, creds(), 25, {}));
    expect(r.reason).toBe("rate_limited");
    expect(r.held).toBe(true);
    expect(r.message).toContain(LATER);
    expect(r.retryAfterSeconds).toBe(3 * 60 * 60);
    expect(v.calls.some((c) => c.path === "/v1/people/search")).toBe(false);
  });

  it("paced lookups hold the search too: rows bought now could not be looked up. A paced company search does not.", async () => {
    const enrich = vendor({ pages: [[person(1)]], account: { pace: { search: [], enrich: [], paced: { kind: "enrich", resetsAt: LATER } } } });
    expect(bad(await adapter(enrich).search(CRITERIA, creds(), 25, {})).held).toBe(true);
    expect(enrich.pageCalls()).toEqual([]);

    const company = vendor({ pages: [[person(1)]], account: { pace: { search: [], enrich: [], paced: { kind: "company", resetsAt: LATER } } } });
    expect(ok(await adapter(company).search(CRITERIA, creds(), 25, {})).records).toHaveLength(1);
  });

  it("past the monthly records: a paid plan is held, a refusing plan is spent", async () => {
    const throttled = vendor({ pages: [[person(1)]], account: { records: { overLimit: true, whenOver: "throttled", resetsAt: LATER } } });
    expect(bad(await adapter(throttled).search(CRITERIA, creds(), 25, {})).held).toBe(true);
    const refused = vendor({ pages: [[person(1)]], account: { records: { overLimit: true, whenOver: "refused", resetsAt: null } } });
    const r = bad(await adapter(refused).search(CRITERIA, creds(), 25, {}));
    expect(r.reason).toBe("budget_exhausted");
    expect(r.held).toBeFalsy();
    expect(refused.pageCalls()).toEqual([]);
  });

  it("a page answered paced keeps the rows already paid for, reports it, and stops walking", async () => {
    const v = vendor({ pages: [
      json({ success: true, data: [person(1)], meta: { count: 1, credits: 1, nextCursor: "c1", unsupportedFilters: [] } }, 200, { "x-quota-state": "paced", "x-quota-reset": LATER }),
      [person(2)],
    ] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(r.records).toHaveLength(1);
    expect(r.note).toContain("1 request a minute");
    expect(r.note).toContain(LATER);
    expect(v.pageCalls()).toHaveLength(1);
  });

  it("the same notice in the body alone counts (meta.notice, no header)", async () => {
    const v = vendor({ pages: [json({ success: true, data: [person(1)], meta: { credits: 1, nextCursor: "c1", notice: { code: "fair_use_paced", kind: "search", resetsAt: LATER } } })] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(r.note).toContain("search records");
    expect(v.pageCalls()).toHaveLength(1);
  });

  it("429 with Retry-After (AppSumo's wording) is held, not retried into, and not empty", async () => {
    const v = vendor({ pages: [paced429(), [person(1)]] });
    const r = bad(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(r.reason).toBe("rate_limited");
    expect(r.held).toBe(true);
    expect(v.pageCalls()).toHaveLength(1);
    expect(r.message).toContain(LATER);
  });

  it("a key's own quota is held too, until its reset", async () => {
    const quota = json({ success: false, error: { code: "key_quota", message: "cap", kind: "search", window: "day", limit: 10, used: 10, resetsAt: LATER } }, 429, { "retry-after": "3600", "x-key-limit-reset": LATER });
    const v = vendor({ pages: [quota] });
    const r = bad(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(r.held).toBe(true);
    expect(r.message).toContain("own cap");
    expect(v.pageCalls()).toHaveLength(1);
  });

  it("plain too-fast is not a pace: it waits a second and asks again", async () => {
    const tooFast = json({ success: false, error: { code: "key_rate", message: "slow" } }, 429, { "retry-after": "1" });
    const waits: number[] = [];
    const v = vendor({ pages: [tooFast, [person(1)]] });
    const s = createLeadOceanSource({ fetchImpl: v.impl, sleep: async (ms) => { waits.push(ms); } });
    expect(ok(await s.search(CRITERIA, creds(), 5, {})).records).toHaveLength(1);
    expect(waits).toEqual([1000]);
  });

  it("held does not tell the breaker; a plain rate limit does", async () => {
    addKey(LSI, KEY_LSI);
    const run = async (page: Response) => {
      const v = vendor({ pages: [page, page] });
      const s = adapter(v);
      const eligible = { source: s, credentials: creds(), capabilities: s.capabilities(), match: { verdict: "full" as const, approximated: [], missing: [] }, leadsRemaining: null };
      return runWaterfall({ workspaceId: LSI, criteria: CRITERIA, target: 5, sources: [eligible], deduper: new Deduper(), mode: "preview" });
    };
    const held = await run(paced429());
    expect(held.perSource[0]).toEqual(expect.objectContaining({ errorReason: "rate_limited", held: true }));
    expect(held.perSource[0].retryAfterSeconds).toBe(3 * 60 * 60);
    expect(credRow().consecutiveFailures).toBe(0);

    const plain = await run(json({ success: false, error: { code: "key_rate", message: "slow" } }, 429, { "retry-after": "1" }));
    expect(plain.perSource[0].held).toBeUndefined();
    expect(credRow().consecutiveFailures).toBe(1);
  });

  it("a lookup answered paced takes that answer, stops, and gives the rest back to the viewed list", async () => {
    let n = 0;
    const v = vendor({ work: (c) => {
      n += 1;
      return json({ success: true, data: { email: `p${c.body.contact_id}@henrico.gov`, status: "verified" } }, 200, n === 2 ? { "x-quota-state": "paced", "x-quota-reset": LATER } : {});
    } });
    const r = ok(await adapter(v).acquire(["leadocean:1", "leadocean:2", "leadocean:3", "leadocean:4"], creds(), {}));
    expect(r.records.map((x) => x.email)).toEqual(["p1@henrico.gov", "p2@henrico.gov"]);
    expect(r.unitsSpent).toBe(2);
    expect(r.failedExternalIds).toEqual(["leadocean:3", "leadocean:4"]);
    expect(r.note).toContain("1 request a minute");
    expect(r.note).toContain("2 held for later");
    const forgotten = v.viewedCalls().filter((c) => c.method === "DELETE");
    expect(forgotten).toHaveLength(1);
    expect(forgotten[0].body).toEqual({ ids: ["3", "4"], set: "velocity-ws-2" });
  });

  it("a lookup refused outright with nothing done is the failure itself, and the people are given back", async () => {
    const v = vendor({ work: paced429 });
    const r = bad(await adapter(v).acquire(["leadocean:1", "leadocean:2"], creds(), {}));
    expect(r.held).toBe(true);
    expect(v.viewedCalls().find((c) => c.method === "DELETE")!.body.ids).toEqual(["1", "2"]);
  });

  it("the engine waits until the reset, says why, and writes no 'returned nothing' job", async () => {
    addKey(LSI, KEY_LSI);
    rows("are_campaigns").push(campaignRow(["leadocean"]));
    const v = vendor({ account: { pace: { search: [], enrich: [], paced: { kind: "search", windowLabel: "5 hours", resetsAt: LATER } } } });
    vi.stubGlobal("fetch", v.impl);
    expect(await runDiscovery(rows("are_campaigns")[0], 5)).toBe(0);
    const state = rows("are_campaigns")[0].discoveryQueryState;
    expect(state.src.leadocean.nextAt).toBe(T0 + 3 * 60 * 60 * 1000);
    expect(rows("are_scrape_jobs")).toEqual([]);
    const summary = rows("are_engine_logs").find((l) => /^Discovery slice/.test(l.message));
    expect(summary.details.perSource.leadocean.skipped).toContain("1 request a minute");
    expect(summary.details.perSource.leadocean.raw).toBe(0);
    expect(rows("are_engine_logs").some((l) => l.level === "warn" && /leadocean: LeadOcean has slowed/.test(l.message))).toBe(true);
  });
});

/* ─── Each error class ──────────────────────────────────────────────────── */

describe("each error class maps onto the shared vocabulary", () => {
  const err = (status: number, code?: string) => json({ success: false, error: { ...(code ? { code } : {}), message: `no ${status}` } }, status);

  it.each([
    [401, undefined, "unauthorized"],
    [403, undefined, "insufficient_scope"],
    [403, "key_paused", "insufficient_scope"],
    [402, undefined, "budget_exhausted"],
    [429, undefined, "rate_limited"],
    [503, "no_source", "unavailable"],
    [400, "limit_too_large", "invalid_params"],
  ])("%i %s → %s", async (status, code, reason) => {
    const failing = () => err(status as number, code as string | undefined);
    // On the sizing call, and on the page behind it.
    const onSizing = vendor({ sizing: failing() });
    expect(bad(await adapter(onSizing).search(CRITERIA, creds(), 5, {})).reason).toBe(reason);
    expect(onSizing.pageCalls()).toEqual([]);
    const onPage = vendor({ pages: [failing(), failing(), failing()] });
    expect(bad(await adapter(onPage).search(CRITERIA, creds(), 5, {})).reason).toBe(reason);
  });

  it("503 is retried once, then reported; 401 is not retried", async () => {
    const unavailable = vendor({ pages: [err(503, "no_source"), [person(1)]] });
    expect(ok(await adapter(unavailable).search(CRITERIA, creds(), 5, {})).records).toHaveLength(1);
    const denied = vendor({ pages: [err(401), [person(1)]] });
    bad(await adapter(denied).search(CRITERIA, creds(), 5, {}));
    expect(denied.pageCalls()).toHaveLength(1);
  });

  it("402 is terminal: no breaker, the key stays good, and the next search is skipped on the account's word", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [err(402)] });
    const s = adapter(v);
    const eligible = { source: s, credentials: creds(), capabilities: s.capabilities(), match: { verdict: "full" as const, approximated: [], missing: [] }, leadsRemaining: null };
    const r = await runWaterfall({ workspaceId: LSI, criteria: CRITERIA, target: 5, sources: [eligible], deduper: new Deduper(), mode: "preview" });
    expect(r.perSource[0].errorReason).toBe("budget_exhausted");
    expect(credRow().consecutiveFailures).toBe(0);
    expect(credRow().status).toBe("valid");

    const spentPlan = vendor({ account: { records: { ceiling: 1000, used: 1000, remaining: 0, overLimit: true, whenOver: "refused", resetsAt: null } } });
    const budget = await createLeadOceanSource({ fetchImpl: spentPlan.impl }).remainingBudget(creds());
    expect(budget[0]).toEqual(expect.objectContaining({ bucket: "leads", remaining: 0 }));
  });

  it("401 on a real run marks the key invalid, and the source then skips with the reason", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [err(401)] });
    const s = adapter(v);
    const eligible = { source: s, credentials: creds(), capabilities: s.capabilities(), match: { verdict: "full" as const, approximated: [], missing: [] }, leadsRemaining: null };
    await runWaterfall({ workspaceId: LSI, criteria: CRITERIA, target: 5, sources: [eligible], deduper: new Deduper(), mode: "preview" });
    expect(credRow().status).toBe("invalid");
    expect(credRow().validationError).toContain("unauthorized");
    vi.stubGlobal("fetch", vendor().impl);
    const { skipped, eligible: el } = await eligibleFor(LSI, CRITERIA, { only: ["leadocean"] });
    expect(el).toEqual([]);
    expect(skipped.find((x) => x.slug === "leadocean")!.reason).toBe("credential_invalid");
  });

  it("a key the account read refuses stops before the sizing call", async () => {
    const v = vendor({ account: err(401) });
    expect(bad(await adapter(v).search(CRITERIA, creds(), 5, {})).reason).toBe("unauthorized");
    expect(v.calls.some((c) => c.path === "/v1/people/search")).toBe(false);
  });

  it("an account read that merely failed does not block: the page's own answer decides", async () => {
    const v = vendor({ account: err(503, "no_source"), pages: [[person(1)]] });
    expect(ok(await adapter(v).search(CRITERIA, creds(), 5, {})).records).toHaveLength(1);
  });
});

/* ─── Lookups, statuses and phones ──────────────────────────────────────── */

describe("the address comes from the door that spends the least", () => {
  it("phones off and a status the door returns: the work door, with no phone asked for", async () => {
    const v = vendor();
    const r = ok(await adapter(v).acquire(["leadocean:7"], creds(), { campaignId: 3 }));
    expect(v.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v2/people/email/work"]);
    expect(v.calls[0].body).toEqual({ contact_id: "7" });
    expect(r.records[0]).toEqual(expect.objectContaining({ externalId: "leadocean:7", email: "p7@henrico.gov", emailIsMasked: false, emailVerifiedAt: null, mobilePhone: null, businessPhone: null }));
    expect(r.unitsSpent).toBe(1);
    expect(spent("lookups")).toBe(1);
    expect(rows("spend_ledger")[0].feature).toBe("are.discovery");
  });

  it("phones on: the full lookup, one record, and the numbers it holds", async () => {
    const v = vendor();
    const r = ok(await adapter(v).acquire(["leadocean:7"], creds({ fetchPhones: true }), {}));
    expect(v.calls.map((c) => c.path)).toEqual(["/v1/people/enrich"]);
    expect(v.calls[0].body).toEqual({ person_id: "7", reveal_email: true });
    expect(r.records[0]).toEqual(expect.objectContaining({ email: "p7@henrico.gov", mobilePhone: "+18045550100", businessPhone: "+18045550101" }));
    expect(r.unitsSpent).toBe(1);
  });

  it("a status the door never returns forces the full lookup, and the phones it brings are not kept", async () => {
    const v = vendor();
    const r = ok(await adapter(v).acquire(["leadocean:7"], creds({ acceptedEmailStatuses: ["verified", "untested"] }), {}));
    expect(v.calls[0].path).toBe("/v1/people/enrich");
    expect(r.records[0].mobilePhone).toBeNull();
    expect(r.records[0].businessPhone).toBeNull();
    expect(JSON.stringify(r.records[0])).not.toContain("+1804");
    expect(leadoceanUsesFullLookup(["verified", "catch_all_valid", "catch_all"], false)).toBe(false);
    expect(leadoceanUsesFullLookup(["verified"], true)).toBe(true);
  });

  it("a thin row asks who it is first, with nothing revealed, then the door: two records, and the estimate says so", async () => {
    const v = vendor();
    const s = adapter(v);
    const r = ok(await s.acquire(["leadocean:55:thin"], creds(), {}));
    expect(v.calls.map((c) => c.path)).toEqual(["/v1/people/enrich", "/v2/people/email/work"]);
    expect(v.calls[0].body).toEqual({ person_id: "55", reveal_email: false });
    expect(r.records[0]).toEqual(expect.objectContaining({ externalId: "leadocean:55:thin", firstName: "Pat", lastName: "Lee55", email: "p55@henrico.gov" }));
    expect(r.unitsSpent).toBe(2);
    expect(s.estimateAcquireUnits!("leadocean:55:thin", creds())).toBe(2);
    expect(s.estimateAcquireUnits!("leadocean:55", creds())).toBe(1);
    expect(s.estimateAcquireUnits!("leadocean:55:thin", creds({ fetchPhones: true }))).toBe(1);
  });

  it("a thin row whose flags say there is nothing to take is not charged a second time", async () => {
    const noEmail = vendor({ enrich: (c) => json({ success: true, data: person(c.body.person_id, { contact: { has_email: false, email_status: "none" } }), meta: { credits: 1 } }) });
    const r = ok(await adapter(noEmail).acquire(["leadocean:55:thin"], creds(), {}));
    expect(noEmail.calls.map((c) => c.path)).toEqual(["/v1/people/enrich"]);
    expect(r.unitsSpent).toBe(1);
    expect(r.failedExternalIds).toEqual(["leadocean:55:thin"]);
  });

  it("the door's null is a paid miss, and its 404 is an unpaid one", async () => {
    const empty = vendor({ work: () => json({ success: true, data: null }) });
    const r = ok(await adapter(empty).acquire(["leadocean:1"], creds(), {}));
    expect(r.records).toEqual([]);
    expect(r.unitsSpent).toBe(1);
    expect(r.failedExternalIds).toEqual(["leadocean:1"]);

    const missing = vendor({ work: () => json({ success: false, error: { message: "not found" } }, 404) });
    const r2 = ok(await adapter(missing).acquire(["leadocean:1", "leadocean:2"], creds(), {}));
    expect(r2.unitsSpent).toBe(0);
    expect(r2.failedExternalIds).toEqual(["leadocean:1", "leadocean:2"]);
  });

  it("an id that is not ours is refused without a call", async () => {
    const v = vendor();
    const r = ok(await adapter(v).acquire(["apollo:1", "leadocean:abc"], creds(), {}));
    expect(v.calls).toEqual([]);
    expect(r.failedExternalIds).toEqual(["apollo:1", "leadocean:abc"]);
  });
});

describe("which statuses count", () => {
  it("defaults to verified, on the search filter and on the address, because search's status is only an upper bound", async () => {
    const v = vendor({ pages: [[person(1)]] });
    ok(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(v.pageCalls()[0].body.emailStatus).toEqual(["verified"]);

    // Search said verified; the door says catch_all. The enriched answer is the correct one.
    const door = vendor({ work: () => json({ success: true, data: { email: "a@b.gov", status: "catch_all" } }) });
    const r = ok(await adapter(door).acquire(["leadocean:1"], creds(), {}));
    expect(r.records).toEqual([]);
    expect(r.unitsSpent).toBe(1);
  });

  it("a status it cannot read is not a status it accepts", async () => {
    const door = vendor({ work: () => json({ success: true, data: { email: "a@b.gov" } }) });
    expect(ok(await adapter(door).acquire(["leadocean:1"], creds(), {})).records).toEqual([]);
  });

  it("invalid, disposable, spam_trap and abuse are refused whatever the settings say", async () => {
    const never = ["invalid", "disposable", "spam_trap", "abuse"];
    expect(leadoceanAcceptedStatuses(never)).toEqual(["verified"]);
    expect(leadoceanAcceptedStatuses(["untested", ...never])).toEqual(["untested"]);
    expect(leadoceanAcceptedStatuses(null)).toEqual(["verified"]);
    expect(leadoceanAcceptedStatuses(["catch_all"])).toEqual(["catch_all", "catch_all_valid"]);

    // A row or an address carrying one is dropped, even with a tampered config.
    const tampered = creds({ acceptedEmailStatuses: never });
    for (const status of never) {
      const door = vendor({ work: () => json({ success: true, data: { email: "a@b.gov", status } }) });
      expect(ok(await adapter(door).acquire(["leadocean:1"], tampered, {})).records).toEqual([]);
      expect(addressFrom([{ email: "a@b.gov", type: "work", status }], [status])).toBeNull();
      const rowsOut = vendor({ pages: [[person(1, { contact: { email_status: status } })]] });
      const page = ok(await adapter(rowsOut).search(CRITERIA, tampered, 5, {}));
      expect(page.records).toEqual([]);
      expect(rowsOut.pageCalls()[0].body.emailStatus).toEqual(["verified"]);
    }
    await expect(caller(ADMIN).prospectSources.saveCredentials({ slug: "leadocean", config: { acceptedEmailStatuses: ["invalid"] as never } })).rejects.toThrow();
  });

  it("takes a current work address only: not a former employer's, not a personal one", () => {
    const list = [
      { email: "old@former.com", type: "work_other", status: "verified" },
      { email: "me@gmail.com", type: "personal", status: "verified" },
      { email: "maybe@now.gov", type: "work", status: "untested" },
      { email: "good@now.gov", type: "work", status: "verified", verified_batch_date: "2026-09-20" },
    ];
    expect(addressFrom(list, ["verified"])).toEqual({ email: "good@now.gov", status: "verified", verifiedBatchDate: "2026-09-20" });
    expect(addressFrom(list.slice(0, 2), ["verified"])).toBeNull();
    expect(addressFrom("nonsense", ["verified"])).toBeNull();
  });

  it("makes no claim of its own: Velocity's gate decides what can be mailed", () => {
    // A vendor's batch date is not a verification time, so nothing downstream can read one.
    expect(read("server/services/prospectSources/adapters/leadocean.ts")).not.toMatch(/emailVerifiedAt: (?!null)/);
  });

  it("rows the flags already rule out are paid for but not looked up, and the note counts them", async () => {
    const v = vendor({ pages: [[person(1), person(2, { contact: { has_email: false } }), person(3, { contact: { email_status: "untested" } })]] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(r.records.map((x) => x.externalId)).toEqual(["leadocean:1"]);
    expect(r.unitsSpent).toBe(3);
    expect(r.note).toContain("2 rows with no address you accept");
  });

  it("two records of one person (person_group_id) are one person, and both are remembered", async () => {
    const v = vendor({ pages: [[
      person(1, { meta: { source_ids: { person_id: "1", person_group_id: "G" } } }),
      person(2, { meta: { source_ids: { person_id: "2", person_group_id: "G" } } }),
    ]] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(r.records).toHaveLength(1);
    expect(v.viewedCalls()[0].body.ids).toEqual(["1", "2"]);
  });
});

/* ─── Viewed lists ──────────────────────────────────────────────────────── */

describe("the viewed list belongs to the workspace", () => {
  it("every delivered row is remembered, in this workspace's list only, and every search leaves those out", async () => {
    const a = vendor({ pages: [[person(1), person(2, { contact: { has_email: false } })]] });
    ok(await adapter(a).search(CRITERIA, creds({}, LSI, KEY_LSI), 5, {}));
    expect(a.pageCalls()[0].body).toEqual(expect.objectContaining({ excludeViewed: true, viewedSet: "velocity-ws-2" }));
    expect(a.sizingCalls()[0].body).toEqual(expect.objectContaining({ excludeViewed: true, viewedSet: "velocity-ws-2" }));
    expect(a.viewedCalls()[0].body).toEqual({ ids: ["1", "2"], set: "velocity-ws-2" });

    // One LeadOcean key can serve two workspaces, and the lists live on its account.
    const b = vendor({ pages: [[person(1)]] });
    ok(await adapter(b).search(CRITERIA, creds({}, CF, KEY_LSI), 5, {}));
    expect(b.pageCalls()[0].body.viewedSet).toBe("velocity-ws-4");
    expect(b.viewedCalls()[0].body.set).toBe("velocity-ws-4");
    expect(viewedSetFor(LSI)).not.toBe(viewedSetFor(CF));
    expect(viewedSetFor(99999999).length).toBeLessThanOrEqual(64);
  });

  it("a list that could not be written is said, not swallowed", async () => {
    const v = vendor({ pages: [[person(1)]], viewed: json({ success: false, error: { code: "viewed_limit", message: "full" } }, 409) });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(r.records).toHaveLength(1);
    expect(r.note).toContain("may bill them again");
  });
});

/* ─── The daily cap ─────────────────────────────────────────────────────── */

describe("the optional daily cap on people pulled", () => {
  const usedToday = (n: number, ws = LSI) => rows("spend_ledger").push({ workspaceId: ws, day: "2026-11-18", vendor: "leadocean", meter: "search_records", model: "", keySource: "workspace", feature: "x", quantity: n, calls: 1 });

  it("trims the page to what is left and refuses at the cap, before any call", async () => {
    usedToday(95);
    const v = vendor({ pages: [[person(1)]] });
    ok(await adapter(v).search(CRITERIA, creds({ dailyPeopleCap: 100 }), 50, {}));
    expect(v.pageCalls()[0].body.limit).toBe(5);

    usedToday(4); // with the row just pulled, that is the whole 100
    const full = vendor();
    const r = bad(await adapter(full).search(CRITERIA, creds({ dailyPeopleCap: 100 }), 50, {}));
    expect(r.reason).toBe("budget_exhausted");
    expect(r.message).toContain("100/100");
    expect(full.calls).toEqual([]);
  });

  it("counts this workspace's rows only, and today's only", async () => {
    usedToday(100, CF);
    rows("spend_ledger").push({ workspaceId: LSI, day: "2026-11-17", vendor: "leadocean", meter: "search_records", model: "", keySource: "workspace", feature: "x", quantity: 100, calls: 1 });
    const v = vendor({ pages: [[person(1)]] });
    ok(await adapter(v).search(CRITERIA, creds({ dailyPeopleCap: 100 }), 50, {}));
    expect(v.pageCalls()[0].body.limit).toBe(50);
  });

  it("no cap set means none, and the registry reads the headroom from the budget it reports", async () => {
    const v = vendor();
    const s = createLeadOceanSource({ fetchImpl: v.impl });
    expect((await s.remainingBudget(creds()))[0]).toEqual(expect.objectContaining({ bucket: "leads", remaining: null, limit: null, fundedBy: "no daily cap set" }));
    usedToday(30);
    expect((await s.remainingBudget(creds({ dailyPeopleCap: 100 })))[0]).toEqual(expect.objectContaining({ bucket: "leads", remaining: 70, limit: 100, used: 30 }));
    expect(s.budgetPeriods({ now: new Date(), credentials: creds({ dailyPeopleCap: 100 }) })).toEqual([]);
  });

  it("reports LeadOcean's own windows as LeadOcean's, read from the account, not assumed", async () => {
    const v = vendor();
    const out = await createLeadOceanSource({ fetchImpl: v.impl }).remainingBudget(creds());
    expect(out).toContainEqual(expect.objectContaining({ bucket: "leads", limit: 100000, used: 200, fundedBy: "LeadOcean search pace · 5 hours" }));
    expect(out).toContainEqual(expect.objectContaining({ bucket: "lookups", limit: 10000, used: 50, fundedBy: "LeadOcean enrichment pace · 5 hours" }));
    // The same adapter on a different plan reports that plan: no number is built in.
    const other = vendor({ account: { pace: { search: [{ window: "d", windowLabel: "day", limit: 7, used: 1, resetsAt: LATER }], enrich: [], paced: null } } });
    const out2 = await createLeadOceanSource({ fetchImpl: other.impl }).remainingBudget(creds());
    expect(out2).toContainEqual(expect.objectContaining({ limit: 7, remaining: 6 }));
    const src = read("server/services/prospectSources/adapters/leadocean.ts").split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    for (const tierNumber of ["100000", "100_000", "500000", "10000", "50000", "1500"]) expect(src, tierNumber).not.toContain(tierNumber);
  });
});

/* ─── Test connection ───────────────────────────────────────────────────── */

describe("Test connection reads only what is free", () => {
  it("calls the account and usage reads and nothing else, and reports the plan and usage", async () => {
    const v = vendor();
    const r = await adapter(v).validateCredentials(creds());
    expect(v.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v1/account", "GET /v1/usage"]);
    expect(r.ok).toBe(true);
    expect(r.message).toContain("appsumo_tier_3 plan");
    expect(r.discovered).toEqual(expect.objectContaining({
      plan: "appsumo_tier_3", searchView: "full", requestsPerSecond: 50,
      usage: expect.objectContaining({ used: 1234, searchToday: 40, enrichToday: 7 }),
    }));
  });

  it("keeps an allowlist of the account: no email, no key id, no key prefix", () => {
    const s = JSON.stringify(summarizeAccount(account()));
    expect(s).not.toContain("holder@example.test");
    expect(s).not.toContain("lo_live_ab");
    expect(s).not.toContain("key_1");
    expect(s).not.toContain("acct_1");
  });

  it("thin plans and phone counters are reported, never assumed", () => {
    const s = summarizeAccount(account({ search: { view: "thin", thinFields: null }, phoneReveals: { used: 3, limit: 1500 } }));
    expect(s.searchView).toBe("thin");
    expect(s.phoneCounters).toEqual({ "phoneReveals.used": 3, "phoneReveals.limit": 1500 });
    expect(summarizeAccount(account()).phoneCounters).toEqual({});
  });

  it("a key that cannot search or look up, or a suspended account, fails with the reason", async () => {
    const noEnrich = vendor({ account: { key: { scopes: ["search"] } } });
    const r = await adapter(noEnrich).validateCredentials(creds());
    expect(r.ok).toBe(false);
    expect(r.message).toContain("enrich scope");

    const suspended = vendor({ account: { account: { plan: "x", suspended: true } } });
    const r2 = await adapter(suspended).validateCredentials(creds());
    expect(r2).toEqual(expect.objectContaining({ ok: false, terminal: true }));
  });

  it("a bad key is terminal; a vendor that cannot answer says nothing about the key, so its status stands", async () => {
    addKey(LSI, KEY_LSI);
    const bad401 = vendor({ account: json({ success: false, error: { message: "no" } }, 401) });
    const r = await adapter(bad401).validateCredentials(creds());
    expect(r).toEqual(expect.objectContaining({ ok: false, terminal: true, transient: false }));

    const down = vendor({ account: json({ success: false, error: { code: "no_source", message: "down" } }, 503) });
    const r2 = await adapter(down).validateCredentials(creds());
    expect(r2).toEqual(expect.objectContaining({ ok: false, transient: true }));
    const { recordValidation } = await import("./services/prospectSources/credentials");
    await recordValidation(LSI, "leadocean", r2);
    expect(credRow().status).toBe("valid");
    await recordValidation(LSI, "leadocean", r);
    expect(credRow().status).toBe("invalid");
  });
});

/* ─── The key ───────────────────────────────────────────────────────────── */

describe("the key goes one way", () => {
  it("is stored encrypted, and no read returns any part of it: only that one exists", async () => {
    vi.stubGlobal("fetch", vendor().impl);
    const admin = caller(ADMIN);
    await admin.prospectSources.saveCredentials({ slug: "leadocean", apiKey: KEY_LSI });
    expect(credRow().credentialsEnc).not.toContain(KEY_LSI);
    expect(credRow().credentialsEnc).not.toContain("lo_live");

    const validated = await admin.prospectSources.validate({ slug: "leadocean" });
    const described = await admin.prospectSources.describe();
    const asRep = await caller(REP).prospectSources.describe();
    const ledger = await admin.prospectSources.ledger({ slug: "leadocean" });
    const row = described.find((s) => s.slug === "leadocean")!;
    expect(row.credential.configured).toBe(true);
    expect(row.credential.masked).toBe("");
    for (const out of [validated, described, asRep, ledger]) {
      const s = JSON.stringify(out);
      expect(s).not.toContain("lo_live");
      expect(s).not.toContain(KEY_LSI.slice(-4));
      expect(s).not.toContain("holder@example.test");
    }
  });

  it("a stored status read never decrypts it into anything the UI gets", async () => {
    addKey(LSI, KEY_LSI);
    const view = await credentialView(LSI, getSource("leadocean"));
    expect(view).toEqual(expect.objectContaining({ configured: true, masked: "", source: "workspace" }));
    // WarmySender still shows its hint: the rule is this source's, by its own flag.
    expect(getSource("leadocean").writeOnlyKey).toBe(true);
    expect(getSource("warmysender").writeOnlyKey).toBeUndefined();
  });

  it("goes out only in its own header, never in a body, a query, a log line or a failure", async () => {
    const lines: string[] = [];
    setVendorCallLogger((e) => lines.push(JSON.stringify(e)));
    const log = vi.spyOn(console, "log").mockImplementation((...a) => { lines.push(a.join(" ")); });
    const errLog = vi.spyOn(console, "error").mockImplementation((...a) => { lines.push(a.join(" ")); });
    const v = vendor({ pages: [[person(1)], json({ success: false, error: { message: "denied" } }, 401)] });
    const s = adapter(v);
    const page = await s.search(CRITERIA, creds(), 1, {});
    const failure = await s.search(CRITERIA, creds(), 1, {});
    const acq = await s.acquire(["leadocean:1"], creds(), {});
    const val = await s.validateCredentials(creds());
    const refused = await adapter(vendor({ account: json({ success: false, error: { message: "denied" } }, 401) })).validateCredentials(creds());
    log.mockRestore();
    errLog.mockRestore();
    for (const c of v.calls.filter((x) => x.path !== "/v1/enums/industry")) expect(c.apiKey).toBe(KEY_LSI);
    expect(refused.ok).toBe(false);
    const everything = JSON.stringify([page, failure, acq, val, refused, lines, v.calls.map((c) => [c.path, c.body, String(c.query)])]);
    expect(everything).not.toContain(KEY_LSI);
    expect(everything).not.toContain("lo_live");
  });

  it("saving, testing and removing are for admins; a rep gets a refusal and the key is untouched", async () => {
    vi.stubGlobal("fetch", vendor().impl);
    const rep = caller(REP);
    expect((await refusal(rep.prospectSources.saveCredentials({ slug: "leadocean", apiKey: KEY_LSI }))).code).toBe("FORBIDDEN");
    expect(credRow()).toBeUndefined();
    addKey(LSI, KEY_LSI);
    expect((await refusal(rep.prospectSources.removeCredentials({ slug: "leadocean" }))).code).toBe("FORBIDDEN");
    expect((await refusal(rep.prospectSources.validate({ slug: "leadocean" }))).code).toBe("FORBIDDEN");
    expect((await refusal(rep.prospectSources.setEnabled({ slug: "leadocean", enabled: false }))).code).toBe("FORBIDDEN");
    expect(credRow().status).toBe("valid");
  });

  it("removing the key stops the source and keeps the options", async () => {
    vi.stubGlobal("fetch", vendor().impl);
    const admin = caller(ADMIN);
    await admin.prospectSources.saveCredentials({ slug: "leadocean", apiKey: KEY_LSI, config: { fetchPhones: true, dailyPeopleCap: 200, acceptedEmailStatuses: ["verified", "catch_all"] } });
    expect(credRow().config).toEqual(expect.objectContaining({ fetchPhones: true, dailyPeopleCap: 200, acceptedEmailStatuses: ["verified", "catch_all"] }));
    await admin.prospectSources.removeCredentials({ slug: "leadocean" });
    expect(credRow().status).toBe("revoked");
    expect(credRow().credentialsEnc).toBeNull();
    expect(await loadCredentials(LSI, getSource("leadocean"))).toBeNull();
    const { skipped } = await eligibleFor(LSI, CRITERIA, { only: ["leadocean"] });
    expect(skipped.find((x) => x.slug === "leadocean")!.reason).toBe("no_credentials");
    // Clearing the cap on a later save.
    await admin.prospectSources.saveCredentials({ slug: "leadocean", apiKey: KEY_LSI, config: { dailyPeopleCap: null } });
    expect(JSON.parse(JSON.stringify(credRow().config)).dailyPeopleCap).toBeUndefined();
  });
});

/* ─── No fallback ───────────────────────────────────────────────────────── */

describe("each workspace uses its own key, and nothing else", () => {
  afterEach(() => { delete process.env.LEADOCEAN_API_KEY; });

  it("another workspace's key is no key, and neither is one in the environment", async () => {
    process.env.LEADOCEAN_API_KEY = "lo_live_platform_fixture";
    addKey(LSI, KEY_LSI);
    const s = getSource("leadocean");
    expect(s.credentialMode).toBe("table");
    expect((await loadCredentials(LSI, s))!.secrets.apiKey).toBe(KEY_LSI);
    expect(await loadCredentials(CF, s)).toBeNull();
    const view = await credentialView(CF, s);
    expect(view).toEqual(expect.objectContaining({ configured: false, source: "none" }));
    const { eligible, skipped } = await eligibleFor(CF, CRITERIA, { only: ["leadocean"] });
    expect(eligible).toEqual([]);
    expect(skipped.find((x) => x.slug === "leadocean")!.reason).toBe("no_credentials");
  });

  it("a workspace with only another's key cannot start a search; one with its own can", async () => {
    addKey(LSI, KEY_LSI);
    vi.stubGlobal("fetch", vendor().impl);
    const cf = await refusal(caller(ADMIN, CF).prospectSources.startSearch({ criteria: { ...CRITERIA }, sources: ["leadocean"] } as never));
    expect(cf.code).toBe("PRECONDITION_FAILED");
    const lsi = await caller(ADMIN, LSI).prospectSources.startSearch({ criteria: { ...CRITERIA }, batchTarget: 5, sources: ["leadocean"] } as never);
    expect(lsi.runId).toBeGreaterThan(0);
  });

  it("each workspace's calls carry its own key", async () => {
    addKey(LSI, KEY_LSI);
    addKey(CF, KEY_CF);
    const v = vendor({ pages: [[person(1)], [person(2)]] });
    vi.stubGlobal("fetch", v.impl);
    const run = async (ws: number) => {
      const { eligible } = await eligibleFor(ws, CRITERIA, { only: ["leadocean"] });
      expect(eligible).toHaveLength(1);
      return runWaterfall({ workspaceId: ws, criteria: CRITERIA, target: 1, sources: eligible, deduper: new Deduper(), mode: "preview" });
    };
    await run(LSI);
    const lsiCalls = v.calls.length;
    await run(CF);
    expect(v.calls.slice(0, lsiCalls).every((c) => c.apiKey === KEY_LSI)).toBe(true);
    expect(v.calls.slice(lsiCalls).every((c) => c.apiKey === KEY_CF)).toBe(true);
    expect(spent("search_records", LSI)).toBe(1);
    expect(spent("search_records", CF)).toBe(1);
  });

  it("the credential module has no environment path for this source", () => {
    const cred = read("server/services/prospectSources/credentials.ts");
    expect(cred).not.toMatch(/LEADOCEAN/);
    expect(read("server/services/prospectSources/adapters/leadocean.ts")).not.toContain("process.env");
  });
});

/* ─── Saving a key starts nothing ───────────────────────────────────────── */

function campaignRow(prospectSources: unknown, over: Record<string, unknown> = {}) {
  return {
    id: 7, workspaceId: LSI, name: "Counties", status: "active", targetProspectCount: 10, prospectSources,
    icpOverrides: { targetTitles: ["County Administrator"], targetGeographies: ["Virginia"], targetIndustries: ["Government Administration"] },
    discoveryQueryState: null, researchSectorId: null, researchPersonaId: null, ...over,
  };
}

describe("a saved key makes the source available, and that is all", () => {
  it("is in the vocabulary, but in no default", () => {
    expect(ARE_SOURCE_IDS).toContain("leadocean");
    expect(ARE_OPT_IN_SOURCES).toContain("leadocean");
    expect(ARE_DEFAULT_SOURCES).not.toContain("leadocean");
    expect(ARE_DEFAULT_SOURCES).toEqual(ARE_SOURCE_IDS.filter((id) => id !== "leadocean"));
    // Its checking-order slot exists, last, so ticking it never reorders anything.
    expect(ARE_DEFAULT_SOURCE_ORDER[ARE_DEFAULT_SOURCE_ORDER.length - 1]).toBe("leadocean");
    // "On" in the workspace mask does not make it selected.
    expect(resolveSourceOrder(null, { leadocean: true }, ARE_DEFAULT_SOURCES)).not.toContain("leadocean");
    // A person's tick is kept.
    expect(normalizeSources(["leadocean"])).toEqual(["leadocean"]);
    expect(resolveSourceOrder(null, { leadocean: true }, ["leadocean"])).toEqual(["leadocean"]);
  });

  it("saving and testing a key buys nothing and changes no campaign", async () => {
    const v = vendor({ pages: [[person(1)]] });
    vi.stubGlobal("fetch", v.impl);
    rows("are_campaigns").push(campaignRow(null), campaignRow(["apollo"], { id: 8 }));
    const before = JSON.stringify(rows("are_campaigns"));
    const admin = caller(ADMIN);
    await admin.prospectSources.saveCredentials({ slug: "leadocean", apiKey: KEY_LSI });
    await admin.prospectSources.validate({ slug: "leadocean" });
    await admin.prospectSources.describe();
    await runSourceMaintenance({ skipWorkspace: () => false });
    expect(v.paidCalls()).toEqual([]);
    expect(v.calls.some((c) => c.path === "/v1/people/search")).toBe(false);
    expect(JSON.stringify(rows("are_campaigns"))).toBe(before);
    expect(credRow().status).toBe("valid");
    expect(rows("workspace_settings").find((s) => s.workspaceId === LSI).areScraperSources).toBeNull();
  });

  it("a campaign with no stored sources, the very case that falls back to the defaults, never calls it", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [[person(1)]] });
    vi.stubGlobal("fetch", v.impl);
    rows("are_campaigns").push(campaignRow(null));
    await runDiscovery(rows("are_campaigns")[0], 5);
    // It did fall back to the defaults: the other sources ran. Just not this one.
    expect(v.calls.length).toBeGreaterThan(0);
    expect(v.leadOcean()).toEqual([]);
    expect(rows("are_scrape_jobs").some((j) => j.sourceType === "leadocean")).toBe(false);
  });

  it("nor does one with its own list, nor one whose list is explicitly empty", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [[person(1)]] });
    vi.stubGlobal("fetch", v.impl);
    rows("are_campaigns").push(campaignRow(["internal"]), campaignRow([], { id: 8 }));
    await runDiscovery(rows("are_campaigns")[0], 5);
    await runDiscovery(rows("are_campaigns")[1], 5);
    expect(v.leadOcean()).toEqual([]);
  });

  it("the wizard's default is built from the defaults, whatever the workspace mask says", () => {
    const wizard = read("client/src/pages/usip/ARECampaigns.tsx");
    expect(wizard).toContain("const picked = ARE_DEFAULT_SOURCES.filter((id) => saved[id] ?? true);");
    expect(wizard).not.toContain("ARE_SOURCE_IDS.filter((id) => saved[id] ?? true)");
    expect(read("server/routers/are/campaigns.ts")).toContain(".default([...ARE_DEFAULT_SOURCES])");
  });

  it("a search that names nobody leaves it out, and one that names it runs it", async () => {
    addKey(LSI, KEY_LSI);
    vi.stubGlobal("fetch", vendor().impl);
    const none = await eligibleFor(LSI, CRITERIA, { only: null });
    expect(none.eligible.map((e) => e.source.slug)).not.toContain("leadocean");
    expect(none.skipped.find((x) => x.slug === "leadocean")).toEqual(expect.objectContaining({ reason: "not_selected" }));
    const named = await eligibleFor(LSI, CRITERIA, { only: ["leadocean"] });
    expect(named.eligible.map((e) => e.source.slug)).toEqual(["leadocean"]);
  });

  it("Source search starts it unticked and says what a run will bill", () => {
    const page = read("client/src/pages/usip/SourceSearch.tsx");
    expect(page).toContain("chosen ?? new Set<ProspectSourceSlug>(freeSlugs)");
    expect(page).toContain("new Set<ProspectSourceSlug>(prev ?? freeSlugs)");
    expect(page).toContain('billedPreviews.length > 0 ? "Run search (billed preview)" : "Run search (free preview)"');
  });

  it("the off switch beats a tick", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [[person(1)]] });
    vi.stubGlobal("fetch", v.impl);
    rows("workspace_settings").find((s) => s.workspaceId === LSI).areScraperSources = { leadocean: false };
    rows("are_campaigns").push(campaignRow(["leadocean"]));
    await runDiscovery(rows("are_campaigns")[0], 5);
    expect(v.paidCalls()).toEqual([]);
    const { skipped } = await eligibleFor(LSI, CRITERIA, { only: ["leadocean"] });
    expect(skipped.find((x) => x.slug === "leadocean")!.reason).toBe("disabled");
  });
});

/* ─── The engine, end to end ────────────────────────────────────────────── */

describe("a campaign that ticks it", () => {
  it("searches by the employer's state, screens before the lookup, and queues only who it paid for", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [[
      person(1),
      person(2, { profile: { profile_address: "Charleston, West Virginia, United States" } }),
      person(3, { profile: { profile_address: "Greater Richmond Region" } }),
    ]] });
    vi.stubGlobal("fetch", v.impl);
    rows("are_campaigns").push(campaignRow(["leadocean"]));
    const added = await runDiscovery(rows("are_campaigns")[0], 3);

    expect(v.pageCalls()[0].body).toEqual(expect.objectContaining({ title: ["County Administrator"], hqState: ["Virginia"], limit: 3, order: "stable", viewedSet: "velocity-ws-2" }));
    // The person in West Virginia was billed as a row, and spared the lookup.
    expect(v.calls.filter((c) => c.path === "/v2/people/email/work").map((c) => c.body.contact_id)).toEqual(["1", "3"]);
    expect(spent("search_records")).toBe(3);
    expect(spent("lookups")).toBe(2);
    expect(added).toBe(2);

    const queued = rows("prospect_queue").filter((q) => q.campaignId === 7);
    expect(queued.map((q) => q.email)).toEqual(["p1@henrico.gov", "p3@henrico.gov"]);
    expect(queued.every((q) => q.sourceType === "leadocean")).toBe(true);
    expect(rows("are_scrape_jobs").find((j) => j.sourceType === "leadocean").status).toBe("complete");

    const state = rows("are_campaigns")[0].discoveryQueryState;
    expect(JSON.stringify(state)).not.toContain("cursor");
    const log = rows("are_engine_logs").find((l) => /^leadocean returned/.test(l.message));
    expect(log.message).toContain("place check: 1 inside, 1 outside, 1 unknown");
    expect(log.message).toContain("(5 units");
  });

  it("no key is a choice, not a failure: it logs, records a skip, and does not rest", async () => {
    const v = vendor();
    vi.stubGlobal("fetch", v.impl);
    rows("are_campaigns").push(campaignRow(["leadocean"]));
    await runDiscovery(rows("are_campaigns")[0], 5);
    expect(v.leadOcean()).toEqual([]);
    const c = rows("are_campaigns")[0].discoveryQueryState;
    expect(c.src?.leadocean).toBeUndefined();
    const summary = rows("are_engine_logs").find((l) => /^Discovery slice/.test(l.message));
    expect(summary.details.perSource.leadocean.skipped).toContain("no API key");
    expect(rows("are_scrape_jobs")).toEqual([]);
  });

  it("a refusal reads as an error with its reason, not as nobody found", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ sizing: { total: null, unsupportedFilters: ["hqState"], totalWithheld: { reason: "unsupported_filters", message: "Too many companies." } } });
    vi.stubGlobal("fetch", v.impl);
    rows("are_campaigns").push(campaignRow(["leadocean"]));
    expect(await runDiscovery(rows("are_campaigns")[0], 5)).toBe(0);
    expect(v.pageCalls()).toEqual([]);
    const summary = rows("are_engine_logs").find((l) => /^Discovery slice/.test(l.message));
    expect(summary.details.perSource.leadocean.error).toContain("would not apply hqState");
    expect(rows("are_scrape_jobs")).toEqual([]);
    expect(rows("are_campaigns")[0].discoveryQueryState.src.leadocean.empty).toBe(1);
  });
});

/* ─── Source search ─────────────────────────────────────────────────────── */

describe("Source search with it ticked", () => {
  it("stages masked rows, and the estimate counts the lookups a promotion will spend", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [[person(1), person(2)]] });
    vi.stubGlobal("fetch", v.impl);
    const [run] = rows("prospect_search_runs").length ? rows("prospect_search_runs") : [null];
    expect(run).toBeNull();
    rows("prospect_search_runs").push({ id: 11, workspaceId: LSI, userId: ADMIN, criteria: CRITERIA, batchTarget: 5, status: "queued" });
    await executeRun(LSI, 11, { only: ["leadocean"] });
    const done = rows("prospect_search_runs")[0];
    expect(done.status).toBe("complete");
    expect(done.perSource.leadocean).toEqual(expect.objectContaining({ searched: 2, unitsSpent: 2 }));
    const staged = rows("prospect_search_results");
    expect(staged.map((r) => r.externalId)).toEqual(["leadocean:1", "leadocean:2"]);
    expect(staged.every((r) => r.emailIsMasked && !r.wasCharged)).toBe(true);
    expect(JSON.stringify(done.perSource)).not.toContain("signed");
    const est = await estimatePromotion(LSI, 11, staged.map((r) => r.id));
    expect(est.units).toBe(2);
    expect(v.calls.some((c) => c.path.startsWith("/v2/"))).toBe(false);
  });

  it("the estimate for a thin row is its two lookups", async () => {
    addKey(LSI, KEY_LSI);
    rows("prospect_search_runs").push({ id: 12, workspaceId: LSI, userId: ADMIN, criteria: CRITERIA, batchTarget: 5, status: "complete" });
    rows("prospect_search_results").push({ id: 1, workspaceId: LSI, runId: 12, sourceSlug: "leadocean", externalId: "leadocean:9:thin", wasCharged: false, promotedProspectId: null });
    expect((await estimatePromotion(LSI, 12, [1])).units).toBe(2);
  });
});

describe("promoting a staged LeadOcean row", () => {
  it("buys the address then, under the row's own id, and it enters People through the consolidation with no verified claim", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [[person(1)]] });
    vi.stubGlobal("fetch", v.impl);
    rows("prospect_search_runs").push({ id: 11, workspaceId: LSI, userId: ADMIN, criteria: CRITERIA, batchTarget: 5, status: "queued" });
    await executeRun(LSI, 11, { only: ["leadocean"] });
    const staged = rows("prospect_search_results")[0];
    const r = await promoteResults(LSI, ADMIN, 11, [staged.id]);
    expect(r.acquired).toBe(1);
    expect(r.unitsSpent).toBe(1);
    expect(r.failed).toBe(0);
    expect(spent("lookups")).toBe(1);
    const after = rows("prospect_search_results")[0];
    expect(after.wasCharged).toBe(true);
    expect(after.emailIsMasked).toBe(false);
    expect(after.normalized).toEqual(expect.objectContaining({ email: "p1@henrico.gov", firstName: "Pat", lastName: "Lee1", emailVerifiedAt: null }));
    const raw = rows("raw_finds").find((f) => f.source === "leadocean");
    expect(raw).toBeTruthy();
    // Promoting twice does not buy twice.
    const again = await promoteResults(LSI, ADMIN, 11, [staged.id]);
    expect(again.unitsSpent).toBe(0);
    expect(spent("lookups")).toBe(1);
  });
});

/* ─── Money and people at the edges ─────────────────────────────────────── */

describe("rows are counted as billed, not as kept", () => {
  const paged = (rowsIn: unknown[], nextCursor: string | null) =>
    json({ success: true, data: rowsIn, meta: { count: rowsIn.length, credits: rowsIn.length, nextCursor, unsupportedFilters: [] } });

  it("a page of duplicates and dropped rows does not buy another page to make up the number", async () => {
    const v = vendor({ pages: [paged([
      person(1, { meta: { source_ids: { person_id: "1", person_group_id: "G" } } }),
      person(2, { meta: { source_ids: { person_id: "2", person_group_id: "G" } } }),
      person(3, { contact: { has_email: false } }),
    ], "c1"), paged([person(4), person(5)], null)] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 3, {}));
    expect(v.pageCalls()).toHaveLength(1);
    expect(r.unitsSpent).toBe(3);
    expect(r.records).toHaveLength(1);
  });

  it("a short page leaves only what is unbilled for the next one, not what is unkept", async () => {
    const v = vendor({ pages: [paged([person(1), person(2, { contact: { has_email: false } })], "c1"), paged([person(3)], null)] });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 3, {}));
    expect(v.pageCalls().map((p) => p.body.limit)).toEqual([3, 1]);
    expect(r.unitsSpent).toBe(3);
  });

  it("so a daily cap of ten is ten billed rows, however many of them are kept", async () => {
    const dup = (id: number) => person(id, { meta: { source_ids: { person_id: String(id), person_group_id: "G" } } });
    const v = vendor({ pages: [paged(Array.from({ length: 10 }, (_, i) => dup(i + 1)), "c1"), paged([person(99)], null)] });
    const r = ok(await adapter(v).search(CRITERIA, creds({ dailyPeopleCap: 10 }), 50, {}));
    expect(v.pageCalls().map((p) => p.body.limit)).toEqual([10]);
    expect(r.unitsSpent).toBe(10);
    expect(spent("search_records")).toBe(10);
  });

  it("a page billed and then a failure reports what it cost, in the outcome as well as the ledger", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [paged([person(1, { contact: { has_email: false } })], "c1"), json({ success: false, error: { message: "denied" } }, 401)] });
    const s = adapter(v);
    const direct = bad(await s.search(CRITERIA, creds(), 3, {}));
    expect(direct.reason).toBe("unauthorized");
    expect(direct.unitsSpent).toBe(1);

    const v2 = vendor({ pages: [paged([person(2, { contact: { has_email: false } })], "c1"), json({ success: false, error: { message: "denied" } }, 401)] });
    const s2 = adapter(v2);
    const eligible = { source: s2, credentials: creds(), capabilities: s2.capabilities(), match: { verdict: "full" as const, approximated: [], missing: [] }, leadsRemaining: null };
    const r = await runWaterfall({ workspaceId: LSI, criteria: CRITERIA, target: 3, sources: [eligible], deduper: new Deduper(), mode: "preview" });
    expect(r.perSource[0]).toEqual(expect.objectContaining({ errorReason: "unauthorized", unitsSpent: 1 }));
  });

  it("a plan that refuses past its records buys only rows it can afford to look up", async () => {
    const records = (remaining: number, whenOver = "refused") => ({ records: { ceiling: 1000, used: 1000 - remaining, remaining, overLimit: false, whenOver, resetsAt: null } });
    const seven = vendor({ pages: [[person(1)]], account: records(7) });
    ok(await adapter(seven).search(CRITERIA, creds(), 25, {}));
    expect(seven.pageCalls()[0].body.limit).toBe(3);

    const one = vendor({ pages: [[person(1)]], account: records(1) });
    const r = bad(await adapter(one).search(CRITERIA, creds(), 25, {}));
    expect(r.reason).toBe("budget_exhausted");
    expect(one.calls.some((c) => c.path === "/v1/people/search")).toBe(false);

    // A plan that slows instead of refusing has no such edge.
    const slows = vendor({ pages: [[person(1)]], account: records(7, "throttled") });
    ok(await adapter(slows).search(CRITERIA, creds(), 25, {}));
    expect(slows.pageCalls()[0].body.limit).toBe(25);
  });
});

describe("a lookup billed with nothing to take is not bought twice", () => {
  it("the adapter says which misses were billed: a null is, a 404 and an untried person are not", async () => {
    let n = 0;
    const v = vendor({ work: () => {
      n += 1;
      if (n === 1) return json({ success: true, data: null });
      if (n === 2) return json({ success: false, error: { message: "not found" } }, 404);
      return json({ success: true, data: null }, 200, { "x-quota-state": "paced", "x-quota-reset": LATER });
    } });
    const r = ok(await adapter(v).acquire(["leadocean:1", "leadocean:2", "leadocean:3", "leadocean:4"], creds(), {}));
    expect(r.paidMissExternalIds).toEqual(["leadocean:1", "leadocean:3"]);
    expect(r.failedExternalIds).toEqual(["leadocean:1", "leadocean:2", "leadocean:3", "leadocean:4"]);

    const thin = vendor({ enrich: (c) => json({ success: true, data: person(c.body.person_id, { contact: { has_email: false } }), meta: { credits: 1 } }) });
    expect(ok(await adapter(thin).acquire(["leadocean:9:thin"], creds(), {})).paidMissExternalIds).toEqual(["leadocean:9:thin"]);
  });

  it("promoting it again, as Select all would, buys nothing, and the estimate agrees", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [[person(1), person(2)]], work: (c) => json({ success: true, data: c.body.contact_id === "1" ? null : { email: "p2@henrico.gov", status: "verified" } }) });
    vi.stubGlobal("fetch", v.impl);
    rows("prospect_search_runs").push({ id: 11, workspaceId: LSI, userId: ADMIN, criteria: CRITERIA, batchTarget: 5, status: "queued" });
    await executeRun(LSI, 11, { only: ["leadocean"] });
    const ids = rows("prospect_search_results").map((r) => r.id);
    const first = await promoteResults(LSI, ADMIN, 11, ids);
    expect(first).toEqual(expect.objectContaining({ acquired: 1, unitsSpent: 2, failed: 1 }));
    const miss = rows("prospect_search_results").find((r) => r.externalId === "leadocean:1");
    expect(miss.wasCharged).toBe(true);
    expect(miss.normalized.rawSourcePayload.noAddressFound).toBe(true);
    expect(miss.promotedProspectId ?? null).toBeNull();

    const doors = () => v.calls.filter((c) => c.path === "/v2/people/email/work").length;
    const before = doors();
    const again = await promoteResults(LSI, ADMIN, 11, [miss.id]);
    expect(again).toEqual(expect.objectContaining({ acquired: 0, unitsSpent: 0, promoted: 0 }));
    expect(doors()).toBe(before);
    expect((await estimatePromotion(LSI, 11, [miss.id])).units).toBe(0);
  });

  it("a miss that was not billed can be tried again", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [[person(1)]], work: () => json({ success: false, error: { message: "not found" } }, 404) });
    vi.stubGlobal("fetch", v.impl);
    rows("prospect_search_runs").push({ id: 11, workspaceId: LSI, userId: ADMIN, criteria: CRITERIA, batchTarget: 5, status: "queued" });
    await executeRun(LSI, 11, { only: ["leadocean"] });
    const staged = rows("prospect_search_results")[0];
    await promoteResults(LSI, ADMIN, 11, [staged.id]);
    expect(staged.wasCharged).toBe(false);
    expect((await estimatePromotion(LSI, 11, [staged.id])).units).toBe(1);
  });

  it("the page does not offer it for selection, and says why", () => {
    const page = read("client/src/pages/usip/SourceSearch.tsx");
    expect(page).toContain("noAddressFound === true");
    expect(page).toContain("const selectable = r.isNetNew && !r.promotedProspectId && !lookedUpEmpty(r);");
    expect(page).toContain("setSelected(v ? new Set(selectableRows.map((r) => r.id)) : new Set())");
    expect(page).toContain("looked up: no address you accept");
  });
});

describe("people are not lost, and it says when they might be", () => {
  it("a give-back that fails says so instead of claiming they are held for later", async () => {
    const down = json({ success: false, error: { code: "no_source", message: "down" } }, 503);
    let n = 0;
    const v = vendor({
      viewed: down,
      work: (c) => { n += 1; return json({ success: true, data: { email: `p${c.body.contact_id}@henrico.gov`, status: "verified" } }, 200, n === 1 ? { "x-quota-state": "paced" } : {}); },
    });
    const r = ok(await adapter(v).acquire(["leadocean:1", "leadocean:2"], creds(), {}));
    expect(r.note).toContain("1 could not be given back");
    expect(r.note).not.toContain("held for later");

    const refused = vendor({ viewed: down, work: () => json({ success: false, error: { message: "denied" } }, 401) });
    expect(bad(await adapter(refused).acquire(["leadocean:1"], creds(), {})).message).toContain("could not be given back");
  });

  it("lookups reach the ledger one at a time, so a batch that dies partway is still counted", async () => {
    const v = vendor();
    ok(await adapter(v).acquire(["leadocean:1", "leadocean:2", "leadocean:3"], creds(), {}));
    const row = rows("spend_ledger").find((r) => r.meter === "lookups");
    expect(row.quantity).toBe(3);
    expect(row.calls).toBe(3);
  });

  it("a search that only skipped people already seen says that, rather than ending quietly", async () => {
    const skip = (i: number) => json({ success: true, data: [], meta: { credits: 0, nextCursor: `c${i}`, walkCapped: true, excludedViewed: 500 } });
    const v = vendor({ pages: Array.from({ length: 10 }, (_, i) => skip(i)) });
    const r = ok(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(r.records).toEqual([]);
    expect(r.note).toContain("still skipping people this workspace has already seen");
  });

  it("an earlier search can be reopened on the page, because its rows will not come back", () => {
    const page = read("client/src/pages/usip/SourceSearch.tsx");
    expect(page).toContain("trpc.prospectSources.listRuns.useQuery({ limit: 15 })");
    expect(page).toContain('aria-label="Open an earlier search"');
    expect(page).toContain("setRunId(e.target.value ? Number(e.target.value) : null)");
  });
});

describe("a hold partway through lookups is still a hold", () => {
  const quota = () => json({ success: false, error: { code: "key_quota", message: "cap", resetsAt: LATER } }, 429, { "retry-after": "3600", "x-key-limit-reset": LATER });

  it("a long Retry-After with nothing else to go on is a pace: AppSumo's wording, not retried into", async () => {
    const v = vendor({ pages: [json({ success: false, error: { message: "too many" } }, 429, { "retry-after": "60" }), [person(1)]] });
    const r = bad(await adapter(v).search(CRITERIA, creds(), 5, {}));
    expect(r.held).toBe(true);
    expect(r.retryAfterSeconds).toBe(60);
    expect(v.pageCalls()).toHaveLength(1);
  });

  it("a key's quota is not retried even when its reset is seconds away", async () => {
    const soon = json({ success: false, error: { code: "key_quota", message: "cap" } }, 429, { "retry-after": "3" });
    const v = vendor({ pages: [soon, [person(1)]] });
    expect(bad(await adapter(v).search(CRITERIA, creds(), 5, {})).held).toBe(true);
    expect(v.pageCalls()).toHaveLength(1);
  });

  it("a lookup that failed after a billed step reports what that step cost", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [[person(1)]], work: () => json({ success: false, error: { message: "denied" } }, 401) });
    const s = adapter(v);
    const direct = bad(await s.acquire(["leadocean:9:thin"], creds(), {}));
    expect(direct.reason).toBe("unauthorized");
    expect(direct.unitsSpent).toBe(1);
    // In the waterfall too: the row and the identity lookup, with the lookup's failure.
    const thin = { person_id: "9", profile_data: {}, contact_data: { contact_current_experiences: [{ job_title: "Clerk" }] }, meta: { view: "thin" } };
    const v2 = vendor({ pages: [[thin]], work: () => json({ success: false, error: { message: "denied" } }, 401) });
    const s2 = adapter(v2);
    const eligible = { source: s2, credentials: creds(), capabilities: s2.capabilities(), match: { verdict: "full" as const, approximated: [], missing: [] }, leadsRemaining: null };
    const r = await runWaterfall({ workspaceId: LSI, criteria: CRITERIA, target: 1, sources: [eligible], deduper: new Deduper(), mode: "acquire" });
    expect(r.perSource[0]).toEqual(expect.objectContaining({ errorReason: "unauthorized", unitsSpent: 2 }));
  });

  it("a thin row paced between its two lookups has not been tried: it is given back, and can be bought later", async () => {
    const v = vendor({ enrich: (c) => json({ success: true, data: person(c.body.person_id), meta: { credits: 1 } }, 200, { "x-quota-state": "paced", "x-quota-reset": LATER }) });
    const r = ok(await adapter(v).acquire(["leadocean:9:thin"], creds(), {}));
    expect(v.calls.some((c) => c.path === "/v2/people/email/work")).toBe(false);
    expect(r.unitsSpent).toBe(1);
    expect(r.records).toEqual([]);
    expect(r.paidMissExternalIds).toBeUndefined();
    expect(r.failedExternalIds).toEqual(["leadocean:9:thin"]);
    expect(r.hold?.retryAfterSeconds).toBe(3 * 60 * 60);
    expect(v.viewedCalls().find((c) => c.method === "DELETE")!.body.ids).toEqual(["9"]);
  });

  it("the adapter reports the hold along with who it did get", async () => {
    let n = 0;
    const v = vendor({ work: (c) => { n += 1; return n === 1 ? json({ success: true, data: { email: `p${c.body.contact_id}@henrico.gov`, status: "verified" } }) : quota(); } });
    const r = ok(await adapter(v).acquire(["leadocean:1", "leadocean:2"], creds(), {}));
    expect(r.records.map((x) => x.email)).toEqual(["p1@henrico.gov"]);
    expect(r.hold).toEqual({ message: expect.stringContaining("own cap"), retryAfterSeconds: 3 * 60 * 60 });
    expect(r.note).toContain("1 held for later");
  });

  it("a paced first lookup that answers null is a hold, not a search that found nothing", async () => {
    addKey(LSI, KEY_LSI);
    const v = vendor({ pages: [[person(1), person(2)]], work: () => json({ success: true, data: null }, 200, { "x-quota-state": "paced", "x-quota-reset": LATER }) });
    vi.stubGlobal("fetch", v.impl);
    rows("are_campaigns").push(campaignRow(["leadocean"]));
    expect(await runDiscovery(rows("are_campaigns")[0], 2)).toBe(0);
    const state = rows("are_campaigns")[0].discoveryQueryState;
    expect(state.src.leadocean).toEqual(expect.objectContaining({ held: true, nextAt: T0 + 3 * 60 * 60 * 1000 }));
    expect(rows("are_scrape_jobs")).toEqual([]);
    const summary = rows("are_engine_logs").find((l) => /^Discovery slice/.test(l.message));
    expect(summary.details.perSource.leadocean.skipped).toContain("1 request a minute");
  });

  it("the people it did get are queued, and the next tick buys nothing until the reset", async () => {
    addKey(LSI, KEY_LSI);
    let n = 0;
    const v = vendor({ pages: [[person(1), person(2)]], work: (c) => { n += 1; return n === 1 ? json({ success: true, data: { email: `p${c.body.contact_id}@henrico.gov`, status: "verified" } }) : quota(); } });
    vi.stubGlobal("fetch", v.impl);
    rows("are_campaigns").push(campaignRow(["leadocean"]));
    expect(await runDiscovery(rows("are_campaigns")[0], 2)).toBe(1);
    expect(rows("prospect_queue").map((q) => q.email)).toEqual(["p1@henrico.gov"]);
    const state = rows("are_campaigns")[0].discoveryQueryState;
    expect(state.src.leadocean).toEqual(expect.objectContaining({ held: true, nextAt: T0 + 3 * 60 * 60 * 1000 }));

    const paid = v.paidCalls().length;
    vi.setSystemTime(new Date(T0 + 40 * 60 * 1000));
    await runDiscovery(rows("are_campaigns")[0], 2);
    expect(v.paidCalls().length).toBe(paid);
    const log = rows("are_engine_logs").filter((l) => /^Discovery slice/.test(l.message)).pop();
    expect(log.details.perSource.leadocean.skipped).toContain("held by the vendor");
  });

  it("a promotion surfaces the hold rather than reading as 'could not be acquired'", async () => {
    addKey(LSI, KEY_LSI);
    let n = 0;
    const v = vendor({ pages: [[person(1), person(2)]], work: (c) => { n += 1; return n === 1 ? json({ success: true, data: { email: `p${c.body.contact_id}@henrico.gov`, status: "verified" } }) : quota(); } });
    vi.stubGlobal("fetch", v.impl);
    rows("prospect_search_runs").push({ id: 11, workspaceId: LSI, userId: ADMIN, criteria: CRITERIA, batchTarget: 5, status: "queued" });
    await executeRun(LSI, 11, { only: ["leadocean"] });
    const r = await promoteResults(LSI, ADMIN, 11, rows("prospect_search_results").map((x) => x.id));
    expect(r.errors.join(" ")).toContain("own cap");
    // Held rows stay promotable: nothing was billed for them.
    expect(rows("prospect_search_results").find((x) => x.externalId === "leadocean:2").wasCharged).toBe(false);
  });
});

describe("a tick that asked nobody is not an empty run", () => {
  const held = { account: { pace: { search: [], enrich: [], paced: { kind: "search", windowLabel: "5 hours", resetsAt: LATER } } } };

  it("a held source leaves the angle and the campaign's rest alone, and no log says it found nobody", async () => {
    addKey(LSI, KEY_LSI);
    vi.stubGlobal("fetch", vendor(held).impl);
    rows("are_campaigns").push(campaignRow(["leadocean"]));
    await runDiscovery(rows("are_campaigns")[0], 5);
    const state = rows("are_campaigns")[0].discoveryQueryState;
    expect(state.lastRunNew).toBeUndefined();
    expect(state.lastRunAt).toBeUndefined();
    expect(state.slices[0].emptyRuns ?? 0).toBe(0);
    expect(state.slices[0].nextAt ?? null).toBeNull();

    // And the next tick, with the source still resting on the vendor's word.
    vi.setSystemTime(new Date(T0 + 5 * 60 * 1000));
    await runDiscovery(rows("are_campaigns")[0], 5);
    const later = rows("are_campaigns")[0].discoveryQueryState;
    expect(later.lastRunNew).toBeUndefined();
    expect(later.slices[0].emptyRuns ?? 0).toBe(0);
    expect(rows("are_engine_logs").some((l) => /found nobody new|come back empty/.test(l.message))).toBe(false);
  });

  it("no key is the same, so saving one works on the next tick", async () => {
    vi.stubGlobal("fetch", vendor().impl);
    rows("are_campaigns").push(campaignRow(["leadocean"]));
    await runDiscovery(rows("are_campaigns")[0], 5);
    const state = rows("are_campaigns")[0].discoveryQueryState;
    expect(state.lastRunNew).toBeUndefined();
    expect(state.slices[0].emptyRuns ?? 0).toBe(0);
  });

  it("a failed search did ask, so it counts the way a failure does", async () => {
    addKey(LSI, KEY_LSI);
    vi.stubGlobal("fetch", vendor({ sizing: { total: null, unsupportedFilters: ["hqState"], totalWithheld: { reason: "unsupported_filters" } } }).impl);
    rows("are_campaigns").push(campaignRow(["leadocean"]));
    await runDiscovery(rows("are_campaigns")[0], 5);
    const state = rows("are_campaigns")[0].discoveryQueryState;
    expect(state.lastRunNew).toBe(0);
    expect(state.slices[0].emptyRuns).toBe(1);
  });

  it("beside another source that ran, the run is an ordinary one", async () => {
    addKey(LSI, KEY_LSI);
    vi.stubGlobal("fetch", vendor(held).impl);
    rows("are_campaigns").push(campaignRow(["internal", "leadocean"]));
    await runDiscovery(rows("are_campaigns")[0], 5);
    const state = rows("are_campaigns")[0].discoveryQueryState;
    expect(state.lastRunNew).toBe(0);
    expect(state.src.leadocean.held).toBe(true);
    expect(state.src.internal.held).toBeUndefined();
  });

  it("the campaign's source panel says the vendor asked for the wait", () => {
    expect(read("server/routers/are/campaigns.ts")).toContain("heldByVendor: !!rest?.held,");
    expect(read("client/src/components/usip/are/CampaignSourceHealth.tsx")).toContain("Held by the vendor — next attempt");
  });
});

describe("what a run has to say reaches where a person reads it", () => {
  it("Source search and the run inspector show the source's note, not only the engine log", () => {
    expect(read("client/src/pages/usip/SourceSearch.tsx")).toContain('`${p.netNew} net-new / ${p.searched}${p.note ? ` — ${p.note}` : ""}`');
    expect(read("client/src/components/usip/settings/ProspectSourceRegistryCard.tsx")).toContain('{p.note ? ` · ${p.note}` : ""}');
  });

  it("a filter left unsent reaches the staged run's own record", async () => {
    addKey(LSI, KEY_LSI);
    vi.stubGlobal("fetch", vendor({ pages: [[person(1)]] }).impl);
    rows("prospect_search_runs").push({ id: 11, workspaceId: LSI, userId: ADMIN, criteria: { ...CRITERIA, seniorities: ["VP", "Grand Poobah"] }, batchTarget: 5, status: "queued" });
    await executeRun(LSI, 11, { only: ["leadocean"] });
    expect(rows("prospect_search_runs")[0].perSource.leadocean.note).toContain("Grand Poobah");
  });

  it("the card clears a cap of zero in the box as well as on the server", () => {
    const card = read("client/src/components/usip/settings/LeadOceanSourceCard.tsx");
    expect(card).toContain('setCap(nextCap == null ? "" : String(nextCap));');
    expect(card).toContain("dailyPeopleCap: nextCap");
  });

  it("two letters that are a known country name go through the table: UK is GB on LeadOcean's list", () => {
    const uk = buildSearchFilters({ ...CRITERIA, countries: ["UK", "us", "DE"] }, ["verified"], LSI, null);
    expect(uk.filters.country).toEqual(["GB", "US", "DE"]);
  });
});

/* ─── Wiring ────────────────────────────────────────────────────────────── */

describe("wiring", () => {
  it("the manifest says a preview is billed, and the adapter acquires on demand from its own table row", () => {
    const s = getSource("leadocean");
    expect(s.capabilities()).toBe(LEADOCEAN_CAPABILITIES);
    expect(LEADOCEAN_CAPABILITIES.supportsFreePreview).toBe(false);
    expect(LEADOCEAN_CAPABILITIES.returnsMaskedPreview).toBe(true);
    expect(LEADOCEAN_CAPABILITIES.maxBatchSize).toBe(100);
    expect(s.acquisition).toBe("on_demand");
    expect(s.credentialMode).toBe("table");
    expect(s.displayName).toBe("LeadOcean");
  });

  it("migration 0219 widens both sourceType enums and the schema agrees, or the first queued row fails", () => {
    const m = read("server/_core/rawMigrations.ts");
    const block = m.slice(m.indexOf("0219_leadocean_source.sql"));
    expect(m.indexOf("0219_leadocean_source.sql")).toBeGreaterThan(-1);
    expect(block).toMatch(/ALTER TABLE `are_scrape_jobs` MODIFY COLUMN `sourceType` enum\('[^)]*'warmysender','leadocean'\) NOT NULL/);
    expect(block).toMatch(/ALTER TABLE `prospect_queue` MODIFY COLUMN `sourceType` enum\('[^)]*'warmysender','leadocean'\) NOT NULL/);
    expect(read("drizzle/schema.ts").match(/"leadocean", \/\/ migration 0219/g)).toHaveLength(2);
    const scraper = read("server/routers/are/scraper.ts");
    expect(scraper).toContain('leadocean: "leadocean"');
    expect(/QUEUE_SOURCE_TYPES = new Set\(\[[\s\S]*?"leadocean",[\s\S]*?\]\)/.test(scraper)).toBe(true);
  });

  it("both settings surfaces mount the card, which offers no consent, licence or tier gate", () => {
    // The tag, not the name: an import that is never rendered would pass on the name.
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toContain("<LeadOceanSourceCard />");
    expect(read("client/src/pages/usip/ARESettings.tsx")).toContain('<LeadOceanSourceCard variant="bare" />');
    const card = read("client/src/components/usip/settings/LeadOceanSourceCard.tsx");
    expect(card).not.toMatch(/licen[cs]e|terms of|liabilit|I agree|I accept/i);
    expect(card).not.toMatch(/tier ?[0-9]/i);
    // Write-only on screen too: it shows that a key exists, never a piece of one.
    expect(card).not.toContain("cred?.masked");
    expect(card).toContain("Test connection");
    expect(card).toContain("Remove key");
    expect(card).toContain("Fetch phone numbers");
    expect(card).toContain("Daily cap on people pulled");
  });

  it("the help article, the assistant's digest and the source vocabulary all say so", () => {
    expect(read("server/seedHelpContent.ts")).toContain("**LeadOcean.** Settings → Data sources");
    expect(read("server/productKnowledge.ts")).toContain("Apollo, LeadOcean)");
    expect(read("docs/prospect-sources.md")).toContain("## LeadOcean specifics");
  });
});
