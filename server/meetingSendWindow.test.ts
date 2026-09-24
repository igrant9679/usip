/**
 * Offered times are sent only inside 9:00–16:00 in the workspace's CURRENT
 * zone (2026-09-24). LSI Media's proposals were drafted while its zone was
 * UTC; its zone then became America/New_York, and a bulk approve booked 98
 * meetings at "10:00", which by then meant 6:00 AM Eastern.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { calendarAccounts, meetings, workspaces } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({ db: null as any, createEvent: null as any, tz: "America/New_York" }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));
vi.mock("./services/workspaceTimezone", async (importActual) => ({
  ...(await importActual<typeof import("./services/workspaceTimezone")>()),
  getWorkspaceTimezone: async () => h.tz,
}));
vi.mock("./calendarAdapter", async (importActual) => ({
  ...(await importActual<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: () => ({ listEvents: async () => [], createEvent: (...a: unknown[]) => h.createEvent(...a) }),
}));
vi.mock("./routers/are/execution", async (importActual) => ({
  ...(await importActual<typeof import("./routers/are/execution")>()),
  attributeMeetingBookingToAre: async () => {},
}));

import { appRouter } from "./routers";
import { proposalIsOutdated, sendMeetingInvite, startsInProposalWindow } from "./services/meetingScheduler";

const DAY = 86_400_000;
const NY = "America/New_York";
// Three days out, at 10:00 UTC (6:00 AM New York, EDT) and 15:00 UTC (11:00 AM).
const day = Math.ceil((Date.now() + 3 * DAY) / DAY) * DAY;
const SIX_AM_ET = new Date(day + 10 * 3_600_000).toISOString();
const ELEVEN_AM_ET = new Date(day + 15 * 3_600_000).toISOString();

type World = { role: string; meeting: any; updates: any[] };
let w: World;

function makeDb() {
  const builder = (fields?: unknown) => {
    const st: { table?: unknown; join?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin(t: unknown) { st.join = t; return b; },
      where() { return b; }, orderBy() { return b; }, limit() { return b; },
      then(res: (v: unknown) => void) {
        if (st.join === workspaces) {
          res([{ ws: { id: 2, name: "LSI Media", ownerUserId: 2, archivedAt: null },
            mb: { id: 1, userId: 2, workspaceId: 2, role: w.role, deactivatedAt: null, lastActiveAt: new Date() } }]);
        // ownerCommitments reads proposedTimes across proposals: none here.
        } else if (st.table === meetings) res(fields && "proposedTimes" in (fields as object) ? [] : [w.meeting]);
        else if (st.table === calendarAccounts) res([{ id: 1, workspaceId: 2, userId: 2, calendarId: null, unipileAccountId: "acc" }]);
        else res([]);
      },
    };
    return b;
  };
  return {
    select: (fields?: unknown) => builder(fields),
    insert: () => ({ values() { return Promise.resolve([{ insertId: 1 }]); } }),
    update: (t: unknown) => { const u: any = { table: t }; const b: any = { set(v: any) { u.set = v; return b; }, where() { w.updates.push(u); return Promise.resolve([]); } }; return b; },
  };
}

function caller() {
  return appRouter.createCaller({
    user: { id: 2, openId: "u2", email: "i@example.com", name: "Idris", loginMethod: "manus", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: {} }, res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

beforeEach(() => {
  h.tz = NY;
  w = {
    role: "rep",
    meeting: { id: 9, workspaceId: 2, ownerUserId: 2, status: "proposed", proposedTimes: [SIX_AM_ET], scheduledAt: null, durationMin: 30, contactEmail: "ada@example.org", contactName: "Ada", title: "Intro", inviteMessage: "Hi", meetingUrl: null },
    updates: [],
  };
  h.db = makeDb();
  h.createEvent = vi.fn(async (_c: string, e: any) => ({ externalId: "evt", title: e.title, startAt: e.startAt, endAt: e.endAt }));
});

describe("the window test", () => {
  it("is the workspace's zone, inclusive of 9:00 and 16:00", () => {
    expect(startsInProposalWindow(SIX_AM_ET, NY)).toBe(false);
    expect(startsInProposalWindow(SIX_AM_ET, "UTC")).toBe(true);
    expect(startsInProposalWindow(ELEVEN_AM_ET, NY)).toBe(true);
    expect(startsInProposalWindow(new Date(day + 13 * 3_600_000).toISOString(), NY)).toBe(true);  // 9:00 ET
    expect(startsInProposalWindow(new Date(day + 20 * 3_600_000).toISOString(), NY)).toBe(true);  // 16:00 ET
    expect(startsInProposalWindow(new Date(day + 21 * 3_600_000).toISOString(), NY)).toBe(false); // 17:00 ET
    expect(startsInProposalWindow("not a time", NY)).toBe(false);
  });

  it("staleness still agrees with it", () => {
    expect(proposalIsOutdated([SIX_AM_ET], NY, Date.now())).toBe(true);
    expect(proposalIsOutdated([ELEVEN_AM_ET], NY, Date.now())).toBe(false);
  });
});

describe("sending", () => {
  it("an offer drafted under an older zone (6 AM here) is not booked", async () => {
    expect(await sendMeetingInvite(2, 9)).toEqual({ sent: false, scheduledAt: null, reason: "outside_window" });
    expect(h.createEvent).not.toHaveBeenCalled();
    expect(w.updates).toEqual([]);
  });

  it("with an in-window offer too, that one is booked instead", async () => {
    w.meeting.proposedTimes = [SIX_AM_ET, ELEVEN_AM_ET];
    expect(await sendMeetingInvite(2, 9)).toEqual({ sent: true, scheduledAt: ELEVEN_AM_ET });
  });

  it("an out-of-window time picked by the approver is refused", async () => {
    w.meeting.proposedTimes = [SIX_AM_ET, ELEVEN_AM_ET];
    expect((await sendMeetingInvite(2, 9, SIX_AM_ET)).reason).toBe("outside_window");
    expect(h.createEvent).not.toHaveBeenCalled();
  });

  it("a time the prospect agreed (a booking link) is booked as agreed", async () => {
    w.meeting.scheduledAt = new Date(SIX_AM_ET);
    expect(await sendMeetingInvite(2, 9)).toEqual({ sent: true, scheduledAt: SIX_AM_ET });
  });

  it("all past is still 'all_times_expired', not 'outside_window'", async () => {
    w.meeting.proposedTimes = [new Date(Date.now() - DAY).toISOString()];
    expect((await sendMeetingInvite(2, 9)).reason).toBe("all_times_expired");
  });
});

describe("editing", () => {
  it("an offered time outside the window cannot be saved", async () => {
    await expect(caller().meetings.updateProposal({ id: 9, proposedTimes: [SIX_AM_ET] }))
      .rejects.toThrow("Every offered time must start between 9:00 AM and 4:00 PM America/New York time.");
    expect(w.updates).toEqual([]);
  });

  it("an in-window time saves", async () => {
    expect(await caller().meetings.updateProposal({ id: 9, proposedTimes: [ELEVEN_AM_ET] })).toEqual({ ok: true });
    expect(w.updates[0].set.proposedTimes).toEqual([ELEVEN_AM_ET]);
  });
});
