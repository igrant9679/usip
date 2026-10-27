/**
 * Company search sorts and pages over ids, then reads only the page's rows
 * (audit 2026-10-20, X4.1). Sorting whole rows carried every column of every
 * match — the inline logo images, notes, custom fields — through the sort,
 * and the first search after a quiet spell took 2.7–5 s live in LSI Media.
 *
 *   the sort and page read ids only · the page reads the columns the table
 *   shows, for the page's ids only · rows that tie keep one order, so a row
 *   is on exactly one page · the page comes back in the sort's order · "Most
 *   contacts" is ordered in SQL across every match, this workspace's links
 *   only · totals and contact counts are unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { getTableName, type SQL } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, wsId: 2, selects: [] as Array<{ table: string; cols: string[] | "*"; limit?: number; where?: string; rows?: number }> };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { searchOrder } from "./services/company/searchService";

const LSI = 2, OTHER = 9;
const PNG_URI = `data:image/png;base64,${Buffer.from("89504e470d0a1a0a", "hex").toString("base64")}`;

function caller(ws = LSI) {
  h.wsId = ws;
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

const acct = (id: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: LSI, name: `Org ${id}`, domain: `org${id}.example`, normalizedDomain: `org${id}.example`,
  industry: null, region: null, hqState: null, hqCountry: null, hqCity: null, archivedAt: null,
  createdAt: new Date(2026, 9, 1), updatedAt: new Date(2026, 9, 1),
  logoUrl: null, logoSourceType: null, logoStatus: null, logoLastVerifiedAt: null,
  notes: null, customFields: null, description: null, ...o,
});
const link = (accountId: number, personId: number, workspaceId = LSI) => ({
  workspaceId, personType: "contact", personId, accountId, relationshipType: "employee", isCurrent: true, sourceType: "manual",
});

const search = (sort: { field: any; direction: "asc" | "desc" }, page = 1, perPage = 10, filters = {}) =>
  caller().companies.search({ filters, sort, page, perPage });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [LSI]: "admin", [OTHER]: "admin" }, wsId: () => h.wsId });
  h.selects = [];
  // Record what each SELECT reads: its table, columns, limit, condition and
  // how many rows it returned.
  const real = h.db.select;
  h.db.select = (projection?: Record<string, unknown>) => {
    const b = real(projection);
    const entry: (typeof h.selects)[number] = { table: "", cols: projection ? Object.keys(projection) : "*" };
    h.selects.push(entry);
    const { from, limit, where, then } = b;
    b.from = (t: any) => { entry.table = getTableName(t); return from(t); };
    b.limit = (n: number) => { entry.limit = n; return limit(n); };
    b.where = (c: any) => { entry.where = c ? new MySqlDialect().sqlToQuery(c).sql : undefined; return where(c); };
    b.then = (res: any, rej: any) => then((rows: any[]) => { entry.rows = rows.length; res(rows); }, rej);
    return b;
  };
});

describe("the sort reads ids, the page reads its rows (X4.1)", () => {
  it("the ordered, paged query selects only the account id", async () => {
    h.db.rowsOf("accounts").push(...[3, 1, 2].map((id) => acct(id)));
    await search({ field: "name", direction: "asc" });
    const paged = h.selects.filter((s) => s.table === "accounts" && s.limit != null);
    expect(paged.map(({ table, cols, limit }) => ({ table, cols, limit }))).toEqual([{ table: "accounts", cols: ["id"], limit: 10 }]);
  });

  it("no query reads whole account rows; the page reads what the table shows", async () => {
    h.db.rowsOf("accounts").push(acct(1, { notes: "long notes", customFields: { big: "x".repeat(100) }, description: "about", logoUrl: PNG_URI, logoSourceType: "website_logo", logoStatus: "available" }));
    const r = await search({ field: "contactCount", direction: "desc" });
    expect(h.selects.filter((s) => s.table === "accounts" && s.cols === "*")).toEqual([]);
    const page = h.selects.find((s) => s.table === "accounts" && Array.isArray(s.cols) && s.cols.includes("name"))!;
    for (const heavy of ["notes", "customFields", "description", "fieldProvenance", "brandOverride", "logoSourceUrl"]) {
      expect(page.cols, heavy).not.toContain(heavy);
    }
    expect(page.cols).toEqual(expect.arrayContaining(["logoUrl", "logoStatus", "logoSourceType", "logoLastVerifiedAt", "normalizedDomain"]));
    const json = JSON.stringify(r);
    expect(json).not.toContain("long notes");
    expect(json).not.toContain("base64");
    expect(r.data[0].logo.url).toMatch(/^\/api\/media\/account-logo\/1\?v=/);
  });

  it("the page reads the page's rows, by id, in this workspace", async () => {
    h.db.rowsOf("accounts").push(...Array.from({ length: 30 }, (_, i) => acct(i + 1)), { ...acct(31), workspaceId: OTHER });
    const r = await search({ field: "name", direction: "asc" }, 2, 10);
    expect(r.data).toHaveLength(10);
    const page = h.selects.find((s) => s.table === "accounts" && Array.isArray(s.cols) && s.cols.includes("name"))!;
    expect(page.rows).toBe(10);
    expect(page.where).toContain("`accounts`.`workspaceId` = ?");
    expect(page.where).toMatch(/`accounts`\.`id` in \(/);
  });

  it("an empty page reads no rows at all", async () => {
    h.db.rowsOf("accounts").push(acct(1), acct(2));
    const r = await search({ field: "name", direction: "asc" }, 5, 10);
    expect(r).toEqual({ data: [], total: 2, page: 5, perPage: 10 });
    // Nor any contact counts.
    expect(h.selects.some((s) => s.table === "contact_account_links")).toBe(false);
    expect(h.selects.filter((s) => s.table === "accounts").map((s) => s.cols)).toEqual([["id"], ["total"]]);
  });
});

describe("rows that tie keep one order (R61)", () => {
  // Ids stored out of order, so a sort without the id tiebreak would show it.
  const ids = [17, 3, 22, 1, 9, 25, 14, 11, 2, 19, 8, 24, 4, 13, 10, 21, 6, 16, 23, 5, 12, 18, 7, 20, 15];
  const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it("ascending: ties by id ascending, and the pages split the rows", async () => {
    h.db.rowsOf("accounts").push(...ids.map((id) => acct(id, { name: id === 6 ? "Aardvark" : "Same" })));
    const pages = [];
    for (const p of [1, 2, 3]) pages.push((await search({ field: "name", direction: "asc" }, p, 10)).data.map((a) => a.id));
    expect(pages.flat()).toEqual([6, ...upTo(25).filter((id) => id !== 6)]);
    expect(pages.map((p) => p.length)).toEqual([10, 10, 5]);
  });

  it("descending: ties by id descending", async () => {
    h.db.rowsOf("accounts").push(...ids.map((id) => acct(id, { createdAt: new Date(2026, 9, id <= 12 ? 1 : 2) })));
    const r = await search({ field: "createdAt", direction: "desc" }, 1, 50);
    expect(r.data.map((a) => a.id)).toEqual(upTo(25).reverse());
  });

  it("every sort ends with the id, the same way", () => {
    const dialect = new MySqlDialect();
    for (const field of ["name", "employeeCount", "revenue", "score", "lastEnriched", "createdAt", "contactCount"] as const) {
      for (const direction of ["asc", "desc"] as const) {
        const order = searchOrder(LSI, { field, direction });
        expect(order, `${field} ${direction}`).toHaveLength(2);
        expect(dialect.sqlToQuery(order[1] as SQL).sql).toBe(`\`accounts\`.\`id\` ${direction}`);
      }
    }
  });
});

describe("Most contacts is ordered in SQL across every match", () => {
  it("counts this workspace's links to the row being sorted", () => {
    const q = new MySqlDialect().sqlToQuery(searchOrder(LSI, { field: "contactCount", direction: "desc" })[0] as SQL);
    expect(q.sql.replace(/\s+/g, " ")).toBe(
      "( SELECT COUNT(*) FROM `contact_account_links` cal WHERE cal.`workspaceId` = ? AND cal.`account_id` = `accounts`.`id` ) desc",
    );
    expect(q.params).toEqual([LSI]);
  });

  it("the default sort is newest first", () => {
    const q = new MySqlDialect().sqlToQuery(searchOrder(LSI)[0] as SQL);
    expect(q.sql).toBe("`accounts`.`createdAt` desc");
  });

  it("contact counts and the total are this workspace's", async () => {
    h.db.rowsOf("accounts").push(acct(1), acct(2), acct(3), { ...acct(4), workspaceId: OTHER });
    h.db.rowsOf("contact_account_links").push(link(1, 10), link(1, 11), link(2, 12), link(3, 13, OTHER), link(3, 14, OTHER));
    const r = await search({ field: "name", direction: "asc" });
    expect(r.total).toBe(3);
    expect(r.data.map((a) => [a.id, a.contactCount])).toEqual([[1, 2], [2, 1], [3, 0]]);
  });

  it("filters still narrow the ids and the total together", async () => {
    h.db.rowsOf("accounts").push(acct(1, { industry: "Government" }), acct(2), acct(3, { industry: "Government" }));
    const r = await search({ field: "name", direction: "desc" }, 1, 10, { industries: ["Government"] });
    expect(r.total).toBe(2);
    expect(r.data.map((a) => a.id)).toEqual([3, 1]);
  });
});
