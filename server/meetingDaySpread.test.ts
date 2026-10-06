/**
 * The per-day spread (owner ask 2026-09-28). Autonomous drafted and sent 8
 * CommunityForce invites in one run and all 8 landed on Thu Oct 8, 9 AM to
 * 4 PM: each proposal was sent as soon as it was drafted, so its other offers
 * stopped counting, and Oct 8 stayed the least-offered day for all eight.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { calendarAccounts, calendarEvents, meetings, workspaceSettings, workspaces } from "../drizzle/schema";

const h = vi.hoisted(() => ({ db: null as any, createEvent: null as any }));
vi.mock("./db", async (importActual) => ({ ...(await importActual<typeof import("./db")>()), getDb: async () => h.db }));
vi.mock("./_core/llm", async (importActual) => ({ ...(await importActual<typeof import("./_core/llm")>()), invokeLLM: async () => { throw new Error("no model in tests"); } }));
vi.mock("./services/brandContext", async (importActual) => ({ ...(await importActual<typeof import("./services/brandContext")>()), buildBrandContext: async () => "" }));
vi.mock("./calendarAdapter", async (importActual) => ({
  ...(await importActual<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: () => ({ listEvents: async () => [], createEvent: (...a: unknown[]) => h.createEvent(...a) }),
}));
// No event until accepted (2026-10-06): an un-agreed proposal is emailed
// with its free offered times; nothing goes on the calendar until a pick.
const emailed = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock("./services/meetingProposalEmail", async (importActual) => ({
  ...(await importActual<typeof import("./services/meetingProposalEmail")>()),
  sendProposalEmail: async (input: any) => { emailed.calls.push(input); return { ok: true, fromEmail: "owner@example.org", messageId: "m1" }; },
}));
beforeEach(() => { emailed.calls.length = 0; });
const emailedTimes = (i = 0) => (emailed.calls[i]?.times ?? []).map((t: Date) => t.toISOString());
vi.mock("./routers/are/execution", async (importActual) => ({ ...(await importActual<typeof import("./routers/are/execution")>()), attributeMeetingBookingToAre: async () => {} }));

import { MAX_MEETINGS_PER_OWNER_PER_DAY, computeSlots, createMeetingProposal, dayKeyIn, sendMeetingInvite, __resetLiveBusyCacheForTests } from "./services/meetingScheduler";

const UTC = "UTC";
const DAY = 86_400_000;

describe("the picker", () => {
  it("the cap is 3 a day", () => {
    expect(MAX_MEETINGS_PER_OWNER_PER_DAY).toBe(3);
  });

  it("a full day is never offered", () => {
    const plain = computeSlots([], 3, 30, UTC);
    const first = dayKeyIn(plain[0], UTC);
    const spread = computeSlots([], 3, 30, UTC, undefined, { full: new Set([first]) });
    expect(spread.length).toBe(3);
    expect(spread.every((s) => dayKeyIn(s, UTC) !== first)).toBe(true);
  });

  it("among equally-offered slots, a lighter day wins", () => {
    const plain = computeSlots([], 1, 30, UTC);
    const busyDay = dayKeyIn(plain[0], UTC);
    const [pick] = computeSlots([], 1, 30, UTC, undefined, { load: new Map([[busyDay, 5]]) });
    expect(dayKeyIn(pick, UTC)).not.toBe(busyDay);
  });

  it("replaying the Oct 8 run: eight proposals, each sent as drafted, never more than 3 on a day", () => {
    // What made Oct 8 the magnet: the open queue already offered every slot on
    // the earlier days, and one day carried no offers at all.
    const every = computeSlots([], 200, 30, UTC);
    const emptyDay = [...new Set(every.map((s) => dayKeyIn(s, UTC)))][3];
    const queueOffers = new Map(every.filter((s) => dayKeyIn(s, UTC) !== emptyDay).map((s) => [s, 5] as [string, number]));
    const bookedPerDay = new Map<string, number>();
    const bookedTimes: string[] = [];
    for (let i = 0; i < 8; i++) {
      // Sent proposals no longer offer anything: only the queue's offers and
      // the bookings weigh a day, exactly as drafting computes it.
      const load = new Map<string, number>([...bookedPerDay].map(([d, n]) => [d, n * 3] as [string, number]));
      queueOffers.forEach((n, iso) => { const d = dayKeyIn(iso, UTC); load.set(d, (load.get(d) ?? 0) + n); });
      const full = new Set([...bookedPerDay].filter(([, n]) => n >= MAX_MEETINGS_PER_OWNER_PER_DAY).map(([d]) => d));
      const busy = bookedTimes.map((t) => ({ startAt: new Date(t), endAt: new Date(Date.parse(t) + 30 * 60_000) }));
      const offer = computeSlots(busy, 3, 30, UTC, queueOffers, { load, full });
      const book = offer.find((t) => (bookedPerDay.get(dayKeyIn(t, UTC)) ?? 0) < MAX_MEETINGS_PER_OWNER_PER_DAY)!;
      expect(book).toBeTruthy();
      bookedTimes.push(book);
      bookedPerDay.set(dayKeyIn(book, UTC), (bookedPerDay.get(dayKeyIn(book, UTC)) ?? 0) + 1);
    }
    expect(Math.max(...bookedPerDay.values())).toBeLessThanOrEqual(3);
    expect(bookedPerDay.size).toBeGreaterThanOrEqual(3);
  });
});

// ── Sending and drafting against a recording db ─────────────────────────────
type Row = { id: number; status: string; proposedTimes: string[] | null; scheduledAt: Date | null; durationMin: number };
let meeting: any;
let others: Row[];
let inserts: any[];

function makeDb() {
  const b = (fields?: Record<string, unknown>) => {
    const st: { table?: unknown } = {};
    const q: any = {
      from(t: unknown) { st.table = t; return q; }, where() { return q; }, orderBy() { return q; }, limit() { return q; },
      then(res: (v: unknown) => void) {
        if (st.table === meetings) {
          if (fields && Object.keys(fields).length === 1 && "id" in fields) return res([]); // one-invite-per-person
          return res(fields ? others : [meeting]);
        }
        if (st.table === calendarAccounts) return res([{ id: 2, workspaceId: 4, userId: 5721, calendarId: null, unipileAccountId: "acc" }]);
        if (st.table === workspaces) return res([{ name: "CommunityForce" }]);
        if (st.table === calendarEvents || st.table === workspaceSettings) return res([]);
        return res([]);
      },
    };
    return q;
  };
  return {
    select: (fields?: Record<string, unknown>) => b(fields),
    insert: (t: unknown) => ({ values(v: any) { if (t === meetings) inserts.push(v); return Promise.resolve([{ insertId: 9 }]); } }),
    update: () => { const q: any = { set() { return q; }, where() { return Promise.resolve([{ affectedRows: 1 }]); } }; return q; },
  };
}

// Three offered times on three different days, 14:00 UTC, from 3 days out.
const base = Math.ceil((Date.now() + 3 * DAY) / DAY) * DAY + 14 * 3_600_000;
const T = [0, 1, 2].map((d) => new Date(base + d * DAY).toISOString());
const onDay = (iso: string, hour: number, id: number): Row => {
  const d = new Date(iso); d.setUTCHours(hour, 0, 0, 0);
  return { id, status: "invited", proposedTimes: [], scheduledAt: d, durationMin: 30 };
};

beforeEach(() => {
  __resetLiveBusyCacheForTests();
  meeting = { id: 9, workspaceId: 4, ownerUserId: 5721, status: "proposed", proposedTimes: T, scheduledAt: null, durationMin: 30, contactEmail: "ada@example.org", contactName: "Ada", title: "Intro", inviteMessage: "Hi", meetingUrl: null };
  others = [];
  inserts = [];
  h.db = makeDb();
  h.createEvent = vi.fn(async (_c: string, e: any) => ({ externalId: "evt", title: e.title, startAt: e.startAt, endAt: e.endAt }));
});

describe("sending skips a full day", () => {
  it("the first offered day already has 3: that time is left out of the email", async () => {
    others = [onDay(T[0], 10, 1), onDay(T[0], 11, 2), onDay(T[0], 12, 3)];
    expect(await sendMeetingInvite(4, 9)).toEqual({ sent: true, scheduledAt: null, offered: [T[1], T[2]] });
    expect(emailedTimes()).toEqual([T[1], T[2]]);
  });

  it("two on that day is not full", async () => {
    others = [onDay(T[0], 10, 1), onDay(T[0], 11, 2)];
    expect(await sendMeetingInvite(4, 9)).toEqual({ sent: true, scheduledAt: null, offered: T });
  });

  it("every offered day full: nothing sent, and it says so", async () => {
    others = T.flatMap((t, i) => [onDay(t, 9, i * 10 + 1), onDay(t, 10, i * 10 + 2), onDay(t, 11, i * 10 + 3)]);
    expect(await sendMeetingInvite(4, 9)).toEqual({ sent: false, scheduledAt: null, reason: "days_full" });
    expect(h.createEvent).not.toHaveBeenCalled();
  });

  it("a time a person picked is theirs, even on a busy day", async () => {
    others = [onDay(T[0], 10, 1), onDay(T[0], 11, 2), onDay(T[0], 12, 3)];
    expect(await sendMeetingInvite(4, 9, T[0])).toEqual({ sent: true, scheduledAt: null, offered: [T[0]] });
  });
});

describe("drafting never offers a full day", () => {
  it("a day with 3 meetings already gets no offer", async () => {
    const plain = computeSlots([], 3, 30, UTC);
    const firstDay = plain[0];
    others = [onDay(firstDay, 9, 1), onDay(firstDay, 12, 2), onDay(firstDay, 15, 3)];
    await createMeetingProposal(4, { ownerUserId: 5721, relatedType: "prospect", relatedId: 7, name: "Cy", source: "ai" });
    const offered = inserts[0].proposedTimes as string[];
    expect(offered.length).toBe(3);
    expect(offered.every((t) => dayKeyIn(t, UTC) !== dayKeyIn(firstDay, UTC))).toBe(true);
  });
});
