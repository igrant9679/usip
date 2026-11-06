/**
 * A booking link offers its whole two weeks, and one slot is booked once
 * (audit 2026-10-20, G42).
 *
 *   - The shared slot cap of 40 covered about two and a half working days, so
 *     the page that says "the next two weeks" showed two, and bookSlotForLink
 *     (which re-validates against the same list) refused anything later.
 *   - The re-validation runs before the insert, so two people booking the same
 *     slot at the same moment both passed it and both were booked.
 *
 * The real bookSlotForLink runs against the SQL-evaluating fake, with the
 * calendar invite mocked (no provider is called).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, invites: [] as number[] };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
// The booker's confirmation email (sent when no invite went) is not sent here.
vi.mock("./services/bookingConfirmationEmail", async (a) => ({
  ...(await a<typeof import("./services/bookingConfirmationEmail")>()),
  sendBookingConfirmationEmail: async () => ({ ok: true as const, fromEmail: "rep@example.com" }),
}));
vi.mock("./services/meetingScheduler", async (a) => ({
  ...(await a<typeof import("./services/meetingScheduler")>()),
  sendMeetingInvite: async (_ws: number, meetingId: number, at: string) => { h.invites.push(meetingId); return { sent: false, scheduledAt: at }; },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { bookSlotForLink, openSlotsForLink } from "./routers/bookingLinks";
import { generateSlots } from "@shared/availability";

const WS = 2, REP = 7;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const link = () => rows("booking_links")[0];
const DAY = 86_400_000;

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.invites = [];
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: REP, archivedAt: null, plan: "trial" });
  rows("users").push({ id: REP, name: "Rep" });
  rows("workspace_members").push({ id: 1, workspaceId: WS, userId: REP, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
  rows("booking_links").push({
    id: 3, workspaceId: WS, userId: REP, slug: "rep-7", title: "Intro call", description: null, durationMin: 30,
    active: true, bookingCount: 0, timezone: "UTC", startHour: 9, endHour: 17, workDays: "1,2,3,4,5",
  });
});

describe("the page offers the whole horizon (G42)", () => {
  it("open slots reach well past two and a half days", async () => {
    const now = Date.UTC(2026, 10, 2, 6, 0); // a Monday morning, UTC
    const slots = await openSlotsForLink(link(), now);
    expect(slots.length).toBeGreaterThan(40);
    const lastMs = new Date(slots[slots.length - 1]!).getTime();
    expect(lastMs - now).toBeGreaterThan(10 * DAY);
  });

  it("a slot past the old cap of 40 can be booked", async () => {
    // Every open slot of the horizon, computed the same way with no cap in the way.
    const all = generateSlots([], 30, Date.now(), { timezone: "UTC", startHour: 9, endHour: 17, workDays: [1, 2, 3, 4, 5], maxSlots: 10_000 });
    expect(all.length).toBeGreaterThan(60);
    const late = all[60]!;
    const out = await bookSlotForLink(link(), { startAt: new Date(late), name: "Ann Lee", email: "ann@example.com" });
    expect(out.scheduledAt).toBe(late);
  });
});

describe("one slot is booked once (G42)", () => {
  it("two people booking the same slot at the same moment: one is booked, one is told to pick again", async () => {
    const [slot] = await openSlotsForLink(link());
    const at = new Date(slot!);
    const results = await Promise.allSettled([
      bookSlotForLink(link(), { startAt: at, name: "Ann Lee", email: "ann@example.com" }),
      bookSlotForLink(link(), { startAt: at, name: "Bo Ray", email: "bo@example.com" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason?.code).toBe("CONFLICT");
    const live = rows("meetings").filter((m) => m.status !== "cancelled" && new Date(m.scheduledAt).getTime() === at.getTime());
    expect(live).toHaveLength(1);
    // The one that gave way sent no invite.
    expect(h.invites).toEqual([live[0].id]);
  });
});
