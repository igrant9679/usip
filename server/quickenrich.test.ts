/**
 * QuickEnrich BYOK — key resolution, the free connection test, and the guards
 * that keep this integration honest while it has no engine consumer.
 *
 * Three failure classes this file exists to prevent, all from this repo's own
 * history: the migration reaching schema.ts but not rawMigrations.ts (the
 * dominant prod-breaking bug — runRawMigrations swallows failures, so the app
 * boots identically either way); a settings surface growing controls nothing
 * consults (three inert switches found on 2026-08-03); and a credential that
 * leaks through a status endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

const mocks = vi.hoisted(() => {
  // _core/env.ts snapshots process.env at module load, so the encryption key
  // must exist BEFORE any import graph touches it — hoisted runs first. Only
  // set when absent: a real key in the environment must win.
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) {
    process.env.ENCRYPTION_KEY = "a".repeat(64); // test-only, never persisted
  }
  return {
    getDb: vi.fn(),
    fetch: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ getDb: mocks.getDb, checkPermission: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb, checkPermission: vi.fn() }));

import { encryptSecret } from "./_core/crypto";
import {
  buildQuickenrichFilters,
  currentQuickenrichPage,
  getQuickEnrichKey,
  getQuickenrichIndustries,
  mapIndustriesToVocabulary,
  nextQuickenrichPage,
  quickenrichContactFinder,
  quickenrichFindEmailByLinkedIn,
  quickenrichTestKey,
  QUICKENRICH_BASE,
  QUICKENRICH_MAX_PAGE,
  QUICKENRICH_PROBE_CANDIDATES,
} from "./services/quickenrich";
import { ARE_SOURCE_IDS } from "@shared/areSources";

/** Chainable fake returning one workspace_settings row. */
function dbWithRow(row: Record<string, unknown> | null) {
  const q: any = {
    select: () => q, from: () => q, where: () => q,
    limit: () => Promise.resolve(row ? [row] : []),
  };
  return q;
}

const ENV = ["QUICKENRICH_API_KEY"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.resetAllMocks();
  for (const v of ENV) { saved[v] = process.env[v]; delete process.env[v]; }
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const v of ENV) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("getQuickEnrichKey — same contract as getReoonKey/getApolloKey", () => {
  it("prefers the workspace's own encrypted key", async () => {
    // Round-trips through the REAL encryptSecret/tryDecryptSecret, so a drift
    // in the ciphertext format fails here and not in production.
    mocks.getDb.mockResolvedValue(dbWithRow({ enc: encryptSecret("ws-key-123") }));
    process.env.QUICKENRICH_API_KEY = "env-key";
    expect(await getQuickEnrichKey(7)).toBe("ws-key-123");
  });

  it("falls back to the env var when the workspace column is empty", async () => {
    mocks.getDb.mockResolvedValue(dbWithRow(null));
    process.env.QUICKENRICH_API_KEY = "env-key";
    expect(await getQuickEnrichKey(7)).toBe("env-key");
  });

  it("falls back to the env var when the ciphertext is corrupt", async () => {
    // tryDecryptSecret's whole purpose: a mangled column must degrade to the
    // deploy-wide key, not crash the request.
    mocks.getDb.mockResolvedValue(dbWithRow({ enc: "not:valid:ciphertext" }));
    process.env.QUICKENRICH_API_KEY = "env-key";
    expect(await getQuickEnrichKey(7)).toBe("env-key");
  });

  it("returns empty when neither exists — callers gate on falsiness", async () => {
    mocks.getDb.mockResolvedValue(dbWithRow(null));
    expect(await getQuickEnrichKey(7)).toBe("");
  });

  it("skips the DB entirely without a workspaceId", async () => {
    process.env.QUICKENRICH_API_KEY = "env-key";
    expect(await getQuickEnrichKey(null)).toBe("env-key");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("a DB failure degrades to the env var rather than throwing", async () => {
    mocks.getDb.mockRejectedValue(new Error("connection refused"));
    process.env.QUICKENRICH_API_KEY = "env-key";
    expect(await getQuickEnrichKey(7)).toBe("env-key");
  });
});

describe("quickenrichTestKey — proves the key without spending", () => {
  const jsonResponse = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    // A real fetch Response ALWAYS has .text() — a mock without it made the
    // error-body capture look broken when only the mock was (CI run #871).
    text: async () => JSON.stringify(body),
  });

  it("calls the FREE endpoint, never a paid one — once per probe candidate", async () => {
    // contact-finder is the one endpoint their docs price at 0 credits. A test
    // that spends a credit per click is a meter, not a test. Since the 422
    // schema change the test probes every candidate shape, so the count is
    // derived from the exported list, not pinned.
    mocks.fetch.mockResolvedValue(jsonResponse(200, { data: [] }));
    await quickenrichTestKey("k");
    expect(mocks.fetch).toHaveBeenCalledTimes(QUICKENRICH_PROBE_CANDIDATES.length);
    for (const [url, opts] of mocks.fetch.mock.calls) {
      expect(url).toBe(`${QUICKENRICH_BASE}/api/employees/contact-finder`);
      expect(opts.headers.Authorization).toBe("Bearer k");
      expect(url).not.toContain("/api/employees/search");
    }
  });

  it("reads a 401/403 as a bad key, with a message that says so", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(401, {}));
    const r = await quickenrichTestKey("bad");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(r.message).toContain("rejected");
  });

  it("reads a 5xx as THEIR outage, not a bad key", async () => {
    // The distinction the settings card shows the user: "replace your key" and
    // "try again later" are different instructions.
    mocks.fetch.mockResolvedValue(jsonResponse(503, {}));
    const r = await quickenrichTestKey("k");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("503");
    expect(r.message).not.toContain("rejected");
  });

  it("counts sample rows when the envelope is recognisable", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, { data: [{}, {}, {}] }));
    expect((await quickenrichTestKey("k")).sampleRows).toBe(3);
  });

  it("a 2xx with an alien body still passes — authentication is the question", async () => {
    mocks.fetch.mockResolvedValue({ status: 200, ok: true, json: async () => { throw new Error("not json"); } });
    const r = await quickenrichTestKey("k");
    expect(r.ok).toBe(true);
    expect(r.sampleRows).toBeNull();
  });

  it("network failure returns ok:false rather than throwing", async () => {
    mocks.fetch.mockRejectedValue(new Error("ETIMEDOUT"));
    const r = await quickenrichTestKey("k");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });
});

describe("quickenrichFindEmailByLinkedIn — envelope-agnostic on purpose", () => {
  /**
   * Their docs name the fields but not the wrapper, so the parser recognises
   * the common shapes and treats anything else as a MISS, never a crash — a
   * sweep must not die on row 7 of 25 because a vendor reshaped a payload.
   * (The json() producer/consumer drift class, handled by admitting
   * uncertainty at the read.)
   */
  const jsonResponse = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
  const LI = "https://linkedin.com/in/ada-li";

  it.each([
    ["bare object", { email: "Ada@Acme.io", first_name: "Ada" }],
    ["data object", { data: { email: "ada@acme.io" } }],
    ["data array", { data: [{ email: "ada@acme.io" }] }],
    ["results array", { results: [{ email: "ada@acme.io" }] }],
    ["work_email spelling", { data: { work_email: "ada@acme.io" } }],
  ])("finds the address in a %s envelope", async (_name, body) => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, body));
    const r = await quickenrichFindEmailByLinkedIn("k", LI);
    expect(r.reason).toBe("found");
    expect(r.email).toBe("ada@acme.io"); // lowercased
  });

  it("sends the LinkedIn URL encoded, with the bearer key — under BOTH param spellings on a miss", async () => {
    // Their 08-21 drift renamed the employee-LinkedIn field; a dead GET param
    // can 200 with no rows, which reads exactly like "not in their DB". So a
    // miss on the historical param retries once under the renamed one.
    mocks.fetch.mockResolvedValue(jsonResponse(200, { data: {} }));
    await quickenrichFindEmailByLinkedIn("k", LI);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [url1, opts] = mocks.fetch.mock.calls[0];
    const [url2] = mocks.fetch.mock.calls[1];
    expect(url1).toBe(`${QUICKENRICH_BASE}/api/employees/search?linkedin_url=${encodeURIComponent(LI)}`);
    expect(url2).toBe(`${QUICKENRICH_BASE}/api/employees/search?employee_linkedin=${encodeURIComponent(LI)}`);
    expect(opts.headers.Authorization).toBe("Bearer k");
  });

  it("a hit on the first param never spends the second call", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, { data: { email: "ada@acme.io" } }));
    const r = await quickenrichFindEmailByLinkedIn("k", LI);
    expect(r.reason).toBe("found");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("a hit under the RENAMED param rescues a dead historical param", async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, { data: { email: "ada@acme.io" } }));
    const r = await quickenrichFindEmailByLinkedIn("k", LI);
    expect(r.reason).toBe("found");
    expect(r.email).toBe("ada@acme.io");
  });

  it("verdict merge: a definitive no_match beats a transport failure", async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(404, {}));
    expect((await quickenrichFindEmailByLinkedIn("k", LI)).reason).toBe("no_match");
  });

  it("a 404 is a no_match, not an error", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(404, {}));
    expect((await quickenrichFindEmailByLinkedIn("k", LI)).reason).toBe("no_match");
  });

  it("a recognisable envelope with no address is a no_match", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, { data: { first_name: "Ada" } }));
    expect((await quickenrichFindEmailByLinkedIn("k", LI)).reason).toBe("no_match");
  });

  it("never accepts a non-address string as an email", async () => {
    // has_email flags and status words must not leak into the email field —
    // that is the Email Status bug wearing an API costume.
    mocks.fetch.mockResolvedValue(jsonResponse(200, { data: { email: "valid" } }));
    const r = await quickenrichFindEmailByLinkedIn("k", LI);
    expect(r.email).toBeNull();
  });

  it("HTTP failure and network failure return distinct reasons, and never throw", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(500, {}));
    expect((await quickenrichFindEmailByLinkedIn("k", LI)).reason).toBe("http_error");
    mocks.fetch.mockRejectedValue(new Error("ETIMEDOUT"));
    expect((await quickenrichFindEmailByLinkedIn("k", LI)).reason).toBe("network_error");
  });
});

describe("buildQuickenrichFilters — targeting → their vocabulary, conservatively", () => {
  it("maps titles directly and industries THROUGH their vocabulary", () => {
    const { body } = buildQuickenrichFilters({
      titles: ["CFO", " Executive Director "],
      industries: ["non-profit organizations"],
      geos: [],
    }, ["Non-profit Organizations", "Higher Education"]);
    // Dimensions at the BODY ROOT, no `filters` wrapper and no `logic` key —
    // their API changed schema (probe-proven 2026-08-21): any body carrying a
    // `filters` wrapper 422s as "no filter at all". The industry value sent is
    // THEIR exact string, never ours — one unrecognised value 422s the whole
    // request (observed live 2026-08-24).
    expect(body).toMatchObject({
      page: 1,
      title: { include: ["CFO", "Executive Director"] },
      industry_linkedin: { include: ["Non-profit Organizations"] },
    });
    expect(body).not.toHaveProperty("filters");
    expect(body).not.toHaveProperty("logic");
  });

  it("drops industries not in their vocabulary and reports them — titles still search", () => {
    const { body, unmappedIndustries, industryLookupUnavailable } = buildQuickenrichFilters({
      titles: ["CFO"],
      industries: ["Colleges & Universities", "Higher Education"],
      geos: [],
    }, ["Higher Education", "Government Administration"]);
    expect((body as any).industry_linkedin.include).toEqual(["Higher Education"]);
    expect(unmappedIndustries).toEqual(["Colleges & Universities"]);
    expect(industryLookupUnavailable).toBe(false);
  });

  it("omits the industry dimension entirely when the vocabulary lookup is unavailable", () => {
    // Sending an unvalidated value 422s the WHOLE request — a broader
    // titles-only search that returns people beats a precise one that errors.
    const { body, unmappedIndustries, industryLookupUnavailable } = buildQuickenrichFilters({
      titles: ["CFO"],
      industries: ["Higher Education"],
      geos: [],
    }, null);
    expect(body).not.toHaveProperty("industry_linkedin");
    expect((body as any).title.include).toEqual(["CFO"]);
    expect(unmappedIndustries).toEqual(["Higher Education"]);
    expect(industryLookupUnavailable).toBe(true);
  });

  it("returns null when nothing survives mapping (industries-only targeting, none map)", () => {
    const { body } = buildQuickenrichFilters({
      titles: [],
      industries: ["Colleges & Universities"],
      geos: [],
    }, ["Government Administration"]);
    expect(body).toBeNull();
  });

  it("sends a geo ONLY when it maps cleanly to a country code, and reports the rest", () => {
    // "California" sent as a country_code would silently empty the search —
    // similarity is not meaning, in filter vocabularies as in CSV headers.
    const { body, unmappedGeos } = buildQuickenrichFilters({
      titles: ["CFO"],
      industries: [],
      geos: ["United States", "California", "UK"],
    }, null);
    expect((body as any).country_code.include.sort()).toEqual(["GB", "US"]);
    expect(unmappedGeos).toEqual(["California"]);
  });

  it("refuses to search with no titles and no industries", () => {
    // A filter-less search is 'every contact they have' — never a campaign
    // audience. Same refusal, same reason, as the internal-CRM source.
    const { body } = buildQuickenrichFilters({ titles: [], industries: [], geos: ["United States"] }, null);
    expect(body).toBeNull();
  });

  it("bounds the include lists", () => {
    const { body } = buildQuickenrichFilters({
      titles: Array.from({ length: 40 }, (_, i) => `T${i}`),
      industries: [],
      geos: [],
    }, null);
    expect((body as any).title.include).toHaveLength(12);
  });
});

describe("mapIndustriesToVocabulary — exact or unambiguous, never a guess", () => {
  it("matches on compact form: case, '&'→'and', punctuation and spacing ignored", () => {
    const { mapped, unmapped } = mapIndustriesToVocabulary(
      ["non-profit organizations", "colleges and universities"],
      ["Non-profit Organizations", "Colleges & Universities"],
    );
    // Always THEIR exact strings — that is what their validator accepts.
    expect(mapped).toEqual(["Non-profit Organizations", "Colleges & Universities"]);
    expect(unmapped).toEqual([]);
  });

  it("containment maps ONLY when exactly one candidate matches", () => {
    const one = mapIndustriesToVocabulary(["Grantmaking"], ["Philanthropic Grantmaking Services", "Higher Education"]);
    expect(one.mapped).toEqual(["Philanthropic Grantmaking Services"]);
    // Two candidates contain the term → ambiguous → dropped, not picked.
    const two = mapIndustriesToVocabulary(["Education"], ["Higher Education", "Primary Education"]);
    expect(two.mapped).toEqual([]);
    expect(two.unmapped).toEqual(["Education"]);
  });

  it("dedupes when two of ours map to the same one of theirs", () => {
    const { mapped } = mapIndustriesToVocabulary(
      ["Higher Education", "higher-education"],
      ["Higher Education"],
    );
    expect(mapped).toEqual(["Higher Education"]);
  });
});

describe("getQuickenrichIndustries — their controlled vocabulary, defensively parsed", () => {
  const jsonResponse = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });

  // The 12h in-process cache is keyed by API key — every test uses a fresh
  // key so one test's cached vocabulary can't leak into the next.
  it("accepts a bare string array", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, ["Higher Education", "Philanthropy"]));
    expect(await getQuickenrichIndustries("k-bare")).toEqual(["Higher Education", "Philanthropy"]);
  });

  it("accepts wrapped arrays and object entries", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, { data: [{ name: "Higher Education" }, { value: "Philanthropy" }] }));
    expect(await getQuickenrichIndustries("k-wrapped")).toEqual(["Higher Education", "Philanthropy"]);
  });

  it("returns null on HTTP error, alien shape, or an empty list — callers must then omit the dimension", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(500, {}));
    expect(await getQuickenrichIndustries("k-500")).toBeNull();
    mocks.fetch.mockResolvedValue(jsonResponse(200, { weird: true }));
    expect(await getQuickenrichIndustries("k-alien")).toBeNull();
    mocks.fetch.mockResolvedValue(jsonResponse(200, []));
    expect(await getQuickenrichIndustries("k-empty")).toBeNull();
  });

  it("caches per key — a second call does not re-fetch", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, ["Higher Education"]));
    await getQuickenrichIndustries("k-cache");
    await getQuickenrichIndustries("k-cache");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("contact-finder page rotation — pulls must not re-read page 1 forever", () => {
  it("a fresh or retargeted query starts at page 1", () => {
    expect(currentQuickenrichPage(null, "abc")).toBe(1);
    expect(currentQuickenrichPage({ key: "other", page: 7 }, "abc")).toBe(1);
    // Garbage from a hand-edited JSON column must not become a request page.
    expect(currentQuickenrichPage({ key: "abc", page: 0 }, "abc")).toBe(1);
    expect(currentQuickenrichPage({ key: "abc", page: 2.5 }, "abc")).toBe(1);
  });

  it("an unchanged query resumes at its stored page", () => {
    expect(currentQuickenrichPage({ key: "abc", page: 7 }, "abc")).toBe(7);
  });

  it("advances one page per non-empty pull, keyed to the query", () => {
    const s1 = nextQuickenrichPage(null, "abc", 10);
    expect(s1).toEqual({ key: "abc", page: 2 });
    const s2 = nextQuickenrichPage(s1, "abc", 10);
    expect(s2).toEqual({ key: "abc", page: 3 });
  });

  it("wraps to page 1 on an empty page (past the end) and at the cap", () => {
    expect(nextQuickenrichPage({ key: "abc", page: 9 }, "abc", 0)).toEqual({ key: "abc", page: 1 });
    expect(nextQuickenrichPage({ key: "abc", page: QUICKENRICH_MAX_PAGE }, "abc", 10)).toEqual({ key: "abc", page: 1 });
  });

  it("a query change resets the walk — the old cursor never leaks into the new query", () => {
    expect(nextQuickenrichPage({ key: "old", page: 30 }, "new", 10)).toEqual({ key: "new", page: 2 });
  });
});

describe("quickenrichContactFinder — free discovery, defensively parsed", () => {
  const jsonResponse = (status: number, body: unknown) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
  const BODY = { title: { include: ["CFO"] }, page: 1 };

  it("reads the 2026-08 schema's employee_linkedin field, normalising a bare slug to a URL", async () => {
    // Probe-verified row keys: linkedin_url became employee_linkedin, and the
    // value can be a slug. This field is the enrichment lookup's KEY — a
    // dropped or non-URL value makes the person unenrichable, which is how
    // every discovered row silently vanished on 2026-08-21 (found: 0 while
    // the probe counted 10).
    mocks.fetch.mockResolvedValue(jsonResponse(200, {
      data: [
        { first_name: "Rosa", last_name: "Nunez", title: "CFO", employee_linkedin: "rosa-nunez-1a2b", company_name: "Acme", email_domain: "acme.org", has_email: true },
        { first_name: "Full", last_name: "Url", employee_linkedin: "https://www.linkedin.com/in/full-url", has_email: false },
      ],
    }));
    const r = await quickenrichContactFinder("k", BODY);
    if (!r.ok) throw new Error(r.error);
    expect(r.people).toHaveLength(2);
    expect(r.people[0].linkedinUrl).toBe("https://www.linkedin.com/in/rosa-nunez-1a2b");
    expect(r.people[0].companyDomain).toBe("acme.org"); // email_domain fallback
    expect(r.people[1].linkedinUrl).toBe("https://www.linkedin.com/in/full-url");
  });

  it("maps their row shape to prospect fields, normalising the company URL to a domain", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, {
      data: [{
        first_name: "Ada", last_name: "Li", title: "CFO",
        linkedin_url: "https://linkedin.com/in/ada-li",
        company_name: "Acme", company_url: "https://www.acme.io/about",
        has_email: true,
      }],
    }));
    const r = await quickenrichContactFinder("k", BODY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.people).toEqual([{
      firstName: "Ada", lastName: "Li", title: "CFO",
      linkedinUrl: "https://linkedin.com/in/ada-li",
      companyName: "Acme", companyDomain: "acme.io",
      hasEmail: true,
    }]);
  });

  it("drops rows with no LinkedIn URL or no name — inert in OUR pipeline", async () => {
    // No LinkedIn URL = the enrichment lookup has no key to work with; no name
    // = nothing to address. Keeping either would queue rows nothing can work.
    mocks.fetch.mockResolvedValue(jsonResponse(200, {
      data: [
        { first_name: "Ada", last_name: "Li", linkedin_url: "https://linkedin.com/in/ada" },
        { first_name: "No", last_name: "Url" },
        { linkedin_url: "https://linkedin.com/in/nameless" },
      ],
    }));
    const r = await quickenrichContactFinder("k", BODY);
    if (!r.ok) throw new Error("expected ok");
    expect(r.people).toHaveLength(1);
    expect(r.people[0].firstName).toBe("Ada");
  });

  it("treats has_email as strictly boolean true", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(200, {
      data: [
        { first_name: "A", last_name: "B", linkedin_url: "https://linkedin.com/in/a", has_email: "true" },
      ],
    }));
    const r = await quickenrichContactFinder("k", BODY);
    if (!r.ok) throw new Error("expected ok");
    expect(r.people[0].hasEmail).toBe(false);
  });

  it("reports HTTP and envelope failures as errors, and never throws", async () => {
    mocks.fetch.mockResolvedValue(jsonResponse(500, {}));
    expect((await quickenrichContactFinder("k", BODY)).ok).toBe(false);
    mocks.fetch.mockResolvedValue(jsonResponse(200, { weird: "shape" }));
    const r = await quickenrichContactFinder("k", BODY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unrecognised envelope");
    mocks.fetch.mockRejectedValue(new Error("ETIMEDOUT"));
    expect((await quickenrichContactFinder("k", BODY)).ok).toBe(false);
  });
});

describe("the areSources rule, now enforced: a source exists only if the engine runs it", () => {
  /**
   * areSources.ts has stated this rule in prose since the three-vocabulary
   * cleanup; nothing checked it. Four checkboxes were once silent no-ops for
   * exactly this reason. Every id in the vocabulary must have a dispatch
   * branch in runDiscovery — adding an entry without one now fails here
   * instead of shipping a checkbox that does nothing.
   */
  it("every ARE source id has a runDiscovery branch", () => {
    const engine = read("server/areEngine.ts");
    for (const id of ARE_SOURCE_IDS) {
      expect(
        engine.includes(`sources.includes("${id}")`),
        `source "${id}" is offered but the engine never runs it — the silent-checkbox class`,
      ).toBe(true);
    }
  });
});

describe("migration parity — the dominant prod-breaking bug, pre-empted", () => {
  it("0146 exists in rawMigrations and adds the column schema declares", () => {
    const migrations = read("server/_core/rawMigrations.ts");
    const at = migrations.indexOf("0146_quickenrich_key.sql");
    expect(at, "migration 0146 missing from rawMigrations — schema-only columns break prod silently").toBeGreaterThan(-1);
    const block = migrations.slice(at, at + 400);
    expect(block).toContain("ADD COLUMN `quickenrichApiKeyEnc` text NULL");

    const schema = read("drizzle/schema.ts");
    expect(schema).toContain('quickenrichApiKeyEnc: text("quickenrichApiKeyEnc")');
  });
});

describe("no inert controls, no leaks", () => {
  const routerSrc = read("server/routers/quickenrich.ts");
  const schema = read("drizzle/schema.ts");

  it("every QuickEnrich control is consumed by the engine — none is decoration", () => {
    /**
     * This test REPLACED the inert-columns guard when sourcing landed (its
     * annotated lifecycle: the absence test died in the same commit that
     * added the consumer). The obligation inverts: a column that exists must
     * be consulted where the work happens.
     */
    expect(schema).toContain('quickenrichDailyPullCap: int("quickenrichDailyPullCap")');
    const engine = read("server/areEngine.ts");
    expect(engine.includes("getQuickenrichDailyPullCap(campaign.workspaceId)"), "the pull cap is not consulted by discovery").toBe(true);
    expect(engine.includes("quickenrichPulledToday(campaign.workspaceId)"), "today's usage is not counted against the cap").toBe(true);
    expect(engine.includes("getQuickEnrichKey(campaign.workspaceId)"), "discovery does not check the key").toBe(true);
  });

  it("migration 0148 carries the cap AND both sourceType enum widenings", () => {
    // An enum value the DB doesn't know fails at runtime INSERT (reason on
    // e.cause), so schema-side enum edits without the MODIFYs are the
    // as-never class wearing a sourcing costume.
    const migrations = read("server/_core/rawMigrations.ts");
    const at = migrations.indexOf("0148_quickenrich_source.sql");
    expect(at, "migration 0148 missing").toBeGreaterThan(-1);
    const block = migrations.slice(at, at + 1200);
    expect(block).toContain("ADD COLUMN `quickenrichDailyPullCap` int NOT NULL DEFAULT 50");
    expect(block).toMatch(/ALTER TABLE `are_scrape_jobs` MODIFY COLUMN `sourceType` enum\('[^)]*'quickenrich'\) NOT NULL/);
    expect(block).toMatch(/ALTER TABLE `prospect_queue` MODIFY COLUMN `sourceType` enum\('[^)]*'quickenrich'\) NOT NULL/);
    // And the schema enums agree with the migration.
    expect(/quickenrich[\s\S]{0,40}?\]\)\.notNull\(\)/.test(schema), "a schema sourceType enum is missing quickenrich").toBe(true);
  });

  it("discovery ranks has_email rows first, so headroom goes to convertible people", () => {
    const engine = read("server/areEngine.ts");
    expect(engine.includes("Number(b.hasEmail) - Number(a.hasEmail)"), "has_email prioritisation is gone").toBe(true);
  });

  it("saveScrapeJobAndQueue maps the quickenrich source end to end", () => {
    const scraper = read("server/routers/are/scraper.ts");
    expect(scraper.includes('quickenrich: "quickenrich"'), "job→queue sourceType mapping missing").toBe(true);
    expect(/QUEUE_SOURCE_TYPES = new Set\(\[[\s\S]*?"quickenrich",[\s\S]*?\]\)/.test(scraper), "queue enum allowlist missing quickenrich").toBe(true);
  });

  it("the status endpoint never returns the key", () => {
    const getBlock = routerSrc.slice(routerSrc.indexOf("get: workspaceProcedure"), routerSrc.indexOf("upsert:"));
    expect(getBlock.length).toBeGreaterThan(300);
    expect(getBlock).toContain("maskSecret(");
    // The decrypted value must feed ONLY configured/masked/source.
    expect(getBlock).not.toMatch(/masked: (workspaceKey|effective)[,\s]*$/m);
    expect(getBlock).not.toMatch(/key: (workspaceKey|effective|envKey)/);
  });

  it("writes go through encryptSecret; the raw input is never stored", () => {
    const upsert = routerSrc.slice(routerSrc.indexOf("upsert:"), routerSrc.indexOf("test:"));
    expect(upsert).toContain("encryptSecret(input.apiKey.trim())");
    expect(upsert).not.toMatch(/quickenrichApiKeyEnc:\s*input\.apiKey\s*[,}]/);
  });

  it("mutations are admin-gated and permission-checked", () => {
    const upsert = routerSrc.slice(routerSrc.indexOf("upsert:"), routerSrc.indexOf("test:"));
    expect(upsert).toContain("adminWsProcedure");
    expect(upsert).toContain('checkPermission(ctx, "manage_api_keys")');
    const test = routerSrc.slice(routerSrc.indexOf("test: "));
    expect(test).toContain("adminWsProcedure");
  });

  it("the router is registered", () => {
    const routers = read("server/routers.ts");
    expect(routers).toContain("quickenrich: quickenrichRouter");
  });

  it("both settings surfaces mount the card", () => {
    for (const rel of ["client/src/pages/usip/SettingsHub.tsx", "client/src/pages/usip/ARESettings.tsx"]) {
      expect(read(rel).includes("QuickEnrichSourceCard"), `${rel} does not mount the card`).toBe(true);
    }
  });

  it("the card describes the live wiring: free discovery, credits at enrichment, Reoon gate", () => {
    // Updated together with the sourcing integration, per the old overclaim
    // guard's annotation. The card must not resurrect the pre-sourcing claim.
    const card = read("client/src/components/usip/settings/QuickEnrichSourceCard.tsx");
    expect(card).toContain("Campaigns source new prospects from QuickEnrich");
    expect(card.includes("campaigns do not pull from QuickEnrich yet")).toBe(false);
    expect(card).toContain("Reoon-verified");
    // The cap input exists and the save path sends it.
    expect(card).toContain("Daily pull cap");
    expect(card).toContain("dailyPullCap: capNum");
  });
});
