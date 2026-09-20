/**
 * The persistence sweep, behaviourally.
 *
 * Phase 1 of this fix derives the stage on the way out of routers/cs.ts, so the
 * board, the KPIs and the AI assistant are already right. This engine only
 * makes the STORED column agree, for the readers that are not those — a direct
 * query, an export, a future report.
 *
 * Which means it is pure downside if it gets any of four things wrong, and each
 * one is a test below:
 *
 *   · writing an archived workspace. Archiving that keeps rewriting rows is not
 *     archiving (2026-08-12). Checked here by running the engine, not by
 *     grepping for the import — archiveEnforcement.test.ts's structural sweep
 *     uses `git grep`, which cannot see this file until it is tracked.
 *   · stomping an outcome. `renewed` and `churned` came from a human through
 *     cs.addAmendment; a churned customer that re-floats as an active renewal
 *     is a worse bug than the stale column.
 *   · rewriting rows that are already correct. customers.updatedAt carries
 *     onUpdateNow(), so a no-op UPDATE restamps every customer in the product
 *     every six hours and destroys that column as a signal.
 *   · starving the rows that matter. The scan is ordered by oldest contractEnd,
 *     which is precisely the settled past-due rows; without a predicate that
 *     drops them the 5000-row budget never reaches a row crossing the 90/60/30
 *     boundaries.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";

const h = vi.hoisted(() => ({ db: null as any, archived: new Set<number>() }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

vi.mock("./_core/workspaceArchive", () => ({
  archivedWorkspaceIds: async () => h.archived,
  invalidateArchivedWorkspaceCache: () => {},
  isWorkspaceArchived: async (id: number) => h.archived.has(id),
}));

import { runRenewalStageSweepAllWorkspaces } from "./services/renewalStageEngine";

const ROOT = join(__dirname, "..");
const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);

type Update = { set?: Record<string, unknown>; where?: unknown };

function makeDb(rows: unknown[]) {
  const cap: { selectWhere?: unknown; updates: Update[] } = { updates: [] };
  const db = {
    select: () => {
      const b: any = {
        from: () => b,
        where(c: unknown) { cap.selectWhere = c; return b; },
        orderBy: () => b,
        limit: () => b,
        then: (res: (v: unknown) => void) => res(rows),
      };
      return b;
    },
    update: () => {
      const u: Update = {};
      const b: any = {
        set(v: Record<string, unknown>) { u.set = v; return b; },
        where(c: unknown) { u.where = c; cap.updates.push(u); return Promise.resolve([]); },
      };
      return b;
    },
  };
  return { db, cap };
}

const daysOut = (d: number) => new Date(Date.now() + d * 86400000);

beforeEach(() => {
  h.archived = new Set<number>();
});

describe("the candidate query", () => {
  it("excludes recorded outcomes and settled past-due rows", async () => {
    const { db, cap } = makeDb([]);
    h.db = db;
    await runRenewalStageSweepAllWorkspaces();

    const where = render(cap.selectWhere);
    // No outcome a human recorded is even fetched.
    expect(where.params).toContain("renewed");
    expect(where.params).toContain("churned");
    // A row already parked at at_risk can never move again, so it leaves the
    // set — otherwise the oldest-first ordering spends the whole cap on them.
    expect(where.params).toContain("at_risk");
    expect(where.sql).toMatch(/or/i);
    expect(where.sql).toContain("is not null");
  });
});

describe("archived workspaces", () => {
  it("are scanned but never written", async () => {
    const { db, cap } = makeDb([
      { id: 1, workspaceId: 11, contractEnd: daysOut(10), renewalStage: "early" },
      { id: 2, workspaceId: 22, contractEnd: daysOut(10), renewalStage: "early" },
    ]);
    h.db = db;
    h.archived = new Set([11]);

    const r = await runRenewalStageSweepAllWorkspaces();
    expect(r.moved).toBe(1);
    expect(cap.updates).toHaveLength(1);
    const where = render(cap.updates[0]!.where);
    expect(where.params).toContain(22);
    expect(where.params).not.toContain(11);
  });
});

describe("what it writes", () => {
  it("every update is scoped by workspace AND by explicit ids", async () => {
    const { db, cap } = makeDb([
      { id: 1, workspaceId: 11, contractEnd: daysOut(10), renewalStage: "early" },
      { id: 2, workspaceId: 11, contractEnd: daysOut(10), renewalStage: "early" },
    ]);
    h.db = db;
    await runRenewalStageSweepAllWorkspaces();

    expect(cap.updates).toHaveLength(1); // both rows share a target: one statement
    const where = render(cap.updates[0]!.where);
    expect(where.sql).toContain("`customers`.`workspaceId` = ?");
    expect(where.sql).toContain("`customers`.`id` in (?, ?)");
    expect(where.params).toEqual([11, 1, 2]);
    expect(cap.updates[0]!.set).toEqual({ renewalStage: "thirty" });
  });

  it("splits by workspace and by target, never mixing tenants in one statement", async () => {
    const { db, cap } = makeDb([
      { id: 1, workspaceId: 11, contractEnd: daysOut(10), renewalStage: "early" },
      { id: 2, workspaceId: 22, contractEnd: daysOut(10), renewalStage: "early" },
      { id: 3, workspaceId: 11, contractEnd: daysOut(45), renewalStage: "early" },
    ]);
    h.db = db;
    const r = await runRenewalStageSweepAllWorkspaces();

    expect(r.moved).toBe(3);
    expect(cap.updates).toHaveLength(3);
    cap.updates.forEach((u) => {
      expect(render(u.where).sql).toContain("`customers`.`workspaceId` = ?");
    });
  });

  it("never sets an outcome nobody recorded", async () => {
    const { db, cap } = makeDb([
      { id: 1, workspaceId: 11, contractEnd: daysOut(-30), renewalStage: "early" },
      { id: 2, workspaceId: 11, contractEnd: daysOut(-400), renewalStage: "thirty" },
    ]);
    h.db = db;
    await runRenewalStageSweepAllWorkspaces();

    // A lapsed contract is PAST DUE. seed.ts calls it "renewed" so demo data
    // has a populated column; doing that here would file every churn as a win.
    cap.updates.forEach((u) => {
      expect(u.set!.renewalStage).toBe("at_risk");
    });
    const src = readFileSync(join(ROOT, "server/services/renewalStageEngine.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/renewalStage:\s*"(renewed|churned)"/);
  });
});

describe("what it does not write", () => {
  it("a row already at its target produces no statement at all", async () => {
    const { db, cap } = makeDb([
      { id: 1, workspaceId: 11, contractEnd: daysOut(10), renewalStage: "thirty" },
      { id: 2, workspaceId: 11, contractEnd: daysOut(200), renewalStage: "early" },
      { id: 3, workspaceId: 11, contractEnd: daysOut(75), renewalStage: "ninety" },
    ]);
    h.db = db;
    const r = await runRenewalStageSweepAllWorkspaces();

    expect(r.scanned).toBe(3);
    expect(r.moved).toBe(0);
    expect(cap.updates).toEqual([]);
  });

  it("does nothing at all without a database", async () => {
    h.db = null;
    await expect(runRenewalStageSweepAllWorkspaces()).resolves.toEqual({ scanned: 0, moved: 0 });
  });
});

describe("it is actually registered", () => {
  const index = readFileSync(join(ROOT, "server/_core/index.ts"), "utf8");

  it("runs under the overlap guard on a 6h interval", () => {
    // An engine nobody schedules is a file, not a feature.
    expect(index).toContain('guardOverlap("RenewalStages"');
    expect(index).toContain("setInterval(runRenewalStages, 6 * 60 * 60 * 1000)");
  });

  it("is staggered off boot and off every other sweep", () => {
    const staggers = [...index.matchAll(/setTimeout\(run\w+, (\d+) \* 60 \* 1000\)/g)].map((m) => Number(m[1]));
    expect(staggers).toContain(27);
    expect(staggers.filter((s) => s === 27)).toHaveLength(1);
  });
});
