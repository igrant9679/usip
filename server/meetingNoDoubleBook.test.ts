/**
 * No more one-slot pile-ups (2026-09-24). Every CommunityForce proposal
 * offered the same three times, and "Approve & send all" booked each at its
 * earliest one: 33 prospects invited to the same 2 PM slot on Khaja Syed's
 * calendar before the run was cut off by a deploy.
 *
 *  1. Drafting spreads offers: least-offered slots first, and the owner's
 *     booked meetings count as busy.
 *  2. Sending never books a slot the owner is already booked in: checked
 *     against Velocity's own bookings (which cannot lag) and the live
 *     calendar, moving to the next free offered time when none was picked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { calendarAccounts, calendarEvents, meetings, workspaceSettings, workspaces } from "../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any, listEvents: null as any, createEvent: null as any }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));
vi.mock("./_core/llm", async (importActual) => ({
  ...(await importActual<typeof import("./_core/llm")>()),
  invokeLLM: async () => { throw new Error("no model in tests"); },
}));
vi.mock("./services/brandContext", async (importActual) => ({
  ...(await importActual<typeof import("./services/brandContext")>()),
  buildBrandContext: async () => "",
}));
vi.mock("./calendarAdapter", async (importActual) => ({
  ...(await importActual<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: () => ({
    listEvents: (...a: unknown[]) => h.listEvents(...a),
    createEvent: (...a: unknown[]) => h.createEvent(...a),
  }),
}));
vi.mock("./routers/are/execution", async (importActual) => ({
  ...(await importActual<typeof import("./routers/are/execution")>()),
  attributeMeetingBookingToAre: async () => {},
}));

import { computeSlots, createMeetingProposal, regenerateMeetingProposal, sendMeetingInvite, __resetLiveBusyCacheForTests } from "./services/meetingScheduler";

const NY = "America/New_York";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const KHAJA = 5721;

describe("1. drafting spreads offers across proposals", () => {
  it("with nothing offered yet, the pick is exactly the old one", () => {
    expect(computeSlots([], 3, 30, NY, new Map())).toEqual(computeSlots([], 3, 30, NY));
  });

  it("slots already offered elsewhere go to the back of the queue", () => {
    const first = computeSlots([], 3, 30, NY);
    const offered = new Map(first.map((s) => [s, 1]));
    const second = computeSlots([], 3, 30, NY, offered);
    expect(second.filter((s) => first.includes(s))).toEqual([]);
  });

  it("twenty proposals in a row: no time is offered twice while free ones remain", () => {
    const offered = new Map<string, number>();
    for (let i = 0; i < 20; i++) {
      for (const s of computeSlots([], 3, 30, NY, offered)) offered.set(s, (offered.get(s) ?? 0) + 1);
    }
    expect(Math.max(...Array.from(offered.values()))).toBe(1);
    expect(offered.size).toBe(60);
  });
});

type Row = { id: number; status: string; proposedTimes: string[] | null; scheduledAt: Date | null; durationMin: number };
type World = { meeting: any; others: Row[]; accounts: any[]; updates: any[]; inserts: any[] };
let w: World;

function makeDb() {
  const builder = (fields?: Record<string, unknown>) => {
    const st: { table?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      where() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void) {
        if (st.table === meetings) res(fields ? w.others : [w.meeting]);
        else if (st.table === calendarAccounts) res(w.accounts);
        else if (st.table === workspaces) res([{ name: "CommunityForce" }]);
        else if (st.table === calendarEvents || st.table === workspaceSettings) res([]);
        else res([]);
      },
    };
    return b;
  };
  return {
    select: (fields?: Record<string, unknown>) => builder(fields),
    insert: (t: unknown) => ({
      values(v: any) { w.inserts.push({ table: t, values: v }); return Promise.resolve([{ insertId: 1 }]); },
    }),
    update: () => {
      const u: any = {};
      const b: any = { set(v: any) { u.set = v; return b; }, where() { w.updates.push(u); return Promise.resolve([]); } };
      return b;
    },
  };
}

// Three offered times, a day apart, at 14:00 UTC.
const base = Math.ceil((Date.now() + 2 * DAY) / DAY) * DAY + 14 * HOUR;
const T = [0, 1, 2].map((d) => new Date(base + d * DAY).toISOString());
const booked = (id: number, at: string): Row => ({ id, status: "scheduled", proposedTimes: [], scheduledAt: new Date(at), durationMin: 30 });
const createdAt = () => (h.createEvent.mock.calls[0]?.[1]?.startAt as Date | undefined)?.toISOString();

beforeEach(() => {
  __resetLiveBusyCacheForTests();
  w = {
    meeting: { id: 9, workspaceId: 4, ownerUserId: KHAJA, status: "proposed", proposedTimes: T, scheduledAt: null, durationMin: 30, title: "Intro", contactEmail: "ada@example.org", contactName: "Ada", inviteMessage: "Hi", meetingUrl: null },
    others: [],
    accounts: [{ id: 2, workspaceId: 4, userId: KHAJA, calendarId: null, unipileAccountId: "acc-ms365" }],
    updates: [],
    inserts: [],
  };
  h.db = makeDb();
  h.listEvents = vi.fn().mockResolvedValue([]);
  h.createEvent = vi.fn(async (_cal: string, e: any) => ({ externalId: "evt", title: e.title, startAt: e.startAt, endAt: e.endAt, meetingUrl: "https://teams.microsoft.com/l/x" }));
});

describe("2. sending never books a taken slot", () => {
  it("the earliest time is booked in Velocity already: the next offered time is booked instead", async () => {
    w.others = [booked(1, T[0])];
    const res = await sendMeetingInvite(4, 9);
    expect(res).toEqual({ sent: true, scheduledAt: T[1] });
    expect(createdAt()).toBe(T[1]);
    expect(w.updates[0].set.scheduledAt.toISOString()).toBe(T[1]);
  });

  it("the live calendar is busy too: it moves past that as well", async () => {
    w.others = [booked(1, T[0])];
    h.listEvents.mockResolvedValue([{ externalId: "x", title: "Board call", startAt: new Date(Date.parse(T[1]) - 15 * 60000), endAt: new Date(Date.parse(T[1]) + 15 * 60000) }]);
    expect(await sendMeetingInvite(4, 9)).toEqual({ sent: true, scheduledAt: T[2] });
  });

  it("every offered time taken: nothing is sent, and it says why", async () => {
    w.others = T.map((t, i) => booked(i + 1, t));
    expect(await sendMeetingInvite(4, 9)).toEqual({ sent: false, scheduledAt: null, reason: "all_times_taken" });
    expect(h.createEvent).not.toHaveBeenCalled();
    expect(w.updates).toEqual([]);
  });

  it("a time the approver picked is refused when taken, never silently moved", async () => {
    w.others = [booked(1, T[1])];
    expect(await sendMeetingInvite(4, 9, T[1])).toEqual({ sent: false, scheduledAt: null, reason: "time_taken" });
    expect(h.createEvent).not.toHaveBeenCalled();
  });

  it("a time the prospect already agreed is theirs: booked as agreed", async () => {
    w.meeting = { ...w.meeting, scheduledAt: new Date(T[0]) };
    w.others = [booked(1, T[0])];
    expect(await sendMeetingInvite(4, 9)).toEqual({ sent: true, scheduledAt: T[0] });
    expect(h.listEvents).not.toHaveBeenCalled();
  });

  it("a live calendar failure still leaves Velocity's bookings to decide", async () => {
    w.others = [booked(1, T[0])];
    h.listEvents.mockRejectedValue(new Error("Unipile 503"));
    expect(await sendMeetingInvite(4, 9)).toEqual({ sent: true, scheduledAt: T[1] });
  });

  it("a meeting ending as the next begins is not a clash", async () => {
    // 30-minute booking at T0 - 30min ends exactly at T0.
    w.others = [booked(1, new Date(Date.parse(T[0]) - 30 * 60000).toISOString())];
    expect(await sendMeetingInvite(4, 9)).toEqual({ sent: true, scheduledAt: T[0] });
  });

  it("after a booking, the next draft reads the calendar again rather than a stale cache", async () => {
    const target = { ownerUserId: KHAJA, relatedType: "prospect", relatedId: 7, name: "Bo Prospect", source: "ai" as const };
    await createMeetingProposal(4, target);            // live read 1 (cached)
    await sendMeetingInvite(4, 9);                     // live read 2 (fresh check), then books
    await createMeetingProposal(4, target);            // live read 3: the cache was dropped
    expect(h.listEvents).toHaveBeenCalledTimes(3);
  });
});

describe("drafting counts the owner's other proposals and bookings", () => {
  it("a slot booked for the owner is never offered, and a heavily offered one is avoided", async () => {
    const first = computeSlots([], 3, 30, "UTC");
    w.others = [
      booked(1, first[0]),
      { id: 2, status: "proposed", proposedTimes: [first[1], first[2]], scheduledAt: null, durationMin: 30 },
    ];
    await createMeetingProposal(4, { ownerUserId: KHAJA, relatedType: "prospect", relatedId: 7, name: "Cy", source: "ai" });
    const offered = w.inserts.find((i) => i.table === meetings).values.proposedTimes as string[];
    expect(offered).toHaveLength(3);
    for (const s of first) expect(offered).not.toContain(s);
  });


  it("regenerating a proposal does not count its OWN old offers against it", async () => {
    const first = computeSlots([], 3, 30, "UTC");
    w.meeting = { ...w.meeting, relatedType: null, relatedId: null, proposedTimes: first };
    w.others = [{ id: 9, status: "proposed", proposedTimes: first, scheduledAt: null, durationMin: 30 }];
    expect(await regenerateMeetingProposal(4, 9)).toEqual({ ok: true });
    expect(w.updates[0].set.proposedTimes).toEqual(first);
  });
});
