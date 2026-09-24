/**
 * Undoing the "meeting booked" effects of invites nobody accepted (owner ask
 * 2026-09-24: 22 CommunityForce + 2 LSI prospects). Reverses exactly what
 * the signal did, and nothing a real reply or a real acceptance justifies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { areCampaigns, areExecutionQueue, areSignalLog, meetings, prospectQueue } from "../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { REPLIED_SKIP_REASON, undoInviteBookingSignals } from "./services/are/undoInviteBookings";

const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);
const WS = 4;
const HOUR = 3_600_000;
const signalAt = new Date(Date.now() - 2 * HOUR);

type World = {
  signals: any[]; replySignals: any[]; meetings: any[]; prospects: any[]; queue: any[];
  updates: { table: unknown; set: any; where: unknown }[];
  deletes: { table: unknown; where: unknown }[];
  executes: string[];
};
let w: World;

function makeDb() {
  const builder = (fields?: Record<string, unknown>) => {
    const st: { table?: unknown; where?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      where(c: unknown) { st.where = c; return b; },
      orderBy() { return b; }, limit() { return b; },
      then(res: (v: unknown) => void) {
        if (st.table === areSignalLog) res(fields && "rawPayload" in fields ? w.signals : w.replySignals);
        else if (st.table === meetings) res(w.meetings);
        else if (st.table === prospectQueue) res(w.prospects);
        else if (st.table === areCampaigns) res([{ id: 21, stepGapDays: 3 }]);
        else if (st.table === areExecutionQueue) {
          const params = render(st.where).params;
          res(w.queue.filter((r) => params.includes(r.prospectQueueId)));
        } else res([]);
      },
    };
    return b;
  };
  return {
    select: (fields?: Record<string, unknown>) => builder(fields),
    update: (t: unknown) => { const u: any = { table: t }; const b: any = { set(v: any) { u.set = v; return b; }, where(c: unknown) { u.where = c; w.updates.push(u); return Promise.resolve([]); } }; return b; },
    delete: (t: unknown) => ({ where(c: unknown) { w.deletes.push({ table: t, where: c }); return Promise.resolve([]); } }),
    execute: (q: unknown) => { w.executes.push(render(q).sql + " | " + JSON.stringify(render(q).params)); return Promise.resolve([]); },
  };
}

const signal = (over: Record<string, unknown> = {}) => ({ id: 900, prospectQueueId: 7, campaignId: 21, rawPayload: { source: "autonomous_booking", meetingId: 55 }, processedAt: signalAt, ...over });
const prospect = (over: Record<string, unknown> = {}) => ({ id: 7, firstName: "Ada", lastName: "Lovelace", sequenceStatus: "replied", linkedContactId: 301, linkedOpportunityId: null, ...over });

beforeEach(() => {
  w = {
    signals: [signal()],
    replySignals: [],
    meetings: [{ id: 55, status: "cancelled", attendeeResponse: null }],
    prospects: [prospect()],
    queue: [
      { id: 1, prospectQueueId: 7, stepIndex: 0, status: "sent", scheduledAt: new Date(Date.now() - 9 * 24 * HOUR), executedAt: new Date(Date.now() - 9 * 24 * HOUR), failureReason: null },
      // Came due after the fake booking and was skipped because of it.
      { id: 2, prospectQueueId: 7, stepIndex: 1, status: "skipped", scheduledAt: new Date(Date.now() - HOUR), executedAt: new Date(Date.now() - HOUR), failureReason: REPLIED_SKIP_REASON },
      { id: 3, prospectQueueId: 7, stepIndex: 2, status: "scheduled", scheduledAt: new Date(Date.now() + 2 * 24 * HOUR), executedAt: null, failureReason: null },
    ],
    updates: [], deletes: [], executes: [],
  };
  h.db = makeDb();
});

describe("undoInviteBookingSignals", () => {
  it("dry run by default: reports each prospect, writes nothing", async () => {
    const res = await undoInviteBookingSignals(WS);
    expect(res.dryRun).toBe(true);
    expect(res.undone).toBe(0);
    expect(res.rows).toEqual([{
      signalId: 900, prospectQueueId: 7, campaignId: 21, meetingId: 55, name: "Ada Lovelace",
      statusBefore: "replied", restoresStatus: true, keptReason: undefined, stepsRevived: 1,
      crm: { contactId: 301, opportunityId: null },
    }]);
    expect(w.updates).toEqual([]);
    expect(w.deletes).toEqual([]);
    expect(w.executes).toEqual([]);
  });

  it("for real: sequence back to enrolled, the skipped step revived (not now, not a burst), count down, signal gone", async () => {
    const res = await undoInviteBookingSignals(WS, { dryRun: false });
    expect(res.undone).toBe(1);
    const status = w.updates.find((u) => u.table === prospectQueue);
    expect(status?.set).toEqual({ sequenceStatus: "enrolled" });
    // Only if it is still the fake "replied".
    expect(render(status!.where).params).toEqual(expect.arrayContaining([7, WS, "replied"]));
    const revive = w.updates.find((u) => u.table === areExecutionQueue && u.set.status === "scheduled");
    expect(revive?.set).toMatchObject({ status: "scheduled", failureReason: null, executedAt: null });
    expect(render(revive!.where).params).toEqual(expect.arrayContaining([2, "skipped", REPLIED_SKIP_REASON]));
    expect((revive!.set.scheduledAt as Date).getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
    expect(w.executes).toHaveLength(1);
    expect(w.executes[0]).toContain("meetingsBooked = GREATEST(0, meetingsBooked - 1)");
    expect(w.executes[0]).toContain("[21,4]");
    expect(w.deletes).toHaveLength(1);
    expect(w.deletes[0].table).toBe(areSignalLog);
    expect(render(w.deletes[0].where).params).toEqual([900, WS]);
  });

  it("the next pending step keeps its campaign gap after the revived one", async () => {
    // Step 2 was due in 2 days; with a 3-day gap it moves to 3 days after the revived step 1.
    await undoInviteBookingSignals(WS, { dryRun: false });
    const pushed = w.updates.find((u) => u.table === areExecutionQueue && !u.set.status);
    expect(pushed).toBeDefined();
    expect(render(pushed!.where).params).toEqual(expect.arrayContaining([3, "scheduled"]));
  });

  it("someone who REALLY replied stays replied; the fake booking still comes off the count", async () => {
    w.replySignals = [{ prospectQueueId: 7 }];
    const res = await undoInviteBookingSignals(WS, { dryRun: false });
    expect(res.rows[0]).toMatchObject({ restoresStatus: false, keptReason: "they really replied", stepsRevived: 0 });
    expect(w.updates).toEqual([]);
    expect(w.executes).toHaveLength(1);
    expect(w.deletes).toHaveLength(1);
  });

  it("a skip from BEFORE the fake booking is not revived", async () => {
    w.queue[1] = { ...w.queue[1], executedAt: new Date(signalAt.getTime() - 5 * 60_000) };
    const res = await undoInviteBookingSignals(WS);
    expect(res.rows[0].stepsRevived).toBe(0);
  });

  it("never touches an ACCEPTED meeting's signal", async () => {
    w.meetings = [{ id: 55, status: "cancelled", attendeeResponse: "accepted" }];
    expect((await undoInviteBookingSignals(WS, { dryRun: false })).rows).toEqual([]);
    expect(w.deletes).toEqual([]);
  });

  it("never touches a meeting still on the books, or a hand-ingested signal", async () => {
    w.meetings = [{ id: 55, status: "invited", attendeeResponse: null }];
    expect((await undoInviteBookingSignals(WS)).rows).toEqual([]);
    w.meetings = [{ id: 55, status: "cancelled", attendeeResponse: null }];
    w.signals = [signal({ rawPayload: { source: "manual", meetingId: 55 } })];
    expect((await undoInviteBookingSignals(WS)).rows).toEqual([]);
  });

  it("the endpoint is admin-only and previews by default", () => {
    const router = readFileSync("server/routers/meetings.ts", "utf8");
    expect(router).toContain("undoInviteBookingSignals: adminWsProcedure");
    expect(router).toContain("const res = await undoInviteBookingSignals(ctx.workspace.id, { dryRun: input?.dryRun ?? true });");
  });
});
