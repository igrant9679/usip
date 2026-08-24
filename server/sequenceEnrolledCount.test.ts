/**
 * The Sequences surfaces must serve a LIVE enrolled count.
 *
 * `sequences.enrolledCount` is a stored column no write path maintains —
 * enroll/bulkEnroll insert `enrollments` rows and never bump it (the
 * sequence-enrollment spec says to; nothing does) — so list/get served the
 * column's default 0 regardless of real enrollments. Classic dead wiring: a
 * finished write path (enrollments) and a reader (the column) that never
 * meet. The fix computes the count from the enrollments table at read time.
 *
 * The helper is EXECUTED here (per feedback_source_scanner_traps: presence
 * is not effect); the two consuming procedures need a live DB + tRPC ctx, so
 * their wiring is pinned by source assertion in areEnrollPage.test.ts's shape.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveEnrolledCounts } from "./routers/sequences";

describe("liveEnrolledCounts (executed)", () => {
  it("groups enrollment rows into a per-sequence Map, coercing driver strings", async () => {
    // Minimal drizzle-shaped chain: the mysql2 driver returns count() as a
    // string, which is exactly why the helper must Number() it.
    const captured: Record<string, unknown> = {};
    const db = {
      select: (shape: unknown) => ({
        from: (table: unknown) => ({
          where: (cond: unknown) => ({
            groupBy: (col: unknown) => {
              Object.assign(captured, { shape, table, cond, col });
              return Promise.resolve([
                { sequenceId: 22, n: "3" },
                { sequenceId: 24, n: 1 },
              ]);
            },
          }),
        }),
      }),
    };
    const m = await liveEnrolledCounts(db as never, 4);
    expect(m.get(22)).toBe(3);
    expect(m.get(24)).toBe(1);
    expect(m.get(999)).toBeUndefined();
    expect(captured.cond, "workspace + status filter must be applied").toBeTruthy();
    expect(captured.col, "must group by sequenceId").toBeTruthy();
  });

  it("an empty workspace yields an empty Map (readers fall back to 0, not undefined)", async () => {
    const db = {
      select: () => ({ from: () => ({ where: () => ({ groupBy: () => Promise.resolve([]) }) }) }),
    };
    const m = await liveEnrolledCounts(db as never, 2);
    expect(m.size).toBe(0);
  });
});

describe("list and get consume the live count (source-pinned)", () => {
  const src = readFileSync(join(__dirname, "routers", "sequences.ts"), "utf8");

  it("the status filter counts non-exited enrollments only", () => {
    expect(src).toContain(
      'inArray(enrollments.status, ["active", "paused", "finished"])',
    );
  });

  it("list overrides the stored column for every row, BEFORE the rep-visibility filter", () => {
    const listStart = src.indexOf("list: workspaceProcedure");
    const listEnd = src.indexOf("listTemplates:", listStart);
    expect(listStart).toBeGreaterThan(-1);
    const body = src.slice(listStart, listEnd);
    expect(body).toContain("liveEnrolledCounts(db, ctx.workspace.id)");
    expect(body).toContain("enrolledCount: enrolled.get(s.id) ?? 0");
    expect(body.indexOf("enrolledCount: enrolled.get(s.id)"), "count must be mapped before the role branch returns").toBeLessThan(body.indexOf('roleRank("manager")'));
  });

  it("get overrides the stored column too (the editor header reads it)", () => {
    const getStart = src.indexOf("get: workspaceProcedure");
    expect(getStart).toBeGreaterThan(-1);
    const body = src.slice(getStart, src.indexOf("create: repProcedure", getStart));
    expect(body).toContain("liveEnrolledCounts(db, ctx.workspace.id)");
    expect(body).toContain("enrolledCount: enrolled.get(row.id) ?? 0");
  });
});
