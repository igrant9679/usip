/**
 * Days picked in a date input are the workspace's days, read back the same way.
 *
 *   sequence analytics and login history filter on whole workspace days · a
 *   stored deadline reads back on the day that was picked, so saving a form does
 *   not move it · an extension's default is seven calendar days · an expiry
 *   picker's earliest day is today in the workspace's zone.
 *
 * CI runs under UTC, where the viewer's day and the UTC day agree, so these tests
 * move the machine's zone themselves and check that the move took. Every clock
 * and expected day is a literal, either side of both clock changes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, wsId: 2, selects: [] as string[], settings: {} as Record<string, unknown> };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("@/lib/trpc", () => ({ trpc: { settings: { get: { useQuery: () => h.settings } } } }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { emailDrafts, sequences, workspaceSettings } from "../drizzle/schema";
import { appRouter } from "./routers";
import { sequencePerformance } from "./services/sequenceAnalytics";
import { deadlineFrom } from "./services/calendarDeadline";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import { tzOffsetMs } from "@shared/availability";
import { deadlineDayOf, extendedExpiry, todayLocal } from "../client/src/lib/localDay";
import { useWorkspaceTimezone } from "../client/src/hooks/useWorkspaceTimezone";

const WS = 2;
const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const T = (t: any) => h.db.rowsOf(getTableName(t)) as any[];

const MACHINES = ["UTC", NY, TOKYO, "Europe/Paris", "Pacific/Apia"];
const savedTz = process.env.TZ;
afterAll(() => { process.env.TZ = savedTz; });

/** Run a block's tests on a machine in `tz`, with the control that the move took. */
function onMachine(tz: string) {
  beforeAll(() => { process.env.TZ = tz; });
  it(`control: the machine really is on ${tz}`, () => {
    const at = new Date("2026-11-03T12:00:00Z");
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(tz);
    expect(at.getTimezoneOffset() + tzOffsetMs(tz, at.getTime()) / 60_000).toBe(0);
  });
}

/* ── Reading a deadline back ─────────────────────────────────────────────── */

describe.each(MACHINES)("on a machine in %s", (machine) => {
  onMachine(machine);

  describe("a stored deadline reads back on the day that was picked", () => {
    it.each([
      // workspace zone, the day picked. The days after both clock changes, the days of them, a month and a year end.
      [NY, "2026-11-14"], [NY, "2026-10-31"], [NY, "2026-11-01"], [NY, "2026-11-02"], [NY, "2027-03-13"], [NY, "2027-03-14"], [NY, "2027-03-15"],
      [TOKYO, "2026-11-14"], ["UTC", "2026-11-14"], ["UTC", "2026-12-31"], ["Europe/Paris", "2027-03-28"], ["Europe/Paris", "2027-03-29"],
      ["America/Havana", "2027-03-13"], ["America/Havana", "2027-03-14"], ["America/Santiago", "2026-09-05"], ["Australia/Sydney", "2026-10-04"], ["Pacific/Apia", "2027-01-01"],
    ])("%s, %s", (tz, day) => {
      expect(deadlineDayOf(deadlineFrom(day, tz), tz)).toBe(day);
    });

    it("saving the form again and again leaves it where it was", () => {
      let stored = deadlineFrom("2026-11-14", NY)!;
      const first = stored.getTime();
      for (let save = 0; save < 5; save++) stored = deadlineFrom(deadlineDayOf(stored, NY), NY)!;
      expect(stored.getTime()).toBe(first);
    });

    it("takes the row's own shapes, and has nothing to say about nothing", () => {
      const end = "2026-11-15T04:59:59.999Z"; // the end of the 14th in New York, in winter
      expect(deadlineDayOf(end, NY)).toBe("2026-11-14");
      expect(deadlineDayOf(new Date(end), NY)).toBe("2026-11-14");
      expect(deadlineDayOf(Date.parse(end), NY)).toBe("2026-11-14");
      expect(deadlineDayOf(end, TOKYO)).toBe("2026-11-15");
      for (const empty of [null, undefined, "", "not a date"]) expect(deadlineDayOf(empty, NY)).toBe("");
    });
  });

  describe("an extension's default is seven calendar days", () => {
    const WEEK_BEFORE = Date.parse("2026-10-01T15:00:00Z");

    it.each([
      // zone, picked expiry, default. Across the autumn change, the spring change, a month and a year.
      [NY, "2026-10-28", "2026-11-04"], [NY, "2026-11-01", "2026-11-08"], [NY, "2027-03-10", "2027-03-17"], [NY, "2027-03-14", "2027-03-21"],
      ["Europe/Paris", "2027-03-25", "2027-04-01"], [TOKYO, "2026-12-28", "2027-01-04"], ["UTC", "2026-11-14", "2026-11-21"], ["America/Havana", "2027-03-13", "2027-03-20"],
    ])("%s: a week past %s is %s", (tz, picked, want) => {
      expect(extendedExpiry(deadlineFrom(picked, tz), tz, WEEK_BEFORE)).toBe(want);
    });

    it("an expiry already gone counts from today in the workspace's zone", () => {
      const gone = new Date("2026-10-01T00:00:00Z");
      expect(extendedExpiry(gone, NY, Date.parse("2026-11-03T00:30:00Z"))).toBe("2026-11-09"); // 7:30pm on the 2nd
      expect(extendedExpiry(gone, TOKYO, Date.parse("2026-11-03T20:30:00Z"))).toBe("2026-11-11"); // 5:30am on the 4th
      expect(extendedExpiry(gone, "UTC", Date.parse("2026-11-03T00:30:00Z"))).toBe("2026-11-10");
    });

    it("no expiry counts from today, and the clock defaults to now", () => {
      expect(extendedExpiry(null, NY, Date.parse("2026-11-03T00:30:00Z"))).toBe("2026-11-09");
      expect(extendedExpiry(undefined, NY, Date.parse("2026-11-03T00:30:00Z"))).toBe("2026-11-09");
      // An expiry that cannot be read is no expiry, not a crash in the approve button.
      expect(extendedExpiry("not a date", NY, Date.parse("2026-11-03T00:30:00Z"))).toBe("2026-11-09");
      expect(extendedExpiry(new Date(NaN), NY, Date.parse("2026-11-03T00:30:00Z"))).toBe("2026-11-09");
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-03T00:30:00Z"));
      try {
        expect(extendedExpiry(null, NY)).toBe("2026-11-09");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("a downloaded file is named for the viewer's own day", () => {
  const AT = new Date("2026-11-03T00:30:00Z");
  afterAll(() => { process.env.TZ = savedTz; });

  describe("in New York", () => {
    onMachine(NY);
    it("7:30pm on the 2nd is the 2nd", () => expect(todayLocal(AT)).toBe("2026-11-02"));
  });
  describe("in Tokyo", () => {
    onMachine(TOKYO);
    it("9:30am on the 3rd is the 3rd", () => expect(todayLocal(AT)).toBe("2026-11-03"));
  });
  describe("in UTC", () => {
    onMachine("UTC");
    it("and the clock defaults to now", () => {
      vi.useFakeTimers();
      vi.setSystemTime(AT);
      try {
        expect(todayLocal()).toBe("2026-11-03");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

/* ── The zone the browser uses ───────────────────────────────────────────── */

describe("useWorkspaceTimezone reads the zone as the server does", () => {
  beforeAll(() => { process.env.TZ = TOKYO; });
  const zone = (query: Record<string, unknown>) => {
    h.settings = query;
    let out!: ReturnType<typeof useWorkspaceTimezone>;
    const Probe = () => { out = useWorkspaceTimezone(); return null; };
    renderToStaticMarkup(createElement(Probe));
    return out;
  };

  it("the saved zone, not the viewer's", () => {
    expect(zone({ data: { timezone: NY }, isLoading: false })).toEqual({ timezone: NY, isLoading: false });
  });
  it("UTC when what is saved is not a real zone, as getWorkspaceTimezone does", () => {
    expect(zone({ data: { timezone: "Mars/Olympus" }, isLoading: false }).timezone).toBe("UTC");
    expect(zone({ data: { timezone: null }, isLoading: false }).timezone).toBe("UTC");
  });
  it("the viewer's zone stands in until settings answer, and says it is waiting", () => {
    expect(zone({ data: undefined, isLoading: true })).toEqual({ timezone: TOKYO, isLoading: true });
  });
  it("the viewer's zone stands in if settings fail, and does not wait forever", () => {
    expect(zone({ data: undefined, isLoading: false, isError: true })).toEqual({ timezone: TOKYO, isLoading: false });
  });
});

/* ── Sequence analytics ──────────────────────────────────────────────────── */

const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

function freshDb(timezone: string) {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  _clearWorkspaceTimezoneCache();
  T(workspaceSettings).push({ id: 1, workspaceId: WS, timezone });
}

describe("sequence analytics filter on the workspace's days", () => {
  beforeAll(() => { process.env.TZ = "UTC"; });
  afterEach(() => { _clearWorkspaceTimezoneCache(); });

  /** One draft per instant; each carries its own power of two, so the total says exactly which were counted. */
  function seed(timezone: string, instants: string[]) {
    freshDb(timezone);
    T(sequences).push({ id: 1, workspaceId: WS, name: "One", status: "active" });
    instants.forEach((at, i) => T(emailDrafts).push({ id: i + 1, workspaceId: WS, sequenceId: 1, status: "sent", openCount: 2 ** i, clickCount: 0, bouncedAt: null, sentAt: new Date(at) }));
  }
  const counted = async (instants: string[], range: { dateFrom?: string; dateTo?: string }) => {
    const [row] = await sequencePerformance(WS, { sequenceId: 1, ...range });
    return instants.filter((_, i) => row.totalOpens & (2 ** i));
  };

  it.each([
    // zone, day, the instant before it, its first, its last, the instant after it.
    // The day after the autumn change, then after the spring change; each change's own 25- and 23-hour day.
    [NY, "2026-11-02", "2026-11-02T04:59:59.999Z", "2026-11-02T05:00:00.000Z", "2026-11-03T04:59:59.999Z", "2026-11-03T05:00:00.000Z"],
    [NY, "2027-03-15", "2027-03-15T03:59:59.999Z", "2027-03-15T04:00:00.000Z", "2027-03-16T03:59:59.999Z", "2027-03-16T04:00:00.000Z"],
    [NY, "2026-11-01", "2026-11-01T03:59:59.999Z", "2026-11-01T04:00:00.000Z", "2026-11-02T04:59:59.999Z", "2026-11-02T05:00:00.000Z"],
    [NY, "2027-03-14", "2027-03-14T04:59:59.999Z", "2027-03-14T05:00:00.000Z", "2027-03-15T03:59:59.999Z", "2027-03-15T04:00:00.000Z"],
    [TOKYO, "2026-11-03", "2026-11-02T14:59:59.999Z", "2026-11-02T15:00:00.000Z", "2026-11-03T14:59:59.999Z", "2026-11-03T15:00:00.000Z"],
    ["UTC", "2026-11-03", "2026-11-02T23:59:59.999Z", "2026-11-03T00:00:00.000Z", "2026-11-03T23:59:59.999Z", "2026-11-04T00:00:00.000Z"],
  ])("%s, %s: exactly that day", async (tz, day, before, first, last, after) => {
    const instants = [before, first, last, after];
    seed(tz, instants);
    expect(await counted(instants, { dateFrom: day, dateTo: day })).toEqual([first, last]);
  });

  it("the evening a New York team sent on counts for that day, and not the day after", async () => {
    const evening = ["2026-11-03T01:00:00Z", "2026-11-03T17:00:00Z", "2026-11-04T01:00:00Z"]; // 8pm on the 2nd, noon and 8pm on the 3rd
    seed(NY, evening);
    expect(await counted(evening, { dateFrom: "2026-11-03", dateTo: "2026-11-03" })).toEqual(evening.slice(1));
    expect(await counted(evening, { dateFrom: "2026-11-02", dateTo: "2026-11-02" })).toEqual(evening.slice(0, 1));
  });

  it("either end may be missing", async () => {
    const instants = ["2026-11-03T04:59:59.999Z", "2026-11-03T05:00:00.000Z"]; // the last of the 2nd and the first of the 3rd
    seed(NY, instants);
    expect(await counted(instants, { dateFrom: "2026-11-03" })).toEqual([instants[1]]);
    expect(await counted(instants, { dateTo: "2026-11-02" })).toEqual([instants[0]]);
    expect(await counted(instants, {})).toEqual(instants);
  });

  it("through the router, as the Performance panel asks", async () => {
    const evening = ["2026-11-03T01:00:00Z", "2026-11-04T01:00:00Z"];
    seed(NY, evening);
    const [row] = await caller().sequences.getPerformanceAnalytics({ sequenceId: 1, dateFrom: "2026-11-03", dateTo: "2026-11-03" });
    expect(row.totalOpens).toBe(2);
  });

  it("no range asks for no zone, so the analytics page keeps its reads", async () => {
    seed(NY, ["2026-11-03T01:00:00Z"]);
    const real = h.db.select;
    h.selects = [];
    h.db.select = (p?: Record<string, unknown>) => {
      const b = real(p);
      const { from } = b;
      b.from = (t: any) => { h.selects.push(getTableName(t)); return from(t); };
      return b;
    };
    await sequencePerformance(WS, {});
    expect(h.selects).not.toContain("workspace_settings");
    await sequencePerformance(WS, { dateFrom: "2026-11-03" });
    expect(h.selects).toContain("workspace_settings");
  });
});

/* ── Login history ───────────────────────────────────────────────────────── */

describe("login history filters on the workspace's days", () => {
  beforeAll(() => { process.env.TZ = TOKYO; }); // the server's zone must not matter
  afterAll(() => { process.env.TZ = savedTz; });
  afterEach(() => { _clearWorkspaceTimezoneCache(); });

  /** The bounds of the history query, paired with their comparison. */
  async function bounds(timezone: string, range: { from?: string; to?: string }) {
    freshDb(timezone);
    h.db.rowsOf("workspace_members").push({ id: 5, userId: 7, workspaceId: WS, role: "rep", deactivatedAt: null, inviteToken: null });
    const realSelect = h.db.select;
    let where: any;
    h.db.select = (p?: Record<string, unknown>) => {
      const b = realSelect(p);
      const { from } = b;
      b.from = (t: any) => {
        const chain = from(t);
        if (getTableName(t) === "login_history") {
          const realWhere = chain.where;
          chain.where = (w: any) => { where = w; return realWhere.call(chain, w); };
        }
        return chain;
      };
      return b;
    };
    await caller().team.getLoginHistoryFiltered({ memberId: 5, ...range });
    const q = new MySqlDialect().sqlToQuery(where);
    // A timestamp column binds as UTC digits with no zone on them.
    const dates = q.params.filter((p): p is string => typeof p === "string" && /^\d{4}-\d{2}-\d{2} /.test(p));
    const ops = [...q.sql.matchAll(/`createdAt` (>=|<=) \?/g)].map((m) => m[1]!);
    expect(ops).toHaveLength(dates.length);
    return Object.fromEntries(ops.map((op, i) => [op, new Date(`${dates[i]!.replace(" ", "T")}Z`).toISOString()]));
  }

  it.each([
    [NY, "2026-11-02", "2026-11-02T05:00:00.000Z", "2026-11-03T04:59:59.999Z"],
    [NY, "2027-03-15", "2027-03-15T04:00:00.000Z", "2027-03-16T03:59:59.999Z"],
    [TOKYO, "2026-11-03", "2026-11-02T15:00:00.000Z", "2026-11-03T14:59:59.999Z"],
    ["UTC", "2026-11-03", "2026-11-03T00:00:00.000Z", "2026-11-03T23:59:59.999Z"],
  ])("%s, %s runs from its first instant to its last", async (tz, day, first, last) => {
    expect(await bounds(tz, { from: day, to: day })).toEqual({ ">=": first, "<=": last });
  });

  it("either end may be missing, and no range is no bound", async () => {
    expect(await bounds(NY, { from: "2026-11-02" })).toEqual({ ">=": "2026-11-02T05:00:00.000Z" });
    expect(await bounds(NY, { to: "2026-11-02" })).toEqual({ "<=": "2026-11-03T04:59:59.999Z" });
    expect(await bounds(NY, {})).toEqual({});
  });
});

/* ── The screens ─────────────────────────────────────────────────────────── */

describe("the screens use the workspace's days", () => {
  const proposals = () => read("client/src/pages/usip/Proposals.tsx");
  const detail = () => read("client/src/pages/usip/ProposalDetail.tsx");
  /** The JSX element that carries this aria-label: from its tag to its closing `/>`. */
  const input = (src: string, label: string) => {
    const at = src.indexOf(`aria-label="${label}"`);
    expect(at, `no input labelled ${label}`).toBeGreaterThan(-1);
    const end = src.indexOf("/>", at);
    expect(end).toBeGreaterThan(at);
    return src.slice(at, end);
  };

  it("both expiry pickers on the list start at today in the workspace's zone", () => {
    const src = proposals();
    expect(src).toContain("const { timezone, isLoading: zoneLoading } = useWorkspaceTimezone();");
    expect(src).toContain("const today = zonedDayKey(timezone, Date.now());");
    expect(input(src, "Expiry Date")).toContain("min={today}");
    expect(input(src, "New Expiry Date")).toContain("min={today}");
  });

  it("the picker on the detail page does too", () => {
    const src = detail();
    expect(input(src, "New Expiry Date")).toContain("min={zonedDayKey(timezone, Date.now())}");
  });

  it("Edit fills the deadlines in when pressed, and waits for the zone", () => {
    const src = detail();
    const at = src.indexOf("<Edit2 ");
    expect(at).toBeGreaterThan(-1);
    const button = src.slice(src.lastIndexOf("<Button", at), at);
    expect(button).toContain("disabled={zoneLoading}");
    expect(button).toContain("rfpDeadline: deadlineDayOf(proposal.rfpDeadline, timezone)");
    expect(button).toContain("expiresAt: deadlineDayOf(proposal.expiresAt, timezone)");
    expect(button).toContain("setEditing(true)");
    // Before that they are blank, not read in a zone that may not be the workspace's yet.
    const init = src.slice(src.indexOf("const [form, setForm] = useState({"), src.indexOf("const updateMutation = trpc.proposals.update"));
    expect(init).toContain('rfpDeadline: "",');
    expect(init).toContain('expiresAt: "",');
  });

  it("the dates shown beside those pickers are the same days", () => {
    expect(proposals()).toContain("Expires {new Date((p as any).expiresAt).toLocaleDateString(undefined, { timeZone: timezone })}");
    const src = detail();
    expect(src).toContain("new Date(proposal.rfpDeadline).toLocaleDateString(undefined, { timeZone: timezone })");
    expect(src).toContain("{expDate.toLocaleDateString(undefined, { timeZone: timezone })}");
  });

  it("extension defaults are counted in the workspace's zone, and Approve all waits for it", () => {
    const src = proposals();
    expect(src.match(/extendedExpiry\(req\.expiresAt, timezone\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/extendedExpiry\(req\.expiresAt\)/);
    expect(src).toContain("disabled={approveAllExtMutation.isPending || zoneLoading}");
  });

  it("the login history sends the days it was given", () => {
    const src = read("client/src/pages/usip/Team.tsx");
    expect(src).toContain("from: historyFrom || undefined,");
    expect(src).toContain("to: historyTo || undefined,");
    expect(read("server/routers/admin.ts")).toContain("dayRangeBounds(input.from, input.to, await getWorkspaceTimezone(ctx.workspace.id))");
  });

  it("nothing in the client takes today from a UTC slice any more", () => {
    for (const file of ["pages/usip/Proposals.tsx", "pages/usip/Audit.tsx", "pages/usip/Settings.tsx"]) {
      expect(read(`client/src/${file}`), file).not.toContain("new Date().toISOString()");
    }
    expect(read("client/src/pages/usip/Audit.tsx")).toContain("a.download = `audit-log-${todayLocal()}.csv`;");
    expect(read("client/src/pages/usip/Settings.tsx")).toContain("a.download = `workspace-export-${todayLocal()}.json`;");
  });

  it("the viewer-zone read of a stored deadline is gone", () => {
    expect(existsSync(join(root, "client/src/lib/localDay.ts"))).toBe(true);
    expect(read("client/src/lib/localDay.ts")).not.toContain("localDayOf");
    expect(proposals()).not.toContain("localDayOf");
    expect(detail()).not.toContain("localDayOf");
  });
});
