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
  MAX_TITLE_SEARCHES, buildSearchLeadsArgs, createWarmySenderSource, extractCursor, extractLeadRows, fitJoin, looksMasked, mapLeadRow,
  monthlyPeriodKeyForAnniversary, paramNameFor, parseMcpBody, parseTitleCursor, planSearchLeadsCalls, unwrapToolResult,
  warmySenderBudgetPeriods, warmySenderCapabilities,
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
    expect(noSchema.args).toMatchObject({ job_title: "CFO", country: "United States", keyword: "grants", has_email: true, limit: 30 });
    const schema = { properties: { title: { type: "array" }, country: { type: "string" }, q: { type: "string" }, page_size: { type: "integer" }, cursor: { type: "string" } } };
    const withSchema = buildSearchLeadsArgs({ ...CRIT, seniorities: ["C-level"], keywords: ["grants"] }, schema, 500, "abc");
    expect(withSchema.args).toMatchObject({ title: ["CFO"], country: "United States", q: "grants C-level", page_size: 50, cursor: "abc" });
    expect(withSchema.foldedIntoKeyword).toEqual(["seniority"]);
    expect(paramNameFor(schema, "jobTitle")).toBe("title");
    expect(paramNameFor(schema, "seniority")).toBeNull();
  });
  it("a text filter never exceeds its maxLength: whole values, the first ones, as many as fit", () => {
    // 2026-10-16: a county campaign's 22 titles joined into one jobTitle string (>255) failed every search.
    const states = ["Virginia", "Maryland", "North Carolina", "South Carolina", "West Virginia", "Pennsylvania", "Delaware", "Tennessee", "Kentucky", "Georgia", "New Jersey"];
    const schema = { properties: { state: { type: "string", maxLength: 120, description: "Comma-separated values are OR-combined." }, keyword: { type: "string", maxLength: 6 } } };
    const r = buildSearchLeadsArgs({ ...CRIT, stateProvinces: states, keywords: ["County of"] }, schema, 30, null);
    const st = r.args.state as string;
    expect(st.length).toBeLessThanOrEqual(120);
    expect(st.startsWith("Virginia, Maryland, North Carolina,")).toBe(true);
    expect(states.some((s) => st.endsWith(s))).toBe(true); // no state cut in half
    // One value longer than the limit is cut to it rather than dropped.
    expect(r.args.keyword).toBe("County");
    expect((buildSearchLeadsArgs({ ...CRIT, jobTitles: ["x".repeat(300)] }, null, 30, null).args.job_title as string)).toHaveLength(255);
    expect(fitJoin(["x".repeat(300)], ", ", 255)).toHaveLength(255);
    expect(fitJoin(["a", "b"], ", ", 255)).toBe("a, b");
  });

  /* The captured search_leads schema (workspace 2, validated 2026-10-18), the parameters that matter here. */
  const LIVE_SCHEMA = {
    type: "object",
    properties: {
      page: { type: "integer", default: 1, maximum: 2000, minimum: 1 },
      limit: { type: "integer", default: 25, maximum: 50, minimum: 1 },
      state: { type: "string", maxLength: 120, description: "State / region filter. US names and USPS codes are equivalent (\"Alabama\" = \"AL\"). Comma-separated values are OR-combined." },
      country: { type: "string", maxLength: 120, description: "Country filter (e.g. \"United States\"). Comma-separated values are OR-combined." },
      city: { type: "string", maxLength: 120, description: "City filter." },
      keyword: { type: "string", maxLength: 255, description: "Free-text search across name, company, job title, industry, and category." },
      industry: { type: "string", maxLength: 255, description: "Industry filter." },
      hasEmail: { type: "boolean" },
      jobTitle: { type: "string", maxLength: 255, description: "Job title filter. Each word you pass must start a word in the title: \"cto\" finds \"CTO\" and \"Co-Founder/CTO\" but not \"Director\"; \"market\" finds \"Marketing Manager\"." },
      seniority: { type: "string", maxLength: 255, description: "Seniority group. Keys: founder, c_level, vp, director, manager, senior. Comma-separated values OR together. Unknown values are rejected, never ignored." },
      department: { type: "string", maxLength: 255, description: "Department group. Comma-separated values OR together. Unknown values are rejected, never ignored." },
      postalCode: { type: "string", maxLength: 255, description: "Postcode / ZIP prefix filter. Comma-separated values are OR-combined (up to 20)." },
    },
    additionalProperties: false,
  };
  const COUNTY_TITLES = ["County Administrator", "County Manager", "Deputy County Administrator", "Assistant County Manager", "Chief Administrative Officer",
    "Director of Information Technology", "IT Director", "Chief Information Officer", "Public Information Officer", "Communications Director",
    "Communications Manager", "Digital Communications Specialist", "Web Content Manager", "ADA Coordinator", "ADA Title II Coordinator",
    "Risk Manager", "County Attorney", "Purchasing Director", "Procurement Manager", "Purchasing Agent", "Finance Director", "Budget Director"];
  const COUNTY = criteriaFromTargeting({
    titles: COUNTY_TITLES,
    industries: ["Government Administration", "Executive Offices", "Legislative Offices"],
    geos: ["Virginia", "Maryland", "North Carolina"],
    keywords: ["County of", "County Government", "Board of Supervisors", "Board of Commissioners", "County Administrator", "Public Information Officer",
      "ADA Coordinator", "IT Director", "Digital Services", "Web Content", "Purchasing"],
  });

  it("a list goes only where the schema says it ORs: states yes; one title, one keyword phrase per call", () => {
    // 2026-10-18: campaign 38's titles went out as one comma-joined jobTitle (every word of eleven titles in ONE title),
    // its eleven keywords as one ~30-word free-text query, its industries as one string: every search returned nobody.
    const { args } = buildSearchLeadsArgs(COUNTY, LIVE_SCHEMA, 50, null);
    expect(args).toEqual({
      jobTitle: "County Administrator",
      state: "Virginia, Maryland, North Carolina",
      keyword: "County of",
      hasEmail: true,
      limit: 50,
    });
    // ORing parameters keep their lists; the country goes by name, as the vendor's rows carry it.
    const more = buildSearchLeadsArgs({ ...emptyCriteria(), countries: ["US", "CA"], seniorities: ["director", "vp"], departments: ["it", "finance"], postalCodes: ["220", "221"] }, LIVE_SCHEMA, 10, null).args;
    expect(more).toMatchObject({ country: "United States, Canada", seniority: "director, vp", department: "it, finance", postalCode: "220, 221" });
    // The connection probe asks for a country the vendor knows.
    expect(buildSearchLeadsArgs({ ...emptyCriteria(), jobTitles: ["Owner"], countries: ["US"] }, LIVE_SCHEMA, 3, null).args.country).toBe("United States");
    // No description, no schema: the concepts known to OR still take lists, the rest one value.
    expect(buildSearchLeadsArgs({ ...emptyCriteria(), stateProvinces: ["Virginia", "Maryland"], cities: ["Richmond", "Norfolk"] }, null, 10, null).args)
      .toMatchObject({ state: "Virginia, Maryland", city: "Richmond" });
  });

  it("industry never goes to search_leads; only a search with no title and no keyword folds it into the keyword", () => {
    // 2026-10-19 previews: "County Administrator" in VA/MD/NC found 28; adding industry "Government Administration" found 0,
    // and that industry (or "government") across the three states alone found 0: the vendor's person rows carry no industry.
    const withTitle = buildSearchLeadsArgs(COUNTY, LIVE_SCHEMA, 50, null);
    expect(withTitle.args).not.toHaveProperty("industry");
    expect(withTitle.args.keyword).toBe("County of");
    expect(withTitle.foldedIntoKeyword).toEqual([]);
    const titleNoKeyword = buildSearchLeadsArgs({ ...COUNTY, keywords: [] }, LIVE_SCHEMA, 50, null);
    expect(titleNoKeyword.args).not.toHaveProperty("industry");
    expect(titleNoKeyword.args).not.toHaveProperty("keyword");
    const keywordNoTitle = buildSearchLeadsArgs({ ...COUNTY, jobTitles: [] }, LIVE_SCHEMA, 50, null);
    expect(keywordNoTitle.args).not.toHaveProperty("industry");
    expect(keywordNoTitle.args.keyword).toBe("County of");
    // Nothing else to define the audience: the first industry becomes the keyword.
    const onlyIndustry = buildSearchLeadsArgs({ ...emptyCriteria(), industries: ["Government Administration", "Executive Offices"], stateProvinces: ["Virginia"] }, LIVE_SCHEMA, 50, null);
    expect(onlyIndustry.args).toEqual({ state: "Virginia", keyword: "Government Administration", hasEmail: true, limit: 50 });
    expect(onlyIndustry.foldedIntoKeyword).toEqual(["industry"]);
    // Every per-title call of a campaign search leaves it out too.
    expect(planSearchLeadsCalls(COUNTY, LIVE_SCHEMA, 50, null).calls.every((c) => !("industry" in c.args))).toBe(true);
    // The manifest says so whatever the schema lists, so the registry calls the match approximate.
    const c = creds("warmysender");
    c.config = { toolSchemas: { search_leads: LIVE_SCHEMA } };
    const caps = warmySenderCapabilities(c);
    expect(caps.approximatedFilters).toContain("industry");
    expect(caps.supportedFilters).not.toContain("industry");
    expect(caps.supportedFilters).toContain("jobTitle");
    expect(matchCapabilities(caps, COUNTY)).toEqual({ verdict: "approximate", approximated: ["industry"], missing: [] });
    expect(warmySenderCapabilities(null).approximatedFilters).toContain("industry");
  });

  it("several titles become one search_leads call per title, the cursor walking the rest, then the next page", () => {
    const first = planSearchLeadsCalls(COUNTY, LIVE_SCHEMA, 50, null);
    expect(first.calls.map((c) => c.args.jobTitle)).toEqual(COUNTY_TITLES.slice(0, MAX_TITLE_SEARCHES));
    expect(first.calls.every((c) => c.args.state === "Virginia, Maryland, North Carolina" && c.args.limit === 9 && c.limit === 9 && !("page" in c.args))).toBe(true);
    expect(first.titleWalk).toEqual({ titles: COUNTY_TITLES, page: 1, offset: 0 });
    // A title list that ORs (an array parameter) stays one call.
    const asArray = planSearchLeadsCalls(COUNTY, { properties: { jobTitle: { type: "array" } } }, 50, null);
    expect(asArray.calls).toHaveLength(1);
    expect(asArray.calls[0].args.jobTitle).toEqual(COUNTY_TITLES);
    expect(asArray.titleWalk).toBeNull();
    // A cursor for other titles starts over; one past the end wraps.
    expect(parseTitleCursor("1:6:zzz", COUNTY_TITLES)).toEqual({ page: 1, offset: 0 });
    expect(parseTitleCursor("7", COUNTY_TITLES)).toEqual({ page: 1, offset: 0 });
    // Down to one title, a stored title cursor is no page number (page NaN would be refused every tick).
    const one = planSearchLeadsCalls({ ...COUNTY, jobTitles: ["County Administrator"] }, LIVE_SCHEMA, 50, "2:6:abc");
    expect(one.calls).toHaveLength(1);
    expect("page" in one.calls[0].args).toBe(false);
    expect(planSearchLeadsCalls({ ...COUNTY, jobTitles: ["County Administrator"] }, LIVE_SCHEMA, 50, "3").calls[0].args.page).toBe(3);
  });

  it("search(): one call per title, people merged once, the cursor resumes the walk; an empty page says why", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let rowsFor: (a: Record<string, unknown>) => Array<Record<string, unknown>> = () => [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const headers = { "content-type": "application/json", "mcp-session-id": "s-test" };
      if (body.method !== "tools/call") return new Response(body.id ? JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }) : "", { status: body.id ? 200 : 202, headers });
      const a = body.params.arguments as Record<string, unknown>;
      sent.push(a);
      const leads = rowsFor(a);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { leads, pagination: { page: a.page ?? 1, total: leads.length } } } }), { status: 200, headers });
    }) as unknown as typeof fetch;
    const src = createWarmySenderSource({ fetchImpl });
    const c = creds("warmysender");
    c.secrets = { apiKey: "ws_search_test" };
    c.config = { toolSchemas: { search_leads: LIVE_SCHEMA } };
    // Every title finds one person of its own; the deputy also holds "County Administrator".
    rowsFor = (a) => {
      const t = String(a.jobTitle);
      const own = { id: `L-${t}`, firstName: "Pat", lastName: t.replace(/\s+/g, ""), jobTitle: t, email: "p***@county.gov", companyName: "County of Henrico", state: "Virginia" };
      return t === "County Administrator" ? [own, { id: "L-Deputy County Administrator", firstName: "Pat", lastName: "Deputy", jobTitle: "Deputy County Administrator", email: "d***@county.gov" }] : [own];
    };
    const p1 = await src.search(COUNTY, c, 50, { cursor: null });
    if (!p1.ok) throw new Error(p1.message);
    expect(sent.map((a) => a.jobTitle)).toEqual(COUNTY_TITLES.slice(0, 6));
    // The deputy came with the first title and is not taken again with the third.
    expect(p1.records.map((r) => r.jobTitle)).toEqual(["County Administrator", "Deputy County Administrator", "County Manager",
      "Assistant County Manager", "Chief Administrative Officer", "Director of Information Technology"]);
    expect(p1.records.every((r) => r.email === null && r.emailIsMasked)).toBe(true);
    expect(p1.note).toBe("titles 1–6 of 22, one per search");
    expect(parseTitleCursor(p1.nextCursor, COUNTY_TITLES)).toEqual({ page: 1, offset: 6 });

    // The last window: nobody left on a full page, so the walk wraps to the start.
    sent.length = 0;
    const p4 = await src.search(COUNTY, c, 50, { cursor: p1.nextCursor!.replace(/^1:6:/, "1:18:") });
    if (!p4.ok) throw new Error(p4.message);
    expect(sent.map((a) => a.jobTitle)).toEqual(COUNTY_TITLES.slice(18));
    expect(p4.nextCursor).toBeNull();
    // A full page on some title: the next pass is page 2.
    rowsFor = (a) => Array.from({ length: Number(a.limit) }, (_, i) => ({ id: `${a.jobTitle}-${a.page ?? 1}-${i}`, firstName: "A", lastName: `B${i}`, email: "x***@y.gov" }));
    const p5 = await src.search(COUNTY, c, 50, { cursor: p1.nextCursor!.replace(/^1:6:/, "1:18:") });
    if (!p5.ok) throw new Error(p5.message);
    expect(parseTitleCursor(p5.nextCursor, COUNTY_TITLES)).toEqual({ page: 2, offset: 0 });
    sent.length = 0;
    await src.search(COUNTY, c, 50, { cursor: p5.nextCursor });
    expect(sent.every((a) => a.page === 2)).toBe(true);

    // Nobody anywhere: the note tells "the vendor matched nobody" from "rows we cannot find".
    rowsFor = () => [];
    const empty = await src.search({ ...COUNTY, jobTitles: ["County Administrator"] }, c, 50, { cursor: null });
    if (!empty.ok) throw new Error(empty.message);
    expect(empty.records).toEqual([]);
    expect(empty.note).toBe("no rows; vendor total 0; payload keys leads, pagination");
  });

  it("search(): the first call's failure is the source's; a later one keeps what came back and resumes there", async () => {
    let calls = 0;
    let failAt = 1;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const headers = { "content-type": "application/json", "mcp-session-id": "s-fail" };
      if (body.method !== "tools/call") return new Response(body.id ? JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }) : "", { status: body.id ? 200 : 202, headers });
      calls += 1;
      if (calls === failAt) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Invalid arguments for tool search_leads" } }), { status: 200, headers });
      const t = String(body.params.arguments.jobTitle);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { leads: [{ id: `L-${t}`, firstName: "Pat", lastName: "Lee", jobTitle: t }] } } }), { status: 200, headers });
    }) as unknown as typeof fetch;
    const src = createWarmySenderSource({ fetchImpl });
    const c = creds("warmysender");
    c.secrets = { apiKey: "ws_fail_test" };
    c.config = { toolSchemas: { search_leads: LIVE_SCHEMA } };
    const failed = await src.search(COUNTY, c, 50, { cursor: null });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.reason).toBe("invalid_params");
    calls = 0; failAt = 3;
    const partial = await src.search(COUNTY, c, 50, { cursor: null });
    if (!partial.ok) throw new Error(partial.message);
    expect(partial.records.map((r) => r.jobTitle)).toEqual(COUNTY_TITLES.slice(0, 2));
    expect(parseTitleCursor(partial.nextCursor, COUNTY_TITLES)).toEqual({ page: 1, offset: 2 });
  });
  it("the page size never exceeds its maximum: the schema's own, else 50", () => {
    // 2026-10-16: once the text filters fit, a limit of 100 failed every search (search_leads allows 50).
    expect(buildSearchLeadsArgs(CRIT, { properties: { limit: { type: "integer", maximum: 50 } } }, 100, null).args.limit).toBe(50);
    expect(buildSearchLeadsArgs(CRIT, { properties: { limit: { type: "integer", maximum: 25 } } }, 100, null).args.limit).toBe(25);
    expect(buildSearchLeadsArgs(CRIT, null, 100, null).args.limit).toBe(50);
    expect(buildSearchLeadsArgs(CRIT, null, 30, null).args.limit).toBe(30);
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
