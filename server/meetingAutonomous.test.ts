/**
 * Autonomous meeting proposals, behaviourally (restored 2026-09-24): each
 * proposal the autopilot drafts is sent through sendMeetingInvite at once;
 * in Approve nothing is. And reminders wait for the prospect to accept
 * (owner ask the same day: "Hold reminders until the prospect accepts").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { calendarAccounts, meetings, prospects, workspaceMembers, workspaces } from "../drizzle/schema";
import { CONFIRMED_MEETING_STATUSES, REMINDABLE_MEETING_STATUSES } from "@shared/meetingStatus";

const h = vi.hoisted(() => ({ db: null as any, createEvent: null as any }));

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
  createCalendarAdapter: () => ({ listEvents: async () => [], createEvent: (...a: unknown[]) => h.createEvent(...a) }),
}));
vi.mock("./routers/are/execution", async (importActual) => ({
  ...(await importActual<typeof import("./routers/are/execution")>()),
  attributeMeetingBookingToAre: async () => {},
}));

import { runMeetingAutopilotForWorkspace } from "./services/meetingScheduler";

let inserted: any[];
function makeDb() {
  const builder = (fields?: Record<string, unknown>) => {
    const st: { table?: unknown } = {};
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin() { return b; }, where() { return b; }, orderBy() { return b; }, limit() { return b; },
      then(res: (v: unknown) => void) {
        if (st.table === prospects) res([
          { id: 1, firstName: "Ada", lastName: "One", email: "ada@example.org", company: "Acme" },
          { id: 2, firstName: "Bo", lastName: "Two", email: "bo@example.org", company: "Beta" },
        ]);
        // sendMeetingInvite's read of the proposal it is sending: the one just inserted.
        else if (st.table === meetings && !fields) res(inserted.slice(-1).map((v, i) => ({ id: 100 + inserted.length - 1 + i, ...v })));
        else if (st.table === calendarAccounts) res([{ id: 2, workspaceId: 4, userId: 5721, calendarId: null, unipileAccountId: "acc" }]);
        else if (st.table === workspaceMembers) res([{ userId: 5721, role: "admin" }]);
        else if (st.table === workspaces) res([{ name: "CommunityForce" }]);
        else res([]);
      },
    };
    return b;
  };
  return {
    select: (fields?: Record<string, unknown>) => builder(fields),
    insert: (t: unknown) => ({ values(v: any) { if (t === meetings) inserted.push(v); return Promise.resolve([{ insertId: 100 + inserted.length - 1 }]); } }),
    update: () => { const b: any = { set() { return b; }, where() { return Promise.resolve([]); } }; return b; },
  };
}

beforeEach(() => {
  inserted = [];
  h.db = makeDb();
  h.createEvent = vi.fn(async (_c: string, e: any) => ({ externalId: "evt", title: e.title, startAt: e.startAt, endAt: e.endAt }));
});

describe("Autonomous", () => {
  it("sends each proposal it drafts, through the one send path", async () => {
    const res = await runMeetingAutopilotForWorkspace(4, 2, 5721, { send: true });
    expect(res).toEqual({ proposed: 2, sent: 2, skipped: 0 });
    expect(h.createEvent).toHaveBeenCalledTimes(2);
    // Each invite goes to the prospect it was drafted for.
    expect(h.createEvent.mock.calls.map((c) => c[1].attendees[0].email)).toEqual(["ada@example.org", "bo@example.org"]);
  });

  it("Approve drafts the same proposals and sends none", async () => {
    const res = await runMeetingAutopilotForWorkspace(4, 2, 5721);
    expect(res).toEqual({ proposed: 2, sent: 0, skipped: 0 });
    expect(h.createEvent).not.toHaveBeenCalled();
  });
});

describe("reminders wait for acceptance", () => {
  it("confirmed means accepted, agreed or moved: never an unanswered invite", () => {
    expect([...CONFIRMED_MEETING_STATUSES].sort()).toEqual(["rescheduled", "scheduled"]);
    // The calendar and attention panel still show an invite awaiting an answer.
    expect(REMINDABLE_MEETING_STATUSES).toContain("invited");
  });

  it("the reminder job uses the confirmed set", () => {
    const src = readFileSync("server/services/meetingReminders.ts", "utf8");
    expect(src).toContain("const REMINDER_STATUSES = confirmedMeetingStatuses();");
    expect(src).toContain("inArray(meetings.status, REMINDER_STATUSES),");
    expect(src).not.toContain("remindableMeetingStatuses");
  });
});
