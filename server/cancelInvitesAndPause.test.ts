/**
 * 2026-10-06: a bulk "Approve & send all" sent nine invites while LSI Media
 * was paused. The owner chose to cancel them for real and to block every
 * person-clicked send while paused. This pins both.
 */
import { readFileSync } from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarAccounts, calendarEvents, meetings } from "../drizzle/schema";

type Row = Record<string, any>;
const data = new Map<unknown, Row[]>();
const deleted: unknown[] = [];
const updates: Row[] = [];
const fakeDb: any = {
  select: () => ({
    from: (table: unknown) => {
      const q: any = { where: () => q, limit: () => Promise.resolve(data.get(table) ?? []), then: (r: any, j: any) => Promise.resolve(data.get(table) ?? []).then(r, j) };
      return q;
    },
  }),
  delete: (table: unknown) => ({ where: () => { deleted.push(table); return Promise.resolve(); } }),
  update: () => ({ set: (v: Row) => ({ where: () => { updates.push(v); return Promise.resolve(); } }) }),
};
vi.mock("./db", () => ({ getDb: async () => fakeDb }));
const deleteEvent = vi.fn(async () => {});
vi.mock("./calendarAdapter", () => ({ createCalendarAdapter: () => ({ deleteEvent: (...a: any[]) => (deleteEvent as any)(...a) }) }));
const recordAudit = vi.fn(async () => {});
vi.mock("./audit", () => ({ recordAudit: (...a: any[]) => (recordAudit as any)(...a) }));
const paused = { value: true };
vi.mock("./services/sendWindow", () => ({ getWorkspaceSendWindow: async () => ({ timezone: "America/New_York", window: {}, paused: paused.value }) }));

import { cancelSentInvites } from "./services/cancelInvites";
import { assertOutboundNotPaused, isOutboundPaused, OUTBOUND_PAUSED_MESSAGE } from "./services/outboundPause";

const invited = { id: 596, workspaceId: 2, status: "invited", inviteSent: true, contactEmail: "joed@bsa.org", calendarEventId: 70, calendarAccountId: 3, scheduledAt: new Date("2026-10-06T18:00:00Z") };

beforeEach(() => {
  data.clear();
  deleted.length = 0;
  updates.length = 0;
  deleteEvent.mockReset();
  recordAudit.mockClear();
  data.set(meetings, [invited]);
  data.set(calendarEvents, [{ id: 70, externalId: "AAMkAD-event" }]);
  data.set(calendarAccounts, [{ id: 3, calendarId: "cal-1" }]);
  paused.value = true;
});

describe("cancelling invites that went out", () => {
  it("dry run touches nothing", async () => {
    const r = await cancelSentInvites(2, [596], { dryRun: true, actorUserId: 2 });
    expect(r).toEqual([{ id: 596, contact: "joed@bsa.org", scheduledAt: invited.scheduledAt, outcome: "would cancel on the calendar" }]);
    expect(deleteEvent).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it("deletes the event on the calendar (the attendee is notified), marks it cancelled, audits, no rebound task", async () => {
    const r = await cancelSentInvites(2, [596], { dryRun: false, actorUserId: 2 });
    expect(deleteEvent).toHaveBeenCalledWith("cal-1", "AAMkAD-event");
    expect(r[0].outcome).toBe("deleted on the calendar (attendee notified)");
    expect(deleted).toEqual([calendarEvents]);
    expect(updates).toEqual([{ status: "cancelled", calendarEventId: null }]);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ entityId: 596, after: expect.objectContaining({ status: "cancelled", cancelledSentInvite: true }) }));
    expect(readFileSync(path.join(__dirname, "services", "cancelInvites.ts"), "utf8")).not.toContain("createMeetingReboundTask");
  });

  it("a calendar that refuses leaves the meeting as it was, so it can be retried", async () => {
    deleteEvent.mockRejectedValueOnce(new Error("401 token expired"));
    const r = await cancelSentInvites(2, [596], { dryRun: false, actorUserId: 2 });
    expect(r[0].outcome).toContain("calendar delete failed: 401 token expired");
    expect(updates).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("only invites that went out: a proposal or an already-cancelled meeting is skipped", async () => {
    data.set(meetings, [{ ...invited, status: "proposed", inviteSent: false }, { ...invited, id: 597, status: "cancelled" }]);
    const r = await cancelSentInvites(2, [596, 597], { dryRun: false, actorUserId: 2 });
    expect(r.map((x) => x.outcome)).toEqual(["skipped: status proposed, no invite sent", "skipped: status cancelled"]);
    expect(deleteEvent).not.toHaveBeenCalled();
  });
});

describe("while paused, a person cannot send invites either", () => {
  it("the check refuses with a message that says where the switch is", async () => {
    await expect(assertOutboundNotPaused(2)).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: OUTBOUND_PAUSED_MESSAGE });
    paused.value = false;
    await expect(assertOutboundNotPaused(2)).resolves.toBeUndefined();
    expect(await isOutboundPaused(2)).toBe(false);
  });

  it("Approve & send and Approve & send all ask before anything is sent", () => {
    const src = readFileSync(path.join(__dirname, "routers", "meetings.ts"), "utf8");
    const one = src.slice(src.indexOf("approveAndSend: repProcedure"), src.indexOf("approveAllProposed: repProcedure"));
    expect(one.indexOf("await assertOutboundNotPaused(ctx.workspace.id);")).toBeGreaterThan(-1);
    expect(one.indexOf("await assertOutboundNotPaused(ctx.workspace.id);")).toBeLessThan(one.indexOf("sendMeetingInvite("));
    const all = src.slice(src.indexOf("approveAllProposed: repProcedure"), src.indexOf("regenerateProposal: repProcedure"));
    expect(all.indexOf("await assertOutboundNotPaused(ctx.workspace.id);")).toBeGreaterThan(-1);
    expect(all.indexOf("await assertOutboundNotPaused(ctx.workspace.id);")).toBeLessThan(all.indexOf("sendMeetingInvite("));
  });
});

describe("an event already deleted by hand", () => {
  it("counts as removed: the meeting is marked cancelled", async () => {
    deleteEvent.mockRejectedValueOnce(new Error("Unipile DELETE /calendars/AAMk.../events/AAMk... failed: 404 Not Found"));
    const r = await cancelSentInvites(2, [596], { dryRun: false, actorUserId: 2 });
    expect(r[0].outcome).toBe("already removed from the calendar");
    expect(updates).toEqual([{ status: "cancelled", calendarEventId: null }]);
  });
  it("a long provider error keeps its reason (the end), not just the URL", async () => {
    deleteEvent.mockRejectedValueOnce(new Error(`Unipile DELETE /calendars/${"A".repeat(300)} failed: 500 Internal`));
    const r = await cancelSentInvites(2, [596], { dryRun: false, actorUserId: 2 });
    expect(r[0].outcome).toMatch(/failed: 500 Internal$/);
  });
});
