/**
 * Audit 2026-10-20, O28: cancelling or rescheduling a meeting changed the row
 * and nothing else. The invite stayed on the owner's calendar at the old time,
 * so the attendee was never told the meeting was off, or was moved — while the
 * reminder, keyed to the row, named the new time. And the Meetings page
 * cancelled on one click, with no confirmation.
 *
 * Through the real procedures via createCaller, against a recording db and a
 * mocked calendar adapter. Nothing is sent anywhere.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarAccounts, calendarEvents, meetings, users, workspaces } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

type Row = Record<string, any>;
const h = vi.hoisted(() => ({
  db: null as any,
  paused: false,
  meeting: null as Row | null,
  updates: [] as Array<{ table: unknown; set: Row }>,
  deleted: [] as unknown[],
  deleteEvent: null as any,
  updateEvent: null as any,
}));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));
vi.mock("./calendarAdapter", async (importActual) => ({
  ...(await importActual<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: () => ({
    deleteEvent: (...a: any[]) => h.deleteEvent(...a),
    updateEvent: (...a: any[]) => h.updateEvent(...a),
  }),
}));
vi.mock("./services/sendWindow", async (importActual) => ({
  ...(await importActual<typeof import("./services/sendWindow")>()),
  getWorkspaceSendWindow: async () => ({ timezone: "UTC", window: {}, paused: h.paused }),
}));

import { appRouter } from "./routers";

const WS = { id: 4, name: "CommunityForce" };
const ME = 2;
const EVENT = {
  id: 70, workspaceId: 4, externalId: "AAMkAD-event", title: "Intro call", description: "Agenda", location: null,
  attendees: [{ email: "pat@example.org", name: "Pat" }],
};
const ACCOUNT = { id: 3, workspaceId: 4, calendarId: "cal-1" };

function makeDb() {
  const builder = () => {
    const st: { table?: unknown; join?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin(t: unknown) { st.join = t; return b; },
      where() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void, rej: any) {
        let rows: unknown[] = [];
        if (st.join === workspaces) {
          rows = [{
            ws: { ...WS, ownerUserId: ME, archivedAt: null },
            mb: { id: 1, userId: ME, workspaceId: WS.id, role: "rep", deactivatedAt: null, lastActiveAt: new Date() },
          }];
        } else if (st.join === users) rows = []; // the team: the attendee is an outside address
        else if (st.table === meetings) rows = h.meeting ? [h.meeting] : [];
        else if (st.table === calendarEvents) rows = [EVENT];
        else if (st.table === calendarAccounts) rows = [ACCOUNT];
        return Promise.resolve(rows).then(res, rej);
      },
    };
    return b;
  };
  return {
    select: () => builder(),
    insert: () => ({ values: () => Promise.resolve([{ insertId: 1 }]) }),
    update: (table: unknown) => ({
      set(v: Row) { return { where: () => { h.updates.push({ table, set: v }); return Promise.resolve([]); } }; },
    }),
    delete: (table: unknown) => ({ where: () => { h.deleted.push(table); return Promise.resolve([]); } }),
  };
}

function caller() {
  return appRouter.createCaller({
    user: {
      id: ME, openId: "user-2", email: "rep@example.com", name: "Rep",
      loginMethod: "manus", role: "user",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

const booked = () => ({
  id: 596, workspaceId: 4, title: "Intro call", status: "scheduled", inviteSent: true,
  contactEmail: "pat@example.org", contactName: "Pat", durationMin: 45,
  calendarEventId: 70, calendarAccountId: 3, scheduledAt: new Date(Date.now() + 2 * 86400000),
  ownerUserId: ME, relatedType: null, relatedId: null,
});
const meetingSets = () => h.updates.filter((u) => u.table === meetings).map((u) => u.set);

beforeEach(() => {
  h.db = makeDb();
  h.paused = false;
  h.meeting = booked();
  h.updates.length = 0;
  h.deleted.length = 0;
  h.deleteEvent = vi.fn(async () => {});
  h.updateEvent = vi.fn(async (_c: string, externalId: string, ev: any) => ({ externalId, ...ev }));
});

describe("cancelling a meeting cancels its invite", () => {
  it("deletes the event on the calendar (that tells the attendee), drops Velocity's copy, then marks it cancelled", async () => {
    const r = await caller().meetings.cancel({ id: 596 });
    expect(h.deleteEvent).toHaveBeenCalledWith("cal-1", "AAMkAD-event");
    expect(h.deleted).toEqual([calendarEvents]);
    expect(meetingSets()).toEqual([{ status: "cancelled", calendarEventId: null }]);
    expect(r).toMatchObject({ ok: true, calendar: "done" });
  });

  it("a calendar that refuses is reported, and the meeting is left as it was", async () => {
    h.deleteEvent.mockRejectedValueOnce(new Error("Unipile DELETE failed: 401 token expired"));
    await expect(caller().meetings.cancel({ id: 596 })).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: expect.stringContaining("401 token expired"),
    });
    expect(meetingSets()).toEqual([]);
    expect(h.deleted).toEqual([]);
  });

  it("an event already deleted by hand counts as cancelled", async () => {
    h.deleteEvent.mockRejectedValueOnce(new Error("failed: 404 Not Found"));
    const r = await caller().meetings.cancel({ id: 596 });
    expect(r.calendar).toBe("gone");
    expect(meetingSets()).toEqual([{ status: "cancelled", calendarEventId: null }]);
  });

  it("a meeting that was never on a calendar is cancelled in Velocity only", async () => {
    h.meeting = { ...booked(), inviteSent: false, calendarEventId: null, calendarAccountId: null };
    const r = await caller().meetings.cancel({ id: 596 });
    expect(h.deleteEvent).not.toHaveBeenCalled();
    expect(meetingSets()).toEqual([{ status: "cancelled" }]);
    expect(r.calendar).toBe("none");
  });

  it("cancelling is allowed while outbound is paused, as the pause promises", async () => {
    h.paused = true;
    const r = await caller().meetings.cancel({ id: 596 });
    expect(r.calendar).toBe("done");
  });
});

describe("rescheduling a meeting moves its invite", () => {
  it("moves the event (whole event, new start and end) and Velocity's copy, and keeps the row rules", async () => {
    const when = new Date(Date.now() + 5 * 86400000);
    const r = await caller().meetings.reschedule({ id: 596, scheduledAt: when.toISOString() });
    expect(h.updateEvent).toHaveBeenCalledTimes(1);
    const [cal, ext, ev] = h.updateEvent.mock.calls[0];
    expect([cal, ext]).toEqual(["cal-1", "AAMkAD-event"]);
    expect(ev).toMatchObject({
      title: "Intro call", description: "Agenda", startAt: when,
      endAt: new Date(when.getTime() + 45 * 60_000),
      attendees: [{ email: "pat@example.org", name: "Pat" }],
    });
    const evSet = h.updates.find((u) => u.table === calendarEvents)?.set;
    expect(evSet).toEqual({ startAt: when, endAt: new Date(when.getTime() + 45 * 60_000) });
    expect(meetingSets()).toEqual([{ status: "rescheduled", scheduledAt: when, reminderSentAt: null }]);
    expect(r).toMatchObject({ ok: true, calendar: "done" });
  });

  it("a calendar that refuses is reported, and the meeting is not moved", async () => {
    h.updateEvent.mockRejectedValueOnce(new Error("Unipile PATCH failed: 500 Internal"));
    await expect(caller().meetings.reschedule({ id: 596, scheduledAt: new Date(Date.now() + 5 * 86400000).toISOString() }))
      .rejects.toMatchObject({ code: "BAD_GATEWAY", message: expect.stringContaining("500 Internal") });
    expect(meetingSets()).toEqual([]);
  });

  it("moving an invite to an outside attendee is held while outbound is paused", async () => {
    h.paused = true;
    await expect(caller().meetings.reschedule({ id: 596, scheduledAt: new Date(Date.now() + 5 * 86400000).toISOString() }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(h.updateEvent).not.toHaveBeenCalled();
    expect(meetingSets()).toEqual([]);
  });

  it("a meeting with no calendar event moves in Velocity only, paused or not", async () => {
    h.paused = true;
    h.meeting = { ...booked(), inviteSent: false, calendarEventId: null, calendarAccountId: null };
    const r = await caller().meetings.reschedule({ id: 596, scheduledAt: new Date(Date.now() + 5 * 86400000).toISOString() });
    expect(h.updateEvent).not.toHaveBeenCalled();
    expect(r.calendar).toBe("none");
    expect(meetingSets()).toHaveLength(1);
  });

  it("an unknown meeting is not found", async () => {
    h.meeting = null;
    await expect(caller().meetings.reschedule({ id: 1, scheduledAt: new Date().toISOString() })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the Meetings page asks before cancelling, and says what happened to the invite", () => {
  const src = readFileSync(path.join(__dirname, "..", "client", "src", "pages", "usip", "MeetingsV2.tsx"), "utf8");
  it("the Cancel menu item goes through confirmAction, not straight to the mutation", () => {
    const at = src.indexOf("<X className=\"size-3.5 mr-2\" /> Cancel</DropdownMenuItem>");
    expect(at).toBeGreaterThan(-1);
    const item = src.slice(src.lastIndexOf("<DropdownMenuItem", at), at);
    expect(item).toContain("onClick={() => confirmAction({");
    expect(item).toContain("}, () => cancel.mutate({ id: m.id }))}");
    expect(src).not.toContain("onClick={() => cancel.mutate({ id: m.id })}");
  });
  it("the success toast reads the calendar outcome", () => {
    const at = src.indexOf("const cancel = trpc.meetings.cancel.useMutation({");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("});", at));
    expect(block).toContain('r.calendar === "done"');
    expect(block).toContain('r.calendar === "gone"');
  });
});
