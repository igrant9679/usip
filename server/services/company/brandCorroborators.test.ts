/**
 * corroboratorDomainsFor — the account's own domain evidence that lets an
 * 80–94 name-match hit fill an empty domain.
 *
 * Until 2026-08-18 it read CONTACT mailboxes only. People are the sitewide
 * record (owner directive 2026-08-17) and LSI's contacts table is empty by
 * instruction, so the reconciler had gone blind there: a company with ten
 * linked People at its domain and no Contacts corroborated nothing. Proved
 * here from the SQL text of the queries the function issues, against a fake
 * db (companyDuplicates.test.ts pattern).
 */
import { describe, it, expect, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { contacts, prospects } from "../../../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("../../db", async (importActual) => ({
  ...(await importActual<typeof import("../../db")>()),
  getDb: async () => h.db,
}));

import { corroboratorDomainsFor } from "./brandReconciler";

const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);

function fakeDb(rows: { people: unknown[]; contacts: unknown[] }, wheres: Record<string, string>) {
  const builder = () => {
    const st: { table?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      where(cond: unknown) {
        if (st.table === prospects) wheres.prospects = render(cond).sql;
        if (st.table === contacts) wheres.contacts = render(cond).sql;
        return b;
      },
      limit() { return b; },
      then(res: (v: unknown) => void) {
        if (st.table === prospects) res(rows.people);
        else if (st.table === contacts) res(rows.contacts);
        else res([]);
      },
    };
    return b;
  };
  return { select: () => builder() };
}

describe("corroboratorDomainsFor", () => {
  it("reads linked PEOPLE mailboxes as well as Contacts, both scoped to the account", async () => {
    const wheres: Record<string, string> = {};
    h.db = fakeDb({
      people: [{ email: "dean@marquette.edu" }, { email: "someone@gmail.com" }, { email: null }],
      contacts: [{ email: "x@marquette.edu" }, { email: "y@partner.org" }],
    }, wheres);
    const out = await corroboratorDomainsFor(4, 77, "https://www.marquette.edu/");
    expect(out.sort()).toEqual(["marquette.edu", "partner.org"]);
    // People are read, and by accountId, not just workspace.
    expect(wheres.prospects).toContain("`prospects`.`workspaceId` = ?");
    expect(wheres.prospects).toContain("`prospects`.`account_id` = ?"); // snake_case column on prospects
    expect(wheres.contacts).toContain("`contacts`.`accountId` = ?");
  });

  it("with no Contacts at all (LSI), People alone corroborate", async () => {
    const wheres: Record<string, string> = {};
    h.db = fakeDb({ people: [{ email: "a@cornellhotelsociety.com" }], contacts: [] }, wheres);
    const out = await corroboratorDomainsFor(2, 5, null);
    expect(out).toEqual(["cornellhotelsociety.com"]);
  });
});
