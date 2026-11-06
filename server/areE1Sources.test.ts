/**
 * Prospect-source money paths (audit 2026-10-20, batch E1).
 *
 *   A59 two promotions of the same search rows — a double click — buy them once
 *   A72 a vendor's plan refusal is read as one whatever status it comes with, and
 *       a budget hold leaked by a crashed run is released by its own age, not by
 *       how long since anything wrote the row
 *
 * The vendor is a fake on-demand source; nothing reaches a real one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: null as any, acquires: [] as string[][], release: null as null | (() => void) }));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./services/prospectSources/registry", async (a) => ({
  ...(await a<typeof import("./services/prospectSources/registry")>()),
  getSource: () => ({
    slug: "leadocean",
    displayName: "Fake vendor",
    acquisition: "on_demand",
    budgetPeriods: () => [],
    acquire: async (ids: string[]) => {
      h.acquires.push(ids);
      // Hold the call open so a second promotion overlaps this one.
      await new Promise<void>((r) => { h.release = r; setTimeout(r, 5); });
      return { ok: true, unitsSpent: ids.length, records: ids.map((id) => ({ externalId: id, email: `${id}@example.com`, firstName: "Pat", lastName: id, emailIsMasked: false, rawSourcePayload: {} })) };
    },
  }),
}));
vi.mock("./services/prospectSources/credentials", async (a) => ({
  ...(await a<typeof import("./services/prospectSources/credentials")>()),
  loadCredentials: async () => ({ secrets: {}, config: {} }),
}));
vi.mock("./services/discovery/consolidate", () => ({ processRun: async () => 0 }));

import { MySqlDialect } from "drizzle-orm/mysql-core";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { promoteResults, PROMOTE_CLAIM_STALE_MS } from "./services/prospectSources/searchRuns";
import { classifyHttpFailure } from "./services/prospectSources/vendorHttp";
import { commit, release, releaseStaleHolds, reserve } from "./services/prospectSources/ledger";

const WS = 2;
const rows = (t: string) => h.db.rowsOf(t) as any[];

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  h.acquires = [];
  rows("prospect_search_runs").push({ id: 11, workspaceId: WS, userId: 20, status: "complete" });
  for (const id of [1, 2]) {
    rows("prospect_search_results").push({
      id, workspaceId: WS, runId: 11, sourceSlug: "leadocean", externalId: `x${id}`, wasCharged: false, emailIsMasked: true,
      promotedProspectId: null, promoteClaim: null, promoteClaimedAt: null,
      normalized: { externalId: `x${id}`, firstName: "Pat", lastName: `x${id}`, emailIsMasked: true, rawSourcePayload: {} },
    });
  }
});

describe("promoting search rows (A59)", () => {
  it("a double click buys the rows once", async () => {
    const [a, b] = await Promise.all([promoteResults(WS, 20, 11, [1, 2]), promoteResults(WS, 20, 11, [1, 2])]);
    expect(h.acquires).toEqual([["x1", "x2"]]);
    expect(a.unitsSpent + b.unitsSpent).toBe(2);
    // The second says why it bought nothing.
    expect([...a.errors, ...b.errors].join(" ")).toMatch(/already being promoted/);
  });

  it("lets go of the rows when it ends, so a later promotion of a row that failed can retry", async () => {
    await promoteResults(WS, 20, 11, [1]);
    expect(rows("prospect_search_results").every((r) => r.promoteClaim == null)).toBe(true);
  });

  it("takes rows a dead promotion left claimed once the claim is stale, and not before", async () => {
    const r1 = rows("prospect_search_results")[0];
    r1.promoteClaim = "dead"; r1.promoteClaimedAt = new Date(Date.now() - 60_000);
    await promoteResults(WS, 20, 11, [1]);
    expect(h.acquires).toEqual([]);
    r1.promoteClaimedAt = new Date(Date.now() - PROMOTE_CLAIM_STALE_MS - 60_000);
    await promoteResults(WS, 20, 11, [1]);
    expect(h.acquires).toEqual([["x1"]]);
  });

  it("never claims another workspace's rows", async () => {
    rows("prospect_search_results").push({ id: 3, workspaceId: 4, runId: 11, sourceSlug: "leadocean", externalId: "x3", wasCharged: false, promotedProspectId: null, promoteClaim: null, normalized: {} });
    await promoteResults(WS, 20, 11, [3]);
    expect(h.acquires).toEqual([]);
    expect(rows("prospect_search_results").find((r) => r.id === 3).promoteClaim).toBeNull();
  });
});

describe("a vendor's plan refusal (A72)", () => {
  it("is plan_required with either code, whatever the status", () => {
    expect(classifyHttpFailure(402, "verifier_access_required")).toBe("plan_required");
    expect(classifyHttpFailure(403, "verifier_access_required")).toBe("plan_required");
    expect(classifyHttpFailure(400, "plan_upgrade_required")).toBe("plan_required");
  });
  it("a bare 402 is a plan refusal; a 402 naming the allowance is still the allowance", () => {
    expect(classifyHttpFailure(402)).toBe("plan_required");
    expect(classifyHttpFailure(402, "allowance_exhausted")).toBe("budget_exhausted");
  });
});

describe("a budget hold's age (A72)", () => {
  /** The ledger writes raw SQL; record it with its parameters. */
  const statements: string[] = [];
  beforeEach(() => {
    statements.length = 0;
    const dialect = new MySqlDialect();
    h.db.execute = (q: unknown) => {
      statements.push(dialect.sqlToQuery(q).sql.replace(/\s+/g, " "));
      return Promise.resolve([{ affectedRows: 1 }]);
    };
  });
  const periods = [{ bucket: "leads", granularity: "monthly", periodKey: "2026-11", unitsLimit: 100, resetsAt: null }] as any;

  it("a hold stamps when it began and keeps the first stamp while holds overlap", async () => {
    const r = await reserve(WS, "leadocean" as any, "leads" as any, 5, periods);
    expect(r).not.toBeNull();
    expect(statements.at(-1)).toContain("`heldAt` = COALESCE(`heldAt`, NOW())");
  });

  it("commit and release clear the stamp once nothing is reserved", async () => {
    const r = await reserve(WS, "leadocean" as any, "leads" as any, 5, periods);
    await commit(WS, r!, 5);
    expect(statements.at(-1)).toMatch(/`unitsReserved` = GREATEST\(0, `unitsReserved` - \?\), `heldAt` = IF\(`unitsReserved` = 0, NULL, `heldAt`\)/);
    await release(WS, r!);
    expect(statements.at(-1)).toMatch(/`unitsReserved` = GREATEST\(0, `unitsReserved` - \?\), `heldAt` = IF\(`unitsReserved` = 0, NULL, `heldAt`\)/);
  });

  it("the nightly release goes by the hold's age, so a busy row's leak is not kept alive by other writes", async () => {
    await releaseStaleHolds();
    const sql = statements.at(-1)!;
    expect(sql).toContain("`heldAt` < (NOW() - INTERVAL 2 HOUR)");
    // updatedAt only for a hold placed before the stamp existed.
    expect(sql).toContain("(`heldAt` IS NULL AND `updatedAt` < (NOW() - INTERVAL 2 HOUR))");
    expect(sql).not.toMatch(/WHERE `unitsReserved` > 0 AND `updatedAt` </);
  });
});
