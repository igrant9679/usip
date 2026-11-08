/**
 * What's Working: date and campaign filters, and a spreadsheet-safe CSV
 * (audit 2026-10-20, F20).
 *
 * The server takes the filters (a campaign; a range of the workspace's own
 * days) and every measure reads its own clock; the page passes them; the CSV
 * neutralises formula cells as the suppression and board exports do. Dates
 * in these tests are fixed, offsets derived from the zone, never frozen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "8".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { dayRangeInZone } from "./routers/are/metrics";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import { wallTimeToUtcMs } from "@shared/availability";
import { performanceCsv, presetRange } from "../client/src/pages/usip/arePerformanceModel";

const WS = 2, OTHER = 9;
const NY = "America/New_York";
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const block = (src: string, from: string, to: string) => {
  const a = src.indexOf(from);
  expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1);
  const b = src.indexOf(to, a + from.length);
  expect(b, `end anchor not found: ${to}`).toBeGreaterThan(a);
  return src.slice(a, b);
};
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
/** Noon on a New York calendar day, as a Date. */
const nyNoon = (y: number, m: number, d: number) => new Date(wallTimeToUtcMs(NY, y, m, d, 12 * 60));

describe("the range is the workspace's own days, both ends included", () => {
  it("from the start of the first day to the start of the day after the last, across a clock change", () => {
    const r = dayRangeInZone(NY, "2026-10-31", "2026-11-01");
    expect(r.since!.getTime()).toBe(wallTimeToUtcMs(NY, 2026, 10, 31, 0));
    expect(r.until!.getTime()).toBe(wallTimeToUtcMs(NY, 2026, 11, 2, 0));
    // 2026-11-01 is 25 hours long in New York: the window is 49 hours, not 48.
    expect(r.until!.getTime() - r.since!.getTime()).toBe(49 * 3600_000);
  });

  it("either end may be open; a start after the end is refused", () => {
    expect(dayRangeInZone(NY, "2026-10-01")).toEqual({ since: new Date(wallTimeToUtcMs(NY, 2026, 10, 1, 0)), until: undefined });
    expect(() => dayRangeInZone(NY, "2026-10-05", "2026-10-01")).toThrow(/after the end/);
  });

  it("the page's presets are calendar days ending today, in the workspace's zone", () => {
    // 01:30 UTC on 2 Nov is still 1 Nov in New York.
    const now = Date.UTC(2026, 10, 2, 1, 30);
    expect(presetRange("7", NY, now)).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(presetRange("30", "UTC", now)).toEqual({ from: "2026-10-04", to: "2026-11-02" });
    expect(presetRange("all", NY, now)).toEqual({});
    expect(presetRange("custom", NY, now)).toEqual({});
  });
});

describe("the server filters the engine's steps by campaign and by date", () => {
  beforeEach(() => {
    _clearWorkspaceTimezoneCache();
    h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
    rows("workspace_settings").push({ workspaceId: WS, timezone: NY });
    rows("are_campaigns").push({ id: 10, workspaceId: WS, name: "Counties" }, { id: 11, workspaceId: WS, name: "Cities" });
    const send = (id: number, o: Record<string, unknown>) => rows("are_execution_queue").push({ id, workspaceId: WS, campaignId: 10, prospectQueueId: id, stepIndex: 0, status: "sent", openedAt: null, trackingToken: null, ...o });
    send(1, { executedAt: nyNoon(2026, 10, 5) });
    send(2, { executedAt: nyNoon(2026, 10, 20) });
    send(3, { executedAt: nyNoon(2026, 10, 20), campaignId: 11 });
    send(4, { executedAt: nyNoon(2026, 11, 3) });
    rows("are_execution_queue").push({ id: 5, workspaceId: OTHER, campaignId: 10, prospectQueueId: 5, stepIndex: 0, status: "sent", executedAt: nyNoon(2026, 10, 20) });
    rows("are_signal_log").push(
      { id: 1, workspaceId: WS, campaignId: 10, prospectQueueId: 2, signalType: "email_reply", processedAt: nyNoon(2026, 10, 21) },
      { id: 2, workspaceId: WS, campaignId: 10, prospectQueueId: 1, signalType: "email_reply", processedAt: nyNoon(2026, 11, 4) },
    );
  });
  const sent = (r: Array<{ campaignId: number; sent: number; replies: number }>) => r.map((x) => `${x.campaignId}:${x.sent}:${x.replies}`);

  it("no filter: everything, as before", async () => {
    expect(sent(await caller().are.metrics.areSteps())).toEqual(["10:3:2", "11:1:0"]);
  });

  it("October in New York, one campaign: its sends then, and the replies that arrived then", async () => {
    expect(sent(await caller().are.metrics.areSteps({ from: "2026-10-01", to: "2026-10-31" }))).toEqual(["10:2:1", "11:1:0"]);
    expect(sent(await caller().are.metrics.areSteps({ campaignId: 11 }))).toEqual(["11:1:0"]);
    expect(sent(await caller().are.metrics.areSteps({ campaignId: 10, from: "2026-10-15", to: "2026-10-31" }))).toEqual(["10:1:1"]);
    expect(await caller().are.metrics.areSteps({ from: "2026-12-01" })).toEqual([]);
  });

  it("every measure reads the scope on its own clock", () => {
    const pm = read("server/services/performanceMetrics.ts");
    const yieldFn = block(pm, "export async function getSourceYieldStats(workspaceId: number, scope: MetricsScope = {})", "/* ─── Inbound reply mix");
    expect(yieldFn).toContain("...within(prospectQueue.createdAt, scope)");
    expect(yieldFn).toContain("...within(areExecutionQueue.executedAt, scope)");
    expect(yieldFn).toContain("...within(areSignalLog.processedAt, scope)");
    expect(yieldFn).toContain("...inCampaign(areSignalLog.campaignId)");
    const repliers = block(pm, "async function areRepliers(", "/* ─── Revenue Engine step performance");
    expect(repliers).toContain("...within(areSignalLog.processedAt, scope)");
    expect(repliers).toContain("...within(areExecutionQueue.executedAt, scope)");
    const seq = block(pm, "export async function getSequenceStepStats(", "/* ─── Sourcing yield by source");
    expect(seq.match(/\.\.\.within\(emailDrafts\.sentAt, opts\)/g)?.length).toBe(2);
    const router = read("server/routers/are/metrics.ts");
    for (const proc of ["areSteps", "sourceYield", "replyMix"]) {
      expect(block(router, `  ${proc}: workspaceProcedure`, "),")).toContain(".input(scopeInput)");
    }
  });
});

describe("the CSV is spreadsheet-safe", () => {
  it("a formula-looking campaign name, source or label is text; numbers stay numbers", () => {
    const csv = performanceCsv({
      scopeLabel: "All campaigns · all time",
      areSteps: [{ campaignName: '=HYPERLINK("https://evil.example","Open")', campaignId: 1, stepIndex: 0, sent: 12, opens: 3, opensTracked: true, openRate: 25, replies: 2, replyRate: 16.7, meetings: 1, meetingRate: 8.3 }],
      sources: [{ sourceType: "+cmd", discovered: 5, avgIcpScore: 61, contacted: 4, replied: 1, replyRate: 25, meetings: 0, meetingRate: 0 }],
      replies: [{ replyClass: "@SUM(A1)", count: 1, share: 100 }],
      sequenceSteps: [{ sequenceId: 9, stepIndex: 1, sent: 3, opens: 0, openRate: 0, replies: 0, replyRate: 0, positiveReplies: 0, meetings: 0, meetingRate: 0 }],
    });
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"",""Open"")",1,12,3,25,2,16.7,1,8.3`);
    expect(csv).toContain("'+cmd,5,61,4,1,25,0,0");
    expect(csv).toContain("'@SUM(A1),1,100");
    expect(csv).toContain("9,2,3,0,0,0,0,0,0,0");
    expect(csv.split("\r\n")[0]).toBe("What's Working,All campaigns · all time");
    expect(csv).not.toMatch(/(^|,)=/m);
  });
});

describe("the page passes the filters and exports", () => {
  const page = read("client/src/pages/usip/AREPerformance.tsx");

  it("campaign and dates go to the server; the CRM table takes the dates only", () => {
    expect(page).toContain("const scope = { ...range, ...(campaignId ? { campaignId } : {}) };");
    expect(page).toContain("trpc.are.metrics.areSteps.useQuery(scope,");
    expect(page).toContain("trpc.are.metrics.sourceYield.useQuery(scope,");
    expect(page).toContain("trpc.are.metrics.replyMix.useQuery(scope,");
    expect(page).toContain("trpc.are.metrics.sequenceSteps.useQuery(range,");
    expect(page).toContain('<select id="perf-campaign"');
    expect(page).toContain('<select id="perf-range"');
    expect(page).toContain('<Input id="perf-from" type="date"');
  });

  it("Export CSV writes the four tables through performanceCsv", () => {
    const exp = block(page, "const exportCsv = () => {", "\n  };");
    expect(exp).toContain("performanceCsv({");
    expect(exp).toContain("areSteps: areStepRows, sources: sourceRows, replies: replyRows, sequenceSteps: stepRows,");
    expect(page).toContain("onClick={exportCsv}");
    expect(read("client/src/pages/usip/arePerformanceModel.ts")).toContain('import { csvCell } from "@shared/csvCell";');
  });
});
