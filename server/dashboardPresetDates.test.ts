/**
 * "Last 7 days" is seven calendar days in the workspace's zone, on any machine,
 * on either side of a clock change, and the server counts all seven.
 *
 * Three defects, one feature:
 *   1. The filter bar counted back on the browser's clock and labelled the result
 *      in UTC, so a range holding a clock change spanned 8 dates (autumn) or 6
 *      (spring) for an hour each evening. "Today" was tomorrow from 7pm in New York.
 *   2. The server read each day as midnight UTC, so a range stopped when its last
 *      day began and "Today" ran from an instant to the same instant.
 *   3. This suite's own copy of the resolver kept the bug, and CI runs under UTC,
 *      where (1) can't show. So these tests move the machine's zone themselves,
 *      and check that the move took.
 *
 * Every instant below is fixed and written out, so nothing here floats off the
 * real clock or changes meaning on some later date.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { tzOffsetMs } from "@shared/availability";
import { resolvePresetDates } from "@shared/dashboardPresets";
import { dashboardWidgets, workspaceSettings } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { dayRangeBounds, endOfLocalDay, startOfCalendarDay } from "./services/calendarDeadline";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock("./db", async (importActual) => ({
  ...(await importActual<typeof import("./db")>()),
  getDb: async () => h.db,
}));

import { appRouter } from "./routers";

const NY = "America/New_York";
/** Nov 2, 7:30pm in New York: the hour that spanned 8 dates after the autumn change. */
const AUTUMN_EVENING = new Date("2026-11-03T00:30:00.000Z");
/** Mar 16, 7:30pm in New York: the hour that spanned 6 dates after the spring change. */
const SPRING_EVENING = new Date("2027-03-16T23:30:00.000Z");

/** Inclusive count of calendar days between two "YYYY-MM-DD", with no zone in it. */
function datesSpanned(from: string, to: string): number {
  const ms = (day: string) => {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return (ms(to) - ms(from)) / 86_400_000 + 1;
}

/** The zone's calendar day, read independently of the code under test. */
function dayIn(tz: string, at: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// CI is UTC, where counting in the machine's zone and labelling in UTC agree.
// Each of the others can tell them apart, in a different direction.
const MACHINES = ["UTC", NY, "Asia/Tokyo", "Europe/Paris", "Pacific/Apia"];

describe.each(MACHINES)("on a machine set to %s", (machine) => {
  const original = process.env.TZ;
  beforeAll(() => { process.env.TZ = machine; });
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  it("the machine's zone really moved (the control for everything below)", () => {
    for (const at of [AUTUMN_EVENING, SPRING_EVENING]) {
      expect(at.getTimezoneOffset() + tzOffsetMs(machine, at.getTime()) / 60_000).toBe(0);
    }
  });

  it("the evening after the autumn change: exact days, in New York", () => {
    expect(resolvePresetDates("today", NY, AUTUMN_EVENING)).toEqual({ dateFrom: "2026-11-02", dateTo: "2026-11-02" });
    expect(resolvePresetDates("7d", NY, AUTUMN_EVENING)).toEqual({ dateFrom: "2026-10-27", dateTo: "2026-11-02" });
    expect(resolvePresetDates("30d", NY, AUTUMN_EVENING)).toEqual({ dateFrom: "2026-10-04", dateTo: "2026-11-02" });
    expect(resolvePresetDates("90d", NY, AUTUMN_EVENING)).toEqual({ dateFrom: "2026-08-05", dateTo: "2026-11-02" });
    expect(resolvePresetDates("ytd", NY, AUTUMN_EVENING)).toEqual({ dateFrom: "2026-01-01", dateTo: "2026-11-02" });
  });

  it("the evening after the spring change: exact days, in New York", () => {
    expect(resolvePresetDates("today", NY, SPRING_EVENING)).toEqual({ dateFrom: "2027-03-16", dateTo: "2027-03-16" });
    expect(resolvePresetDates("7d", NY, SPRING_EVENING)).toEqual({ dateFrom: "2027-03-10", dateTo: "2027-03-16" });
    expect(resolvePresetDates("30d", NY, SPRING_EVENING)).toEqual({ dateFrom: "2027-02-15", dateTo: "2027-03-16" });
    expect(resolvePresetDates("90d", NY, SPRING_EVENING)).toEqual({ dateFrom: "2026-12-17", dateTo: "2027-03-16" });
    expect(resolvePresetDates("ytd", NY, SPRING_EVENING)).toEqual({ dateFrom: "2027-01-01", dateTo: "2027-03-16" });
  });

  it("the year is the workspace's year on both sides of its New Year", () => {
    const newYearsEveInNewYork = new Date("2027-01-01T01:00:00.000Z");
    expect(resolvePresetDates("ytd", NY, newYearsEveInNewYork)).toEqual({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    const newYearsDayInTokyo = new Date("2026-12-31T23:00:00.000Z");
    expect(resolvePresetDates("ytd", "Asia/Tokyo", newYearsDayInTokyo)).toEqual({ dateFrom: "2027-01-01", dateTo: "2027-01-01" });
  });

  it("uses the real clock when no instant is passed", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(AUTUMN_EVENING);
      expect(resolvePresetDates("7d", NY)).toEqual({ dateFrom: "2026-10-27", dateTo: "2026-11-02" });
      vi.setSystemTime(SPRING_EVENING);
      expect(resolvePresetDates("7d", NY)).toEqual({ dateFrom: "2027-03-10", dateTo: "2027-03-16" });
    } finally {
      vi.useRealTimers();
    }
  });

  // Every hour of the days a range can still reach back across each change.
  const CHANGES: Array<[string, string]> = [
    [NY, "2026-11-01T06:00:00.000Z"],
    [NY, "2027-03-14T07:00:00.000Z"],
    ["Australia/Sydney", "2026-10-03T16:00:00.000Z"],
    ["America/Havana", "2027-03-14T05:00:00.000Z"],
  ];
  const DAYS_AFTER = [0, 1, 6, 7, 29, 30, 89, 90];

  it.each(CHANGES)("%s at %s: every preset spans its days, ending today", (tz, change) => {
    const at = Date.parse(change);
    // Not vacuous: there is a change here, or this sweep proves nothing.
    expect(tzOffsetMs(tz, at - 1)).not.toBe(tzOffsetMs(tz, at + 1));
    for (const after of DAYS_AFTER) {
      for (let hour = 0; hour < 24; hour++) {
        const now = at + (after * 24 + hour) * 3_600_000;
        const today = dayIn(tz, now);
        for (const [preset, span] of [["today", 1], ["7d", 7], ["30d", 30], ["90d", 90]] as const) {
          const out = resolvePresetDates(preset, tz, new Date(now));
          expect(out.dateTo).toBe(today);
          expect(datesSpanned(out.dateFrom!, out.dateTo!)).toBe(span);
        }
      }
    }
  });

  it("the server reads a day the same way on every machine", () => {
    expect(dayRangeBounds("2026-10-27", "2026-11-02", NY)).toEqual({
      from: new Date("2026-10-27T04:00:00.000Z"),
      to: new Date("2026-11-03T04:59:59.999Z"),
    });
  });
});

describe("resolvePresetDates, whatever the machine", () => {
  it("has no range for all time, a custom range or an unknown preset", () => {
    for (const preset of ["all", "custom", "unknown"]) {
      expect(resolvePresetDates(preset, NY, AUTUMN_EVENING)).toEqual({});
    }
  });

  it("the same instant is a different day in a different workspace", () => {
    expect(resolvePresetDates("today", NY, AUTUMN_EVENING).dateTo).toBe("2026-11-02");
    expect(resolvePresetDates("today", "UTC", AUTUMN_EVENING).dateTo).toBe("2026-11-03");
    expect(resolvePresetDates("today", "Asia/Tokyo", AUTUMN_EVENING).dateTo).toBe("2026-11-03");
  });

  it("reads a zone it cannot use as UTC, like the rest of the workspace settings", () => {
    expect(resolvePresetDates("today", "Not/AZone", AUTUMN_EVENING).dateTo).toBe("2026-11-03");
  });
});

describe("dayRangeBounds: a range lasts from the start of its first day to the end of its last", () => {
  const hours = (r: { from: Date | null; to: Date | null }) => (r.to!.getTime() + 1 - r.from!.getTime()) / 3_600_000;

  it("one day is a whole day, not an instant", () => {
    const r = dayRangeBounds("2026-11-02", "2026-11-02", NY);
    expect(r.from!.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(r.to!.toISOString()).toBe("2026-11-03T04:59:59.999Z");
    expect(hours(r)).toBe(24);
  });

  it("the day of the autumn change has 25 hours and the spring one 23", () => {
    const autumn = dayRangeBounds("2026-11-01", "2026-11-01", NY);
    expect(autumn.from!.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(autumn.to!.toISOString()).toBe("2026-11-02T04:59:59.999Z");
    expect(hours(autumn)).toBe(25);
    const spring = dayRangeBounds("2027-03-14", "2027-03-14", NY);
    expect(spring.from!.toISOString()).toBe("2027-03-14T05:00:00.000Z");
    expect(spring.to!.toISOString()).toBe("2027-03-15T03:59:59.999Z");
    expect(hours(spring)).toBe(23);
  });

  it("a day east of UTC starts on the UTC day before", () => {
    const r = dayRangeBounds("2026-11-02", "2026-11-02", "Asia/Tokyo");
    expect(r.from!.toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(r.to!.toISOString()).toBe("2026-11-02T14:59:59.999Z");
  });

  it("adjacent days meet with no gap and no overlap, across both changes", () => {
    for (const [first, second] of [["2026-10-31", "2026-11-01"], ["2026-11-01", "2026-11-02"], ["2027-03-13", "2027-03-14"], ["2027-03-14", "2027-03-15"]] as const) {
      const end = dayRangeBounds(first, first, NY).to!.getTime();
      expect(dayRangeBounds(second, second, NY).from!.getTime()).toBe(end + 1);
    }
  });

  // These zones spring forward AT midnight, so that day has no 00:00 at all.
  it.each([
    ["America/Havana", "2027-03-14", "2027-03-14T05:00:00.000Z", "2027-03-14T04:59:59.999Z"],
    ["America/Santiago", "2026-09-06", "2026-09-06T04:00:00.000Z", "2026-09-06T03:59:59.999Z"],
    ["Asia/Beirut", "2027-03-28", "2027-03-27T22:00:00.000Z", "2027-03-27T21:59:59.999Z"],
  ])("%s: %s starts when it really starts, and the day before keeps its last hour", (tz, day, start, lastOfPrevious) => {
    expect(startOfCalendarDay(day, tz)!.toISOString()).toBe(start);
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const previous = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
    expect(endOfLocalDay(previous, tz)!.toISOString()).toBe(lastOfPrevious);
    expect(dayIn(tz, Date.parse(start))).toBe(day);
    expect(dayIn(tz, Date.parse(lastOfPrevious))).toBe(previous);
  });

  it("either end may be missing, and is no bound", () => {
    expect(dayRangeBounds(undefined, undefined, NY)).toEqual({ from: null, to: null });
    expect(dayRangeBounds("", "", NY)).toEqual({ from: null, to: null });
    expect(dayRangeBounds("2026-11-02", undefined, NY).to).toBeNull();
    expect(dayRangeBounds(undefined, "2026-11-02", NY).from).toBeNull();
  });

  it("an end it cannot read is no bound, never an Invalid Date in a query", () => {
    expect(dayRangeBounds("nonsense", "nonsense", NY)).toEqual({ from: null, to: null });
  });

  it("an instant, as a saved widget may hold, is kept as given", () => {
    const at = "2026-11-02T09:30:00.000Z";
    expect(dayRangeBounds(at, at, NY)).toEqual({ from: new Date(at), to: new Date(at) });
  });
});

/* ── Through the real procedure: the instants the query is actually given ── */

const WS = { id: 7, name: "Acme Corp" };
const dialect = new MySqlDialect();

function makeDb(widget: Record<string, unknown>, timezone: string, wheres: unknown[]) {
  const builder = () => {
    const st: { table?: unknown; joined: boolean } = { joined: false };
    const b: any = {
      from(t: unknown) { st.table = t; return b; },
      innerJoin() { st.joined = true; return b; },
      leftJoin() { return b; },
      where(c: unknown) { wheres.push(c); return b; },
      orderBy() { return b; },
      groupBy() { return b; },
      limit() { return b; },
      then(res: (v: unknown) => void, rej: (e: unknown) => void) {
        if (st.joined) {
          res([{
            ws: { ...WS, ownerUserId: 1, archivedAt: null },
            mb: { id: 1, userId: 1, workspaceId: WS.id, role: "rep", deactivatedAt: null, lastActiveAt: new Date() },
          }]);
        } else if (st.table === dashboardWidgets) {
          res([{ id: 1, workspaceId: WS.id, title: "Widget", ...widget }]);
        } else if (st.table === workspaceSettings) {
          res([{ timezone }]);
        } else {
          res([]);
        }
      },
    };
    return b;
  };
  return { select: () => builder() };
}

function makeCtx(): TrpcContext {
  return {
    user: {
      id: 1, openId: "user-1", email: "u1@example.com", name: "User 1",
      loginMethod: "manus", role: "user",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext;
}

/** Every Date bound into the queries this widget ran, with its comparison: ">= 2026-…Z". */
async function boundsQueried(
  widget: Record<string, unknown>,
  filters: { dateFrom?: string; dateTo?: string } | undefined,
  timezone = NY,
): Promise<string[]> {
  const wheres: unknown[] = [];
  h.db = makeDb(widget, timezone, wheres);
  await appRouter.createCaller(makeCtx()).dashboards.resolveWidget({ id: 1, filters });
  return wheres.filter(Boolean).flatMap((w) => {
    const { sql, params } = dialect.sqlToQuery(w as any);
    // One match per placeholder, so operators and params stay paired by position.
    const before = [...sql.matchAll(/(\S*)\s*\?/g)].map((m) => m[1]);
    return params.flatMap((p, i) => (p instanceof Date ? [`${before[i]} ${p.toISOString()}`] : []));
  });
}

describe("dashboards.resolveWidget bounds its queries by the workspace's days", () => {
  beforeEach(() => { _clearWorkspaceTimezoneCache(); });
  afterEach(() => { _clearWorkspaceTimezoneCache(); });

  // One row for each place the filter is applied.
  const WIDGETS: Array<[string, Record<string, unknown>]> = [
    ["a deal KPI", { type: "kpi", config: { metric: "pipeline_value" } }],
    ["the activity count", { type: "kpi", config: { metric: "activity_counts" } }],
    ["meetings booked", { type: "kpi", config: { metric: "meetings_booked" } }],
    ["the activity chart", { type: "line", config: { metric: "activities" } }],
    ["the heatmap", { type: "heatmap", config: {} }],
    ["the activity feed", { type: "activity_feed", config: {} }],
  ];

  it.each(WIDGETS)("%s runs from the first day's start to the last day's end", async (_name, widget) => {
    const seen = await boundsQueried(widget, { dateFrom: "2026-10-27", dateTo: "2026-11-02" });
    expect(seen).toContain(">= 2026-10-27T04:00:00.000Z");
    expect(seen).toContain("<= 2026-11-03T04:59:59.999Z");
    // The readings this replaced: midnight UTC at each end.
    expect(seen).not.toContain(">= 2026-10-27T00:00:00.000Z");
    expect(seen).not.toContain("<= 2026-11-02T00:00:00.000Z");
  });

  it.each(WIDGETS)("%s: 'Today' is the whole day", async (_name, widget) => {
    const seen = await boundsQueried(widget, { dateFrom: "2026-11-02", dateTo: "2026-11-02" });
    expect(seen).toContain(">= 2026-11-02T05:00:00.000Z");
    expect(seen).toContain("<= 2026-11-03T04:59:59.999Z");
  });

  it.each(WIDGETS)("%s has no date bound without a date filter", async (_name, widget) => {
    expect(await boundsQueried(widget, undefined)).toEqual([]);
  });

  it("reads the days in THIS workspace's zone, not New York's", async () => {
    const seen = await boundsQueried(WIDGETS[0]![1], { dateFrom: "2026-11-02", dateTo: "2026-11-02" }, "Asia/Tokyo");
    expect(seen).toContain(">= 2026-11-01T15:00:00.000Z");
    expect(seen).toContain("<= 2026-11-02T14:59:59.999Z");
  });

  it("a workspace left on the default zone reads them in UTC", async () => {
    const seen = await boundsQueried(WIDGETS[0]![1], { dateFrom: "2026-11-02", dateTo: "2026-11-02" }, "UTC");
    expect(seen).toContain(">= 2026-11-02T00:00:00.000Z");
    expect(seen).toContain("<= 2026-11-02T23:59:59.999Z");
  });

  it("a range saved on the widget is read the same way", async () => {
    const seen = await boundsQueried(
      { ...WIDGETS[0]![1], filters: { dateFrom: "2026-10-27", dateTo: "2026-11-02" } },
      undefined,
    );
    expect(seen).toContain(">= 2026-10-27T04:00:00.000Z");
    expect(seen).toContain("<= 2026-11-03T04:59:59.999Z");
  });
});

/* ── The filter bar: the browser has to pick the days in the same zone ── */

describe("DashboardFilterBar", () => {
  const src = readFileSync(resolve(import.meta.dirname, "../client/src/components/usip/DashboardFilterBar.tsx"), "utf8");
  const start = src.indexOf("const update = (patch");
  const update = src.slice(start, src.indexOf("onChange(next)", start));
  const buttonStart = src.indexOf("key={p.value}");
  const button = src.slice(buttonStart, src.indexOf("className=", buttonStart));

  it("resolves a preset in the workspace's zone, when one is picked", () => {
    expect(update).toContain('resolvePresetDates(patch.preset, settings.data?.timezone ?? "UTC")');
    expect(src).toContain('from "@shared/dashboardPresets"');
    expect(src).toContain("trpc.settings.get.useQuery(");
  });

  it("holds the buttons until it knows the zone", () => {
    expect(button).toContain("disabled={settings.isLoading}");
  });

  it("has no date arithmetic of its own left to drift", () => {
    expect(src).not.toMatch(/toISOString|setDate\(|getFullYear/);
    expect(src).not.toMatch(/function resolvePresetDates/);
  });
});
