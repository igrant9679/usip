/**
 * The People list repairs rows after it answers, not inside the read (audit
 * 2026-10-20, R86).
 *
 *   the page shows the repaired company and name at once · the writes happen
 *   after the list has returned, not while it waits · two views of the same
 *   page write each person once · each write is scoped to the workspace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, writes: [] as Array<{ where: string; params: unknown[]; set: Record<string, unknown> }> };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { flushProspectRepairs } from "./routers/prospects";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const list = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext).prospects.list({ page: 1, perPage: 50 });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  h.writes = [];
  const real = h.db.update;
  h.db.update = (table: any) => {
    const chain = real(table);
    const set = chain.set;
    let values: Record<string, unknown> = {};
    chain.set = (v: Record<string, unknown>) => { values = v; return set(v); };
    const where = chain.where;
    chain.where = (c: unknown) => {
      if (getTableName(table) === "prospects") {
        const q = new MySqlDialect().sqlToQuery(c as any);
        h.writes.push({ where: q.sql, params: q.params, set: values });
      }
      return where(c);
    };
    return chain;
  };
  rows("prospects").push(
    { id: 1, workspaceId: WS, firstName: "Ron Flournoy", lastName: "PSP", company: null, companyDomain: null, email: "ron@gmail.com", createdAt: new Date(2026, 9, 1) },
    { id: 2, workspaceId: WS, firstName: "Ann", lastName: "Lee", company: "Acme", companyDomain: "acme.example", createdAt: new Date(2026, 9, 2) },
  );
  rows("prospect_linkedin_enrichments").push({ id: 1, workspaceId: WS, prospectId: 1, linkedinProfileUrl: "https://linkedin.com/in/ron", currentCompanyName: "Flournoy Labs", currentCompanyDomain: "flournoylabs.example" });
});

describe("R86 · the list's repairs are written after it answers", () => {
  it("shows the repair at once and writes it afterwards, once, in this workspace", async () => {
    const page = await list();
    const ron = page.data.find((p: any) => p.id === 1)!;
    expect(ron).toMatchObject({ firstName: "Ron", lastName: "Flournoy", company: "Flournoy Labs", companyDomain: "flournoylabs.example" });
    // The read itself wrote nothing.
    expect(h.writes).toEqual([]);
    await list(); // a second view of the same page before the queue runs
    expect(h.writes).toEqual([]);
    await flushProspectRepairs();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].where).toBe("(`prospects`.`workspaceId` = ? and `prospects`.`id` = ?)");
    expect(h.writes[0].params).toEqual([WS, 1]);
    expect(rows("prospects").find((p) => p.id === 1)).toMatchObject({ firstName: "Ron", lastName: "Flournoy", company: "Flournoy Labs", companyDomain: "flournoylabs.example" });
    expect(rows("prospects").find((p) => p.id === 1).fieldProvenance.company).toMatchObject({ source: "linkedin" });
  });

  it("a page with nothing to repair queues nothing", async () => {
    rows("prospects").splice(0, 1);
    await list();
    await flushProspectRepairs();
    expect(h.writes).toEqual([]);
  });
});
