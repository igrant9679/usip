/**
 * Apollo's api_search rows, and the engine's walk through them.
 *
 * Campaign 38 (2026-10-19): every tick logged "Apollo returned 25 people
 * (0 with a company domain) from 25 matches" and queued 0 new. Three causes,
 * pinned here:
 *   - the engine sent no page, so every tick read page 1 of the same filters;
 *   - api_search reports its total as top-level `total_entries`, and we read
 *     only `pagination.total_entries`, so "25 matches" was the page size;
 *   - api_search rows are masked (docs.apollo.io/reference/people-api-search):
 *     first name, `last_name_obfuscated`, title, has_* flags and the
 *     organization's name. The 19 such rows queued at 00:36 UTC were all
 *     rejected: the email lookup needs a LinkedIn URL, or a full name and a
 *     company domain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

const mocks = vi.hoisted(() => {
  // _core/env.ts snapshots process.env at module load (see quickenrich.test.ts).
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) {
    process.env.ENCRYPTION_KEY = "a".repeat(64); // test-only, never persisted
  }
  return { getDb: vi.fn(), fetch: vi.fn() };
});

vi.mock("./db", () => ({ getDb: mocks.getDb, checkPermission: vi.fn() }));

import { encryptSecret } from "./_core/crypto";
import {
  APOLLO_MAX_RECORDS,
  APOLLO_PAGE_SIZE,
  apolloEmailReady,
  apolloQueryKey,
  apolloSearchPeople,
  currentApolloPage,
  mapPerson,
  nextApolloPage,
} from "./services/apollo";

/** A person row as the api_search docs show it. */
const maskedRow = (n: number) => ({
  id: `67bdafd0c3a4c5000${n}`,
  first_name: "Andrew",
  last_name_obfuscated: "Hu***n",
  title: "County Administrator",
  last_refreshed_at: "2025-11-04T23:20:32.690+00:00",
  has_email: true,
  has_city: true,
  has_state: true,
  has_country: true,
  has_direct_phone: "Yes",
  organization: {
    name: `County of Example ${n}`,
    has_industry: true, has_phone: false, has_city: true, has_state: true,
    has_country: true, has_zip_code: false, has_revenue: false, has_employee_count: true,
  },
});

function jsonResponse(status: number, body: unknown) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function dbWithKey() {
  const q: any = {
    select: () => q, from: () => q, where: () => q,
    limit: () => Promise.resolve([{ enc: encryptSecret("apollo-test-key") }]),
  };
  return q;
}

const sentBodies = () => mocks.fetch.mock.calls.map(([, opts]) => JSON.parse(String(opts.body)));

beforeEach(() => {
  mocks.getDb.mockReset().mockResolvedValue(dbWithKey());
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("an api_search row is masked, and we read it as such", () => {
  it("keeps the first name, the id and the flags; never stores the starred last name", () => {
    const p = mapPerson(maskedRow(1));
    expect(p.firstName).toBe("Andrew");
    expect(p.lastName).toBe("");
    expect(p.lastNameMasked).toBe(true);
    expect(p.apolloId).toBe("67bdafd0c3a4c50001");
    expect(p.hasEmail).toBe(true);
    expect(p.companyName).toBe("County of Example 1");
    expect(p.companyDomain).toBe("");
    expect(p.linkedinUrl).toBe("");
    expect(apolloEmailReady(p)).toBe(false);
  });

  it("treats a starred last_name as masked too", () => {
    const p = mapPerson({ first_name: "Dana", last_name: "Do***e", organization: { name: "X", primary_domain: "x.gov" } });
    expect(p.lastName).toBe("");
    expect(p.lastNameMasked).toBe(true);
    expect(apolloEmailReady(p)).toBe(false);
    // The old search's lower tiers sent an initial.
    expect(mapPerson({ first_name: "Dana", last_name: "S.", organization: { name: "X", primary_domain: "x.gov" } }).lastNameMasked).toBe(true);
    expect(mapPerson({ first_name: "Dana", last_name: "Ng", organization: { name: "X", primary_domain: "x.gov" } }).lastNameMasked).toBe(false);
  });

  it("a full row (old search shape) is something the email lookup can use", () => {
    const full = mapPerson({
      id: "p1", first_name: "Dana", last_name: "Doe", title: "County Manager",
      organization: { name: "Example County", primary_domain: "examplecounty.gov" },
    });
    expect(full.lastNameMasked).toBe(false);
    expect(full.companyDomain).toBe("examplecounty.gov");
    expect(apolloEmailReady(full)).toBe(true);
    // A LinkedIn URL alone is enough (QuickEnrich looks up by it).
    expect(apolloEmailReady(mapPerson({ first_name: "Dana", linkedin_url: "https://www.linkedin.com/in/dana", organization: { name: "X" } }))).toBe(true);
    // A full name without a domain is not.
    expect(apolloEmailReady(mapPerson({ first_name: "Dana", last_name: "Doe", organization: { name: "X" } }))).toBe(false);
  });
});

describe("apolloSearchPeople against the api_search response", () => {
  it("reads the total from top-level total_entries and sends the page asked for", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, { total_entries: 3412, people: [maskedRow(1), maskedRow(2)] }));
    const res = await apolloSearchPeople(2, { titles: ["County Administrator"], locations: ["Virginia"], page: 7, perPage: 25 });
    expect(res.ok).toBe(true);
    expect(res.totalAvailable).toBe(3412);
    expect(res.pageCount).toBe(2);
    expect(res.prospects).toHaveLength(2);
    const [body] = sentBodies();
    expect(body.page).toBe(7);
    expect(body.per_page).toBe(25);
    expect(body.person_titles).toEqual(["County Administrator"]);
    expect(body.organization_locations).toEqual(["Virginia"]);
    // Search only: nothing that reveals (and bills) emails or phones.
    expect(body).not.toHaveProperty("reveal_personal_emails");
    expect(body).not.toHaveProperty("reveal_phone_number");
    expect(String(mocks.fetch.mock.calls[0][0])).toMatch(/\/mixed_people\/api_search$/);
  });

  it("still reads the old pagination.total_entries", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, { pagination: { total_entries: 90 }, people: [maskedRow(1)] }));
    expect((await apolloSearchPeople(2, { titles: ["x"] })).totalAvailable).toBe(90);
  });

  it("drops the keywords only when the FIRST page matched nobody, and says so", async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(200, { total_entries: 0, people: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { total_entries: 40, people: [maskedRow(1)] }));
    const res = await apolloSearchPeople(2, { titles: ["x"], keywords: ["County of", "Board", "third"], page: 1 });
    const [withKw, without] = sentBodies();
    expect(withKw.q_keywords).toBe("County of Board");
    expect(without).not.toHaveProperty("q_keywords");
    expect(res.keywordsDropped).toBe(true);
  });

  it("an empty later page is the end of the keyword search, not a reason to drop them", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, { total_entries: 30, people: [] }));
    const res = await apolloSearchPeople(2, { titles: ["x"], keywords: ["County of"], page: 3 });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(sentBodies()[0].q_keywords).toBe("County of");
    expect(res.keywordsDropped).toBe(false);
  });

  it("a page of masked rows is not 'empty': no relaxed retry", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, { total_entries: 30, people: [maskedRow(1)] }));
    const res = await apolloSearchPeople(2, { titles: ["x"], keywords: ["County of"], page: 1 });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(res.keywordsDropped).toBe(false);
  });
});

describe("the page cursor", () => {
  const full = { pageCount: APOLLO_PAGE_SIZE, perPage: APOLLO_PAGE_SIZE, totalAvailable: 3412, keywordsDropped: false };

  it("walks forward one page per full page, then wraps on a short one", () => {
    const s1 = nextApolloPage(null, "k", full);
    expect(s1).toEqual({ key: "k", page: 2 });
    expect(currentApolloPage(s1, "k")).toEqual({ page: 2, relaxed: false });
    const s2 = nextApolloPage(s1, "k", full);
    expect(s2.page).toBe(3);
    expect(nextApolloPage(s2, "k", { ...full, pageCount: 7 })).toEqual({ key: "k", page: 1 });
    expect(nextApolloPage(s2, "k", { ...full, pageCount: 0 })).toEqual({ key: "k", page: 1 });
  });

  it("wraps at the last page of the total, and at Apollo's 50,000-record limit", () => {
    expect(nextApolloPage({ key: "k", page: 4 }, "k", { ...full, totalAvailable: 100 })).toEqual({ key: "k", page: 1 });
    expect(nextApolloPage({ key: "k", page: 3 }, "k", { ...full, totalAvailable: 100 }).page).toBe(4);
    const last = APOLLO_MAX_RECORDS / APOLLO_PAGE_SIZE;
    expect(nextApolloPage({ key: "k", page: last }, "k", { ...full, totalAvailable: 10_000_000 })).toEqual({ key: "k", page: 1 });
  });

  it("a retargeted campaign (new key) starts at page 1", () => {
    expect(currentApolloPage({ key: "old", page: 9 }, "new")).toEqual({ page: 1, relaxed: false });
    expect(nextApolloPage({ key: "old", page: 9 }, "new", full)).toEqual({ key: "new", page: 2 });
  });

  it("remembers a query that had to drop its keywords until the walk wraps", () => {
    const s1 = nextApolloPage(null, "k", { ...full, keywordsDropped: true });
    expect(s1).toEqual({ key: "k", page: 2, relaxed: true });
    expect(currentApolloPage(s1, "k").relaxed).toBe(true);
    expect(nextApolloPage(s1, "k", full)).toEqual({ key: "k", page: 3, relaxed: true });
    expect(nextApolloPage(s1, "k", { ...full, pageCount: 3 })).toEqual({ key: "k", page: 1 });
  });

  it("the key follows the filters sent, not their industry (Apollo is not sent one)", () => {
    const base = { titles: ["County Administrator"], locations: ["Virginia"], keywords: ["County of"], employeeMin: 1, employeeMax: 250, perPage: 25 };
    expect(apolloQueryKey(base)).toBe(apolloQueryKey({ ...base, industries: ["Government Administration"] }));
    expect(apolloQueryKey(base)).not.toBe(apolloQueryKey({ ...base, locations: ["Maryland"] }));
    expect(apolloQueryKey(base)).not.toBe(apolloQueryKey({ ...base, keywords: [] }));
    expect(apolloQueryKey(base)).not.toBe(apolloQueryKey({ ...base, employeeMax: 5000 }));
  });
});

describe("the engine's Apollo source", () => {
  const engine = read("server/areEngine.ts");
  const fn = engine.slice(engine.indexOf("async function discoverViaApollo"), engine.indexOf("async function discoverViaQuickenrich"));

  it("asks for the cursor's page, a fixed page size, and leaves the keywords out of a relaxed walk", () => {
    expect(fn).toContain("currentApolloPage(apPageState, apKey)");
    expect(fn).toContain("perPage: APOLLO_PAGE_SIZE");
    expect(fn).toContain("keywords: relaxed ? [] : targeting.keywords");
    // 2026-10-27 (audit Phase 3): the search names what spent it, for the spend report.
    expect(fn).toMatch(/apolloSearchPeople\(campaign\.workspaceId, \{[\s\S]*?\bpage,\s*\}, "are\.discovery"\)/);
  });

  it("queues only rows the email lookup can use, within the record cap, and says why the rest were not", () => {
    expect(fn).toContain("res.prospects.filter(apolloEmailReady)");
    // 2026-10-27 (audit A32): within the record cap AND this tick's open slots.
    expect(fn).toContain("ready.slice(0, Math.max(0, Math.min(headroom, remaining)))");
    expect(fn).toContain("not queued: no LinkedIn URL, and no full name with a company domain");
    expect(fn).toContain("raw: kept.map(");
  });

  it("holds the cursor on a failed search and on a page the cap cut short", () => {
    const failed = fn.slice(fn.indexOf("if (!res.ok)"), fn.indexOf("const ready"));
    expect(failed).toContain("return { raw: [], nextAp: null }");
    expect(fn).toContain("kept.length < ready.length");
  });

  it("persists the cursor next to QuickEnrich's", () => {
    expect(engine).toContain("discoverViaApollo(campaign, { titles, industries, geos, keywords, overrides: size }, persistedState.ap ?? null, remaining)");
    expect(engine).toContain("apolloNextPage = nextAp;");
    expect(engine).toContain("ap: apolloNextPage ?? persistedState.ap ?? null,");
  });
});

describe("the registry adapter", () => {
  it("keys a masked row by Apollo's person id, not by first name and an empty domain", () => {
    const adapter = read("server/services/prospectSources/adapters/apollo.ts");
    expect(adapter).toContain("p.apolloId ? `apollo:${p.apolloId}`");
  });
});
