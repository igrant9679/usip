/**
 * Audit 2026-10-20, O20: the Calendar's edit dialog crashed on synced events.
 *
 * Confirmed from the code, not only suspected: `calendar_events.attendees` is a
 * JSON column (drizzle/schema.ts), sync and create store an ARRAY in it, and
 * the dialog's useState initialiser ran `JSON.parse(event.attendees)`.
 * JSON.parse on an array stringifies it first — "[object Object]", or "" for
 * `[]` — and throws, so opening any event with attendees threw during render.
 * The meeting summary made the same call inside a try/catch, so every summary
 * silently said "(none listed)".
 *
 * Now one reader accepts an array or a JSON string and never throws.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, prompts: [] as string[], paused: false };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async (req: any) => {
    h.prompts.push(String(req.messages.at(-1).content));
    return { choices: [{ message: { content: "Summary" } }] };
  },
}));
vi.mock("./services/sendWindow", async (a) => ({
  ...(await a<typeof import("./services/sendWindow")>()),
  getWorkspaceSendWindow: async () => ({ timezone: "UTC", window: {}, paused: h.paused }),
}));
vi.mock("./calendarAdapter", async (a) => ({
  ...(await a<typeof import("./calendarAdapter")>()),
  createCalendarAdapter: () => ({ updateEvent: async () => { throw new Error("must not reach the calendar"); } }),
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { storedAttendees } from "@shared/calendarAttendees";

const WS = 2;
const ME = 1;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "rep@lsi.example", name: "Rep", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

const SYNCED = [{ email: "pat@example.org", name: "Pat" }, { email: "lee@example.org" }];

describe("the stored attendees, whatever shape they are in", () => {
  it("the old read throws on what the column returns", () => {
    // What the dialog did, on what a synced event carries.
    expect(() => JSON.parse(SYNCED as unknown as string)).toThrow();
    expect(() => JSON.parse([] as unknown as string)).toThrow();
  });

  it("an array, a JSON string, bare addresses, nothing or junk", () => {
    expect(storedAttendees(SYNCED).map((a) => a.email)).toEqual(["pat@example.org", "lee@example.org"]);
    expect(storedAttendees(JSON.stringify(SYNCED)).map((a) => a.email)).toEqual(["pat@example.org", "lee@example.org"]);
    expect(storedAttendees(["ann@example.org", " "])).toEqual([{ email: "ann@example.org", name: "" }]);
    expect(storedAttendees([])).toEqual([]);
    expect(storedAttendees(null)).toEqual([]);
    expect(storedAttendees(undefined)).toEqual([]);
    expect(storedAttendees("not json")).toEqual([]);
    expect(storedAttendees({ email: "x@example.org" })).toEqual([]);
    expect(storedAttendees([null, 3, { name: "Only a name" }])).toEqual([{ email: "", name: "Only a name" }]);
  });

  it("the edit dialog reads them through it, and parses nothing itself", () => {
    const page = readFileSync("client/src/pages/usip/Calendar.tsx", "utf8");
    const dialog = page.slice(page.indexOf("function EventDialog("), page.indexOf("export default function CalendarPage"));
    expect(dialog.length).toBeGreaterThan(1000);
    expect(dialog).toContain("storedAttendees(event?.attendees).map((a) => a.email).filter(Boolean).join(\", \")");
    expect(page).not.toMatch(/JSON\.parse\(\s*event/);
  });
});

describe("the server reads them the same way", () => {
  beforeEach(() => {
    h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
    h.prompts = [];
    h.paused = false;
    rows("workspaces").push({ id: WS, name: "LSI", slug: "lsi", ownerUserId: ME, archivedAt: null, plan: "trial" });
    rows("calendar_events").push({
      id: 70, workspaceId: WS, userId: ME, calendarAccountId: 3, externalId: "evt-70", title: "Intro call",
      description: null, location: null, startAt: new Date("2026-11-04T15:00:00Z"), endAt: new Date("2026-11-04T15:30:00Z"),
      attendees: SYNCED, relatedType: null, relatedId: null,
    });
  });

  it("a meeting summary names the synced attendees (it said none)", async () => {
    await caller().calendar.summarizeMeeting({ eventId: 70 });
    expect(h.prompts[0]).toContain("Attendees: pat@example.org, lee@example.org");
  });

  it("an update while paused still sees attendees stored as a JSON string, and is refused", async () => {
    rows("calendar_events")[0].attendees = JSON.stringify(SYNCED);
    rows("calendar_accounts").push({ id: 3, workspaceId: WS, userId: ME, calendarId: "cal" });
    h.paused = true;
    await expect(caller().calendar.updateEvent({ accountId: 3, calendarId: "cal", externalId: "evt-70", dbId: 70, title: "Moved" } as any))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
