/**
 * Audit final pass, batch CRMP (2026-11-07), U27: QBRs grouped into
 * upcoming, overdue and completed, scheduled at a time, with a calendar
 * invite that is a downloaded .ics file (no provider call, no email).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "e".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
// shared/ics.ts became one module at the merge with PR 59 (2026-11-07):
// the general builder is buildCalendarIcs; buildIcs is the booking's.
import { buildCalendarIcs, foldIcsLine, icsText } from "@shared/ics";
import { groupQbrs, isQbrOverdue } from "@shared/qbrSchedule";

const WS = 2, OTHER = 7, REP = 21;
const T0 = new Date("2026-11-18T15:00:00Z");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
function caller() {
  return appRouter.createCaller({
    user: { id: REP, openId: "u", email: "r@example.com", name: "R", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
    req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("customers").push({ id: 1, workspaceId: WS, accountId: 10 }, { id: 2, workspaceId: OTHER, accountId: 11 });
});
afterEach(() => { vi.useRealTimers(); });

describe("a QBR can be scheduled at a time, and moved (U27)", () => {
  it("with a length, the instant and the length are stored", async () => {
    const { id } = await caller().cs.scheduleQbr({ customerId: 1, scheduledAt: "2026-11-20T19:00:00.000Z", durationMinutes: 45 });
    const q = rows("qbrs").find((r) => r.id === id);
    expect(q.scheduledAt.toISOString()).toBe("2026-11-20T19:00:00.000Z");
    expect(q.durationMinutes).toBe(45);
  });

  it("without one it is a day, as before; a length with no time is refused", async () => {
    const { id } = await caller().cs.scheduleQbr({ customerId: 1, scheduledAt: "2026-12-03" });
    const q = rows("qbrs").find((r) => r.id === id);
    expect(q.scheduledAt.toISOString().slice(0, 10)).toBe("2026-12-03");
    expect(q.durationMinutes).toBeNull();
    expect((await refusal(caller().cs.scheduleQbr({ customerId: 1, scheduledAt: "2026-12-03", durationMinutes: 60 }))).code).toBe("BAD_REQUEST");
  });

  it("a scheduled QBR moves; a completed one or another workspace's does not", async () => {
    rows("qbrs").push(
      { id: 5, workspaceId: WS, customerId: 1, status: "scheduled", scheduledAt: new Date("2026-11-10T12:00:00Z"), durationMinutes: null },
      { id: 6, workspaceId: WS, customerId: 1, status: "completed", scheduledAt: new Date("2026-11-01T12:00:00Z"), durationMinutes: null },
      { id: 7, workspaceId: OTHER, customerId: 2, status: "scheduled", scheduledAt: new Date("2026-11-01T12:00:00Z"), durationMinutes: null },
    );
    await caller().cs.rescheduleQbr({ id: 5, scheduledAt: "2026-11-25T16:30:00.000Z", durationMinutes: 60 });
    expect(rows("qbrs").find((r) => r.id === 5)).toMatchObject({ durationMinutes: 60 });
    expect(rows("qbrs").find((r) => r.id === 5).scheduledAt.toISOString()).toBe("2026-11-25T16:30:00.000Z");
    expect((await refusal(caller().cs.rescheduleQbr({ id: 6, scheduledAt: "2026-11-30" }))).code).toBe("BAD_REQUEST");
    expect((await refusal(caller().cs.rescheduleQbr({ id: 7, scheduledAt: "2026-11-30" }))).code).toBe("NOT_FOUND");
  });

  it("listQbrs reads one customer's in SQL", async () => {
    rows("qbrs").push(
      { id: 5, workspaceId: WS, customerId: 1, status: "scheduled", scheduledAt: new Date(T0) },
      { id: 8, workspaceId: WS, customerId: 3, status: "scheduled", scheduledAt: new Date(T0) },
      { id: 9, workspaceId: OTHER, customerId: 1, status: "scheduled", scheduledAt: new Date(T0) },
    );
    expect((await caller().cs.listQbrs({ customerId: 1 })).map((q) => q.id)).toEqual([5]);
  });
});

describe("QBRs are grouped into upcoming, overdue and completed (U27)", () => {
  const today = "2026-11-18";
  const q = (id: number, status: string, scheduledAt: string | null, durationMinutes: number | null = null, completedAt: string | null = null) =>
    ({ id, status, scheduledAt, durationMinutes, completedAt });
  it("puts each in its group, soonest first ahead and latest first behind", () => {
    const g = groupQbrs([
      q(1, "scheduled", "2026-11-25T12:00:00Z"),
      q(2, "scheduled", "2026-11-17T12:00:00Z"), // yesterday, day only
      q(3, "scheduled", "2026-11-18T12:00:00Z"), // today, day only: not overdue yet
      q(4, "scheduled", "2026-11-18T13:00:00Z", 60), // ended 14:00, now 15:00
      q(5, "scheduled", "2026-11-18T14:30:00Z", 60), // running until 15:30
      q(6, "completed", "2026-10-01T12:00:00Z", null, "2026-10-02T10:00:00Z"),
      q(7, "completed", "2026-11-01T12:00:00Z", null, "2026-11-01T18:00:00Z"),
      q(8, "cancelled", "2026-11-05T12:00:00Z"),
      q(9, "scheduled", null),
    ], T0, today);
    expect(g.overdue.map((x) => x.id)).toEqual([2, 4]);
    expect(g.upcoming.map((x) => x.id)).toEqual([3, 5, 1, 9]);
    expect(g.completed.map((x) => x.id)).toEqual([7, 6]);
    expect(g.cancelled.map((x) => x.id)).toEqual([8]);
  });
  it("a completed QBR is never overdue", () => {
    expect(isQbrOverdue(q(1, "completed", "2026-01-01T12:00:00Z"), T0, today)).toBe(false);
  });
});

describe("the calendar invite is an .ics file built here (U27)", () => {
  it("a timed QBR blocks its slot, in UTC, with escaped text and CRLF lines", () => {
    const ics = buildCalendarIcs({ product: "QBR", uid: "qbr-5@velocity", title: "QBR: Acme, Inc; Q4", description: "Agenda:\n- Roadmap", start: new Date("2026-11-20T19:00:00Z"), end: new Date("2026-11-20T19:45:00Z"), stamp: T0 });
    expect(ics.split("\r\n")).toEqual([
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Velocity//QBR//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VEVENT", "UID:qbr-5@velocity", "DTSTAMP:20261118T150000Z",
      "DTSTART:20261120T190000Z", "DTEND:20261120T194500Z",
      "SUMMARY:QBR: Acme\\, Inc\\; Q4", "DESCRIPTION:Agenda:\\n- Roadmap",
      "END:VEVENT", "END:VCALENDAR", "",
    ]);
  });
  it("a day-only QBR is an all-day entry that ends the next day", () => {
    const ics = buildCalendarIcs({ product: "QBR", uid: "q", title: "QBR", start: new Date("2026-11-30T12:00:00Z"), allDay: true, day: "2026-11-30", stamp: T0 });
    expect(ics).toContain("DTSTART;VALUE=DATE:20261130\r\nDTEND;VALUE=DATE:20261201\r\n");
  });
  it("long lines fold at 75 octets and text escapes backslashes", () => {
    const line = `DESCRIPTION:${"x".repeat(100)}`;
    expect(foldIcsLine(line).split("\r\n").map((l) => l.length)).toEqual([75, 38]);
    expect(icsText("a\\b")).toBe("a\\\\b");
  });
  it("the QBRs page groups, offers the invite as a download and moves a QBR; no calendar provider or send is called", () => {
    const src = read("client/src/pages/usip/QBRs.tsx");
    expect(src).toContain("groupQbrs((data ?? []) as Array<QbrLike & Record<string, any>>, new Date(), localToday())");
    const invite = src.slice(src.indexOf("function downloadInvite"), src.indexOf("function whenFromForm"));
    expect(invite).toContain("buildCalendarIcs({");
    expect(invite).toContain(`new Blob([ics], { type: "text/calendar;charset=utf-8" })`);
    expect(invite).not.toMatch(/trpc|fetch\(|mutate/);
    expect(src).toContain(`<Field name="scheduledTime" label="Time (optional)" type="time" />`);
    expect(src).toContain("reschedule.mutate({ id: moveFor, scheduledAt: when.scheduledAt, durationMinutes: when.durationMinutes ?? null });");
  });
});
