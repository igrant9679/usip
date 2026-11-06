/**
 * Audit 2026-10-20, O53: the Email Suppressions search filtered the one page
 * of 50 the browser had fetched, so an address on another page read as "not
 * found"; and Next showed whenever a page was full and never disabled.
 *
 * The search is now a server query across the whole list, and the page asks
 * for one row more than it shows to know whether there is a next page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "a@lsi.example", name: "A", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: 1, archivedAt: null, plan: "trial" });
  // 120 suppressions, newest first; the one we look for is among the oldest.
  for (let i = 0; i < 120; i++) {
    rows("email_suppressions").push({ id: i + 1, workspaceId: WS, email: i === 3 ? "needle@acme.example" : `p${i}@x.example`, reason: "unsubscribe", createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)) });
  }
  rows("email_suppressions").push({ id: 999, workspaceId: 99, email: "needle@other.example", reason: "manual", createdAt: new Date() });
});

describe("search covers the whole list", () => {
  it("an address far past the first page is found, in this workspace only", async () => {
    const page1 = await caller().emailSuppressions.list({ reason: "all", limit: 51, offset: 0 });
    expect(page1.some((r: any) => r.email === "needle@acme.example")).toBe(false);
    const found = await caller().emailSuppressions.list({ reason: "all", limit: 51, offset: 0, search: "NEEDLE" });
    expect(found.map((r: any) => r.email)).toEqual(["needle@acme.example"]);
  });

  it("a search with no match is empty, not the unfiltered page", async () => {
    expect(await caller().emailSuppressions.list({ reason: "all", limit: 51, offset: 0, search: "nobody" })).toEqual([]);
  });
});

describe("the page knows whether there is a next page", () => {
  it("one row more than the page says so; the last page says not", async () => {
    const p1 = await caller().emailSuppressions.list({ reason: "all", limit: 51, offset: 0 });
    expect(p1).toHaveLength(51);
    const p3 = await caller().emailSuppressions.list({ reason: "all", limit: 51, offset: 100 });
    expect(p3).toHaveLength(20);
  });

  it("the page searches on the server, asks for LIMIT + 1, and disables Next at the end", () => {
    const page = readFileSync("client/src/pages/usip/EmailSuppressions.tsx", "utf8").replace(/\r\n/g, "\n");
    expect(page).toContain("search: searchDebounced || undefined,");
    expect(page).toContain("limit: LIMIT + 1,");
    expect(page).toContain("const hasMore = (fetched?.length ?? 0) > LIMIT;");
    expect(page).toContain('<Button variant="outline" size="sm" disabled={!hasMore} onClick={() => setOffset(offset + LIMIT)}>Next</Button>');
    expect(page).not.toContain("r.email.toLowerCase().includes(search.toLowerCase())");
  });
});
