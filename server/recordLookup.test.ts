/**
 * Owner, 2026-11-23: "if the search doesn't find the person or company then
 * the app should go out to the prospect sources to get the info, and offer to
 * create a record in the system", and (of the search) "within the Elsie/AI
 * Assistant also".
 *
 * Held here:
 *   1. what is looked up for what was typed: a person's name on LinkedIn and
 *      the databases, a company through the databases, an email address as
 *      its company, because no source finds a person from an address;
 *   2. the lookup goes through the doors the rest of the app uses: the
 *      account's own LinkedIn gate (not the person-initiated bypass), and the
 *      databases' FREE previews only;
 *   3. what it shows: no masked address as an address, no row that is not
 *      about what was typed, who is here already, what saving spends;
 *   4. saving opens a record that is already here, never makes it twice, and
 *      reads only this workspace's staged rows;
 *   5. Elsie reads the lookup, and her card for the save names the cost;
 *   6. the box asks on a press, never on a keystroke.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { prospects, prospectSearchResults, prospectSearchRuns } from "../drizzle/schema";

const h = vi.hoisted(() => ({
  db: null as any,
  linkedin: null as any,
  linkedinCalls: [] as any[],
  startCalls: [] as any[],
  startError: null as string | null,
  run: null as any,
  getRunCalls: [] as any[],
  promoteCalls: [] as any[],
  promote: null as any,
  configured: true,
  index: new Map<string, any>(),
  match: { accountId: null as number | null, confidence: "no_match" },
  matchCalls: [] as any[],
  createdAccounts: [] as any[],
  savedFinds: [] as any[],
  runRows: [] as any[],
  staged: [] as any[],
  people: [] as any[],
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./services/linkedinLookup", async (a) => ({
  ...(await a<typeof import("./services/linkedinLookup")>()),
  searchLinkedInProfiles: async (o: unknown) => { h.linkedinCalls.push(o); return h.linkedin; },
}));
vi.mock("./services/prospectSources/searchRuns", async (a) => ({
  ...(await a<typeof import("./services/prospectSources/searchRuns")>()),
  startRun: async (...args: unknown[]) => { h.startCalls.push(args); if (h.startError) throw new Error(h.startError); return { runId: 77 }; },
  getRun: async (ws: number, id: number) => { h.getRunCalls.push([ws, id]); return h.run; },
  promoteResults: async (...args: unknown[]) => { h.promoteCalls.push(args); return h.promote(); },
}));
vi.mock("./services/prospectSources/credentials", async (a) => ({
  ...(await a<typeof import("./services/prospectSources/credentials")>()),
  credentialView: async (_ws: number, s: { slug: string }) => ({ slug: s.slug, configured: h.configured && s.slug !== "leadocean" }),
  loadCredentials: async () => null,
}));
vi.mock("./services/prospectSources/dedupe", async (a) => ({
  ...(await a<typeof import("./services/prospectSources/dedupe")>()),
  workspaceIdentityIndex: async () => h.index,
}));
vi.mock("./services/company/matchingService", async (a) => ({
  ...(await a<typeof import("./services/company/matchingService")>()),
  findWorkspaceAccountMatch: async (ws: number, input: unknown) => { h.matchCalls.push([ws, input]); return { ...h.match, globalOrganizationId: null, score: 0, conflict: false, reasons: [] }; },
}));
vi.mock("./services/company/associationService", () => ({
  createWorkspaceAccount: async (ws: number, input: unknown, sourceType: string) => { h.createdAccounts.push([ws, input, sourceType]); return 901; },
}));
vi.mock("./services/discovery", () => ({
  saveFindsAsPeople: async (...args: unknown[]) => { h.savedFinds.push(args); return { runId: 5, prospectsCreated: 1, prospectsUpdated: 0, prospectsSkipped: 0 }; },
}));

import { describeLookupSave, lookupOutside, matchesLookup, saveFromLookup } from "./services/recordLookup";
import { parseRecordSearch } from "@shared/recordSearch";
import {
  LOOKUP_TARGET, NO_EMAIL_LOOKUP_NOTE, lookupKindsFor, mergeLookup, outsidePersonDetail, planLookup, saveLabel,
  type OutsideLookupResult, type OutsidePerson,
} from "@shared/recordLookup";
import { queueIdentityKeys } from "./services/are/queueIdentity";
import { buildCatalogFrom, searchCatalog, LOOKUP_SAVE_PATH, type CatalogEntry } from "./services/assistantActionCatalog";
import { lookupSaveSchema } from "./routers/search";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const CALLER = { workspaceId: 2, userId: 9, isAdmin: false };
const q = (s: string) => parseRecordSearch(s)!;

/** select().from(table).where().orderBy().limit(): each table answers from its own rows. */
function makeDb() {
  return {
    select: () => {
      let table: unknown = null;
      const rows = () => (table === prospectSearchRuns ? h.runRows : table === prospectSearchResults ? h.staged : table === prospects ? h.people : []);
      const b: any = {
        from(t: unknown) { table = t; return b; },
        where() { return b; },
        orderBy() { return b; },
        limit(n: number) { return Promise.resolve(rows().slice(0, n)); },
        then(res: (v: unknown) => void) { return res(rows()); },
      };
      return b;
    },
  };
}

const record = (over: Record<string, unknown> = {}) => ({
  externalId: "x1", firstName: "Jane", lastName: "Doe", jobTitle: "Director", seniority: null,
  companyName: "Acme Foundation", companyDomain: "acme.org", email: null, emailIsMasked: false, emailVerifiedAt: null,
  mobilePhone: null, businessPhone: null, linkedinUrl: null, city: "Austin", stateProvince: "TX", country: "US",
  industry: "Nonprofit", headcount: "51-200", rawSourcePayload: {}, ...over,
});
const staged = (id: number, slug: string, rec: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id, workspaceId: 2, runId: 77, sourceSlug: slug, externalId: String(rec.externalId ?? id), normalized: rec,
  isNetNew: true, wasCharged: false, emailIsMasked: !!rec.emailIsMasked, promotedProspectId: null, ...over,
});
const run = (results: unknown[], over: Record<string, unknown> = {}) => ({
  run: { id: 77, status: "complete", error: null, perSource: { apollo: { slug: "apollo", searched: 3 } }, ...over },
  results,
});
const hit = (over: Record<string, unknown> = {}) => ({
  name: "Jane Doe", firstName: "Jane", lastName: "Doe", headline: "Director at Acme", location: "Austin, TX",
  company: "Acme Foundation", linkedinUrl: "https://www.linkedin.com/in/jane-doe", profilePictureUrl: null, networkDistance: "2", ...over,
});

beforeEach(() => {
  h.db = makeDb();
  h.linkedin = { ok: true, viaAccountId: "acct", hits: [], message: "" };
  h.linkedinCalls = []; h.startCalls = []; h.startError = null; h.getRunCalls = []; h.promoteCalls = [];
  h.run = run([]);
  h.promote = () => ({ promoted: 1, acquired: 0, unitsSpent: 0, failed: 0, discoveryRunId: 1, errors: [] });
  h.configured = true;
  h.index = new Map();
  h.match = { accountId: null, confidence: "no_match" };
  h.matchCalls = []; h.createdAccounts = []; h.savedFinds = [];
  h.runRows = [{ id: 77 }]; h.staged = []; h.people = [];
});

describe("what is looked up for what was typed", () => {
  it("a name is looked up as a person on LinkedIn and by keyword, or as a company by its name", () => {
    expect(lookupKindsFor(q("jane doe"))).toEqual(["person", "company"]);
    expect(planLookup(q("jane doe"), "person")).toMatchObject({ kind: "person", linkedin: true, keywords: ["jane doe"], companyNames: [], companyDomains: [], note: null });
    expect(planLookup(q("acme foundation"), "company")).toMatchObject({ kind: "company", linkedin: false, keywords: [], companyNames: ["acme foundation"], companyDomains: [] });
  });

  it("an email address is looked up as its company, and the box says why", () => {
    expect(lookupKindsFor(q("jane@acme.org"))).toEqual(["company"]);
    // Asked for as a person, it is still the company: no source reverses an address.
    const plan = planLookup(q("jane@acme.org"), "person");
    expect(plan).toMatchObject({ kind: "company", linkedin: false, keywords: [], companyDomains: ["acme.org"], subject: "acme.org" });
    expect(plan.note).toBe(NO_EMAIL_LOOKUP_NOTE);
  });

  it("a bare domain is its company, with nothing to explain", () => {
    expect(lookupKindsFor(q("acme.org"))).toEqual(["company"]);
    expect(planLookup(q("acme.org"), "company")).toMatchObject({ kind: "company", companyDomains: ["acme.org"], note: null });
  });

  it("a row is only kept when it is about what was typed", () => {
    const person = planLookup(q("jane doe"), "person");
    expect(matchesLookup(person, q("jane doe"), record())).toBe(true);
    expect(matchesLookup(person, q("jane doe"), record({ firstName: "Robert", lastName: "Smith" }))).toBe(false);
    const company = planLookup(q("acme"), "company");
    expect(matchesLookup(company, q("acme"), record())).toBe(true);
    // A person NAMED Acme at another company is not that company.
    expect(matchesLookup(company, q("acme"), record({ firstName: "Acme", companyName: "Globex", companyDomain: "globex.com" }))).toBe(false);
    const domain = planLookup(q("acme.org"), "company");
    expect(matchesLookup(domain, q("acme.org"), record({ companyDomain: "www.acme.org" }))).toBe(true);
    expect(matchesLookup(domain, q("acme.org"), record({ companyDomain: "notacme.org" }))).toBe(false);
    // A masked address still names its domain.
    expect(matchesLookup(domain, q("acme.org"), record({ companyDomain: null, email: "j***@acme.org", emailIsMasked: true }))).toBe(true);
  });
});

describe("the lookup", () => {
  it("asks LinkedIn through the account's own gate, and the databases through the free door", async () => {
    await lookupOutside(CALLER, "Jane Doe", "person");
    expect(h.linkedinCalls).toHaveLength(1);
    expect(h.linkedinCalls[0]).toMatchObject({ workspaceId: 2, userId: 9, isAdmin: false, keywords: "Jane Doe", limit: LOOKUP_TARGET, source: "search_box" });
    // Not the bypass for enriching one record: a paused account stays paused.
    expect(h.linkedinCalls[0].personInitiated).toBeUndefined();
    expect(h.startCalls).toHaveLength(1);
    const [ws, user, criteria, target, only] = h.startCalls[0];
    expect([ws, user, target]).toEqual([2, 9, LOOKUP_TARGET]);
    expect(criteria).toMatchObject({ keywords: ["Jane Doe"], companyNames: [], companyDomains: [] });
    // null = connected sources whose preview is free; a billed preview is never asked.
    expect(only).toBeNull();
  });

  it("a company is not a LinkedIn search", async () => {
    await lookupOutside(CALLER, "Acme Foundation", "company");
    expect(h.linkedinCalls).toHaveLength(0);
    expect(h.startCalls[0][2]).toMatchObject({ keywords: [], companyNames: ["Acme Foundation"] });
  });

  it("LinkedIn rows carry a clean name and a profile, and say who is here already", async () => {
    h.linkedin.hits = [hit({ lastName: "Doe, MBA" }), hit({ firstName: "Sam", lastName: "Roe", linkedinUrl: "" }), hit({ firstName: "Ann", lastName: "Poe", linkedinUrl: "https://www.linkedin.com/in/ann-poe" })];
    for (const k of queueIdentityKeys({ linkedinUrl: "https://www.linkedin.com/in/ann-poe" })) h.index.set(k, { where: "people", prospectId: 31, campaignId: null });
    const r = await lookupOutside(CALLER, "jane doe", "person");
    expect(r.searched).toContain("LinkedIn");
    // No profile, nothing to save: not offered.
    expect(r.people.map((p) => p.name)).toEqual(["Jane Doe", "Ann Poe"]);
    expect(r.people[0]).toMatchObject({ ref: "li:0", via: "LinkedIn", already: null, saveCost: 0, email: null, emailHidden: false });
    expect(r.people[0].save).toMatchObject({ type: "linkedin_person", firstName: "Jane", lastName: "Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe" });
    expect(r.people[1].already).toEqual({ href: "/prospects/31" });
  });

  it("a held LinkedIn search is said, and the databases still answer", async () => {
    h.linkedin = { ok: false, viaAccountId: "acct", hits: [], message: "LinkedIn activity is paused for this account.", blocked: "disabled" };
    h.run = run([staged(1, "apollo", record())]);
    const r = await lookupOutside(CALLER, "jane doe", "person");
    expect(r.searched).toEqual(["Apollo.io"]);
    expect(r.notes).toContain("LinkedIn was not searched: LinkedIn activity is paused for this account.");
    expect(r.people.map((p) => p.ref)).toEqual(["src:1"]);
  });

  it("with no database connected none is started, and the result says so", async () => {
    h.configured = false;
    const r = await lookupOutside(CALLER, "jane doe", "person");
    expect(h.startCalls).toHaveLength(0);
    expect(r.notes.join(" ")).toContain("No prospect database is connected");
  });

  it("database rows: a masked address is not shown, an unrelated row is left out, the cost is on the row", async () => {
    h.run = run([
      staged(1, "warmysender", record({ email: "j***@acme.org", emailIsMasked: true })),
      staged(2, "apollo", record({ externalId: "x2", email: "jane@acme.org" })),
      staged(3, "apollo", record({ externalId: "x3", firstName: "Robert", lastName: "Smith" })),
      staged(4, "apollo", record({ externalId: "x4" }), { promotedProspectId: 55 }),
    ], { perSource: { warmysender: { slug: "warmysender" }, apollo: { slug: "apollo" } } });
    const r = await lookupOutside(CALLER, "jane doe", "person");
    const rows = r.people.filter((p) => p.ref.startsWith("src:"));
    expect(rows.map((p) => p.ref)).toEqual(["src:1", "src:2", "src:4"]);
    expect(rows[0]).toMatchObject({ via: "WarmySender", email: null, emailHidden: true, saveCost: 1, save: { type: "source_person", runId: 77, resultId: 1 } });
    expect(rows[1]).toMatchObject({ via: "Apollo.io", email: "jane@acme.org", emailHidden: false, saveCost: 0 });
    // Saved before: it opens, and saving it again spends nothing.
    expect(rows[2]).toMatchObject({ already: { href: "/prospects/55" }, saveCost: 0 });
    expect(r.searched).toEqual(expect.arrayContaining(["WarmySender", "Apollo.io"]));
  });

  it("a row someone already in People matches opens them", async () => {
    for (const k of queueIdentityKeys({ firstName: "Jane", lastName: "Doe", companyDomain: "acme.org" })) h.index.set(k, { where: "people", prospectId: 12, campaignId: null });
    h.run = run([staged(1, "warmysender", record())]);
    const r = await lookupOutside(CALLER, "jane doe", "person");
    expect(r.people.find((p) => p.ref === "src:1")).toMatchObject({ already: { href: "/prospects/12" }, saveCost: 0 });
  });

  it("a search still going is handed back as pending, and picked up without a second LinkedIn search", async () => {
    h.run = run([], { status: "running" });
    const first = await lookupOutside(CALLER, "jane doe", "person", null, { waitMs: 0 });
    expect(first.pending).toEqual({ runId: 77 });
    h.linkedinCalls = []; h.startCalls = []; h.getRunCalls = [];
    h.run = run([staged(1, "apollo", record())]);
    const rest = await lookupOutside(CALLER, "jane doe", "person", 77);
    expect(h.linkedinCalls).toHaveLength(0);
    expect(h.startCalls).toHaveLength(0);
    expect(h.getRunCalls[0]).toEqual([2, 77]);
    expect(rest.pending).toBeNull();
    expect(rest.people.map((p) => p.ref)).toEqual(["src:1"]);
  });

  it("a company is read off the people found there, and matched against Companies", async () => {
    h.run = run([
      staged(1, "apollo", record()),
      staged(2, "apollo", record({ externalId: "x2", firstName: "Sam", lastName: "Roe" })),
      staged(3, "apollo", record({ externalId: "x3", firstName: "Lee", lastName: "Poe", companyName: "Acme Labs", companyDomain: "acmelabs.io", industry: null, headcount: null })),
    ]);
    const r = await lookupOutside(CALLER, "acme", "company");
    expect(r.companies.map((c) => [c.name, c.domain, c.peopleFound, c.typed])).toEqual([["Acme Foundation", "acme.org", 2, false], ["Acme Labs", "acmelabs.io", 1, false]]);
    expect(r.companies[0]).toMatchObject({ industry: "Nonprofit", size: "51-200 employees", already: null, save: { type: "company", name: "Acme Foundation", domain: "acme.org" } });
    h.match = { accountId: 44, confidence: "exact_match" };
    const again = await lookupOutside(CALLER, "acme", "company");
    expect(again.companies[0].already).toEqual({ href: "/v2/companies/44" });
  });

  it("when no source returns the company, it can still be created from what was typed", async () => {
    h.run = run([], { perSource: { warmysender: { slug: "warmysender" }, apollo: { skipped: "cannot_honour", detail: "cannot filter on companyDomain" } } });
    const r = await lookupOutside(CALLER, "jane@acme.org", "person");
    expect(r.kind).toBe("company");
    expect(r.companies).toHaveLength(1);
    expect(r.companies[0]).toMatchObject({ ref: "co:typed", domain: "acme.org", typed: true, peopleFound: 0, save: { type: "company", domain: "acme.org" } });
    expect(r.notes).toContain(NO_EMAIL_LOOKUP_NOTE);
    expect(r.notes.join(" ")).toContain("It can still be created with no details yet");
  });

  it("says which databases could not run this kind of lookup, and a source's own error", async () => {
    h.run = run([], { perSource: { apollo: { skipped: "cannot_honour", detail: "cannot filter on companyDomain" }, quickenrich: { skipped: "cannot_honour", detail: "x" } } });
    const none = await lookupOutside(CALLER, "acme.org", "company");
    expect(none.notes.join(" ")).toContain("Apollo.io, QuickEnrich cannot search by company domain");
    h.run = run([], { perSource: { apollo: { slug: "apollo", error: "rate limited" } } });
    const failed = await lookupOutside(CALLER, "jane doe", "person");
    expect(failed.notes).toContain("Apollo.io: rate limited");
  });

  it("a search that could not be started is a note, not a crash", async () => {
    h.startError = "boom";
    const r = await lookupOutside(CALLER, "jane doe", "person");
    expect(r.notes.join(" ")).toContain("The databases were not searched: boom");
    expect(r.pending).toBeNull();
  });
});

describe("saving a found row", () => {
  it("a company already in Companies is opened, not made twice", async () => {
    h.match = { accountId: 44, confidence: "high_confidence" };
    const r = await saveFromLookup(CALLER, { type: "company", name: "Acme Foundation", domain: "https://www.acme.org/about" });
    expect(r).toMatchObject({ kind: "company", id: 44, href: "/v2/companies/44", created: false, unitsSpent: 0 });
    expect(h.createdAccounts).toHaveLength(0);
    // Matched on the cleaned domain, not on what was typed.
    expect(h.matchCalls[0]).toEqual([2, { name: "Acme Foundation", domain: "acme.org" }]);
  });

  it("a possible match is not taken for the same company: a new one is created", async () => {
    h.match = { accountId: 44, confidence: "possible_match" };
    const r = await saveFromLookup(CALLER, { type: "company", name: "Acme Foundation", domain: "acme.org" });
    expect(r).toMatchObject({ kind: "company", id: 901, href: "/v2/companies/901", created: true });
    expect(h.createdAccounts).toEqual([[2, { name: "Acme Foundation", domain: "acme.org" }, "search_lookup"]]);
  });

  it("a LinkedIn person already in People is opened, with nothing saved", async () => {
    for (const k of queueIdentityKeys({ linkedinUrl: "https://www.linkedin.com/in/jane-doe" })) h.index.set(k, { where: "people", prospectId: 12, campaignId: null });
    const r = await saveFromLookup(CALLER, { type: "linkedin_person", firstName: "Jane", lastName: "Doe", linkedinUrl: "https://www.linkedin.com/in/jane-doe" });
    expect(r).toMatchObject({ kind: "person", id: 12, href: "/prospects/12", created: false });
    expect(h.savedFinds).toHaveLength(0);
  });

  it("a LinkedIn person goes through the Find prospects save, and opens the record they became", async () => {
    h.people = [{ id: 88, email: null, linkedinUrl: "https://www.linkedin.com/in/jane-doe", firstName: "Jane", lastName: "Doe", companyName: "Acme Foundation", companyDomain: null }];
    const r = await saveFromLookup(CALLER, { type: "linkedin_person", firstName: "Jane", lastName: "Doe, MBA", title: "Director", company: "Acme Foundation", linkedinUrl: "https://www.linkedin.com/in/jane-doe", location: "Austin" });
    expect(h.savedFinds).toHaveLength(1);
    const [ws, user, source, finds] = h.savedFinds[0];
    expect([ws, user, source]).toEqual([2, 9, "linkedin_search"]);
    // The credential is not part of the name.
    expect(finds).toEqual([expect.objectContaining({ firstName: "Jane", lastName: "Doe", title: "Director", companyName: "Acme Foundation", linkedinUrl: "https://www.linkedin.com/in/jane-doe" })]);
    expect(r).toMatchObject({ kind: "person", id: 88, href: "/prospects/88", created: true, unitsSpent: 0 });
  });

  it("a LinkedIn person the save left out is reported, not opened as somebody else", async () => {
    // Someone with the same name at another company is not them.
    h.people = [{ id: 70, email: null, linkedinUrl: "https://www.linkedin.com/in/other-jane", firstName: "Jane", lastName: "Doe", companyName: "Globex", companyDomain: null }];
    await expect(saveFromLookup(CALLER, { type: "linkedin_person", firstName: "Jane", lastName: "Doe", company: "Acme Foundation", linkedinUrl: "https://www.linkedin.com/in/jane-doe" }))
      .rejects.toThrow(/was not saved/);
  });

  it("a database row that is not this workspace's is not found, and nothing is bought", async () => {
    h.runRows = [];
    h.staged = [staged(1, "warmysender", record())];
    await expect(saveFromLookup(CALLER, { type: "source_person", runId: 77, resultId: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.promoteCalls).toHaveLength(0);
  });

  it("a database row saved before is opened, and not bought again", async () => {
    h.staged = [staged(1, "warmysender", record(), { promotedProspectId: 55 })];
    const r = await saveFromLookup(CALLER, { type: "source_person", runId: 77, resultId: 1 });
    expect(r).toMatchObject({ id: 55, href: "/prospects/55", created: false, unitsSpent: 0 });
    expect(h.promoteCalls).toHaveLength(0);
  });

  it("a database row is saved through Source search's own save, one row, and says what it spent", async () => {
    const row = staged(1, "warmysender", record());
    h.staged = [row];
    h.promote = () => { row.promotedProspectId = 60 as never; return { promoted: 1, acquired: 1, unitsSpent: 1, failed: 0, discoveryRunId: 3, errors: [] }; };
    const r = await saveFromLookup(CALLER, { type: "source_person", runId: 77, resultId: 1 });
    expect(h.promoteCalls).toEqual([[2, 9, 77, [1]]]);
    expect(r).toMatchObject({ kind: "person", id: 60, href: "/prospects/60", created: true, unitsSpent: 1 });
    expect(r.message).toBe("Saved Jane Doe to People, using 1 WarmySender credit.");
  });

  it("a database row the save left out is an error carrying the reason", async () => {
    h.staged = [staged(1, "warmysender", record())];
    h.promote = () => ({ promoted: 0, acquired: 0, unitsSpent: 0, failed: 1, discoveryRunId: null, errors: ["WarmySender: allowance exhausted for this period"] });
    await expect(saveFromLookup(CALLER, { type: "source_person", runId: 77, resultId: 1 })).rejects.toThrow("Jane Doe was not saved: WarmySender: allowance exhausted for this period");
  });
});

describe("what the box and Elsie say before saving", () => {
  const person = (over: Partial<OutsidePerson>): OutsidePerson => ({
    ref: "src:1", via: "WarmySender", name: "Jane Doe", title: "Director", company: "Acme", domain: "acme.org", location: "Austin",
    linkedinUrl: null, email: null, emailHidden: true, already: null, saveCost: 1, save: { type: "source_person", runId: 77, resultId: 1 }, ...over,
  });

  it("the row's label says open, create, or what creating spends", () => {
    expect(saveLabel(person({ already: { href: "/prospects/1" } }))).toBe("In People · open");
    expect(saveLabel(person({}))).toBe("Create · 1 WarmySender credit");
    expect(saveLabel(person({ saveCost: 3, via: "LeadOcean" }))).toBe("Create · 3 LeadOcean credits");
    expect(saveLabel(person({ saveCost: 0, via: "LinkedIn" }))).toBe("Create record");
  });

  it("a held-back address is said, never printed", () => {
    expect(outsidePersonDetail(person({}))).toBe("Director · Acme · email shown once saved · Austin · via WarmySender");
    expect(outsidePersonDetail(person({ email: "jane@acme.org", emailHidden: false }))).toContain("jane@acme.org");
  });

  it("asking again for the rest keeps the first answer's LinkedIn rows", () => {
    const base: OutsideLookupResult = { query: "jane doe", kind: "person", subject: "jane doe", people: [], companies: [], searched: [], notes: [], pending: null };
    const first = { ...base, people: [person({ ref: "li:0", via: "LinkedIn" })], searched: ["LinkedIn"], notes: ["a"], pending: { runId: 77 } };
    const rest = { ...base, people: [person({ ref: "src:1" })], searched: ["Apollo.io"], notes: ["a", "b"] };
    const all = mergeLookup(first, rest);
    expect(all.people.map((p) => p.ref)).toEqual(["li:0", "src:1"]);
    expect(all.searched).toEqual(["LinkedIn", "Apollo.io"]);
    expect(all.notes).toEqual(["a", "b"]);
    expect(all.pending).toBeNull();
  });

  it("Elsie's card names who is saved, from where, and what it spends", async () => {
    h.staged = [staged(1, "warmysender", record())];
    expect(await describeLookupSave(2, { type: "source_person", runId: 77, resultId: 1 }))
      .toBe("Saves Jane Doe (Acme Foundation) to People from WarmySender. ⚠ Spends 1 WarmySender credit.");
    h.staged = [staged(1, "apollo", record())];
    expect(await describeLookupSave(2, { type: "source_person", runId: 77, resultId: 1 })).toContain("from Apollo.io. Spends nothing.");
    h.staged = [];
    expect(await describeLookupSave(2, { type: "source_person", runId: 77, resultId: 1 })).toContain("this will fail");
    expect(await describeLookupSave(2, { type: "linkedin_person", firstName: "Jane", lastName: "Doe", company: "Acme", linkedinUrl: "u" })).toBe("Saves Jane Doe (Acme) to People from LinkedIn, unless they are there already. Spends nothing.");
    expect(await describeLookupSave(2, { type: "company", name: "Acme", domain: "acme.org" })).toContain("Creates the company Acme (acme.org)");
  });
});

describe("the endpoints, and Elsie", () => {
  let catalog: CatalogEntry[] = [];
  let procedures: Record<string, { _def: { type: string } }> = {};
  beforeAll(async () => {
    const { appRouter } = await import("./routers");
    procedures = (appRouter as unknown as { _def: { procedures: typeof procedures } })._def.procedures;
    catalog = buildCatalogFrom(appRouter as never);
  }, 120_000);

  it("the lookup is a read Elsie can run, and the save is a write she can only propose", () => {
    expect(procedures["search.lookup"]._def.type).toBe("query");
    expect(procedures["search.createFromLookup"]._def.type).toBe("mutation");
    expect(catalog.find((a) => a.path === "search.lookup")?.kind).toBe("query");
    expect(catalog.find((a) => a.path === LOOKUP_SAVE_PATH)?.kind).toBe("mutation");
    // The search router is exactly these three: opening it to Elsie opens nothing else.
    expect(Object.keys(procedures).filter((p) => p.startsWith("search.")).sort()).toEqual(["search.createFromLookup", "search.lookup", "search.records"]);
  });

  it("Elsie finds them by what people ask, and the pinned rankings still hold", () => {
    for (const ask of ["look someone up outside our records", "find this person on linkedin and the prospect databases"]) {
      expect(searchCatalog(catalog, ask).slice(0, 3).map((x) => x.path), ask).toContain("search.lookup");
    }
    expect(searchCatalog(catalog, "save the looked-up row as a record here").slice(0, 3).map((x) => x.path)).toContain(LOOKUP_SAVE_PATH);
    // The workspace's own records are still the first answer to a plain "find".
    for (const ask of ["look up a company by name", "find a person by email address", "who is jane doe"]) {
      expect(searchCatalog(catalog, ask).slice(0, 3).map((x) => x.path), ask).toContain("search.records");
    }
    expect(searchCatalog(catalog, "create sequence").map((x) => x.path)).toContain("sequences.create");
    expect(searchCatalog(catalog, "add people to campaign").map((x) => x.path)).toContain("are.prospects.pushExisting");
    expect(searchCatalog(catalog, "save report", "Analytics").map((x) => x.path)).toContain("reports.save");
  });

  it("the save takes only a row shaped like the ones the lookup hands out", () => {
    expect(lookupSaveSchema.safeParse({ type: "source_person", runId: 77, resultId: 1 }).success).toBe(true);
    expect(lookupSaveSchema.safeParse({ type: "source_person", runId: -1, resultId: 1 }).success).toBe(false);
    expect(lookupSaveSchema.safeParse({ type: "linkedin_person", firstName: "Jane", lastName: "", linkedinUrl: "https://linkedin.com/in/j" }).success).toBe(false);
    expect(lookupSaveSchema.safeParse({ type: "company", name: " " }).success).toBe(false);
    expect(lookupSaveSchema.safeParse({ type: "lead", name: "x" }).success).toBe(false);
  });

  it("the router passes the caller's own role, waits on no client claim, and audits a record it created", () => {
    const src = read("./routers/search.ts");
    const lookup = src.slice(src.indexOf("  lookup: workspaceProcedure"), src.indexOf("  createFromLookup: workspaceProcedure"));
    expect(lookup).toContain(".query(");
    expect(lookup).toContain("isAdmin: isAdminRole(ctx.member.role)");
    expect(lookup).toContain("ctx.workspace.id");
    const save = src.slice(src.indexOf("  createFromLookup: workspaceProcedure"));
    expect(save).toContain(".mutation(");
    expect(save).toContain("if (r.created) {");
    expect(save).toContain('after: { via: "search_lookup", from: input.save.type, unitsSpent: r.unitsSpent }');
  });

  it("Elsie's card for the save is written from the row, on the propose leg", () => {
    const src = read("./routers/assistant.ts");
    const at = src.indexOf("if (entry.path === LOOKUP_SAVE_PATH) {");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 400);
    expect(block).toContain("describeLookupSave(ctx.workspace.id");
    // After the generic sentence, so it replaces it.
    expect(src.slice(0, at)).toContain("description = describeGenericAction(entry, args.input);");
    expect(src).toContain("- Finding someone: search.records first.");
    expect(src).toContain("Never save a row the user did not pick.");
  });

  it("the service reads staged rows only inside the workspace, and never uses the LinkedIn bypass", () => {
    const src = read("./services/recordLookup.ts");
    const stagedRow = src.slice(src.indexOf("async function stagedRow"), src.indexOf("/** The People record a just-saved"));
    expect(stagedRow).toContain("eq(prospectSearchRuns.workspaceId, workspaceId)");
    expect(stagedRow).toContain("eq(prospectSearchResults.workspaceId, workspaceId)");
    const saved = src.slice(src.indexOf("async function personSavedAs"), src.indexOf("/** Save one row a lookup handed out."));
    expect(saved).toContain("eq(prospects.workspaceId, workspaceId)");
    expect(src).not.toMatch(/personInitiated:\s*true/);
    expect(src).toContain("LOOKUP_TARGET, null)");
  });
});

describe("the search box", () => {
  const src = read("../client/src/components/usip/CommandPalette.tsx");
  const fn = (name: string, next: string) => src.slice(src.indexOf(name), src.indexOf(next));

  it("looks outside on a press, never as a watched query or an effect", () => {
    expect(src).toContain("utils.search.lookup.fetch({ q, kind }, { staleTime: 60_000 })");
    expect(src).not.toContain("search.lookup.useQuery");
    // The only caller is the row's own press.
    expect(src.match(/lookUp\(/g)).toHaveLength(1);
    expect(src).toContain("onSelect={() => void lookUp(kind)}");
    for (const m of src.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/g) ?? []) expect(m).not.toContain("lookUp");
  });

  it("offers the lookup once the records have answered, with the kinds that fit what was typed", () => {
    expect(src).toContain("{!waiting && data ? (");
    expect(src).toContain("lookupKindsFor(typed).map((kind) => {");
    expect(src).toContain('heading={hits.length === 0 ? "Look outside your records" : "Not the one? Look outside your records"}');
  });

  it("what was found belongs to the text it was found for, and only the latest lookup writes", () => {
    expect(src).toContain("const found = outside && typed && outside.q === typed.text ? outside : null;");
    const look = fn("const lookUp = async", "/** Save one found row");
    expect(look).toContain("const seq = ++lookupSeq.current;");
    expect(look).toContain('if (mine()) setOutside({ q, kind, status: "done", data: all });');
    // The rest of a search still going is asked for by run id, a bounded number of times.
    expect(look).toContain("for (let i = 0; r.pending && i < LOOKUP_RESUMES && mine(); i++) {");
    expect(look).toContain("runId: r.pending.runId");
    expect(look).toContain("all = mergeLookup(all, r);");
  });

  it("a row already here opens, a row that spends is pressed twice, and one save runs at a time", () => {
    const press = fn("const pressFound = ", "  // The pages:");
    expect(press).toContain("if (row.already) return go(row.already.href);");
    expect(press).toContain("if ((row.saveCost ?? 0) > 0 && armed !== row.ref) return setArmed(row.ref);");
    const save = fn("const saveRow = async", "const pressFound = ");
    expect(save).toContain("if (saving) return;");
    expect(save).toContain("createFromLookup.mutateAsync({ save })");
    expect(save).toContain("go(r.href);");
    expect(src).toContain("`Press again to spend ${p.saveCost} ${p.saveCost === 1 ? \"credit\" : \"credits\"}`");
  });

  it("closing the box drops the lookup and anything armed", () => {
    expect(src).toContain('if (!open) { setText(""); setAsked(""); setOutside(null); setArmed(null); setSaving(null); lookupSeq.current += 1; }');
  });

  it("the help and Elsie's manual describe it", () => {
    expect(read("./productKnowledge.ts")).toContain("search.records and search.lookup are the same reads for you.");
    const help = read("./seedHelpContent.ts");
    expect(help).toContain("Velocity asks LinkedIn and your connected prospect databases");
    // The old sentence sent people to the list pages to find a person.
    expect(help).not.toContain("to find a person or a company, use the search box on People or Companies");
  });
});
