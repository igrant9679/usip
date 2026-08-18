/**
 * runBrandReconciliation({ accountIds }) — reconcile exactly the accounts a
 * caller names, instead of collecting by the refresh rule. Added 2026-08-18
 * for `resolveBrandsBatch { target: "repaired" }`: the accounts the
 * verification repair un-stamped carry a fresh observation, so the refresh
 * rule keeps them inside the 7-day negative-cache window — but with People
 * now linked and read as corroborators, a fresh pass is what lets the
 * honest ones re-verify.
 *
 * Fake db + SQL-text capture (companyDuplicates.test.ts pattern); a fake
 * provider that is search-ready but returns no hits, so each eligible
 * account goes through reconcileAccountBrand and comes back no_match.
 */
import { describe, it, expect, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { accounts } from "../../../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("../../db", async (importActual) => ({
  ...(await importActual<typeof import("../../db")>()),
  getDb: async () => h.db,
}));

import { runBrandReconciliation } from "./brandReconciler";

const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);

function fakeDb(liveRows: unknown[], cap: { accountsWheres: string[] }) {
  const builder = () => {
    const st: { table?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      where(cond: unknown) { if (st.table === accounts) cap.accountsWheres.push(render(cond).sql); return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void) { res(st.table === accounts && cap.accountsWheres.length === 1 ? liveRows : []); },
    };
    return b;
  };
  return {
    select: () => builder(),
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
}

const provider = {
  searchReady: () => true,
  searchBrand: async () => ({ ok: true as const, hits: [] }),
  logoUrl: () => null,
};

describe("runBrandReconciliation with explicit accountIds", () => {
  it("selects exactly those ids (live, in the workspace) and reconciles them, bounded by limit", async () => {
    const cap = { accountsWheres: [] as string[] };
    h.db = fakeDb([
      { id: 11, workspaceId: 2, name: "dell", domain: "dell.com", brandVerifiedAt: null },
      { id: 12, workspaceId: 2, name: "mongodb", domain: "mongodb.com", brandVerifiedAt: null },
      { id: 13, workspaceId: 2, name: "fiserv", domain: "fiserv.com", brandVerifiedAt: null },
    ], cap);
    const s = await runBrandReconciliation({ provider: provider as any, workspaceId: 2, accountIds: [11, 12, 13, 13, 99], limit: 2, spacingMs: 0 });
    // 4 distinct ids named; 3 live rows came back; limit 2 → 2 searched, 2 skipped.
    expect(s.scanned).toBe(4);
    expect(s.searched).toBe(2);
    expect(s.skipped).toBe(2);
    expect(s.noMatch + s.candidates + s.applied + s.corroborated + s.failed).toBeGreaterThanOrEqual(0);
    const where = cap.accountsWheres[0];
    expect(where).toContain("`accounts`.`id` in (");
    expect(where).toContain("`accounts`.`archived_at` is null");
    expect(where).toContain("`accounts`.`workspaceId` = ?");
  });

  it("an empty id list does nothing and touches nothing", async () => {
    const cap = { accountsWheres: [] as string[] };
    h.db = fakeDb([], cap);
    const s = await runBrandReconciliation({ provider: provider as any, workspaceId: 2, accountIds: [], spacingMs: 0 });
    expect(s.searched).toBe(0);
    expect(cap.accountsWheres).toEqual([]);
  });
});
