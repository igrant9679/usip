/**
 * A date in a segment rule is a day in the workspace's zone.
 *
 * "Created after the 2nd" was read as a UTC day, so for a New York workspace it
 * began at 7pm on the 2nd, and someone created that evening counted as after it.
 * Segments feed auto-enrolment, so that decides who gets mail. The SQL and the
 * shared evaluator have to agree, or a count and an enrolment disagree.
 *
 * Every clock and day is a literal, either side of both clock changes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { contacts, workspaceSettings } from "../drizzle/schema";
import { applySegmentRule, matchesSegment, type SegmentRule } from "@shared/segmentRules";
import { countSegment, ruleSql, segmentWhere } from "./services/segmentSql";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";

const WS = 2;
const NY = "America/New_York", TOKYO = "Asia/Tokyo";
const T = (t: any) => h.db.rowsOf(getTableName(t)) as any[];
const after = (value: string): SegmentRule => ({ field: "createdAt", operator: "gt", value });
const before = (value: string): SegmentRule => ({ field: "createdAt", operator: "lt", value });
const person = (id: number, createdAt: string) => ({ id, workspaceId: WS, firstName: "F", lastName: "L", email: `p${id}@example.com`, createdAt: new Date(createdAt) });

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  _clearWorkspaceTimezoneCache();
});
function seed(timezone: string, instants: string[]) {
  T(workspaceSettings).push({ workspaceId: WS, timezone });
  instants.forEach((at, i) => T(contacts).push(person(i + 1, at)));
}
/** Who SQL says is in, as ids. */
const inSql = async (rule: SegmentRule, tz: string) => {
  const where = segmentWhere(WS, [rule], "all", tz);
  if (!where) return [];
  return (await h.db.select({ id: contacts.id }).from(contacts).where(where)).map((r: any) => r.id).sort((a: number, b: number) => a - b);
};
/** Who the evaluator says is in. */
const inEvaluator = (rule: SegmentRule, tz: string) =>
  T(contacts).filter((c) => matchesSegment(c, [rule], "all", tz)).map((c) => c.id).sort((a: number, b: number) => a - b);

describe.each([
  // zone, day, the last instant of the day before it, its first, its last, the first of the next.
  ["the day after the autumn change", NY, "2026-11-02", "2026-11-02T04:59:59.999Z", "2026-11-02T05:00:00.000Z", "2026-11-03T04:59:59.999Z", "2026-11-03T05:00:00.000Z"],
  ["the day after the spring change", NY, "2027-03-15", "2027-03-15T03:59:59.999Z", "2027-03-15T04:00:00.000Z", "2027-03-16T03:59:59.999Z", "2027-03-16T04:00:00.000Z"],
  ["the 25-hour day", NY, "2026-11-01", "2026-11-01T03:59:59.999Z", "2026-11-01T04:00:00.000Z", "2026-11-02T04:59:59.999Z", "2026-11-02T05:00:00.000Z"],
  ["the 23-hour day", NY, "2027-03-14", "2027-03-14T04:59:59.999Z", "2027-03-14T05:00:00.000Z", "2027-03-15T03:59:59.999Z", "2027-03-15T04:00:00.000Z"],
  ["east of UTC", TOKYO, "2026-11-03", "2026-11-02T14:59:59.999Z", "2026-11-02T15:00:00.000Z", "2026-11-03T14:59:59.999Z", "2026-11-03T15:00:00.000Z"],
  ["a UTC workspace", "UTC", "2026-11-03", "2026-11-02T23:59:59.999Z", "2026-11-03T00:00:00.000Z", "2026-11-03T23:59:59.999Z", "2026-11-04T00:00:00.000Z"],
  ["a midnight gap", "America/Havana", "2027-03-14", "2027-03-14T04:59:59.999Z", "2027-03-14T05:00:00.000Z", "2027-03-15T03:59:59.999Z", "2027-03-15T04:00:00.000Z"],
])("%s", (_name, tz, day, lastBefore, first, last, firstAfter) => {
  beforeEach(() => seed(tz, [lastBefore, first, last, firstAfter]));

  it("after that day is from the first instant of the next, in SQL and the evaluator", async () => {
    expect(await inSql(after(day), tz)).toEqual([4]);
    expect(inEvaluator(after(day), tz)).toEqual([4]);
  });
  it("before that day is up to the last instant of the one before, in SQL and the evaluator", async () => {
    expect(await inSql(before(day), tz)).toEqual([1]);
    expect(inEvaluator(before(day), tz)).toEqual([1]);
  });
});

describe("the bug it fixes", () => {
  it("someone created at 8pm in New York on the 2nd is not after the 2nd", async () => {
    seed(NY, ["2026-11-03T01:00:00Z"]);
    expect(await inSql(after("2026-11-02"), NY)).toEqual([]);
    expect(inEvaluator(after("2026-11-02"), NY)).toEqual([]);
    expect(await inSql(before("2026-11-03"), NY)).toEqual([1]);
    expect(inEvaluator(before("2026-11-03"), NY)).toEqual([1]);
  });
});

describe("what doesn't change", () => {
  it("the evaluator's default is UTC, for a caller with no workspace", () => {
    const c = { createdAt: new Date("2026-11-03T01:00:00Z") };
    expect(applySegmentRule(c, after("2026-11-02"))).toBe(true);
    expect(applySegmentRule(c, after("2026-11-02"), NY)).toBe(false);
  });
  it("a bad date matches nobody, in both", () => {
    const c = { createdAt: new Date("2026-11-03T01:00:00Z") };
    for (const value of ["not a date", "2026-13-40", "", "2026-11-03T00:00:00Z"]) {
      expect(applySegmentRule(c, after(value), NY), value).toBe(false);
      expect(applySegmentRule(c, before(value), NY), value).toBe(false);
      expect(ruleSql(after(value), NY), value).toBeNull();
      expect(ruleSql(before(value), NY), value).toBeNull();
    }
  });
  it("a missing date matches nobody", () => {
    expect(applySegmentRule({ createdAt: null }, after("2026-11-02"), NY)).toBe(false);
    expect(applySegmentRule({ createdAt: null }, before("2026-11-02"), NY)).toBe(false);
  });
  it("across a month and year end", async () => {
    seed(NY, ["2027-01-01T04:59:59.999Z", "2027-01-01T05:00:00.000Z"]);
    expect(await inSql(after("2026-12-31"), NY)).toEqual([2]);
    expect(inEvaluator(after("2026-12-31"), NY)).toEqual([2]);
  });
});

describe("the real paths use the workspace's zone", () => {
  it("countSegment reads it", async () => {
    seed(NY, ["2026-11-03T01:00:00Z", "2026-11-03T06:00:00Z"]);
    expect(await countSegment(h.db, WS, [after("2026-11-02")], "all")).toBe(1);
  });
  it("a workspace with no zone set is UTC", async () => {
    T(contacts).push(person(1, "2026-11-03T01:00:00Z"));
    expect(await countSegment(h.db, WS, [after("2026-11-02")], "all")).toBe(1);
  });
  it("the hourly enrolment and the members page pass it, and it isn't optional", () => {
    const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
    expect(read("server/routers/segmentRules.ts")).toContain("segmentWhere(workspaceId, segRules, matchType, await getWorkspaceTimezone(workspaceId))");
    expect(read("server/routers/segments.ts")).toContain('as "all" | "any", await getWorkspaceTimezone(ctx.workspace.id))');
    expect(read("server/services/segmentSql.ts")).toContain('export function segmentWhere(ws: number, rules: SegmentRule[], matchType: "all" | "any", tz: string): SQL | null {');
  });
});
