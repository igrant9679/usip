/**
 * The CluGTM and A-Leads adapters (owner go-ahead 2026-11-25).
 *
 * VERIFIED AGAINST THE DOCUMENTATION ONLY. No live call was made (the keys are
 * the owner's): every fixture below is shaped like the vendor's documented
 * request and response (docs.clugtm.com/api-reference-v2, docs.a-leads.co/
 * reference, read 2026-11-25). A field the live API names differently will
 * not show up here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "a".repeat(64);
  return { db: null as any, reoon: { key: "", status: "safe" } };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./services/reoon", async (a) => ({
  ...(await a<typeof import("./services/reoon")>()),
  getReoonKey: async () => h.reoon.key,
  reoonVerifySingle: async () => ({ status: h.reoon.status }),
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { encryptSecret } from "./_core/crypto";
import { emptyCriteria, PROSPECT_DATABASE_SLUGS, type SearchCriteria } from "@shared/prospectSources";
import { anonymizeVendorText } from "@shared/sourceNames";
import type { SourceCredentials } from "./services/prospectSources/types";
import {
  CLUGTM_API, CLUGTM_ENRICH_JOB, CLUGTM_POLL_EVERY_MS, buildFindBody, createClugtmSource, headcountBuckets,
  stepClugtmEnrichment, titleVariants, __setClugtmJobDepsForTests,
} from "./services/prospectSources/adapters/clugtm";
import {
  ALEADS_API, ALEADS_DAILY_CALLS, buildAdvancedSearchBody, createAleadsSource, takeAleadsCall, __resetAleadsCallsForTests,
} from "./services/prospectSources/adapters/aleads";
import { getSource } from "./services/prospectSources/registry";
import { runWaterfall } from "./services/prospectSources/executor";
import { Deduper } from "./services/prospectSources/dedupe";
import { circuitState, _resetCircuitMemory } from "./services/prospectSources/circuit";
import { invalidatePoolCache, poolConfig } from "./services/prospectPool";
import { prospectQueue, areScrapeJobs } from "../drizzle/schema";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WS = 5;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const creds = (slug: "clugtm" | "aleads", over: Partial<SourceCredentials> = {}): SourceCredentials => ({ slug: slug as never, workspaceId: WS, secrets: { apiKey: `${slug}-key-123456789012` }, config: {}, origin: "own", ...over });
const criteria = (over: Partial<SearchCriteria> = {}): SearchCriteria => ({ ...emptyCriteria(), ...over });
type Call = { url: string; method: string; headers: Record<string, string>; body: any };
function stub(answer: (c: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    const c: Call = { url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined };
    calls.push(c);
    const a = answer(c);
    return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const noSleep = async () => {};

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.reoon = { key: "", status: "safe" };
  invalidatePoolCache();
  __resetAleadsCallsForTests();
  _resetCircuitMemory();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("workspace_settings").push({ workspaceId: WS });
});
afterEach(() => { __setClugtmJobDepsForTests({}); });

/* ─── Documented response shapes ─────────────────────────────────────────── */

// POST /people/find → { results[], total, cursor }
const findPage = (ids: string[], cursor: string | null) => ({
  results: ids.map((id) => ({
    lead_id: id, first_name: "Pat", last_name: `Lee ${id}`, full_name: `Pat Lee ${id}`, title: "Chief Financial Officer",
    company: "Acme", domain: "acme.example", location: "Austin, Texas, United States", linkedin_url: `https://www.linkedin.com/in/pat-${id}`, seniority: "c_suite",
  })),
  total: 60, cursor, credits_charged: 0,
});
// POST /advanced-search → { data[], meta_data }
const advancedPage = (ids: string[], total = 2) => ({
  data: ids.map((id, i) => ({
    member_id: `m-${id}`, member_full_name: `Sam Ray${id}`, member_name_first: "Sam", member_name_last: `Ray${id}`,
    job_title: "VP Sales", company_name: "Bolt", domain: i === 1 ? null : "bolt.example", website: i === 1 ? null : "https://bolt.example",
    member_linkedin_url: `https://www.linkedin.com/in/sam-${id}`, member_linkedin_username: `sam-${id}`, member_location_country: "United States",
    size_range: "51-200", phone_number_available: true, document_id: `doc-${id}`,
  })),
  meta_data: { total_count: total, viewable_leads_count: total },
});

describe("CluGTM", () => {
  it("sends titles as typed and in Title Case, the vendor's headcount buckets, and 25 rows a call", () => {
    expect(titleVariants(["chief financial officer", "CFO"])).toEqual(["chief financial officer", "Chief Financial Officer", "CFO", "Cfo"]);
    expect(headcountBuckets({ min: 40, max: 300 })).toEqual(["11-50", "51-200", "201-500"]);
    expect(buildFindBody(criteria({ jobTitles: ["cfo"], countries: ["United States"], stateProvinces: ["Texas"], headcountRange: { min: 51, max: 200 } }), 80, "c1"))
      .toEqual({ filters: { titles: ["cfo", "Cfo"], company_headcount: ["51-200"], location_country: ["United States"], location_state: ["Texas"] }, limit: 25, cursor: "c1" });
  });

  it("searches with a bearer key, follows the cursor, maps people with no address, and counts the rows on an own key", async () => {
    const { calls, fetchImpl } = stub((c) => ({ json: c.body.cursor ? findPage(["3"], null) : findPage(["1", "2"], "next-1") }));
    const s = createClugtmSource({ fetchImpl, sleep: noSleep });
    const page = await s.search(criteria({ jobTitles: ["CFO"] }), creds("clugtm"), 3, { cursor: null });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(calls.map((c) => c.url)).toEqual([`${CLUGTM_API}/people/find`, `${CLUGTM_API}/people/find`]);
    expect(calls[0].headers.Authorization).toBe("Bearer clugtm-key-123456789012");
    expect(calls[1].body.cursor).toBe("next-1");
    expect(page.records.map((r) => [r.externalId, r.firstName, r.lastName, r.email, r.emailIsMasked, r.city, r.stateProvince, r.country]))
      .toEqual([["clugtm:1", "Pat", "Lee 1", null, true, "Austin", "Texas", "United States"], ["clugtm:2", "Pat", "Lee 2", null, true, "Austin", "Texas", "United States"], ["clugtm:3", "Pat", "Lee 3", null, true, "Austin", "Texas", "United States"]]);
    expect(page.nextCursor).toBeNull();
    expect(page.unitsSpent).toBe(3);
    expect(s.acquisition).toBe("none");
    expect(s.capabilities().supportsFreePreview).toBe(false);
  });

  it("validates on /whoami; a refused key is terminal", async () => {
    const ok = createClugtmSource({ fetchImpl: stub(() => ({ json: { scopes: ["people:read", "enrichment:write"], tier: "appsumo_tier_5" } })).fetchImpl });
    expect(await ok.validateCredentials(creds("clugtm"))).toMatchObject({ ok: true, discovered: { tier: "appsumo_tier_5" } });
    const bad = createClugtmSource({ fetchImpl: stub(() => ({ status: 401, json: { error: { code: "unauthorized" } } })).fetchImpl, sleep: noSleep });
    expect(await bad.validateCredentials(creds("clugtm"))).toMatchObject({ ok: false, terminal: true });
  });

  describe("asynchronous enrichment in the job runner", () => {
    let clock = 1_000_000;
    const queueRow = (id: number, over: Record<string, unknown> = {}) => rows("prospect_queue").push({
      id, workspaceId: WS, campaignId: 1, sourceType: "clugtm", sequenceStatus: "sourcing", email: null, enrichmentError: null,
      firstName: "Pat", lastName: `Lee${id}`, linkedinUrl: `https://www.linkedin.com/in/pat-${id}`, companyName: "Acme", companyDomain: "acme.example", ...over,
    });
    const job = () => rows("bulk_jobs")[0];
    beforeEach(() => {
      clock = 1_000_000;
      rows("prospect_source_credentials").push({ id: 1, workspaceId: WS, sourceSlug: "clugtm", status: "valid", credentialsEnc: encryptSecret(JSON.stringify({ apiKey: "clugtm-key-123456789012" })), config: {} });
      rows("bulk_jobs").push({ id: 1, workspaceId: WS, userId: null, kind: CLUGTM_ENRICH_JOB, status: "running", total: 0, done: 0, failed: 0, resumeFrom: 0, payload: { items: [] } });
    });

    it("makes one lead list, asks for partial enrichment only, polls later, and lands the address", async () => {
      queueRow(11); queueRow(12, { linkedinUrl: null });
      const statuses: Record<string, unknown> = {};
      const { calls, fetchImpl } = stub((c) => {
        if (c.url.endsWith("/lead-lists")) return { json: { id: "list-9" } };
        if (c.url.endsWith("/enrichment/person")) return { json: { workflow_id: `wf-${calls.filter((x) => x.url.endsWith("/enrichment/person")).length}`, credits_reserved: 1 } };
        const wf = c.url.split("/").pop()!;
        return { json: statuses[wf] ?? { status: "pending" } };
      });
      __setClugtmJobDepsForTests({ fetchImpl, sleep: async (ms) => { clock += ms; }, now: () => clock });

      let r = await stepClugtmEnrichment(job(), job().payload, 20_000);
      const submits = calls.filter((c) => c.url.endsWith("/enrichment/person"));
      expect(calls.filter((c) => c.url.endsWith("/lead-lists"))).toHaveLength(1);
      expect(submits.map((c) => c.body)).toEqual([
        { lead_list_id: "list-9", enrichment_type: "partial", linkedin_url: "https://www.linkedin.com/in/pat-11" },
        { lead_list_id: "list-9", enrichment_type: "partial", first_name: "Pat", last_name: "Lee12", domain: "acme.example" },
      ]);
      expect(r.finished).toBe(false);
      // Saved as it went: a restart does not submit them again.
      expect(job().payload.items.map((i: any) => [i.queueId, i.workflowId, i.state])).toEqual([[11, "wf-1", "pending"], [12, "wf-2", "pending"]]);

      statuses["wf-1"] = { status: "completed", result: { full_name: "Pat Lee11", email: "pat.lee11@acme.example", email_status: "valid" } };
      statuses["wf-2"] = { status: "completed", result: { full_name: "Pat Lee12", email: null } };
      clock += CLUGTM_POLL_EVERY_MS;
      r = await stepClugtmEnrichment(job(), job().payload, 20_000);
      expect(r).toMatchObject({ finished: true, done: 1 });
      expect(rows("prospect_queue").find((x) => x.id === 11).email).toBe("pat.lee11@acme.example");
      expect(rows("prospect_queue").find((x) => x.id === 12).email).toBeNull();
      expect(calls.filter((c) => c.url.endsWith("/lead-lists"))).toHaveLength(1);
      expect(calls.every((c) => !c.body || !["full", "phone_only"].includes(c.body.enrichment_type))).toBe(true);
    });

    it("puts every address through Reoon first: an invalid one never lands", async () => {
      queueRow(21);
      h.reoon = { key: "reoon-key", status: "invalid" };
      const { fetchImpl } = stub((c) => c.url.endsWith("/lead-lists") ? { json: { id: "l" } }
        : c.url.endsWith("/enrichment/person") ? { json: { workflow_id: "wf-a" } }
        : { json: { status: "completed", result: { email: "bad@acme.example", email_status: "valid" } } });
      __setClugtmJobDepsForTests({ fetchImpl, sleep: async (ms) => { clock += ms; }, now: () => clock });
      await stepClugtmEnrichment(job(), job().payload, 20_000);
      clock += CLUGTM_POLL_EVERY_MS;
      await stepClugtmEnrichment(job(), job().payload, 20_000);
      expect(rows("prospect_queue").find((x) => x.id === 21).email).toBeNull();
      h.reoon.status = "safe";
    });

    it("someone with neither a LinkedIn URL nor a name and company is not sent", async () => {
      queueRow(31, { linkedinUrl: null, companyName: null, companyDomain: null });
      const { calls, fetchImpl } = stub(() => ({ json: { id: "l" } }));
      __setClugtmJobDepsForTests({ fetchImpl, sleep: noSleep, now: () => clock });
      const r = await stepClugtmEnrichment(job(), job().payload, 20_000);
      expect(calls.filter((c) => c.url.endsWith("/enrichment/person"))).toHaveLength(0);
      expect(r.failures).toHaveLength(1);
      expect(r.finished).toBe(true);
    });
  });
});

describe("A-Leads", () => {
  it("maps the search filters onto advanced-search", () => {
    expect(buildAdvancedSearchBody(criteria({ jobTitles: ["VP Sales"], seniorities: ["vp"], countries: ["United States"], cities: ["Austin"], companyDomains: ["bolt.example"], technologies: ["Salesforce"] }), 2)).toEqual({
      advanced_filters: {
        job_title: ["VP Sales"], job_title_match_mode: "smart", member_management_level: ["vp"],
        member_location_raw_address: ["Austin", "United States"], technologies_used: ["Salesforce"], bulk_domains: ["bolt.example"],
      },
      current_page: 2, search_type: "total",
    });
  });

  it("searches with x-api-key and finds each address by name, website and document_id; no website, no lookup", async () => {
    const { calls, fetchImpl } = stub((c) => c.url.endsWith("/advanced-search")
      ? { json: advancedPage(["1", "2"]) }
      : { json: { data: { response: { email: "sam.ray1@bolt.example", quality: "good", result: "ok", catch_all_status: "not_catch_all" } } } });
    const s = createAleadsSource({ fetchImpl, sleep: noSleep });
    const page = await s.search(criteria({ jobTitles: ["VP Sales"] }), creds("aleads"), 2, { cursor: null });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(calls[0].url).toBe(`${ALEADS_API}/advanced-search`);
    expect(calls[0].headers["x-api-key"]).toBe("aleads-key-123456789012");
    expect(page.records.map((r) => [r.externalId, r.email, r.emailIsMasked, r.companyDomain])).toEqual([["aleads:doc-1", null, true, "bolt.example"], ["aleads:doc-2", null, true, null]]);
    const acq = await s.acquire(page.records.map((r) => r.externalId), creds("aleads"), {});
    expect(acq.ok).toBe(true);
    if (!acq.ok) return;
    const finds = calls.filter((c) => c.url.endsWith("/find-email"));
    expect(finds.map((c) => c.body)).toEqual([{ data: { first_name: "Sam", last_name: "Ray1", website: "https://bolt.example", document_id: "doc-1" } }]);
    expect(acq.records.map((r) => [r.externalId, r.email, r.emailVerifiedAt])).toEqual([["aleads:doc-1", "sam.ray1@bolt.example", null]]);
    expect(acq.failedExternalIds).toEqual(["aleads:doc-2"]);
    expect(acq.unitsSpent).toBe(1);
  });

  it("a miss costs nothing", async () => {
    const { fetchImpl } = stub((c) => c.url.endsWith("/advanced-search") ? { json: advancedPage(["1"], 1) } : { json: { data: { response: { email: null, result: "not_found" } } } });
    const s = createAleadsSource({ fetchImpl, sleep: noSleep });
    const page = await s.search(criteria({ jobTitles: ["VP Sales"] }), creds("aleads"), 1, { cursor: null });
    const acq = page.ok ? await s.acquire(page.records.map((r) => r.externalId), creds("aleads"), {}) : null;
    expect(acq).toMatchObject({ ok: true, unitsSpent: 0, records: [] });
  });

  it("stops at the day's 6,000 calls, and the circuit breaker rests the source", async () => {
    // The breaker lives on the workspace's credential row (its own key).
    rows("prospect_source_credentials").push({ id: 7, workspaceId: WS, sourceSlug: "aleads", status: "valid", credentialsEnc: encryptSecret(JSON.stringify({ apiKey: "aleads-key-123456789012" })), config: {}, consecutiveFailures: 0, circuitOpenUntil: null });
    for (let i = 0; i < ALEADS_DAILY_CALLS; i++) expect(takeAleadsCall("aleads-key-123456789012")).toBe(true);
    expect(takeAleadsCall("aleads-key-123456789012")).toBe(false);
    const { calls, fetchImpl } = stub(() => ({ json: advancedPage(["1"]) }));
    const s = createAleadsSource({ fetchImpl, sleep: noSleep });
    const r = await s.search(criteria({ jobTitles: ["VP Sales"] }), creds("aleads"), 5, { cursor: null });
    expect(r).toMatchObject({ ok: false, reason: "rate_limited" });
    expect((r as any).held).toBeUndefined();
    expect(calls).toHaveLength(0);
    // Pool-origin credentials hold no ledger units (the fake runs no ledger SQL), so the run reaches the source.
    const eligible = { source: s, credentials: creds("aleads", { origin: "pool" }), capabilities: s.capabilities(), match: { verdict: "full", missing: [] } as any, leadsRemaining: null };
    for (let i = 0; i < 3; i++) await runWaterfall({ workspaceId: WS, criteria: criteria({ jobTitles: ["VP Sales"] }), target: 5, sources: [eligible as any], deduper: new Deduper(), mode: "acquire" });
    expect((await circuitState(WS, "aleads" as never, "table")).open).toBe(true);
  });
});

describe("both join the registry, the pool and the names", () => {
  it("are prospect databases with adapters", () => {
    expect(PROSPECT_DATABASE_SLUGS).toEqual(expect.arrayContaining(["aleads", "clugtm"]));
    expect(getSource("aleads").displayName).toBe("A-Leads");
    expect(getSource("clugtm").displayName).toBe("CluGTM");
  });

  it("take their seeded place: LeadOcean, A-Leads, CluGTM, QuickEnrich, WarmySender, Apollo", async () => {
    const cfg = await poolConfig();
    expect(Object.values(cfg.sources).sort((a, b) => a.number - b.number).map((s) => s.slug)).toEqual(["leadocean", "aleads", "clugtm", "quickenrich", "warmysender", "apollo"]);
  });

  it("can be stored on a queue row and a scrape job: both enums, in the schema and in the migrations", () => {
    for (const col of [(prospectQueue as any).sourceType, (areScrapeJobs as any).sourceType]) {
      for (const slug of PROSPECT_DATABASE_SLUGS) expect(col.enumValues, slug).toContain(slug);
    }
    const sqlText = readFileSync(resolve(__dirname, "_core/rawMigrations.ts"), "utf8");
    for (const table of ["are_scrape_jobs", "prospect_queue"]) {
      const last = sqlText.split("\n").filter((l: string) => l.includes(`ALTER TABLE \`${table}\` MODIFY COLUMN \`sourceType\``)).pop() ?? "";
      for (const slug of PROSPECT_DATABASE_SLUGS) expect(last, `${table} ${slug}`).toContain(`'${slug}'`);
    }
  });

  it("their names never reach members", () => {
    const vendors = [{ slug: "aleads", displayName: "A-Leads", label: "Source 2" }, { slug: "clugtm", displayName: "CluGTM", label: "Source 3" }];
    expect(anonymizeVendorText("A-Leads search failed; aleads said 429. CluGTM (Cleanlist) refused; clugtm's key", vendors))
      .toBe("Source 2 search failed; Source 2 said 429. Source 3 (Source 3) refused; Source 3's key");
  });
});
