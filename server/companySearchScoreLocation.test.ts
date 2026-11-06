/**
 * Companies list: the Score column and the Location filter (audit 2026-10-20,
 * R57).
 *
 *   the score shown is the company's score result, the one the profile and the
 *   rating filter read; accounts.accountScore is never written, so the column
 *   was blank for every company · sorting by score orders by that same result
 *   · a location is matched as a whole value: "CA" was a substring of Chicago
 *   and Canada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { SQL } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { searchOrder } from "./services/company/searchService";

const WS = 2, OTHER = 9;
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const acct = (id: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: WS, name: `Org ${id}`, domain: null, region: null, hqState: null, hqCountry: null, hqCity: null,
  archivedAt: null, accountScore: null, accountRating: null, createdAt: new Date(2026, 9, id), updatedAt: new Date(), ...o,
});
const search = (filters: Record<string, unknown> = {}, sort: any = { field: "name", direction: "asc" }) =>
  caller().companies.search({ filters, sort, page: 1, perPage: 50 });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
});

describe("Location matches a whole value", () => {
  beforeEach(() => {
    h.db.rowsOf("accounts").push(
      acct(1, { name: "Bay", hqState: "CA", hqCountry: "United States" }),
      acct(2, { name: "Windy", hqCity: "Chicago", hqState: "IL" }),
      acct(3, { name: "North", hqCountry: "Canada" }),
      acct(4, { name: "Coast", region: "CA" }),
    );
  });

  it("CA is California, not Chicago or Canada", async () => {
    const r = await search({ locations: ["CA"] });
    expect(r.data.map((a) => a.name)).toEqual(["Bay", "Coast"]);
  });

  it("several locations widen, each still whole", async () => {
    const r = await search({ locations: ["Canada", "Chicago"] });
    expect(r.data.map((a) => a.name)).toEqual(["North", "Windy"]);
  });
});

describe("the Score column is the company's score result", () => {
  beforeEach(() => {
    h.db.rowsOf("accounts").push(acct(1, { name: "Scored" }), acct(2, { name: "Unscored" }), acct(3, { name: "Twice" }));
    h.db.rowsOf("score_results").push(
      { id: 1, workspaceId: WS, scoreModelId: 10, objectType: "company", objectId: 1, normalizedScore: "72.50", rating: "good" },
      { id: 2, workspaceId: WS, scoreModelId: 10, objectType: "company", objectId: 3, normalizedScore: "40.00", rating: "fair" },
      { id: 3, workspaceId: WS, scoreModelId: 11, objectType: "company", objectId: 3, normalizedScore: "81.00", rating: "excellent" },
      // A person with the same id, and another workspace's company: not these.
      { id: 4, workspaceId: WS, scoreModelId: 12, objectType: "person", objectId: 2, normalizedScore: "99.00", rating: "excellent" },
      { id: 5, workspaceId: OTHER, scoreModelId: 13, objectType: "company", objectId: 2, normalizedScore: "99.00", rating: "excellent" },
    );
  });

  it("each row shows its own score and rating, the highest when two models scored it", async () => {
    const r = await search();
    expect(r.data.map((a) => [a.name, a.accountScore, a.accountRating])).toEqual([
      ["Scored", 72.5, "good"], ["Twice", 81, "excellent"], ["Unscored", null, null],
    ]);
  });

  it("the score sort orders by the same result, this workspace's companies only", () => {
    const q = new MySqlDialect().sqlToQuery(searchOrder(WS, { field: "score", direction: "desc" })[0] as SQL);
    expect(q.sql.replace(/\s+/g, " ").trim()).toBe(
      "( SELECT MAX(sr.`normalized_score`) FROM `score_results` sr WHERE sr.`workspaceId` = ? AND sr.`object_type` = 'company' AND sr.`object_id` = `accounts`.`id` ) desc",
    );
    expect(q.params).toEqual([WS]);
  });
});
