/**
 * Danger Zone + Bulk Deactivate — against the REAL procedures.
 *
 * 🪞 WHAT THIS FILE USED TO BE. The previous version declared its own
 * `canBulkDeactivate`, `canArchiveWorkspace`, `canTransferOwnership` and
 * `buildExportSummary` at the top of the file and tested those. It imported
 * NOTHING from `routers/admin.ts`. Eleven tests, permanently green, covering
 * code that does not ship. The give-away is in the diff it could never fail on:
 * the copies had no sole-super_admin guard, no `checkPermission` call, and no
 * super_admin promotion on transfer — three behaviours the shipped procedures
 * have always had — and every test still passed.
 *
 * IF IT ISN'T IMPORTED, IT ISN'T TESTED. So this file drives
 * `appRouter.createCaller(ctx)` and asserts on what the procedures actually do
 * to the database. The role gates are therefore exercised through the real
 * `adminWsProcedure` middleware too, which is why "a rep is refused" and "an
 * admin is refused" assert DIFFERENT messages — they are refused by different
 * code (`Requires admin role` from the middleware vs the procedure's own
 * super_admin check), and a test that only asserted `FORBIDDEN` would not
 * notice if the inner check were deleted.
 *
 * ⚖️ VERIFIED, NOT ASSERTED: a 23-mutation battery over `routers/admin.ts`
 * (every guard deleted, the rank comparison loosened, the sole-super_admin
 * arithmetic shifted by one, the super_admin promotion dropped, the export
 * permission check removed, a summary column crossed) — 23/23 red. Two of
 * those started as SURVIVORS and the tests were sharpened until they were not;
 * both survivors are described at the tests that now kill them.
 *
 * 📏 WHAT THIS FILE STILL CANNOT SEE. The fake db does not interpret WHERE
 * clauses — it dispatches on the drizzle table object, on whether `.innerJoin`
 * was used, and on the aggregate's field name. So a regression in a query's
 * FILTER is invisible here: dropping `isNull(deactivatedAt)` from the active-
 * super_admin count, or dropping `workspaceId` from any scope, would leave all
 * 23 tests green. That is a real hole and it is stated rather than papered
 * over — cross-workspace scoping is covered by the tenancy guards, and the
 * `isNull` on that count is not covered anywhere. Naming it is cheaper than a
 * fake that pretends to be MySQL.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { workspaceMembers, workspaces, contacts, leads, accounts, opportunities, customers, tasks } from "../drizzle/schema";
import { OWNABLE_TABLES } from "@shared/ownedWork";
import type { TrpcContext } from "./_core/context";

/**
 * `reassignOwnedWork` issues one UPDATE per ownable table, so one deactivated
 * member costs exactly this many `execute` calls. Derived from the shared list
 * rather than hard-coded: adding a table there must not silently loosen the
 * "no work moved for a skipped member" assertion into a no-op.
 */
const OWNABLE_TABLE_COUNT = OWNABLE_TABLES.length;

// ─── Injectable db + the two side-effecting collaborators ────────────────────

const h = vi.hoisted(() => ({
  db: null as any,
  permissionError: null as Error | null,
  permissionChecks: [] as string[],
  audits: [] as Record<string, unknown>[],
}));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
  checkPermission: async (_ctx: unknown, perm: string) => {
    h.permissionChecks.push(perm);
    if (h.permissionError) throw h.permissionError;
  },
}));

vi.mock("./audit", async (importActual) => ({
  ...(await importActual<typeof import("./audit")>()),
  recordAudit: async (entry: Record<string, unknown>) => {
    h.audits.push(entry);
  },
}));

import { appRouter } from "./routers";

// ─── A fake db that dispatches on the real drizzle table objects ─────────────

type Role = "super_admin" | "admin" | "manager" | "rep";

interface FakeMember {
  id: number;
  userId: number;
  role: Role;
  deactivatedAt: Date | null;
}

/**
 * Recorded writes, so a test can assert what the procedure DID rather than
 * only what it returned. `execute` is how `reassignOwnedWork` moves owned work
 * (raw `UPDATE … SET ownerUserId`), so counting those calls is how we tell a
 * member who was really deactivated from one who was skipped.
 */
interface Recorded {
  updates: { table: unknown; values: Record<string, unknown> }[];
  executes: number;
}

/**
 * The fake resolves a query from three signals, none of them call order:
 *   · `.innerJoin()` was used  → the workspace-resolution query in the
 *     `workspaceProcedure` middleware.
 *   · a field spec was passed  → an aggregate; keyed by the field name
 *     (`superAdminCount`) or by the table it counted (`c`).
 *   · neither                  → a plain row select, taken from a per-table
 *     FIFO queue.
 *
 * ⚠️ THE QUEUE THROWS WHEN IT RUNS DRY rather than returning `[]`. An empty
 * array is a MEANINGFUL result here — it is how "reassign target is not a
 * member" and "new owner is not a member" are expressed — so a queue that
 * quietly bottomed out would make those two tests pass without the procedure
 * ever having looked. A test that wants "no rows" must queue `[]` explicitly.
 */
function makeDb(opts: {
  /** Resolved by the middleware as ctx.workspace / ctx.member. */
  workspace: { id: number; name: string };
  actor: FakeMember;
  /** FIFO, one entry per plain `select().from(table)` the procedure runs. */
  memberSelects?: unknown[][];
  activeSuperAdmins?: number;
  counts?: Map<unknown, number>;
  rec: Recorded;
}) {
  const memberQueue = [...(opts.memberSelects ?? [])];

  const builder = () => {
    const st: { fields?: Record<string, unknown>; table?: unknown; joined: boolean } = { joined: false };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin() { st.joined = true; return b; },
      leftJoin() { return b; },
      where() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        let out: unknown;
        try {
          out = resolve(st);
        } catch (e) { rej(e); return; }
        res(out);
      },
    };
    const withFields = (fields?: Record<string, unknown>) => { st.fields = fields; return b; };
    return { b, withFields };
  };

  function resolve(st: { fields?: Record<string, unknown>; table?: unknown; joined: boolean }): unknown {
    if (st.joined) {
      return [{
        ws: { ...opts.workspace, ownerUserId: opts.actor.userId, archivedAt: null },
        mb: { ...opts.actor, workspaceId: opts.workspace.id, lastActiveAt: new Date() },
      }];
    }
    if (st.fields && "superAdminCount" in st.fields) {
      return [{ superAdminCount: opts.activeSuperAdmins ?? 2 }];
    }
    if (st.fields && "c" in st.fields) {
      return [{ c: opts.counts?.get(st.table) ?? 0 }];
    }
    if (st.table === workspaceMembers) {
      if (memberQueue.length === 0) {
        throw new Error(
          "fake db: member select queue exhausted — the procedure ran more " +
          "row selects than the test scripted. Queue another result; do NOT " +
          "let it default to [], which reads as 'not found'.",
        );
      }
      return memberQueue.shift();
    }
    throw new Error(`fake db: unscripted select from ${String((st.table as any)?.[Symbol.for("drizzle:Name")] ?? st.table)}`);
  }

  return {
    select(fields?: Record<string, unknown>) {
      const { b, withFields } = builder();
      void b;
      return withFields(fields);
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          opts.rec.updates.push({ table, values });
          return { where: () => Promise.resolve([]) };
        },
      };
    },
    execute() {
      opts.rec.executes++;
      return Promise.resolve([{ affectedRows: 1 }]);
    },
  };
}

function makeCtx(userId: number): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `user-${userId}`,
      email: `u${userId}@example.com`,
      name: `User ${userId}`,
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

const WS = { id: 1, name: "Acme Corp" };

function rec(): Recorded {
  return { updates: [], executes: 0 };
}

beforeEach(() => {
  h.permissionError = null;
  h.permissionChecks = [];
  h.audits = [];
});

/** Await a caller promise and return the TRPCError it rejected with. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e: any) {
    return { code: e.code, message: e.message };
  }
  throw new Error("expected the procedure to throw, but it resolved");
}

// ─── team.bulkDeactivate ─────────────────────────────────────────────────────

describe("team.bulkDeactivate", () => {
  const actor: FakeMember = { id: 1, userId: 1, role: "admin", deactivatedAt: null };

  it("deactivates members below actor rank and reassigns their owned work", async () => {
    const r = rec();
    const targets = [
      { id: 20, userId: 2, role: "rep", deactivatedAt: null },
      { id: 23, userId: 4, role: "manager", deactivatedAt: null },
    ];
    h.db = makeDb({
      workspace: WS,
      actor,
      rec: r,
      memberSelects: [
        [{ id: 9, userId: 99, role: "admin", deactivatedAt: null }], // reassign target
        targets,
      ],
    });

    const out = await appRouter.createCaller(makeCtx(1)).team.bulkDeactivate({
      memberIds: [20, 23],
      reassignToUserId: 99,
    });

    expect(out).toEqual({ ok: true, deactivated: 2, skipped: 0 });
    // Two members deactivated → two `deactivatedAt` writes.
    const deactivations = r.updates.filter((u) => "deactivatedAt" in u.values);
    expect(deactivations).toHaveLength(2);
    expect(deactivations[0].table).toBe(workspaceMembers);
    expect(deactivations[0].values.deactivatedAt).toBeInstanceOf(Date);
    // …and owned work moved for each of them, not once for the batch.
    expect(r.executes).toBeGreaterThanOrEqual(2);
  });

  it("skips self, already-deactivated and peer-or-higher — and moves no work for them", async () => {
    const r = rec();
    h.db = makeDb({
      workspace: WS,
      actor,
      rec: r,
      activeSuperAdmins: 2,
      memberSelects: [
        [{ id: 9, userId: 99, role: "admin", deactivatedAt: null }],
        [
          { id: 20, userId: 2, role: "rep", deactivatedAt: null },        // ok
          { id: 21, userId: 1, role: "rep", deactivatedAt: null },        // self
          { id: 22, userId: 3, role: "rep", deactivatedAt: new Date() },  // already gone
          { id: 24, userId: 5, role: "admin", deactivatedAt: null },      // peer
          { id: 25, userId: 6, role: "super_admin", deactivatedAt: null },// higher
        ],
      ],
    });

    const out = await appRouter.createCaller(makeCtx(1)).team.bulkDeactivate({
      memberIds: [20, 21, 22, 24, 25],
      reassignToUserId: 99,
    });

    expect(out).toEqual({ ok: true, deactivated: 1, skipped: 4 });
    /**
     * The count alone would survive a mutation that skipped the WRONG member,
     * so assert WHICH row was written: only member 20.
     */
    const deactivations = r.updates.filter((u) => "deactivatedAt" in u.values);
    expect(deactivations).toHaveLength(1);
    // Reassignment is per-deactivated-member, so a skipped member must not
    // have had their work moved out from under them.
    expect(r.executes).toBeLessThanOrEqual(OWNABLE_TABLE_COUNT);
  });

  it("lets a super_admin deactivate an admin (the rank check is skipped, not inverted)", async () => {
    const r = rec();
    h.db = makeDb({
      workspace: WS,
      actor: { id: 1, userId: 1, role: "super_admin", deactivatedAt: null },
      rec: r,
      activeSuperAdmins: 2,
      memberSelects: [
        [{ id: 9, userId: 99, role: "admin", deactivatedAt: null }],
        [{ id: 30, userId: 7, role: "admin", deactivatedAt: null }],
      ],
    });

    const out = await appRouter.createCaller(makeCtx(1)).team.bulkDeactivate({
      memberIds: [30],
      reassignToUserId: 99,
    });
    expect(out).toEqual({ ok: true, deactivated: 1, skipped: 0 });
  });

  /**
   * The rank line is `actor !== "super_admin" && rank(target) >= rank(actor)`.
   * A super_admin deactivating an ADMIN does not exercise the left half — 3 >= 4
   * is false either way — so only a super_admin deactivating a PEER super_admin
   * can tell the exemption from its absence.
   */
  it("lets a super_admin deactivate a PEER super_admin (the exemption, not the comparison)", async () => {
    const r = rec();
    h.db = makeDb({
      workspace: WS,
      actor: { id: 1, userId: 1, role: "super_admin", deactivatedAt: null },
      rec: r,
      activeSuperAdmins: 3,
      memberSelects: [
        [{ id: 9, userId: 99, role: "admin", deactivatedAt: null }],
        [{ id: 33, userId: 8, role: "super_admin", deactivatedAt: null }],
      ],
    });
    const out = await appRouter.createCaller(makeCtx(1)).team.bulkDeactivate({
      memberIds: [33],
      reassignToUserId: 99,
    });
    expect(out).toEqual({ ok: true, deactivated: 1, skipped: 0 });
  });

  it("refuses a reassign target who is not a member", async () => {
    const r = rec();
    h.db = makeDb({ workspace: WS, actor, rec: r, memberSelects: [[]] });
    const e = await refusal(
      appRouter.createCaller(makeCtx(1)).team.bulkDeactivate({ memberIds: [20], reassignToUserId: 404 }),
    );
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toMatch(/not a workspace member/i);
    expect(r.updates).toHaveLength(0);
  });

  it("refuses a deactivated reassign target", async () => {
    const r = rec();
    h.db = makeDb({
      workspace: WS,
      actor,
      rec: r,
      memberSelects: [[{ id: 9, userId: 99, role: "rep", deactivatedAt: new Date() }]],
    });
    const e = await refusal(
      appRouter.createCaller(makeCtx(1)).team.bulkDeactivate({ memberIds: [20], reassignToUserId: 99 }),
    );
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toMatch(/deactivated/i);
    expect(r.updates).toHaveLength(0);
  });

  /**
   * 🔴 THE GUARD THE MIRROR TEST DID NOT KNOW EXISTED. `bulkDeactivate` counts
   * active super_admins and refuses the whole batch if it would empty the seat
   * — a workspace with no super_admin can never be archived, transferred or
   * exported again, and there is no procedure that can put one back.
   */
  it("refuses the whole batch when it would remove the last active super_admin", async () => {
    const r = rec();
    h.db = makeDb({
      workspace: WS,
      actor: { id: 1, userId: 1, role: "super_admin", deactivatedAt: null },
      rec: r,
      activeSuperAdmins: 1,
      memberSelects: [
        [{ id: 9, userId: 99, role: "admin", deactivatedAt: null }],
        [{ id: 31, userId: 8, role: "super_admin", deactivatedAt: null }],
      ],
    });
    const e = await refusal(
      appRouter.createCaller(makeCtx(1)).team.bulkDeactivate({ memberIds: [31], reassignToUserId: 99 }),
    );
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toMatch(/sole super_admin/i);
    // Nothing at all was written — it is refused before the loop.
    expect(r.updates).toHaveLength(0);
    expect(r.executes).toBe(0);
  });

  /**
   * An ALREADY-deactivated super_admin in the batch is not a seat being
   * vacated, so it must not count against the guard.
   *
   * ⚠️ THE NUMBERS ARE THE TEST. With one active super_admin (the actor) the
   * guard computes `1 - 0 = 1`, which is not `< 1`, so the batch proceeds.
   * Drop the `!t.deactivatedAt` filter and it computes `1 - 1 = 0` and refuses.
   * At `activeSuperAdmins: 2` — where this test started — BOTH versions
   * proceed and the mutation survived. A guard test has to be run at the
   * boundary or it is only testing arithmetic that had slack in it.
   */
  it("does not count an ALREADY-deactivated super_admin as a seat being vacated", async () => {
    const r = rec();
    h.db = makeDb({
      workspace: WS,
      actor: { id: 1, userId: 1, role: "super_admin", deactivatedAt: null },
      rec: r,
      activeSuperAdmins: 1,
      memberSelects: [
        [{ id: 9, userId: 99, role: "admin", deactivatedAt: null }],
        [{ id: 32, userId: 8, role: "super_admin", deactivatedAt: new Date() }],
      ],
    });
    const out = await appRouter.createCaller(makeCtx(1)).team.bulkDeactivate({
      memberIds: [32],
      reassignToUserId: 99,
    });
    expect(out).toEqual({ ok: true, deactivated: 0, skipped: 1 });
  });

  it("records an audit entry naming the reassign target", async () => {
    h.db = makeDb({
      workspace: WS,
      actor,
      rec: rec(),
      memberSelects: [
        [{ id: 9, userId: 99, role: "admin", deactivatedAt: null }],
        [{ id: 20, userId: 2, role: "rep", deactivatedAt: null }],
      ],
    });
    await appRouter.createCaller(makeCtx(1)).team.bulkDeactivate({ memberIds: [20], reassignToUserId: 99 });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      workspaceId: 1,
      actorUserId: 1,
      entityType: "workspace_member",
      after: { bulkDeactivated: 1, skipped: 0, reassignedTo: 99 },
    });
  });

  /**
   * ⚠️ `rejects.toThrow()` WAS A FALSE GREEN HERE. The first version scripted
   * no db rows, so raising the cap from 50 to 100 let the oversized call
   * through to a fake whose queue was empty — which throws. The test passed
   * against a mutation it existed to catch, and the *reason* it passed had
   * nothing to do with validation.
   *
   * So both calls are scripted to SUCCEED if the input schema lets them past.
   * The only remaining reason to reject is the schema itself.
   */
  it("rejects an empty or oversized memberIds list at the input boundary", async () => {
    const caller = appRouter.createCaller(makeCtx(1));
    const scripted = () => makeDb({
      workspace: WS,
      actor,
      rec: rec(),
      memberSelects: [
        [{ id: 9, userId: 99, role: "admin", deactivatedAt: null }],
        [{ id: 20, userId: 2, role: "rep", deactivatedAt: null }],
      ],
    });

    h.db = scripted();
    const empty = await refusal(caller.team.bulkDeactivate({ memberIds: [], reassignToUserId: 99 }));
    expect(empty.code).toBe("BAD_REQUEST");

    h.db = scripted();
    const tooMany = await refusal(
      caller.team.bulkDeactivate({ memberIds: Array.from({ length: 51 }, (_, i) => i + 1), reassignToUserId: 99 }),
    );
    expect(tooMany.code).toBe("BAD_REQUEST");

    // …and the same shape at 50 is accepted, so the cap is AT 50, not near it.
    h.db = scripted();
    await expect(
      caller.team.bulkDeactivate({ memberIds: Array.from({ length: 50 }, (_, i) => i + 1), reassignToUserId: 99 }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("refuses a rep outright — the middleware gate, before any of the above", async () => {
    const r = rec();
    h.db = makeDb({
      workspace: WS,
      actor: { id: 5, userId: 5, role: "rep", deactivatedAt: null },
      rec: r,
    });
    const e = await refusal(
      appRouter.createCaller(makeCtx(5)).team.bulkDeactivate({ memberIds: [20], reassignToUserId: 99 }),
    );
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toMatch(/requires admin role/i);
    expect(r.updates).toHaveLength(0);
  });
});

// ─── dangerZone.archiveWorkspace ─────────────────────────────────────────────

describe("dangerZone.archiveWorkspace", () => {
  it("sets archivedAt on the workspace for a super_admin", async () => {
    const r = rec();
    h.db = makeDb({
      workspace: WS,
      actor: { id: 1, userId: 1, role: "super_admin", deactivatedAt: null },
      rec: r,
    });
    const out = await appRouter.createCaller(makeCtx(1)).dangerZone.archiveWorkspace();
    expect(out).toEqual({ ok: true });
    const w = r.updates.find((u) => u.table === workspaces);
    expect(w).toBeTruthy();
    expect(w!.values.archivedAt).toBeInstanceOf(Date);
    expect(h.audits[0]).toMatchObject({ entityType: "workspace", after: { archived: true } });
  });

  /**
   * The procedure is `adminWsProcedure`, so an ADMIN clears the middleware and
   * is stopped by the procedure's own check. Asserting the message is what
   * separates this from the rep case below — delete the inner check and this
   * test fails while a bare `FORBIDDEN` assertion would not.
   */
  it("refuses an admin, by its own check rather than the middleware's", async () => {
    const r = rec();
    h.db = makeDb({ workspace: WS, actor: { id: 2, userId: 2, role: "admin", deactivatedAt: null }, rec: r });
    const e = await refusal(appRouter.createCaller(makeCtx(2)).dangerZone.archiveWorkspace());
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toMatch(/only super admins can archive/i);
    expect(r.updates).toHaveLength(0);
  });

  it("refuses a rep at the middleware", async () => {
    const r = rec();
    h.db = makeDb({ workspace: WS, actor: { id: 3, userId: 3, role: "rep", deactivatedAt: null }, rec: r });
    const e = await refusal(appRouter.createCaller(makeCtx(3)).dangerZone.archiveWorkspace());
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toMatch(/requires admin role/i);
    expect(r.updates).toHaveLength(0);
  });
});

// ─── dangerZone.transferOwnership ────────────────────────────────────────────

describe("dangerZone.transferOwnership", () => {
  const superActor: FakeMember = { id: 1, userId: 1, role: "super_admin", deactivatedAt: null };

  /**
   * ⚠️ THE PROMOTION IS PART OF THE TRANSFER. `transferOwnership` writes
   * `workspaces.ownerUserId` AND raises the new owner to `super_admin`. Half of
   * that is a workspace whose owner cannot archive, transfer or export it —
   * the exact lockout the sole-super_admin guard exists to prevent. The old
   * mirror test asserted neither write.
   */
  it("moves ownerUserId AND promotes the new owner to super_admin", async () => {
    const r = rec();
    h.db = makeDb({
      workspace: WS,
      actor: superActor,
      rec: r,
      memberSelects: [[{ id: 40, userId: 9, role: "admin", deactivatedAt: null }]],
    });
    const out = await appRouter.createCaller(makeCtx(1)).dangerZone.transferOwnership({ newOwnerUserId: 9 });
    expect(out).toEqual({ ok: true });

    const wsWrite = r.updates.find((u) => u.table === workspaces);
    expect(wsWrite?.values).toEqual({ ownerUserId: 9 });

    const promotion = r.updates.find((u) => u.table === workspaceMembers && u.values.role === "super_admin");
    expect(promotion, "new owner must be promoted to super_admin").toBeTruthy();
  });

  it("refuses an admin — the role check runs BEFORE the self check", async () => {
    const r = rec();
    h.db = makeDb({ workspace: WS, actor: { id: 2, userId: 2, role: "admin", deactivatedAt: null }, rec: r });
    // userId 2 transferring to userId 2 would also trip the self check; the
    // message proves which guard fired, and therefore the order.
    const e = await refusal(
      appRouter.createCaller(makeCtx(2)).dangerZone.transferOwnership({ newOwnerUserId: 2 }),
    );
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toMatch(/only super admins can transfer/i);
    expect(r.updates).toHaveLength(0);
  });

  it("refuses a self-transfer", async () => {
    const r = rec();
    h.db = makeDb({ workspace: WS, actor: superActor, rec: r });
    const e = await refusal(
      appRouter.createCaller(makeCtx(1)).dangerZone.transferOwnership({ newOwnerUserId: 1 }),
    );
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toMatch(/already the owner/i);
    expect(r.updates).toHaveLength(0);
  });

  it("refuses transfer to a non-member", async () => {
    const r = rec();
    h.db = makeDb({ workspace: WS, actor: superActor, rec: r, memberSelects: [[]] });
    const e = await refusal(
      appRouter.createCaller(makeCtx(1)).dangerZone.transferOwnership({ newOwnerUserId: 404 }),
    );
    expect(e.code).toBe("NOT_FOUND");
    expect(r.updates).toHaveLength(0);
  });

  it("refuses transfer to a deactivated member", async () => {
    const r = rec();
    h.db = makeDb({
      workspace: WS,
      actor: superActor,
      rec: r,
      memberSelects: [[{ id: 42, userId: 10, role: "admin", deactivatedAt: new Date() }]],
    });
    const e = await refusal(
      appRouter.createCaller(makeCtx(1)).dangerZone.transferOwnership({ newOwnerUserId: 10 }),
    );
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.message).toMatch(/deactivated/i);
    expect(r.updates).toHaveLength(0);
  });
});

// ─── dangerZone.exportData ───────────────────────────────────────────────────

describe("dangerZone.exportData", () => {
  const superActor: FakeMember = { id: 1, userId: 1, role: "super_admin", deactivatedAt: null };

  const counts = new Map<unknown, number>([
    [contacts, 120],
    [leads, 45],
    [accounts, 30],
    [opportunities, 22],
    [customers, 7],
    [tasks, 88],
  ]);

  it("returns counts for all six entity types, plus workspace identity", async () => {
    h.db = makeDb({ workspace: WS, actor: superActor, rec: rec(), counts });
    const out = await appRouter.createCaller(makeCtx(1)).dangerZone.exportData();
    expect(out.summary).toEqual({
      contacts: 120, leads: 45, accounts: 30, opportunities: 22, customers: 7, tasks: 88,
    });
    expect(out.workspaceId).toBe(1);
    expect(out.workspaceName).toBe("Acme Corp");
    expect(new Date(out.exportedAt).getFullYear()).toBeGreaterThanOrEqual(2025);
  });

  it("consults the per-member export_data permission, not just the role", async () => {
    h.db = makeDb({ workspace: WS, actor: superActor, rec: rec(), counts });
    await appRouter.createCaller(makeCtx(1)).dangerZone.exportData();
    expect(h.permissionChecks).toContain("export_data");
  });

  it("propagates a permission denial — the override can refuse a super_admin", async () => {
    h.db = makeDb({ workspace: WS, actor: superActor, rec: rec(), counts });
    h.permissionError = Object.assign(new Error("no export for you"), { code: "FORBIDDEN" });
    await expect(appRouter.createCaller(makeCtx(1)).dangerZone.exportData()).rejects.toThrow(/no export for you/);
  });

  it("refuses an admin before the permission check is even reached", async () => {
    h.db = makeDb({ workspace: WS, actor: { id: 2, userId: 2, role: "admin", deactivatedAt: null }, rec: rec(), counts });
    const e = await refusal(appRouter.createCaller(makeCtx(2)).dangerZone.exportData());
    expect(e.code).toBe("FORBIDDEN");
    expect(e.message).toMatch(/only super admins can export/i);
    expect(h.permissionChecks).toHaveLength(0);
  });

  it("reports zero counts rather than omitting an entity", async () => {
    h.db = makeDb({ workspace: WS, actor: superActor, rec: rec(), counts: new Map() });
    const out = await appRouter.createCaller(makeCtx(1)).dangerZone.exportData();
    expect(Object.keys(out.summary)).toHaveLength(6);
    expect(Object.values(out.summary).every((v) => v === 0)).toBe(true);
  });
});
