/**
 * Prospect-source registry (migration 0179) — capability matching, the
 * WarmySender adapter's pure parts, the vendor HTTP layer, the waterfall
 * executor (executed against fake sources with the ledger/circuit mocked),
 * and the structural wiring every consumer depends on.
 *
 * The executor tests are the load-bearing ones: "stops at target", "never
 * acquires a duplicate", "one failing source degrades, never fails", and
 * "commits what the vendor actually charged" are the product rules the
 * whole subsystem exists for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FILTER_TYPES, activeFilters, emptyCriteria, filterUnion, matchCapabilities, rankSourcesForQuery,
  type SearchCriteria, type SourceCapabilities,
} from "../shared/prospectSources";
import { ARE_SOURCE_IDS } from "../shared/areSources";
import {
  buildSearchLeadsArgs, extractCursor, extractLeadRows, looksMasked, mapLeadRow, monthlyPeriodKeyForAnniversary,
  paramNameFor, parseMcpBody, unwrapToolResult, warmySenderBudgetPeriods, warmySenderCapabilities,
} from "./services/prospectSources/adapters/warmysender";
import { backoffMs, classifyHttpFailure, isRetryable, setVendorCallLogger, vendorFetch } from "./services/prospectSources/vendorHttp";
import { criteriaFromTargeting, recordToQueueRow } from "./services/prospectSources/bridge";
import { Deduper, dedupeKeysFor } from "./services/prospectSources/dedupe";
import type { ProspectRecord, ProspectSource, SourceCredentials } from "./services/prospectSources/types";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/* ─── ledger / circuit / credentials are mocked for the executor ─────────── */
const h = vi.hoisted(() => ({
  reserved: [] as Array<{ slug: string; units: number }>,
  committed: [] as Array<{ units: number; actual: number }>,
  released: 0,
  exhausted: 0,
  failures: [] as string[],
  successes: [] as string[],
  validations: [] as string[],
  refuse: false,
}));
vi.mock("./services/prospectSources/ledger", () => ({
  reserve: async (_ws: number, slug: string, _b: string, units: number) => {
    if (h.refuse) return null;
    h.reserved.push({ slug, units });
    return { slug, bucket: "leads", units, rowIds: [1, 2], fundedBy: "plan" };
  },
  remainingUnits: async () => ({ plan: h.refuse ? 0 : 100, credits: 0, total: h.refuse ? 0 : 100 }),
  commit: async (_ws: number, r: { units: number }, actual: number) => { h.committed.push({ units: r.units, actual }); },
  release: async () => { h.released += 1; },
  markExhausted: async () => { h.exhausted += 1; },
}));
vi.mock("./services/prospectSources/circuit", () => ({
  recordFailure: async (_ws: number, slug: string) => { h.failures.push(slug); return { open: false, failures: 1, openUntil: null }; },
  recordSuccess: async (_ws: number, slug: string) => { h.successes.push(slug); },
}));
vi.mock("./services/prospectSources/credentials", () => ({
  recordValidation: async (_ws: number, slug: string) => { h.validations.push(slug); },
}));

import { mergeAcquired, runWaterfall } from "./services/prospectSources/executor";
import type { EligibleSource } from "./services/prospectSources/registry";

const creds = (slug: SourceCredentials["slug"]): SourceCredentials => ({ slug, workspaceId: 1, secrets: { apiKey: "ws_x" }, config: {} });

function rec(id: string, over: Partial<ProspectRecord> = {}): ProspectRecord {
  return {
    externalId: id, firstName: `F${id}`, lastName: `L${id}`, jobTitle: "CFO", seniority: null,
    companyName: `Co ${id}`, companyDomain: `co${id}.com`, email: null, emailIsMasked: true, emailVerifiedAt: null,
    mobilePhone: null, businessPhone: null, linkedinUrl: `https://linkedin.com/in/${id}`, city: null, stateProvince: null,
    country: "US", industry: null, headcount: null, rawSourcePayload: {}, ...over,
  };
}

const FREE_CAPS: SourceCapabilities = {
  supportedFilters: ["jobTitle", "country"], approximatedFilters: ["keyword"], supportsFreePreview: true,
  returnsMaskedPreview: true, supportsMobilePhone: false, supportsVerification: false, maxBatchSize: 100, geographicCoverage: ["US", "CA"],
};

function fakeSource(slug: "warmysender" | "quickenrich" | "apollo", opts: {
  acquisition: "on_demand" | "none";
  search: ProspectSource["search"];
  acquire?: ProspectSource["acquire"];
  periods?: boolean;
  calls: string[];
}): ProspectSource {
  return {
    slug, displayName: slug, docsUrl: "", credentialMode: "table", acquisition: opts.acquisition,
    capabilities: () => FREE_CAPS,
    budgetPeriods: () => opts.periods === false ? [] : [{ bucket: "leads", granularity: "daily", periodKey: "d", unitsLimit: 50, resetsAt: null }],
    validateCredentials: async () => ({ ok: true, message: "ok" }),
    search: async (c, cr, limit, ctx) => { opts.calls.push(`${slug}.search(${limit})`); return opts.search(c, cr, limit, ctx); },
    acquire: async (ids, cr, ctx) => { opts.calls.push(`${slug}.acquire(${ids.length})`); return opts.acquire ? opts.acquire(ids, cr, ctx) : { ok: true, records: [], unitsSpent: 0, failedExternalIds: ids }; },
    remainingBudget: async () => [],
  };
}

function eligible(s: ProspectSource): EligibleSource {
  return { source: s, credentials: creds(s.slug), capabilities: s.capabilities(), match: { verdict: "full", approximated: [], missing: [] }, leadsRemaining: null };
}

const CRIT: SearchCriteria = { ...emptyCriteria(), jobTitles: ["CFO"], countries: ["US"] };

beforeEach(() => {
  h.reserved = []; h.committed = []; h.released = 0; h.exhausted = 0; h.failures = []; h.successes = []; h.validations = []; h.refuse = false;
  setVendorCallLogger(() => {});
});

/* ─── shared: capability matching ─────────────────────────────────────── */
describe("capability matching", () => {
  it("full / approximate / cannot, and an empty query is never an audience", () => {
    expect(matchCapabilities(FREE_CAPS, CRIT).verdict).toBe("full");
    expect(matchCapabilities(FREE_CAPS, { ...CRIT, keywords: ["grants"] })).toEqual({ verdict: "approximate", approximated: ["keyword"], missing: [] });
    expect(matchCapabilities(FREE_CAPS, { ...CRIT, industries: ["Nonprofit"] }).verdict).toBe("cannot");
    expect(matchCapabilities(FREE_CAPS, emptyCriteria()).verdict).toBe("cannot");
  });
  it("declared geographic coverage refuses a country outside it (codes only; names are the adapter's job)", () => {
    expect(matchCapabilities(FREE_CAPS, { ...CRIT, countries: ["DE"] })).toMatchObject({ verdict: "cannot", missing: ["country"] });
    expect(matchCapabilities(FREE_CAPS, { ...CRIT, countries: ["Germany"] }).verdict).toBe("full");
  });
  it("filterUnion is the UI's panel; rank prefers free preview, then native support of the lead filter", () => {
    const paid: SourceCapabilities = { ...FREE_CAPS, supportsFreePreview: false, supportedFilters: ["jobTitle", "country", "industry"] };
    const approx: SourceCapabilities = { ...FREE_CAPS, supportedFilters: ["country"], approximatedFilters: ["jobTitle"] };
    expect(filterUnion([FREE_CAPS, paid])).toEqual(["jobTitle", "industry", "country", "keyword"]);
    const ranked = rankSourcesForQuery([
      { slug: "paid", capabilities: paid }, { slug: "approx", capabilities: approx }, { slug: "free", capabilities: FREE_CAPS },
    ], CRIT).map((s) => s.slug);
    expect(ranked).toEqual(["free", "approx", "paid"]);
  });
  it("activeFilters covers every FilterType the panel can set", () => {
    const all: SearchCriteria = {
      jobTitles: ["a"], seniorities: ["a"], departments: ["a"], industries: ["a"], countries: ["US"], stateProvinces: ["a"],
      cities: ["a"], postalCodes: ["a"], companyNames: ["a"], companyDomains: ["a"], headcountRange: { min: 1 }, revenueRange: { max: 1 },
      keywords: ["a"], hasEmail: true, hasPhone: false, technologies: ["a"],
    };
    expect(activeFilters(all).slice().sort()).toEqual(FILTER_TYPES.slice().sort());
  });
});

/* ─── WarmySender adapter, pure parts ─────────────────────────────────── */
describe("WarmySender adapter", () => {
  it("parses JSON and SSE bodies from the MCP endpoint", () => {
    expect(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{"ok":1}}', "application/json")).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: 1 } });
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n';
    expect(parseMcpBody(sse, "text/event-stream")).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
  });
  it("unwraps structuredContent, else the first text block as JSON", () => {
    expect(unwrapToolResult({ structuredContent: { leads: [1] }, content: [] })).toEqual({ leads: [1] });
    expect(unwrapToolResult({ content: [{ type: "text", text: '{"leads":[{"id":"a"}]}' }] })).toEqual({ leads: [{ id: "a" }] });
    expect((unwrapToolResult({ isError: true, content: [{ type: "text", text: "nope" }] }) as Record<string, unknown>).__error).toBe(true);
  });
  it("a masked address is NEVER stored as an email — and the record still carries identity keys", () => {
    expect(looksMasked("j***@acme.com")).toBe(true);
    expect(looksMasked("jane@acme.com")).toBe(false);
    const [r] = mapLeadRow({ id: "L1", first_name: "Jane", last_name: "Doe", email: "j***@acme.com", company: "Acme", website: "https://www.acme.com/", linkedin: "https://linkedin.com/in/jane", phone: "555" });
    expect(r.email).toBeNull();
    expect(r.emailIsMasked).toBe(true);
    expect(r.companyDomain).toBe("acme.com");
    expect(r.businessPhone).toBe("555");
    expect(r.mobilePhone).toBeNull();
    // LinkedIn slug + canonical name@org (canonicalText strips punctuation) — the
    // keys that stop paying twice for a person another vendor already found.
    expect(dedupeKeysFor(r)).toEqual(expect.arrayContaining(["u:jane", "n:jane doe@acme com"]));
    expect(dedupeKeysFor(r).some((k) => k.startsWith("e:"))).toBe(false);
    // The queue row shape keeps the same rule.
    expect(recordToQueueRow(r).email).toBeNull();
  });
  it("splits a business row with up to five contacts into one record each", () => {
    const rows = mapLeadRow({ id: "B1", business_name: "Acme", website: "acme.com", contacts: [
      { contact_name: "Jane Doe", job_title: "CFO", email: "jane@acme.com" },
      { contact_name: "John Roe", job_title: "CEO", email: "j***@acme.com" },
    ] });
    expect(rows.map((r) => [r.firstName, r.lastName, r.jobTitle, r.email, r.emailIsMasked])).toEqual([
      ["Jane", "Doe", "CFO", "jane@acme.com", false],
      ["John", "Roe", "CEO", null, true],
    ]);
    expect(rows.map((r) => r.externalId)).toEqual(["B1#0", "B1#1"]);
    expect(extractLeadRows({ data: { leads: [{ id: 1 }] } })).toEqual([{ id: 1 }]);
    expect(extractCursor({ pagination: { has_more: true, page: 2 } })).toBe("3");
  });
  it("argument builder: documented names without a schema; the captured schema wins; unsupported filters fold into keyword", () => {
    const noSchema = buildSearchLeadsArgs({ ...CRIT, keywords: ["grants"] }, null, 30, null);
    expect(noSchema.args).toMatchObject({ job_title: "CFO", country: "US", keyword: "grants", has_email: true, limit: 30 });
    const schema = { properties: { title: { type: "array" }, country: { type: "string" }, q: { type: "string" }, page_size: { type: "integer" }, cursor: { type: "string" } } };
    const withSchema = buildSearchLeadsArgs({ ...CRIT, seniorities: ["C-level"], keywords: ["grants"] }, schema, 500, "abc");
    expect(withSchema.args).toMatchObject({ title: ["CFO"], country: "US", q: "grants C-level", page_size: 100, cursor: "abc" });
    expect(withSchema.foldedIntoKeyword).toEqual(["seniority"]);
    expect(paramNameFor(schema, "jobTitle")).toBe("title");
    expect(paramNameFor(schema, "seniority")).toBeNull();
  });
  it("job title is APPROXIMATED until a captured schema proves a native parameter", () => {
    expect(warmySenderCapabilities(null).approximatedFilters).toContain("jobTitle");
    const proven = creds("warmysender");
    proven.config = { toolSchemas: { search_leads: { properties: { job_title: { type: "string" }, seniority: {}, department: {}, industry: {}, postcode: {} } } } };
    const caps = warmySenderCapabilities(proven);
    expect(caps.supportedFilters).toContain("jobTitle");
    expect(caps.approximatedFilters).not.toContain("jobTitle");
    const noSeniority = creds("warmysender");
    noSeniority.config = { toolSchemas: { search_leads: { properties: { keyword: {}, country: {} } } } };
    expect(warmySenderCapabilities(noSeniority).approximatedFilters).toEqual(expect.arrayContaining(["seniority", "department", "industry", "postalCode"]));
  });
  it("monthly period keys follow the billing anniversary across the boundary", () => {
    expect(monthlyPeriodKeyForAnniversary(new Date("2026-09-14T00:00:00Z"), 20).key).toBe("2026-08");
    expect(monthlyPeriodKeyForAnniversary(new Date("2026-09-20T00:00:00Z"), 20).key).toBe("2026-09");
    expect(monthlyPeriodKeyForAnniversary(new Date("2026-09-20T00:00:00Z"), 20).resetsAt.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(monthlyPeriodKeyForAnniversary(new Date("2026-01-05T00:00:00Z"), 10).key).toBe("2025-12");
    expect(monthlyPeriodKeyForAnniversary(new Date("2026-09-14T00:00:00Z"), undefined).key).toBe("2026-09");
  });
  it("budget periods: daily pace = ceil(monthly/30), monthly on the anniversary, credits row only with a balance, verification separate", () => {
    const c = creds("warmysender");
    c.config = { tier: "pro", billingAnniversaryDay: 3 };
    const now = new Date("2026-09-14T12:00:00Z");
    const p = warmySenderBudgetPeriods({ now, credentials: c });
    const leads = p.filter((x) => x.bucket === "leads");
    expect(leads.map((x) => [x.granularity, x.periodKey, x.unitsLimit])).toEqual([["daily", "2026-09-14", 67], ["monthly", "2026-09", 2000]]);
    expect(p.filter((x) => x.bucket === "verification").map((x) => x.unitsLimit)).toEqual([20, 600]);
    c.config = { tier: "pro", leadCreditBalance: 5000, monthlyLeadAllowance: 3000 };
    const p2 = warmySenderBudgetPeriods({ now, credentials: c }).filter((x) => x.bucket === "leads");
    expect(p2.map((x) => [x.granularity, x.unitsLimit])).toEqual([["daily", 100], ["monthly", 3000], ["credits", 5000]]);
  });
});

/* ─── vendor HTTP ─────────────────────────────────────────────────────── */
describe("vendorHttp", () => {
  it("classifies vendor codes into one vocabulary", () => {
    expect(classifyHttpFailure(401)).toBe("unauthorized");
    expect(classifyHttpFailure(403, "insufficient_scope")).toBe("insufficient_scope");
    expect(classifyHttpFailure(429, "rate_limited")).toBe("rate_limited");
    expect(classifyHttpFailure(429, "allowance_exhausted")).toBe("budget_exhausted");
    expect(classifyHttpFailure(402, "verifier_access_required")).toBe("plan_required");
    expect(classifyHttpFailure(503)).toBe("unavailable");
    expect(classifyHttpFailure(422, "validation_error")).toBe("invalid_params");
    expect(isRetryable("rate_limited")).toBe(true);
    expect(isRetryable("unauthorized")).toBe(false);
    expect(backoffMs(0)).toBeGreaterThan(200);
    expect(backoffMs(5)).toBeLessThanOrEqual(8000 * 1.25);
  });
  it("retries a 429 honouring Retry-After, never retries a 401, and the log line never carries the key", async () => {
    const seen: string[] = [];
    setVendorCallLogger((e) => seen.push(JSON.stringify(e)));
    let n = 0;
    const waits: number[] = [];
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) return new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }), { status: 429, headers: { "retry-after": "2", "content-type": "application/json" } });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await vendorFetch<{ data: { ok: boolean } }>("https://example.test/x", {
      workspaceId: 1, source: "t", endpoint: "x", headers: { Authorization: "Bearer ws_SECRET" }, fetchImpl, sleep: async (ms) => { waits.push(ms); },
    });
    expect(r.ok).toBe(true);
    expect(n).toBe(2);
    expect(waits).toEqual([2000]);
    expect(seen.join("\n")).not.toContain("ws_SECRET");
    n = 0;
    const bad = (async () => { n += 1; return new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), { status: 401 }); }) as unknown as typeof fetch;
    const r2 = await vendorFetch("https://example.test/y", { workspaceId: 1, source: "t", endpoint: "y", fetchImpl: bad, sleep: async () => {} });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe("unauthorized");
    expect(n).toBe(1);
  });
});

/* ─── the waterfall ───────────────────────────────────────────────────── */
describe("runWaterfall", () => {
  it("stops at the target: the second source is never called once the first fills the batch", async () => {
    const calls: string[] = [];
    const a = fakeSource("warmysender", {
      acquisition: "on_demand", calls,
      search: async (_c, _cr, limit) => ({ ok: true, records: Array.from({ length: Math.min(limit, 5) }, (_, i) => rec(`a${i}`)), nextCursor: null, totalAvailable: 5, alreadyCharged: false, unitsSpent: 0 }),
      acquire: async (ids) => ({ ok: true, records: ids.map((id) => rec(id, { email: `${id}@x.com`, emailIsMasked: false })), unitsSpent: ids.length, failedExternalIds: [] }),
    });
    const b = fakeSource("quickenrich", { acquisition: "none", calls, periods: false, search: async () => ({ ok: true, records: [rec("b0")], nextCursor: null, totalAvailable: 1, alreadyCharged: false, unitsSpent: 0 }) });
    const r = await runWaterfall({ workspaceId: 1, criteria: CRIT, target: 3, sources: [eligible(a), eligible(b)], deduper: new Deduper(), mode: "acquire" });
    expect(calls).toEqual(["warmysender.search(4)", "warmysender.acquire(3)"]); // 3 × 1.3 overfetch = 4; acquire only what fits
    expect(r.collected.length).toBe(3);
    expect(r.reachedTarget).toBe(true);
    expect(r.collected.every((c) => c.wasCharged && c.record.email && !c.record.emailIsMasked)).toBe(true);
    expect(h.reserved).toEqual([{ slug: "warmysender", units: 3 }]);
    expect(h.committed).toEqual([{ units: 3, actual: 3 }]);
    expect(h.successes).toEqual(["warmysender"]);
  });
  it("never acquires a record dedupe says the workspace already holds, and continues to the next source for the rest", async () => {
    const calls: string[] = [];
    const known = new Deduper(dedupeKeysFor(rec("a0")));
    const a = fakeSource("warmysender", {
      acquisition: "on_demand", calls,
      search: async () => ({ ok: true, records: [rec("a0"), rec("a1")], nextCursor: null, totalAvailable: 2, alreadyCharged: false, unitsSpent: 0 }),
      acquire: async (ids) => ({ ok: true, records: ids.map((id) => rec(id, { email: `${id}@x.com`, emailIsMasked: false })), unitsSpent: ids.length, failedExternalIds: [] }),
    });
    const b = fakeSource("apollo", { acquisition: "none", calls, periods: false, search: async () => ({ ok: true, records: [rec("a1"), rec("b0")], nextCursor: null, totalAvailable: 2, alreadyCharged: false, unitsSpent: 0 }) });
    const r = await runWaterfall({ workspaceId: 1, criteria: CRIT, target: 2, sources: [eligible(a), eligible(b)], deduper: known, mode: "acquire" });
    expect(calls).toEqual(["warmysender.search(3)", "warmysender.acquire(1)", "apollo.search(2)"]);
    expect(r.collected.map((c) => [c.slug, c.record.externalId])).toEqual([["warmysender", "a1"], ["apollo", "b0"]]);
    expect(r.duplicates.map((d) => d.record.externalId)).toEqual(["a0", "a1"]);
    // The hold was for the 2 open slots; the vendor was charged for the 1 net-new
    // record actually acquired — commit records the actual, never the hold.
    expect(h.committed).toEqual([{ units: 2, actual: 1 }]);
  });
  it("one failing source degrades the run: its hold is released, the breaker is told, the next source runs", async () => {
    const calls: string[] = [];
    const a = fakeSource("warmysender", { acquisition: "on_demand", calls, search: async () => ({ ok: false, reason: "unavailable", message: "503" }) });
    const b = fakeSource("quickenrich", { acquisition: "none", calls, periods: false, search: async () => ({ ok: true, records: [rec("b0")], nextCursor: null, totalAvailable: 1, alreadyCharged: false, unitsSpent: 0 }) });
    const r = await runWaterfall({ workspaceId: 1, criteria: CRIT, target: 1, sources: [eligible(a), eligible(b)], deduper: new Deduper(), mode: "acquire" });
    expect(r.perSource[0]).toMatchObject({ slug: "warmysender", errorReason: "unavailable" });
    expect(h.released).toBe(1);
    expect(h.failures).toEqual(["warmysender"]);
    expect(r.collected.map((c) => c.slug)).toEqual(["quickenrich"]);
  });
  it("terminal failures are recorded on the credential, not the breaker; a vendor allowance refusal closes the ledger row", async () => {
    const calls: string[] = [];
    const a = fakeSource("warmysender", { acquisition: "on_demand", calls, search: async () => ({ ok: false, reason: "insufficient_scope", message: "leads:read missing" }) });
    await runWaterfall({ workspaceId: 1, criteria: CRIT, target: 1, sources: [eligible(a)], deduper: new Deduper(), mode: "acquire" });
    expect(h.validations).toEqual(["warmysender"]);
    expect(h.failures).toEqual([]);
    const b = fakeSource("warmysender", {
      acquisition: "on_demand", calls,
      search: async () => ({ ok: true, records: [rec("x")], nextCursor: null, totalAvailable: 1, alreadyCharged: false, unitsSpent: 0 }),
      acquire: async () => ({ ok: false, reason: "budget_exhausted", message: "allowance used" }),
    });
    const r = await runWaterfall({ workspaceId: 1, criteria: CRIT, target: 1, sources: [eligible(b)], deduper: new Deduper(), mode: "acquire" });
    expect(h.exhausted).toBe(1);
    expect(r.collected).toEqual([]); // an unacquired masked preview is not a prospect
  });
  it("preview mode spends nothing: no hold, no acquire, masked records staged as-is", async () => {
    const calls: string[] = [];
    const a = fakeSource("warmysender", { acquisition: "on_demand", calls, search: async () => ({ ok: true, records: [rec("a0")], nextCursor: "2", totalAvailable: 9, alreadyCharged: false, unitsSpent: 0 }) });
    const r = await runWaterfall({ workspaceId: 1, criteria: CRIT, target: 1, sources: [eligible(a)], deduper: new Deduper(), mode: "preview" });
    expect(calls).toEqual(["warmysender.search(2)"]); // 1 × 1.3 overfetch, rounded up — free, so it costs nothing
    expect(h.reserved).toEqual([]);
    expect(r.collected[0]).toMatchObject({ wasCharged: false, netNew: true });
    expect(r.collected[0].record.emailIsMasked).toBe(true);
    expect(r.perSource[0].nextCursor).toBe("2");
  });
  it("skips a source whose allowance is exhausted before calling it", async () => {
    h.refuse = true;
    const calls: string[] = [];
    const a = fakeSource("warmysender", { acquisition: "on_demand", calls, search: async () => ({ ok: true, records: [rec("a0")], nextCursor: null, totalAvailable: 1, alreadyCharged: false, unitsSpent: 0 }) });
    const r = await runWaterfall({ workspaceId: 1, criteria: CRIT, target: 1, sources: [eligible(a)], deduper: new Deduper(), mode: "acquire" });
    expect(calls).toEqual([]);
    expect(r.perSource[0].errorReason).toBe("budget_exhausted");
  });
  it("mergeAcquired: acquired detail fills, preview fills the rest, a still-masked acquisition keeps email null", () => {
    const m = mergeAcquired(rec("p", { city: "Austin" }), rec("p", { email: "p@x.com", emailIsMasked: false, city: null, businessPhone: "1" }));
    expect(m).toMatchObject({ email: "p@x.com", emailIsMasked: false, city: "Austin", businessPhone: "1" });
    expect(mergeAcquired(rec("q"), rec("q", { email: "q***@x.com", emailIsMasked: true })).email).toBeNull();
  });
});

/* ─── bridge ──────────────────────────────────────────────────────────── */
describe("criteriaFromTargeting", () => {
  it("maps geos to ISO countries, states, or cities — never guesses a country", () => {
    const c = criteriaFromTargeting({ titles: ["CFO"], geos: ["United States", "Texas", "Austin", "gb"] });
    expect(c.countries).toEqual(["US", "GB"]);
    expect(c.stateProvinces).toEqual(["Texas"]);
    expect(c.cities).toEqual(["Austin"]);
    expect(c.jobTitles).toEqual(["CFO"]);
  });
});

/* ─── structural wiring ───────────────────────────────────────────────── */
describe("wiring — every consumer the registry depends on", () => {
  it("migration 0179 creates the four tables and widens BOTH sourceType enums; schema agrees", () => {
    const m = read("server/_core/rawMigrations.ts");
    const at = m.indexOf("0179_prospect_source_registry.sql");
    expect(at).toBeGreaterThan(-1);
    const block = m.slice(at, at + 6000);
    for (const t of ["prospect_source_credentials", "prospect_source_budget_ledger", "prospect_search_runs", "prospect_search_results"]) {
      expect(block).toContain(`CREATE TABLE IF NOT EXISTS \`${t}\``);
    }
    expect(block).toMatch(/ALTER TABLE `are_scrape_jobs` MODIFY COLUMN `sourceType` enum\('[^)]*'warmysender'\) NOT NULL/);
    expect(block).toMatch(/ALTER TABLE `prospect_queue` MODIFY COLUMN `sourceType` enum\('[^)]*'warmysender'\) NOT NULL/);
    const schema = read("drizzle/schema.ts");
    expect((schema.match(/"warmysender", \/\/ migration 0179/g) ?? []).length).toBe(2);
    for (const t of ["prospectSourceCredentials", "prospectSourceBudgetLedger", "prospectSearchRuns", "prospectSearchResults"]) {
      expect(schema).toContain(`export const ${t} = mysqlTable(`);
    }
  });
  it("warmysender is an ARE source with an engine branch, a queue mapping and the default order slot after quickenrich", () => {
    expect(ARE_SOURCE_IDS).toContain("warmysender");
    const engine = read("server/areEngine.ts");
    expect(engine).toContain('warmysender: (remaining) =>');
    expect(engine).toContain('discoverViaRegistrySource(campaign, "warmysender"');
    const scraper = read("server/routers/are/scraper.ts");
    expect(scraper).toContain('warmysender: "warmysender"');
    expect(/QUEUE_SOURCE_TYPES = new Set\(\[[\s\S]*?"warmysender",[\s\S]*?\]\)/.test(scraper)).toBe(true);
    const order = read("shared/areSources.ts");
    expect(order).toContain('"quickenrich",\n  "warmysender",');
  });
  it("router registered; both settings surfaces mount the card; the search tab, registry row and hover help exist", () => {
    expect(read("server/routers.ts")).toContain("prospectSources: prospectSourcesRouter");
    for (const rel of ["client/src/pages/usip/SettingsHub.tsx", "client/src/pages/usip/ARESettings.tsx"]) {
      expect(read(rel)).toContain("WarmySenderSourceCard");
    }
    expect(read("client/src/pages/usip/SettingsHub.tsx")).toContain("ProspectSourceRegistryCard");
    expect(read("client/src/pages/usip/dataEnrichmentTabs.ts")).toContain('"Source search"');
    expect(read("client/src/pages/usip/DataEnrichment.tsx")).toContain('tab === "Source search" && <SourceSearchPanel />');
    expect(read("client/src/lib/toolRegistry.ts")).toContain('"/v2/data-enrichment?tab=source-search"');
    expect(read("client/src/lib/helpText.ts")).toContain('"/v2/data-enrichment?tab=source-search"');
    expect(read("server/seedHelpContent.ts")).toContain('slug: "prospect-source-registry"');
  });
  it("the maintenance cron gates archived workspaces and the boot sweep marks interrupted runs", () => {
    const idx = read("server/_core/index.ts");
    expect(idx).toContain("runSourceMaintenance({ skipWorkspace: (ws) => archivedWs.has(ws) })");
    expect(idx).toContain("markInterruptedRuns()");
  });
  it("secrets: the credential store encrypts JSON, reads never return plaintext, no log line prints a key", () => {
    const cred = read("server/services/prospectSources/credentials.ts");
    expect(cred).toContain("encryptSecret(JSON.stringify(patch.secrets))");
    expect(cred).toContain("maskSecret(");
    expect(cred).not.toMatch(/console\.(log|error)\([^)]*secrets/);
    const router = read("server/routers/prospectSources.ts");
    expect(router).not.toContain("secrets.apiKey");
    expect(router).toContain("redactConfig(");
    const http = read("server/services/prospectSources/vendorHttp.ts");
    const logLine = http.slice(http.indexOf("export let logVendorCall"), http.indexOf("export function setVendorCallLogger"));
    expect(logLine).not.toContain("headers");
    expect(logLine).not.toContain("body");
  });
  it("the ledger reserves with a conditional UPDATE (affectedRows is the verdict) and never read-modify-writes a counter", () => {
    const ledger = read("server/services/prospectSources/ledger.ts");
    expect(ledger).toContain("SET \\`unitsReserved\\` = \\`unitsReserved\\` + ${n}");
    expect(ledger).toContain("AND (\\`unitsLimit\\` IS NULL OR \\`unitsConsumed\\` + \\`unitsReserved\\` + ${n} <= \\`unitsLimit\\`)");
    expect(ledger).toContain("affectedRows");
    expect(ledger).not.toMatch(/unitsConsumed:\s*\w+\.unitsConsumed\s*\+/);
  });
});
