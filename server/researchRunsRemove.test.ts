/**
 * Removing research runs from the Research page (owner, 2026-10-15: "give me
 * the ability to remove failed (any) searches from the Research screen"), and
 * the runs behind a market or sector staying reachable from its page ("where
 * can I see a report of what was learned"). A removed run is hidden, not
 * deleted: it still counts toward the day's runs and its page still opens.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, wsId: 2 }));
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const ago = (min: number) => new Date(Date.now() - min * 60_000);

function seed() {
  const run = (o: Record<string, unknown>) => ({
    kind: "sector", subject: "County governments", model: "claude-opus-5-5", costUsd: "0", searches: 0, fetches: 0,
    createdAt: ago(60), updatedAt: new Date(), progress: [], sources: [], dropped: [], ...o,
  });
  h.db.rowsOf("research_jobs").push(
    run({ id: 1, workspaceId: 2, userId: 1, status: "failed", costUsd: "3.45", brief: "What the run found…", error: "Draft failed" }),
    run({ id: 2, workspaceId: 2, userId: 1, status: "done", draft: { kind: "sector", content: {} }, costUsd: "1.13", createdAt: ago(30) }),
    run({ id: 3, workspaceId: 2, userId: 2, status: "failed", costUsd: "0", createdAt: ago(20) }),
    run({ id: 4, workspaceId: 2, userId: 1, status: "running", startedAt: new Date(), createdAt: ago(5) }),
    run({ id: 5, workspaceId: 4, userId: 1, status: "failed", costUsd: "0.20" }),
    run({ id: 6, workspaceId: 7, userId: 2, status: "failed", costUsd: "0" }),
    run({ id: 7, workspaceId: 7, userId: 1, status: "failed", costUsd: "0" }),
    // The runs behind sector 9: the one that created it, a refresh, and another sector's.
    run({ id: 8, workspaceId: 2, userId: 1, status: "done", outcome: "accepted", resultType: "sector", resultId: 9, sectorId: null, createdAt: ago(2000) }),
    run({ id: 9, workspaceId: 2, userId: 1, status: "done", outcome: "discarded", sectorId: 9, createdAt: ago(1900) }),
    run({ id: 10, workspaceId: 2, userId: 1, status: "done", outcome: "accepted", resultType: "sector", resultId: 12, createdAt: ago(1800) }),
    run({ id: 11, workspaceId: 2, userId: 1, kind: "market", status: "done", outcome: "accepted", resultType: "market", resultId: 9, createdAt: ago(1700) }),
  );
}

function caller(ws: number) {
  h.wsId = ws;
  return appRouter.createCaller({
    user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  // LSI Media (admin) = 2, CommunityForce = 4, a workspace where the caller is a manager = 7, a rep's = 8.
  h.db = makeSqlFakeDb({ roles: { 2: "admin", 4: "admin", 7: "manager", 8: "rep" }, wsId: () => h.wsId });
  seed();
});

describe("removing runs from the Research page", () => {
  it("takes them off the list, but they still count toward the day's runs", async () => {
    const before = await caller(2).research.runs.list();
    expect(before.runs.map((r) => r.id)).toEqual([4, 3, 2, 1, 11, 10, 9, 8]);
    expect(await caller(2).research.runs.remove({ ids: [1, 3] })).toEqual({ removed: 2 });
    const after = await caller(2).research.runs.list();
    expect(after.runs.map((r) => r.id)).toEqual([4, 2, 11, 10, 9, 8]);
    expect(after.usedToday).toBe(before.usedToday);
    expect(h.db.rowsOf("research_jobs").length).toBe(11); // nothing deleted
  });

  it("a draft nobody saved is set aside, and can no longer be saved", async () => {
    await caller(2).research.runs.remove({ ids: [2] });
    const row = h.db.rowsOf("research_jobs").find((r: any) => r.id === 2);
    expect(row).toMatchObject({ outcome: "discarded", reviewedByUserId: 1, removedByUserId: 1 });
    expect(row.removedAt).toBeInstanceOf(Date);
    await expect(caller(2).research.runs.accept({ id: 2, parts: ["summary"] } as any)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a removed run still opens, read-only: its brief is there, but it cannot be drafted again", async () => {
    await caller(2).research.runs.remove({ ids: [1] });
    const run = await caller(2).research.runs.get({ id: 1 });
    expect(run.removedAt).toBeInstanceOf(Date);
    expect(run.brief).toBe("What the run found…");
    await expect(caller(2).research.runs.redraft({ id: 1 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "This run was removed from the Research page" });
  });

  it("a run still going must be stopped first, and then nothing in the request is removed", async () => {
    await expect(caller(2).research.runs.remove({ ids: [1, 4] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "Stop the run before removing it" });
    expect(h.db.rowsOf("research_jobs").filter((r: any) => r.removedAt)).toEqual([]);
  });

  it("the person who started a run, or an admin; never another workspace's", async () => {
    await expect(caller(7).research.runs.remove({ ids: [6] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await caller(7).research.runs.remove({ ids: [7] })).toEqual({ removed: 1 });
    expect(await caller(2).research.runs.remove({ ids: [3] })).toEqual({ removed: 1 }); // an admin removes someone else's
    await expect(caller(2).research.runs.remove({ ids: [5] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller(8).research.runs.remove({ ids: [1] })).rejects.toMatchObject({ code: "FORBIDDEN" }); // reps don't
    expect(h.db.rowsOf("research_jobs").find((r: any) => r.id === 5).removedAt ?? null).toBeNull();
  });

  it("removing twice changes nothing the second time", async () => {
    await caller(2).research.runs.remove({ ids: [1] });
    const first = h.db.rowsOf("research_jobs").find((r: any) => r.id === 1).removedAt;
    expect(await caller(2).research.runs.remove({ ids: [1] })).toEqual({ removed: 0 });
    expect(h.db.rowsOf("research_jobs").find((r: any) => r.id === 1).removedAt).toBe(first);
  });
});

describe("what each run learned stays reachable from its market or sector", () => {
  it("a sector lists the run that created it and its refreshes, removed ones included", async () => {
    await caller(2).research.runs.remove({ ids: [9] });
    const runs = await caller(2).research.runs.forRecord({ kind: "sector", id: 9 });
    expect(runs.map((r) => [r.id, !!r.removedAt])).toEqual([[9, true], [8, false]]);
    expect((await caller(2).research.runs.forRecord({ kind: "market", id: 9 })).map((r) => r.id)).toEqual([11]);
    expect(await caller(4).research.runs.forRecord({ kind: "sector", id: 9 })).toEqual([]);
  });
});
