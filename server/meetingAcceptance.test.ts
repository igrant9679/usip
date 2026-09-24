/**
 * A booking counts only when the prospect accepts (owner ask 2026-09-24).
 * Counting at send stopped 22 CommunityForce prospects' sequences, bumped
 * their campaigns' meetingsBooked and promoted them to the CRM, for invites
 * nobody had answered.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { calendarAccounts, calendarEvents, meetings } from "../drizzle/schema";
import { BOOKED_MEETING_STATUSES } from "@shared/meetingStatus";

const h = vi.hoisted(() => ({ db: null as any, getEvent: null as any, createEvent: null as any, attribute: null as any, archived: new Set<number>() }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));
vi.mock("./calendarAdapter", async (importActual) => ({
  ...(await importActual<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: (acc: { unipileAccountId?: string | null }) => ({
    listEvents: async () => [],
    createEvent: (...a: unknown[]) => h.createEvent(...a),
    // Only a Unipile-bridged calendar can report attendee answers.
    ...(acc.unipileAccountId ? { getEvent: (...a: unknown[]) => h.getEvent(...a) } : {}),
  }),
}));
vi.mock("./routers/are/execution", async (importActual) => ({
  ...(await importActual<typeof import("./routers/are/execution")>()),
  attributeMeetingBookingToAre: (...a: unknown[]) => h.attribute(...a),
}));
vi.mock("./_core/workspaceArchive", async (importActual) => ({
  ...(await importActual<typeof import("./_core/workspaceArchive")>()),
  archivedWorkspaceIds: async () => h.archived,
}));

import { normalizeResponse, syncInviteResponses } from "./services/meetingResponses";
import { sendMeetingInvite } from "./services/meetingScheduler";

type World = { invites: any[]; meeting: any; accounts: any[]; updates: { set: any; where: unknown }[] };
let w: World;

function makeDb() {
  const builder = (fields?: Record<string, unknown>) => {
    const st: { table?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      where() { return b; }, orderBy() { return b; }, limit() { return b; },
      then(res: (v: unknown) => void) {
        if (st.table === meetings) {
          if (fields && "attendeeResponse" in fields) res(w.invites);          // the sync's pick
          else if (fields && "proposedTimes" in fields) res([]);              // ownerCommitments
          else if (fields && Object.keys(fields).length === 1 && "id" in fields) res([]);                                         // one-invite-per-person check
          else res([w.meeting]);                                              // sendMeetingInvite
        } else if (st.table === calendarAccounts) res(w.accounts);
        else if (st.table === calendarEvents) res([{ externalId: "ms-evt-1" }]);
        else res([]);
      },
    };
    return b;
  };
  return {
    select: (fields?: Record<string, unknown>) => builder(fields),
    insert: () => ({ values() { return Promise.resolve([{ insertId: 7 }]); } }),
    update: () => { const u: any = {}; const b: any = { set(v: any) { u.set = v; return b; }, where(c: unknown) { u.where = c; w.updates.push(u); return Promise.resolve([]); } }; return b; },
  };
}

const invite = (over: Record<string, unknown> = {}) => ({ id: 31, workspaceId: 4, contactEmail: "Ada@Example.org", calendarEventId: 301, calendarAccountId: 2, attendeeResponse: "none", ...over });
const eventWith = (status: string | undefined) => ({ externalId: "ms-evt-1", title: "Intro", startAt: new Date(), endAt: new Date(), attendees: [
  { email: "khaja@communityforce.com", responseStatus: "organizer" },
  { email: "ada@example.org", responseStatus: status },
] });

beforeEach(() => {
  h.archived = new Set();
  w = { invites: [invite()], meeting: null, accounts: [{ id: 2, workspaceId: 4, userId: 5721, calendarId: null, unipileAccountId: "acc" }], updates: [] };
  h.db = makeDb();
  h.getEvent = vi.fn();
  h.attribute = vi.fn().mockResolvedValue(undefined);
  h.createEvent = vi.fn(async (_c: string, e: any) => ({ externalId: "evt", title: e.title, startAt: e.startAt, endAt: e.endAt }));
});

describe("normalizeResponse", () => {
  it("maps Microsoft's answers, tentative before accepted", () => {
    expect(normalizeResponse("accepted")).toBe("accepted");
    expect(normalizeResponse("tentativelyAccepted")).toBe("tentative");
    expect(normalizeResponse("declined")).toBe("declined");
    expect(normalizeResponse("notResponded")).toBe("none");
    expect(normalizeResponse("needs_action")).toBe("none");
    expect(normalizeResponse(undefined)).toBe("none");
  });
});

describe("syncInviteResponses", () => {
  it("accepted: booked now, and only now the ARE signal", async () => {
    h.getEvent.mockResolvedValue(eventWith("accepted"));
    expect(await syncInviteResponses()).toMatchObject({ checked: 1, accepted: 1 });
    expect(h.getEvent).toHaveBeenCalledWith("primary", "ms-evt-1");
    expect(w.updates).toHaveLength(1);
    expect(w.updates[0].set).toMatchObject({ status: "scheduled", attendeeResponse: "accepted" });
    expect(w.updates[0].set.attendeeRespondedAt).toBeInstanceOf(Date);
    expect(h.attribute).toHaveBeenCalledWith(4, { id: 31, contactEmail: "Ada@Example.org" });
  });

  it("declined: cancelled (no reminder to someone who said no), no ARE signal", async () => {
    h.getEvent.mockResolvedValue(eventWith("declined"));
    expect(await syncInviteResponses()).toMatchObject({ declined: 1 });
    expect(w.updates[0].set).toMatchObject({ status: "cancelled", attendeeResponse: "declined" });
    expect(h.attribute).not.toHaveBeenCalled();
  });

  it("tentative: recorded, still an invite, no ARE signal", async () => {
    h.getEvent.mockResolvedValue(eventWith("tentativelyAccepted"));
    expect(await syncInviteResponses()).toMatchObject({ tentative: 1 });
    expect(w.updates[0].set.status).toBeUndefined();
    expect(w.updates[0].set.attendeeResponse).toBe("tentative");
    expect(h.attribute).not.toHaveBeenCalled();
  });

  it("no answer yet: nothing written", async () => {
    h.getEvent.mockResolvedValue(eventWith("notResponded"));
    expect(await syncInviteResponses()).toMatchObject({ checked: 1, accepted: 0 });
    expect(w.updates).toEqual([]);
  });

  it("the organizer's own 'accepted' never counts for the prospect", async () => {
    h.getEvent.mockResolvedValue({ ...eventWith(undefined), attendees: [{ email: "khaja@communityforce.com", responseStatus: "accepted" }] });
    await syncInviteResponses();
    expect(w.updates).toEqual([]);
    expect(h.attribute).not.toHaveBeenCalled();
  });

  it("a calendar that cannot report answers (CalDAV) is skipped", async () => {
    w.accounts = [{ id: 2, workspaceId: 4, userId: 5721, calendarId: null, unipileAccountId: null }];
    expect(await syncInviteResponses()).toMatchObject({ checked: 0 });
    expect(h.getEvent).not.toHaveBeenCalled();
  });

  it("archived workspaces are frozen", async () => {
    h.archived = new Set([4]);
    await syncInviteResponses();
    expect(h.getEvent).not.toHaveBeenCalled();
  });

  it("a failed read is counted and the rest carry on", async () => {
    w.invites = [invite(), invite({ id: 32 })];
    h.getEvent.mockRejectedValueOnce(new Error("Unipile 404")).mockResolvedValueOnce(eventWith("accepted"));
    expect(await syncInviteResponses()).toMatchObject({ failed: 1, accepted: 1 });
  });

  it("only picks invites awaiting an answer", () => {
    const src = readFileSync("server/services/meetingResponses.ts", "utf8");
    expect(src).toContain('eq(meetings.status, "invited"),');
    expect(src).toContain('eq(meetings.id, m.id), eq(meetings.workspaceId, m.workspaceId), eq(meetings.status, "invited"),');
  });
});

describe("sending an invite is not a booking", () => {
  const future = new Date(Math.ceil((Date.now() + 3 * 86_400_000) / 86_400_000) * 86_400_000 + 14 * 3_600_000).toISOString();
  const proposal = () => ({ id: 9, workspaceId: 4, ownerUserId: 5721, status: "proposed", proposedTimes: [future], scheduledAt: null, durationMin: 30, contactEmail: "ada@example.org", contactName: "Ada", title: "Intro", inviteMessage: "Hi", meetingUrl: null });

  it("an offered time: `invited`, awaiting an answer, and no ARE signal", async () => {
    w.meeting = proposal();
    expect((await sendMeetingInvite(4, 9)).sent).toBe(true);
    const set = w.updates.find((u) => u.set.inviteSent)?.set;
    expect(set).toMatchObject({ status: "invited", attendeeResponse: "none", attendeeRespondedAt: null });
    expect(h.attribute).not.toHaveBeenCalled();
  });

  it("a time the prospect picked (booking link): booked at once, with the ARE signal", async () => {
    w.meeting = { ...proposal(), scheduledAt: new Date(future) };
    expect((await sendMeetingInvite(4, 9)).sent).toBe(true);
    const set = w.updates.find((u) => u.set.inviteSent)?.set;
    expect(set).toMatchObject({ status: "scheduled", attendeeResponse: "accepted" });
    expect(h.attribute).toHaveBeenCalledTimes(1);
  });
});

describe("what counts as booked", () => {
  it("an invite awaiting an answer is not booked", () => {
    expect(BOOKED_MEETING_STATUSES).not.toContain("invited");
    expect(BOOKED_MEETING_STATUSES).toContain("scheduled");
  });

  it("the Meetings page's Booked counts accepted meetings; Upcoming still shows invites", () => {
    const router = readFileSync("server/routers/meetings.ts", "utf8");
    expect(router).toContain('if (r.status === "scheduled" || r.status === "rescheduled") s.booked++;');
    const page = readFileSync("client/src/pages/usip/MeetingsV2.tsx", "utf8");
    expect(page).toContain('{m.attendeeResponse === "tentative" ? "Tentative" : "Awaiting response"}');
  });

  it("the job runs every 15 minutes", () => {
    const boot = readFileSync("server/_core/index.ts", "utf8");
    expect(boot).toContain("setInterval(runInviteResponses, 15 * 60 * 1000);");
  });
});
