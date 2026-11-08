/**
 * A booking link checks the host's calendar live (audit 2026-10-20, G42; the
 * part the 2026-11-06 pass left).
 *
 * Busy time came only from synced calendar_events and the app's own meetings,
 * so a meeting made in Outlook since the last sync was offered and booked
 * over. Now:
 *   - the slot list also leaves out what the calendar provider says is busy
 *     (read live, cached five minutes per calendar);
 *   - just before a booking is accepted the calendar is read fresh for that
 *     slot, and a busy slot is refused with a clear message, before any
 *     meeting row, invite or email;
 *   - a provider that fails or hangs leaves the stored events to decide, so a
 *     flaky calendar does not take the booking page down;
 *   - the page offers the next open times after a refusal.
 *
 * The real bookSlotForLink runs against the SQL-evaluating fake. The calendar
 * adapter is mocked: no provider is called.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    invites: [] as number[],
    reads: [] as Array<{ from: Date; to: Date }>,
    listEvents: async (_c: string, _f: Date, _t: Date): Promise<any[]> => [],
  };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./services/bookingConfirmationEmail", async (a) => ({
  ...(await a<typeof import("./services/bookingConfirmationEmail")>()),
  sendBookingConfirmationEmail: async () => ({ ok: true as const, fromEmail: "rep@example.com" }),
}));
vi.mock("./services/meetingScheduler", async (a) => ({
  ...(await a<typeof import("./services/meetingScheduler")>()),
  sendMeetingInvite: async (_ws: number, meetingId: number, at: string) => { h.invites.push(meetingId); return { sent: false, scheduledAt: at }; },
}));
vi.mock("./calendarAdapter", async (a) => ({
  ...(await a<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: () => ({
    listEvents: (c: string, from: Date, to: Date) => { h.reads.push({ from, to }); return h.listEvents(c, from, to); },
  }),
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { BOOKING_SLOT_BUSY, bookSlotForLink, openSlotsForLink } from "./routers/bookingLinks";
import { __resetCalendarFreeBusyCacheForTests, liveCalendarBusy, overlapsAny } from "./services/calendarFreeBusy";
import { nextOpenAfter } from "@shared/availability";

const WS = 2, REP = 7;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const link = () => rows("booking_links")[0];
const MIN = 60_000;
const ev = (startIso: string, mins: number) => ({ externalId: "e", title: "Busy", startAt: new Date(startIso), endAt: new Date(Date.parse(startIso) + mins * MIN), allDay: false, attendees: [] });

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.invites = [];
  h.reads = [];
  h.listEvents = async () => [];
  __resetCalendarFreeBusyCacheForTests();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: REP, archivedAt: null, plan: "trial" });
  rows("users").push({ id: REP, name: "Rep" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: REP, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
  rows("booking_links").push({
    id: 3, workspaceId: WS, userId: REP, slug: "rep-abc", title: "Intro call", description: null, durationMin: 30,
    active: true, bookingCount: 0, timezone: "UTC", startHour: 9, endHour: 17, workDays: "1,2,3,4,5",
  });
  // The rep's connected calendar. Nothing about it is in calendar_events.
  rows("calendar_accounts").push({ id: 11, workspaceId: WS, userId: REP, provider: "outlook", calendarId: null, unipileAccountId: "acc-1" });
});

describe("the slot list hides what the calendar says is busy (G42)", () => {
  it("a meeting only the provider knows about is not offered; the slots around it are", async () => {
    const before = await openSlotsForLink(link());
    const target = before[3]!;
    __resetCalendarFreeBusyCacheForTests();
    h.listEvents = async () => [ev(target, 30)];
    const after = await openSlotsForLink(link());
    expect(before).toContain(target);
    expect(after).not.toContain(target);
    expect(after).toContain(before[2]);
    expect(after).toContain(before[4]);
    expect(rows("calendar_events")).toHaveLength(0);
  });

  it("the list's read is cached per calendar, so a page load reads the calendar once", async () => {
    await openSlotsForLink(link());
    await openSlotsForLink(link());
    expect(h.reads).toHaveLength(1);
  });
});

describe("a booking is checked against the calendar at the last moment (G42)", () => {
  it("a slot that became busy after the list was read is refused, before any meeting, invite or email", async () => {
    const [slot] = await openSlotsForLink(link()); // the list (and its cache) say free
    h.listEvents = async () => [ev(slot!, 30)];   // then the rep accepts a meeting in Outlook
    const r = await refusal(bookSlotForLink(link(), { startAt: new Date(slot!), name: "Ann Lee", email: "ann@example.com" }));
    expect(r).toEqual({ code: "CONFLICT", message: BOOKING_SLOT_BUSY });
    expect(rows("meetings")).toHaveLength(0);
    expect(rows("leads")).toHaveLength(0);
    expect(h.invites).toEqual([]);
  });

  it("the last check is a fresh read of exactly that slot, from a day before (events that run into it)", async () => {
    const [slot] = await openSlotsForLink(link());
    h.reads = [];
    await bookSlotForLink(link(), { startAt: new Date(slot!), name: "Ann Lee", email: "ann@example.com" });
    // One read for the fresh check (the list came from the cache).
    expect(h.reads).toHaveLength(1);
    expect(h.reads[0]!.to.getTime()).toBe(Date.parse(slot!) + 30 * MIN);
    expect(h.reads[0]!.from.getTime()).toBe(Date.parse(slot!) - 86_400_000);
  });

  it("an event that started before the slot and runs into it counts as busy", async () => {
    const [slot] = await openSlotsForLink(link());
    h.listEvents = async () => [ev(new Date(Date.parse(slot!) - 45 * MIN).toISOString(), 60)];
    expect((await refusal(bookSlotForLink(link(), { startAt: new Date(slot!), name: "A", email: "a@example.com" }))).message).toBe(BOOKING_SLOT_BUSY);
  });

  it("a free slot books as before", async () => {
    const [slot] = await openSlotsForLink(link());
    h.listEvents = async () => [ev(new Date(Date.parse(slot!) + 60 * MIN).toISOString(), 30)]; // later the same day
    const out = await bookSlotForLink(link(), { startAt: new Date(slot!), name: "Ann Lee", email: "ann@example.com" });
    expect(out.scheduledAt).toBe(slot);
    expect(rows("meetings")).toHaveLength(1);
    expect(h.invites).toHaveLength(1);
  });

  it("a provider that fails leaves the stored events to decide: the booking goes ahead", async () => {
    const [slot] = await openSlotsForLink(link());
    h.listEvents = async () => { throw new Error("Unipile 503"); };
    const out = await bookSlotForLink(link(), { startAt: new Date(slot!), name: "Ann Lee", email: "ann@example.com" });
    expect(out.scheduledAt).toBe(slot);
  });

  it("with no calendar connected nothing is read and the booking goes ahead", async () => {
    rows("calendar_accounts").length = 0;
    const [slot] = await openSlotsForLink(link());
    await bookSlotForLink(link(), { startAt: new Date(slot!), name: "Ann Lee", email: "ann@example.com" });
    expect(h.reads).toHaveLength(0);
    expect(rows("meetings")).toHaveLength(1);
  });
});

describe("the live read itself (G42)", () => {
  it("a read that hangs gives up and reports failed, so a booking is not held on a slow provider", async () => {
    h.listEvents = () => new Promise(() => {});
    const out = await liveCalendarBusy(WS, REP, new Date(), new Date(Date.now() + MIN), { fresh: true, timeoutMs: 20 });
    expect(out).toEqual({ busy: [], read: "failed" });
  });

  it("a fresh read never fills the list's cache", async () => {
    h.listEvents = async () => [ev(new Date(Date.now() + 3_600_000).toISOString(), 30)];
    await liveCalendarBusy(WS, REP, new Date(), new Date(Date.now() + MIN), { fresh: true });
    h.listEvents = async () => [];
    expect((await liveCalendarBusy(WS, REP, new Date(), new Date(Date.now() + 14 * 86_400_000))).busy).toEqual([]);
  });

  it("overlap is half-open: back-to-back is free", () => {
    const busy = [{ startAt: new Date("2026-11-10T10:00:00Z"), endAt: new Date("2026-11-10T10:30:00Z") }];
    expect(overlapsAny(busy, new Date("2026-11-10T10:30:00Z"), new Date("2026-11-10T11:00:00Z"))).toBe(false);
    expect(overlapsAny(busy, new Date("2026-11-10T10:15:00Z"), new Date("2026-11-10T10:45:00Z"))).toBe(true);
  });
});

describe("the page offers the next open times after a refusal (G42)", () => {
  it("nextOpenAfter gives the earliest later slots", () => {
    const s = ["2026-11-10T10:00:00.000Z", "2026-11-10T09:00:00.000Z", "2026-11-10T11:00:00.000Z", "2026-11-10T12:00:00.000Z", "2026-11-10T13:00:00.000Z"];
    expect(nextOpenAfter(s, "2026-11-10T09:30:00.000Z", 3)).toEqual(["2026-11-10T10:00:00.000Z", "2026-11-10T11:00:00.000Z", "2026-11-10T12:00:00.000Z"]);
    expect(nextOpenAfter(s, "2026-11-10T13:00:00.000Z", 3)).toEqual([]);
  });

  it("BookingPage refetches the list on a CONFLICT and shows the next open times to pick", () => {
    const src = readFileSync(join(__dirname, "..", "client/src/pages/BookingPage.tsx"), "utf8").replace(/\r\n/g, "\n");
    const onBook = src.slice(src.indexOf("const onBook"), src.indexOf("return (", src.indexOf("const onBook")));
    expect(onBook).toContain('err.data?.code !== "CONFLICT"');
    expect(onBook).toContain("link.refetch()");
    expect(onBook).toContain("setNextFree(nextOpenAfter(slots, wanted, 3))");
    expect(src).toContain("The next open times:");
    expect(src).toContain("onClick={() => { setSelected(iso); setNextFree(null); book.reset(); }}");
  });
});
