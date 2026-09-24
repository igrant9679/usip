/**
 * No attendee, no invite (2026-09-24). 8 of CommunityForce's bulk-approved
 * proposals had no email address; each still booked a Teams meeting on Khaja
 * Syed's calendar with nobody invited, and Velocity marked it "scheduled,
 * invite sent". Sending now refuses, and the autopilot and Propose no longer
 * create such proposals. removeBookings takes booked meetings out of Velocity
 * (the owner removes the events from Outlook).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { auditLog, calendarAccounts, calendarEvents, meetings, workspaces } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, createEvent: null as any, deleteEvent: null as any }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));
vi.mock("./calendarAdapter", async (importActual) => ({
  ...(await importActual<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: () => ({
    listEvents: async () => [],
    createEvent: (...a: unknown[]) => h.createEvent(...a),
    deleteEvent: (...a: unknown[]) => h.deleteEvent(...a),
  }),
}));

import { appRouter } from "./routers";
import { sendMeetingInvite } from "./services/meetingScheduler";

const WS = 4;
const dialect = new MySqlDialect();
const render = (x: unknown) => dialect.sqlToQuery(x as any);

type World = {
  role: string;
  meetings: any[];
  events: any[];
  accounts: any[];
  meetingWhere?: unknown;
  deletes: { table: unknown; where: unknown }[];
  updates: { table: unknown; set: any; where: unknown }[];
  inserts: { table: unknown; values: any }[];
};
let w: World;

function makeDb() {
  const builder = () => {
    const st: { table?: unknown; join?: unknown; where?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin(t: unknown) { st.join = t; return b; },
      where(c: unknown) { st.where = c; return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void) {
        if (st.join === workspaces) {
          res([{ ws: { id: WS, name: "CommunityForce", ownerUserId: 2, archivedAt: null },
            mb: { id: 1, userId: 2, workspaceId: WS, role: w.role, deactivatedAt: null, lastActiveAt: new Date() } }]);
        } else if (st.table === meetings) { w.meetingWhere = st.where; res(w.meetings); }
        else if (st.table === calendarEvents) {
          const ids = render(st.where).params;
          res(w.events.filter((e) => ids.includes(e.id)));
        } else if (st.table === calendarAccounts) res(w.accounts);
        else res([]);
      },
    };
    return b;
  };
  return {
    select: () => builder(),
    insert: (t: unknown) => ({ values(v: any) { w.inserts.push({ table: t, values: v }); return Promise.resolve([{ insertId: 1 }]); } }),
    update: (t: unknown) => {
      const u: any = { table: t };
      const b: any = { set(v: any) { u.set = v; return b; }, where(c: unknown) { u.where = c; w.updates.push(u); return Promise.resolve([]); } };
      return b;
    },
    delete: (t: unknown) => ({ where(c: unknown) { w.deletes.push({ table: t, where: c }); return Promise.resolve([]); } }),
  };
}

function caller() {
  return appRouter.createCaller({
    user: { id: 2, openId: "user-2", email: "idris@example.com", name: "Idris Grant", loginMethod: "manus", role: "user",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

const future = new Date(Date.now() + 3 * 86_400_000).toISOString();

beforeEach(() => {
  w = { role: "admin", meetings: [], events: [], accounts: [{ id: 2, workspaceId: WS, userId: 5721, calendarId: null, unipileAccountId: "acc" }], deletes: [], updates: [], inserts: [] };
  h.db = makeDb();
  h.createEvent = vi.fn();
  h.deleteEvent = vi.fn().mockResolvedValue(undefined);
});

describe("sending needs someone to send to", () => {
  it("no attendee email: nothing is booked, and it says why", async () => {
    w.meetings = [{ id: 9, workspaceId: WS, ownerUserId: 5721, status: "proposed", proposedTimes: [future], scheduledAt: null, durationMin: 30, contactEmail: null, title: "Intro" }];
    expect(await sendMeetingInvite(WS, 9)).toEqual({ sent: false, scheduledAt: null, reason: "no_attendee_email" });
    expect(h.createEvent).not.toHaveBeenCalled();
    expect(w.updates).toEqual([]);
  });

  it("a blank email counts as none", async () => {
    w.meetings = [{ id: 9, workspaceId: WS, ownerUserId: 5721, status: "proposed", proposedTimes: [future], scheduledAt: null, durationMin: 30, contactEmail: "  ", title: "Intro" }];
    expect((await sendMeetingInvite(WS, 9)).reason).toBe("no_attendee_email");
  });

  it("the autopilot and Propose meeting no longer propose to prospects without an email", () => {
    const svc = readFileSync("server/services/meetingScheduler.ts", "utf8");
    expect(svc).toContain('      isNotNull(prospects.email),\n      ne(prospects.email, ""),');
    const router = readFileSync("server/routers/meetings.ts", "utf8");
    const propose = router.slice(router.indexOf("propose: repProcedure"), router.indexOf("generateProposals: repProcedure"));
    expect(propose.indexOf("if (!p.email?.trim()) {")).toBeGreaterThan(-1);
    expect(propose.indexOf("if (!p.email?.trim()) {")).toBeLessThan(propose.indexOf("proposeMeetingForProspect("));
  });

  it("the card says so and cannot be approved", () => {
    const page = readFileSync("client/src/pages/usip/MeetingsV2.tsx", "utf8");
    expect(page).toContain("disabled={pending || expired || !chosen || noEmail}");
    expect(page).toContain("No email address for this prospect, so an invite can't be sent.");
  });
});

describe("meetings.removeBookings: out of Velocity, never out of the calendar", () => {
  const b1 = { id: 21, status: "scheduled", calendarEventId: 301, contactName: "Ada", scheduledAt: new Date(future) };
  const b2 = { id: 22, status: "scheduled", calendarEventId: null, contactName: "Bo", scheduledAt: new Date(future) };

  it("selects only this workspace's upcoming booked meetings (and only the ids given)", async () => {
    await caller().meetings.removeBookings({ ids: [21, 22] });
    const q = render(w.meetingWhere);
    expect(q.sql).toContain("`meetings`.`workspaceId` = ?");
    expect(q.sql).toMatch(/`meetings`\.`status` in \(\?, \?, \?\)/);
    expect(q.params).toEqual(expect.arrayContaining([WS, "invited", "scheduled", "rescheduled", 21, 22]));
    expect(q.params).not.toContain("proposed");
    // Upcoming only: past meetings still marked scheduled are history.
    expect(q.sql).toContain("`meetings`.`scheduledAt` > ?");
    // Drizzle renders the cutoff as a UTC "YYYY-MM-DD HH:MM:SS.mmm" string.
    const cutoff = q.params.find((p: unknown) => typeof p === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(p)) as string | undefined;
    expect(cutoff).toBeDefined();
    expect(Math.abs(Date.parse(cutoff!.replace(" ", "T") + "Z") - Date.now())).toBeLessThan(60_000);
  });

  it("dry run by default: lists them, changes nothing", async () => {
    w.meetings = [b1, b2];
    const res = await caller().meetings.removeBookings();
    expect(res.dryRun).toBe(true);
    expect(res.removed).toBe(0);
    expect(res.meetings.map((m: { id: number }) => m.id)).toEqual([21, 22]);
    expect(w.updates).toEqual([]);
    expect(w.deletes).toEqual([]);
  });

  it("for real: cancelled in Velocity, the stored event copy dropped, the provider calendar untouched", async () => {
    w.meetings = [b1, b2];
    const res = await caller().meetings.removeBookings({ dryRun: false });
    expect(res.removed).toBe(2);
    const upd = w.updates.filter((u) => u.table === meetings);
    expect(upd).toHaveLength(1);
    expect(upd[0].set).toEqual({ status: "cancelled", calendarEventId: null });
    expect(render(upd[0].where).params).toEqual(expect.arrayContaining([WS, 21, 22]));
    expect(w.deletes).toHaveLength(1);
    expect(w.deletes[0].table).toBe(calendarEvents);
    expect(render(w.deletes[0].where).params).toEqual([WS, 301]);
    // Deleting in Outlook is what emails attendees a cancellation: never done here.
    expect(h.deleteEvent).not.toHaveBeenCalled();
    const audit = w.inserts.find((i) => i.table === auditLog);
    expect(audit?.values.after).toEqual({ removedFromVelocity: 2, status: "cancelled", providerCalendarTouched: false });
  });

  it("no rebound 'Re-book' task: this is a cleanup, not a prospect cancelling", async () => {
    w.meetings = [b1];
    await caller().meetings.removeBookings({ dryRun: false });
    expect(w.inserts.filter((i) => i.table !== auditLog)).toEqual([]);
  });

  it("admins only", async () => {
    w.role = "rep";
    await expect(caller().meetings.removeBookings({ dryRun: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
