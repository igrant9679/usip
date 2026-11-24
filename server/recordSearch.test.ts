/**
 * Owner, 2026-11-23: "The search is confusing the way it is now", and "Is
 * there a simple way to type in a company name, person's name or email
 * address and see their enriched info?"
 *
 * The header's "Search…" box only jumped to pages: typed into the live site,
 * "foundation" found Sales Pipeline and Email Sending, and no person or
 * company. Nothing searched people, companies and leads together.
 *
 * Held here:
 *   1. how what was typed is read (a name, an email address, a bare domain);
 *   2. the read: every word must match, every statement is scoped to the
 *      workspace, what was typed is never a LIKE pattern, archived records
 *      stay out, and it is capped;
 *   3. the box asks the server instead of filtering page names, and Elsie
 *      has the same read.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import { accounts, leads, prospects } from "../drizzle/schema";

type Stmt = { table: unknown; where: SQL | undefined; orderBy: unknown[]; limit: number | null; grouped: boolean };
const h = vi.hoisted(() => ({
  db: null as any,
  stmts: [] as any[],
  rows: { people: [] as any[], companies: [] as any[], leads: [] as any[], counts: [] as any[] },
}));
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));

import { escapeLike, searchRecords } from "./services/recordSearch";
import { RECORD_SEARCH_PER_KIND, hitDetail, parseRecordSearch } from "@shared/recordSearch";
import { ALLOWED_GROUPS, buildCatalogFrom, searchCatalog, type CatalogEntry } from "./services/assistantActionCatalog";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const dialect = new MySqlDialect();
const render = (s: SQL | undefined) => (s ? dialect.sqlToQuery(s) : { sql: "", params: [] as unknown[] });

function makeDb() {
  return {
    select: () => {
      const st: Stmt = { table: null, where: undefined, orderBy: [], limit: null, grouped: false };
      const out = () => (st.grouped ? h.rows.counts : st.table === prospects ? h.rows.people : st.table === accounts ? h.rows.companies : st.table === leads ? h.rows.leads : []);
      const b: any = {
        from(t: unknown) { st.table = t; h.stmts.push(st); return b; },
        where(w: SQL) { st.where = w; return b; },
        orderBy(...o: unknown[]) { st.orderBy = o; return b; },
        groupBy() { st.grouped = true; return b; },
        limit(n: number) { st.limit = n; return b; },
        then(res: (v: unknown) => void) { return res(st.limit != null ? out().slice(0, st.limit) : out()); },
      };
      return b;
    },
  };
}

const person = (id: number, over: Record<string, unknown> = {}) => ({
  id, firstName: "Jane", lastName: `Doe${id}`, title: "Director", company: "Acme", email: `jane${id}@acme.org`, emailStatus: "verified",
  phone: null, linkedinUrl: null, city: "Austin", state: "TX", country: "US", lastEnrichedAt: new Date("2026-11-01T00:00:00Z"), ...over,
});
const company = (id: number, over: Record<string, unknown> = {}) => ({
  id, name: `Acme ${id}`, domain: "acme.org", normalizedDomain: "acme.org", industry: "Nonprofit", employeeCount: 1200, employeeBand: null,
  hqCity: "Austin", hqState: "TX", hqCountry: "US", ...over,
});
const lead = (id: number, over: Record<string, unknown> = {}) => ({
  id, firstName: "Jane", lastName: `Lead${id}`, title: null, company: "Acme", email: null, phone: null, status: "new", score: 40, ...over,
});

const stmtFor = (t: unknown, grouped = false) => h.stmts.find((s: Stmt) => s.table === t && s.grouped === grouped) as Stmt;

beforeEach(() => {
  h.db = makeDb();
  h.stmts = [];
  h.rows = { people: [], companies: [], leads: [], counts: [] };
});

describe("reading what was typed", () => {
  it("too little is not a search", () => {
    expect(parseRecordSearch("")).toBeNull();
    expect(parseRecordSearch("  a ")).toBeNull();
    expect(parseRecordSearch(null)).toBeNull();
    expect(parseRecordSearch("ab")).toMatchObject({ text: "ab", words: ["ab"] });
  });

  it("a name is words, each of which must be found", () => {
    expect(parseRecordSearch("  Jane   Doe  ")).toEqual({ text: "Jane Doe", words: ["Jane", "Doe"], email: null, domain: null });
    expect(parseRecordSearch("a b c d e f g h")!.words).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(parseRecordSearch("x".repeat(500))!.text.length).toBe(120);
  });

  it("an email address is known as one, with its domain", () => {
    expect(parseRecordSearch("Jane.Doe@Acme.org")).toEqual({ text: "Jane.Doe@Acme.org", words: ["Jane.Doe@Acme.org"], email: "jane.doe@acme.org", domain: "acme.org" });
    // Two things typed are not an address.
    expect(parseRecordSearch("jane doe@acme.org")!.email).toBeNull();
    expect(parseRecordSearch("jane@acme")!.email).toBeNull();
  });

  it("a bare domain is known as one; a name with a dot is not mistaken for it", () => {
    expect(parseRecordSearch("acme.org")).toMatchObject({ email: null, domain: "acme.org" });
    expect(parseRecordSearch("https://www.Acme.org/about")).toMatchObject({ domain: "acme.org" });
    expect(parseRecordSearch("st. jude")!.domain).toBeNull();
    expect(parseRecordSearch("acme")!.domain).toBeNull();
  });
});

describe("the read", () => {
  it("asks for nothing when there is too little to search for", async () => {
    const r = await searchRecords(2, " j ");
    expect(r).toEqual({ query: "j", people: [], companies: [], leads: [], more: { people: false, companies: false, leads: false } });
    expect(h.stmts).toEqual([]);
  });

  it("every statement is scoped to the workspace", async () => {
    h.rows.companies = [company(1)];
    await searchRecords(42, "jane acme");
    expect(h.stmts.length).toBe(4); // people, companies, leads, people per company
    for (const s of h.stmts as Stmt[]) {
      const { sql, params } = render(s.where);
      expect(sql, sql).toContain("`workspaceId` = ?");
      expect(params, sql).toContain(42);
    }
  });

  it("every word must be found on the record: one AND per word, across its fields", async () => {
    await searchRecords(2, "jane acme");
    const p = render(stmtFor(prospects).where);
    expect(p.params.filter((x) => x === "%jane%").length).toBe(5); // first, last, company, title, email
    expect(p.params.filter((x) => x === "%acme%").length).toBe(5);
    expect(p.sql).toMatch(/\(`prospects`\.`firstName` like \? or `prospects`\.`lastName` like \? or `prospects`\.`company` like \? or `prospects`\.`title` like \? or `prospects`\.`email` like \?\) and \(`prospects`\.`firstName` like \?/);
    const c = render(stmtFor(accounts).where);
    expect(c.params.filter((x) => x === "%jane%").length).toBe(3); // name, domain, normalized domain
    expect(c.params.filter((x) => x === "%acme%").length).toBe(3);
    const l = render(stmtFor(leads).where);
    expect(l.params.filter((x) => x === "%jane%").length).toBe(4); // first, last, company, email
    expect(l.params.filter((x) => x === "%acme%").length).toBe(4);
  });

  it("what was typed is never a pattern: % and _ are escaped", async () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
    await searchRecords(2, "50%_off");
    for (const t of [prospects, accounts, leads]) {
      const { params } = render(stmtFor(t).where);
      expect(params, String(params)).toContain("%50\\%\\_off%");
      expect(params).not.toContain("%50%_off%");
    }
  });

  it("archived people and archived companies stay out", async () => {
    await searchRecords(2, "jane");
    const p = render(stmtFor(prospects).where);
    expect(p.sql).toContain("(`prospects`.`verificationStatus` is null or `prospects`.`verificationStatus` <> ?)");
    expect(p.params).toContain("rejected");
    expect(render(stmtFor(accounts).where).sql).toContain("`accounts`.`archived_at` is null");
  });

  it("an email address also finds the company whose domain it is on", async () => {
    await searchRecords(2, "jane@acme.org");
    const c = render(stmtFor(accounts).where);
    expect(c.sql).toContain("`accounts`.`normalized_domain` = ?");
    expect(c.sql).toContain("`accounts`.`domain` = ?");
    expect(c.params.filter((x) => x === "acme.org").length).toBe(2);
    // The person is matched on the address itself.
    expect(render(stmtFor(prospects).where).params).toContain("%jane@acme.org%");
    // A plain name adds no domain match.
    h.stmts = [];
    await searchRecords(2, "jane");
    expect(render(stmtFor(accounts).where).sql).not.toContain("`accounts`.`normalized_domain` = ?");
  });

  it("reads one more than it shows, so it can say there are more", async () => {
    h.rows.people = Array.from({ length: 9 }, (_, i) => person(i + 1));
    h.rows.companies = [company(1), company(2)];
    h.rows.leads = Array.from({ length: 7 }, (_, i) => lead(i + 1));
    const r = await searchRecords(2, "jane");
    for (const t of [prospects, accounts, leads]) expect(stmtFor(t).limit).toBe(RECORD_SEARCH_PER_KIND + 1);
    expect(r.people.length).toBe(RECORD_SEARCH_PER_KIND);
    expect(r.leads.length).toBe(RECORD_SEARCH_PER_KIND);
    expect(r.companies.length).toBe(2);
    expect(r.more).toEqual({ people: true, companies: false, leads: true });
    // Never the table, whatever is asked for.
    h.stmts = [];
    await searchRecords(2, "jane", 5000);
    expect(stmtFor(prospects).limit).toBe(26);
  });

  it("each match carries the facts on file, and where it opens", async () => {
    h.rows.people = [person(7, { phone: "+1 512 555 0100", linkedinUrl: "https://www.linkedin.com/in/x" })];
    h.rows.companies = [company(3)];
    h.rows.leads = [lead(9, { email: "j@acme.org" })];
    h.rows.counts = [{ accountId: 3, n: 12 }];
    const r = await searchRecords(2, "acme");
    expect(r.people[0]).toEqual({
      kind: "person", id: 7, href: "/prospects/7", name: "Jane Doe7", title: "Director", company: "Acme",
      email: "jane7@acme.org", emailStatus: "verified", phone: "+1 512 555 0100", linkedinUrl: "https://www.linkedin.com/in/x",
      location: "Austin, TX, US", enrichedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(r.companies[0]).toEqual({
      kind: "company", id: 3, href: "/v2/companies/3", name: "Acme 3", domain: "acme.org", industry: "Nonprofit",
      size: "1,200 employees", location: "Austin, TX, US", people: 12,
    });
    expect(r.leads[0]).toMatchObject({ kind: "lead", id: 9, href: "/leads/9", name: "Jane Lead9", email: "j@acme.org", status: "new", score: 40 });
    expect(hitDetail(r.people[0])).toBe("Director · Acme · jane7@acme.org (verified) · +1 512 555 0100 · Austin, TX, US");
    expect(hitDetail(r.companies[0])).toBe("acme.org · Nonprofit · 1,200 employees · Austin, TX, US · 12 people");
    expect(hitDetail(r.leads[0])).toBe("Acme · j@acme.org · lead: new");
  });

  it("blanks are left out of the line, not printed", () => {
    expect(hitDetail({ kind: "person", id: 1, href: "/prospects/1", name: "A B", title: null, company: " ", email: null, emailStatus: "verified", phone: null, linkedinUrl: null, location: null, enrichedAt: null })).toBe("");
    expect(hitDetail({ kind: "company", id: 1, href: "/v2/companies/1", name: "A", domain: null, industry: null, size: null, location: null, people: 1 })).toBe("1 person");
  });

  it("the count of people per company is asked only for the companies shown", async () => {
    await searchRecords(2, "acme");
    expect(h.stmts.length).toBe(3); // no company matched, so no count
    h.stmts = [];
    h.rows.companies = [company(3), company(4)];
    await searchRecords(2, "acme");
    const count = render(stmtFor(prospects, true).where);
    expect(count.sql).toContain("`prospects`.`account_id` in (?, ?)");
    expect(count.params).toEqual(expect.arrayContaining([2, 3, 4]));
  });

  it("changes nothing and calls no vendor", () => {
    const src = read("./services/recordSearch.ts");
    expect(src).not.toMatch(/\.(insert|update|delete)\(/);
    expect(src).not.toMatch(/fetch\(|unipile|prospectSources|invokeLLM/);
  });
});

describe("the endpoint, and Elsie", () => {
  let procedures: Record<string, { _def?: { type?: string } }> = {};
  let catalog: CatalogEntry[] = [];
  beforeAll(async () => {
    const { appRouter } = await import("./routers");
    procedures = (appRouter as unknown as { _def: { procedures: typeof procedures } })._def.procedures;
    catalog = buildCatalogFrom(appRouter as never);
  }, 120_000);

  it("search.records is a read anyone in the workspace may run", () => {
    expect(procedures["search.records"]._def?.type).toBe("query");
    const src = read("./routers/search.ts");
    expect(src).toMatch(/records: workspaceProcedure\s*\.input\(z\.object\(\{ q: z\.string\(\)\.max\(200\) \}\)\)\s*\.query\(\(\{ ctx, input \}\) => searchRecords\(ctx\.workspace\.id, input\.q\)\)/);
  });

  it("Elsie has the same read, under its own sentence, and finds it in the owner's words", () => {
    expect(ALLOWED_GROUPS.search.group).toBe("CRM");
    const a = catalog.find((x) => x.path === "search.records");
    expect(a).toBeTruthy();
    expect(a!.kind).toBe("query");
    expect(a!.description).toMatch(/^Find a person, a company or a lead by name, company, email address or domain, in one read/);
    for (const ask of ["look up a company by name", "find a person by email address", "who is jane doe"]) {
      expect(searchCatalog(catalog, ask).slice(0, 3).map((x) => x.path), ask).toContain("search.records");
    }
    // The pinned asks keep their own answers.
    expect(searchCatalog(catalog, "create sequence").map((x) => x.path)).toContain("sequences.create");
    expect(searchCatalog(catalog, "add people to campaign").map((x) => x.path)).toContain("are.prospects.pushExisting");
    expect(searchCatalog(catalog, "save report", "Analytics").map((x) => x.path)).toContain("reports.save");
  });
});

describe("the search box", () => {
  const src = read("../client/src/components/usip/CommandPalette.tsx");

  it("asks the server for records instead of filtering page names", () => {
    expect(src).toContain("trpc.search.records.useQuery(");
    expect(src).toContain("{ q: parsed?.text ?? \"\" }");
    expect(src).toContain("enabled: open && !!parsed");
    // cmdk's own filter is off: it would hide a record matched on a field the row does not print.
    expect(src).toContain("<Command shouldFilter={false}");
    expect(src).not.toContain("<CommandDialog");
  });

  it("waits for a pause in typing, and starts empty each time it opens", () => {
    expect(src).toContain("const SEARCH_DEBOUNCE_MS = 250;");
    expect(src).toContain("const t = window.setTimeout(() => setAsked(text), SEARCH_DEBOUNCE_MS);");
    expect(src).toContain('useEffect(() => { if (!open) { setText(""); setAsked(""); } }, [open]);');
  });

  it("records come first, each opening its own page, and the pages follow", () => {
    const people = src.indexOf('<CommandGroup heading="People">');
    const companies = src.indexOf('<CommandGroup heading="Companies">');
    const leadsAt = src.indexOf('<CommandGroup heading="Leads">');
    const pagesAt = src.indexOf("{TOOL_GROUPS.map((group) => {");
    for (const at of [people, companies, leadsAt, pagesAt]) expect(at).toBeGreaterThan(-1);
    expect(src.slice(people, companies)).toContain("{data.people.map(");
    expect(src.slice(companies, leadsAt)).toContain("{data.companies.map(");
    expect(src.slice(leadsAt, pagesAt)).toContain("{data.leads.map(");
    expect(src).toContain("onSelect={() => onGo(hit.href)}");
    expect(src).toContain("const detail = hitDetail(hit);");
    expect(src).toContain("go(`/v2/people?q=${encodeURIComponent(data.query)}`)");
  });

  it("says so when nothing matches, when it is still looking, and when it failed", () => {
    expect(src).toContain("No person, company or lead in this workspace matches");
    expect(src).toContain("Searching your records…");
    expect(src).toContain("The search could not be run. Try again.");
    expect(src).toContain("Type at least {RECORD_SEARCH_MIN} characters to search your records.");
  });

  it("the pages are still all there, matched on every word typed", () => {
    expect(src).toContain("const visible = TOOLS.filter((t) => !t.adminOnly || isAdmin);");
    expect(src).toContain("return words.every((w) => hay.includes(w));");
    expect(src).toContain("if (words.length === 0) return visible;");
  });

  it("says what it finds, where people will read it", async () => {
    expect(src).toContain('placeholder="A name, a company or an email address — or a page"');
    const { PRODUCT_KNOWLEDGE } = await import("./productKnowledge");
    expect(PRODUCT_KNOWLEDGE).toContain("Search (Ctrl+K) finds a person, a company or a lead by name, company or email address");
    expect(read("./seedHelpContent.ts")).toContain("type a person's name, a company or an email address");
  });
});
