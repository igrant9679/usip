/**
 * companies.duplicates — the merge-review feed, against the REAL procedure
 * via appRouter.createCaller (same fake-db + MySqlDialect SQL-text approach
 * as prospectFieldHistoryReader.test.ts; see there for why object-walking a
 * drizzle condition proves nothing).
 *
 * The archived filter is the load-bearing assertion: mergeAccounts archives
 * the losing account WITHOUT clearing its normalizedDomain, so a finder that
 * forgot `archivedAt IS NULL` would resurface every completed merge as a
 * fresh duplicate, forever. That was the shipped behavior before this
 * surface was wired; the SQL-text check keeps it dead.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { accounts, contacts } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { appRouter } from "./routers";

const WS = { id: 3, name: "Acme Corp" };

function makeDb(accountRows: unknown[], countRows: unknown[], cap: { accountsWhere?: unknown; contactsWhere?: unknown }) {
  const builder = () => {
    const st: { table?: unknown; joined: boolean } = { joined: false };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin() { st.joined = true; return b; },
      where(cond: unknown) {
        if (st.table === accounts) cap.accountsWhere = cond;
        if (st.table === contacts) cap.contactsWhere = cond;
        return b;
      },
      groupBy() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        if (st.joined) {
          res([{
            ws: { ...WS, ownerUserId: 1, archivedAt: null },
            mb: { id: 1, userId: 1, workspaceId: WS.id, role: "rep", deactivatedAt: null, lastActiveAt: new Date() },
          }]);
        } else if (st.table === accounts) {
          res(accountRows);
        } else if (st.table === contacts) {
          res(countRows);
        } else {
          rej(new Error(`fake db: unscripted select from ${String((st.table as any)?.[Symbol.for("drizzle:Name")] ?? st.table)}`));
        }
      },
    };
    return b;
  };
  return { select: () => builder() };
}

function makeCtx(): TrpcContext {
  return {
    user: {
      id: 1, openId: "user-1", email: "u1@example.com", name: "User 1",
      loginMethod: "manus", role: "user",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);

describe("companies.duplicates", () => {
  it("groups active accounts by shared domain with review detail", async () => {
    const cap: { accountsWhere?: unknown; contactsWhere?: unknown } = {};
    h.db = makeDb(
      [
        { id: 1, key: "acme.com", name: "Acme", domain: "acme.com", createdAt: new Date("2026-01-01") },
        { id: 2, key: "acme.com", name: "Acme Inc", domain: "www.acme.com", createdAt: new Date("2026-02-01") },
        { id: 3, key: "other.com", name: "Other", domain: "other.com", createdAt: new Date("2026-03-01") }, // singleton — not a duplicate
        { id: 4, key: null, name: "No domain", domain: null, createdAt: new Date("2026-04-01") }, // unkeyed — can't collide
      ],
      [{ accountId: 1, c: 5 }],
      cap,
    );

    const out = await appRouter.createCaller(makeCtx()).companies.duplicates();
    expect(out).toEqual([{
      key: "acme.com",
      reason: "domain",
      accounts: [
        { id: 1, name: "Acme", domain: "acme.com", createdAt: new Date("2026-01-01"), contactCount: 5 },
        { id: 2, name: "Acme Inc", domain: "www.acme.com", createdAt: new Date("2026-02-01"), contactCount: 0 },
      ],
    }]);

    const accountsWhere = render(cap.accountsWhere);
    expect(accountsWhere.sql).toContain("`accounts`.`workspaceId` = ?");
    expect(accountsWhere.params).toEqual([WS.id]);
    // The resurfacing guard: archived accounts (merged losers) stay out.
    expect(accountsWhere.sql).toContain("`accounts`.`archived_at` is null");

    const contactsWhere = render(cap.contactsWhere);
    expect(contactsWhere.sql).toContain("`contacts`.`workspaceId` = ?");
    expect(contactsWhere.sql).toContain("`accountId` in (");
  });

  it("returns [] when nothing collides (and never runs the count query)", async () => {
    const cap: { accountsWhere?: unknown; contactsWhere?: unknown } = {};
    h.db = makeDb(
      [
        { id: 1, key: "a.com", nameKey: "a", name: "A", domain: "a.com", createdAt: null },
        { id: 2, key: "b.com", nameKey: "b", name: "B", domain: "b.com", createdAt: null },
      ],
      [],
      cap,
    );
    const out = await appRouter.createCaller(makeCtx()).companies.duplicates();
    expect(out).toEqual([]);
    expect(cap.contactsWhere).toBeUndefined();
  });

  it("catches ONE company fragmented across several domains", async () => {
    // The shape association produces when a company's people carry unrelated
    // mailbox domains: same name, a different domain on each account, so
    // grouping by domain alone sees nothing at all.
    const cap: { accountsWhere?: unknown; contactsWhere?: unknown } = {};
    h.db = makeDb(
      [
        { id: 1, key: "takomachildren.org", nameKey: "takoma childrens school", name: "Takoma Children's School", domain: "takomachildren.org", createdAt: new Date("2026-01-01") },
        { id: 2, key: "dc.gov", nameKey: "takoma childrens school", name: "Takoma Children's School", domain: "dc.gov", createdAt: new Date("2026-02-01") },
        { id: 3, key: "ftc.gov", nameKey: "takoma childrens school", name: "Takoma Children's School", domain: "ftc.gov", createdAt: new Date("2026-03-01") },
      ],
      [{ accountId: 2, c: 3 }],
      cap,
    );
    const out = await appRouter.createCaller(makeCtx()).companies.duplicates();
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("name");
    expect(out[0].key).toBe("name:takoma childrens school");
    expect(out[0].accounts.map((a) => a.id).sort()).toEqual([1, 2, 3]);
  });

  it("does not report the same accounts twice when they collide both ways", async () => {
    const cap: { accountsWhere?: unknown; contactsWhere?: unknown } = {};
    h.db = makeDb(
      [
        { id: 1, key: "acme.com", nameKey: "acme", name: "Acme", domain: "acme.com", createdAt: null },
        { id: 2, key: "acme.com", nameKey: "acme", name: "Acme", domain: "acme.com", createdAt: null },
      ],
      [],
      cap,
    );
    const out = await appRouter.createCaller(makeCtx()).companies.duplicates();
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe("domain");
  });
});

describe("consumer wiring (a detector nobody renders is not a detector)", () => {
  const page = fs.readFileSync(path.join(__dirname, "..", "client", "src", "pages", "usip", "Companies.tsx"), "utf8");
  it("the Companies page queries the procedure and merges through companies.merge", () => {
    expect(page).toContain("trpc.companies.duplicates.useQuery");
    expect(page).toContain("merge.mutateAsync({ primaryAccountId: primaryId, duplicateAccountId: d.id })");
  });
  it("…and mounts the review surface", () => {
    expect(page).toContain("<DuplicateReview />");
  });
});
