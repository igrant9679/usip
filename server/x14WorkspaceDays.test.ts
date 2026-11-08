/**
 * Days are the workspace's, not UTC's (audit 2026-10-20, X1.4; final pass
 * 2026-11-07): the daily caps, the Home sparklines' 7 days, and the dates in a
 * report. startOfLocalDay is found from the calendar day, so a clock change
 * between midnight and now cannot move it.
 *
 * Every expectation is derived from the zone for that instant (Intl), never a
 * frozen offset or zone name, so the test means the same in every season. The
 * fake clock walks across each transition.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({ tz: "America/New_York" }));
vi.mock("./db", async (a) => ({
  ...(await a<typeof import("./db")>()),
  getDb: async () => ({
    select: () => ({ from: () => ({ where: async () => [{ timezone: h.tz }] }) }),
  }),
}));

import { _clearWorkspaceTimezoneCache, startOfLocalDay, startOfWorkspaceDay, workspaceDayKeyOf } from "./services/workspaceTimezone";
import { fmtCell } from "../client/src/pages/usip/Reports";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Local wall clock of an instant in a zone, by Intl only. */
function wall(tz: string, ms: number): { day: string; time: string } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { day: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` };
}

/** Clocks every 2 hours across a 36-hour span centred on a transition. */
function clocksAround(isoUtc: string): number[] {
  const mid = Date.parse(isoUtc);
  return Array.from({ length: 19 }, (_, i) => mid - 18 * 3_600_000 + i * 2 * 3_600_000);
}

// Each zone's transitions in 2026, and a zone with none.
const CASES: Array<[string, string]> = [
  ["America/New_York", "2026-03-08T07:00:00Z"],
  ["America/New_York", "2026-11-01T06:00:00Z"],
  ["Europe/London", "2026-03-29T01:00:00Z"],
  ["Europe/London", "2026-10-25T01:00:00Z"],
  ["Australia/Sydney", "2026-04-04T16:00:00Z"],
  ["Australia/Sydney", "2026-10-03T16:00:00Z"],
  ["Asia/Kolkata", "2026-06-01T00:00:00Z"],
  ["UTC", "2026-06-01T00:00:00Z"],
];

afterEach(() => { vi.useRealTimers(); _clearWorkspaceTimezoneCache(); });

describe("the workspace's day begins at its own midnight, across a clock change", () => {
  it.each(CASES)("%s around %s", (tz, around) => {
    for (const now of clocksAround(around)) {
      const start = startOfLocalDay(tz, new Date(now)).getTime();
      const today = wall(tz, now).day;
      expect(wall(tz, start), `${tz} at ${new Date(now).toISOString()}`).toEqual({ day: today, time: "00:00" });
      expect(wall(tz, start - 1).day, "a millisecond earlier is yesterday").not.toBe(today);
      expect(start).toBeLessThanOrEqual(now);
    }
  });

  it("on the fake clock, startOfWorkspaceDay reads the workspace's zone and the clock", async () => {
    vi.useFakeTimers();
    for (const [tz, around] of CASES.slice(0, 2)) {
      h.tz = tz;
      for (const now of clocksAround(around)) {
        vi.setSystemTime(now);
        _clearWorkspaceTimezoneCache();
        const start = (await startOfWorkspaceDay(2)).getTime();
        expect(wall(tz, start)).toEqual({ day: wall(tz, now).day, time: "00:00" });
      }
    }
  });

  it("an instant's day key is the workspace's calendar day", () => {
    expect(workspaceDayKeyOf("UTC", 0)).toBe("1970-01-01");
    expect(workspaceDayKeyOf("America/New_York", Date.parse("2026-11-07T02:00:00Z"))).toBe("2026-11-06");
  });

  it("a bad zone reads as UTC", () => {
    const now = Date.parse("2026-11-07T15:30:00Z");
    expect(startOfLocalDay("Not/AZone", new Date(now)).toISOString()).toBe("2026-11-07T00:00:00.000Z");
  });
});

describe("the daily caps count from the workspace's midnight", () => {
  const sites = [
    "server/services/campaignRouter.ts",
    "server/services/dealAutopilot.ts",
    "server/services/linkedinEnrichment/jobChangeReengagement.ts",
    "server/services/meetingScheduler.ts",
    "server/services/optimization/runner.ts",
    "server/services/replyClassifier.ts",
    "server/services/taskAutopilot.ts",
  ];
  it.each(sites)("%s", (f) => {
    const src = read(f);
    expect(src).not.toContain("startOfUtcDay");
    expect(src).not.toContain("setUTCHours(0, 0, 0, 0)");
    expect(src).toContain("await startOfWorkspaceDay(");
  });

  it("nothing in the server rebuilds a UTC midnight by hand", () => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const walk = (d: string, out: string[] = []): string[] => {
      for (const n of readdirSync(join(ROOT, d))) {
        const rel = `${d}/${n}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
        else if (n.endsWith(".ts") && !n.endsWith(".test.ts")) out.push(rel);
      }
      return out;
    };
    const handMade = walk("server").filter((f) => /setUTCHours\(0, ?0, ?0, ?0\)|function startOfUtcDay/.test(readFileSync(join(ROOT, f), "latin1")));
    // The one left is startOfLocalDay's own fallback for a zone Intl refuses.
    // (workspace.ts's trend7d is replaced by METR's F44 at the merge.)
    expect(handMade.filter((f) => f !== "server/routers/workspace.ts")).toEqual(["server/services/workspaceTimezone.ts"]);
  });

  it("the LinkedIn invite budget stays on UTC days on purpose, the same as the Auto path", () => {
    const src = read("server/services/approvalTasks.ts");
    expect(src).toContain("const since = utcDayStart();");
    expect(read("server/services/socialAutopilot.ts")).toContain("const since = utcDayStart();");
  });
});

// The Home sparklines' seven days are the workspace's since METR's F44
// (services/activityMetrics.ts dailyCounts, pinned by that batch's tests); this
// batch's own version of trend7d was dropped at the merge.

describe("a report's dates are the workspace's", () => {
  it("an instant shows on the workspace's calendar, and a close date as the day it is", () => {
    const late = new Date("2026-11-07T02:00:00Z"); // 9 PM on the 6th in New York
    expect(fmtCell(late, "date", { timeZone: "America/New_York" })).toBe(late.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "America/New_York" }));
    expect(fmtCell(late, "date", { timeZone: "America/New_York" })).not.toBe(fmtCell(late, "date", { timeZone: "Asia/Tokyo" }));
    const closeDate = new Date("2026-11-14T00:00:00Z");
    expect(fmtCell(closeDate, "date", { timeZone: "America/Los_Angeles", calendar: true })).toBe(fmtCell(closeDate, "date", { timeZone: "Asia/Tokyo", calendar: true }));
    expect(fmtCell(closeDate, "date", { calendar: true })).toContain("14");
    expect(read("client/src/pages/usip/Reports.tsx")).toContain("fmtCell(r[c.key], c.kind, { timeZone: timezone, calendar: CALENDAR_DATE_KEYS.has(c.key) })");
  });
});
