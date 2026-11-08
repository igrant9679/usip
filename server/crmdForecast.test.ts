/**
 * A forecast a team can run a forecast call on (audit 2026-10-20, F29, R41).
 *
 *   - a fiscal calendar: the workspace sets the month its fiscal year starts
 *     (January by default — calendar quarters, as before), and the forecast,
 *     quota periods and "this quarter" figures count in the quarters it makes;
 *   - forecast categories for one period: Closed (won in it), Commit, Best
 *     case, Pipeline and Omitted (open deals expected to close in it, by the
 *     category set or the win % rule), with overdue deals counted now and
 *     undated ones apart; computed from the deal metrics module;
 *   - a manager may override a rep's call; every change is recorded with who,
 *     when, from what and whether it was an override; a rep may set only their
 *     own deal's;
 *   - quota pacing: closed and Commit against the target and the time gone,
 *     through quota.teamSummary (the team, managers only) and quota.myPacing;
 *   - the workspace currency is a setting, and every amount on screen shows in
 *     it; the server never sets the display default.
 *
 * Run against the SQL-evaluating fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "9".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import { _clearRevenueSettingsCache } from "./services/workspaceRevenue";
import { currentRanges, quotaPacing, quotaPeriodRange } from "./services/dealMetrics";
import { buildForecastCall, effectiveCategory, forecastPeriod, targetForPeriod } from "./services/forecastCall";
import { quotaPeriodKey } from "./routers/quota";
import { formatAmount, setDisplayCurrency } from "@shared/money";

const WS = 2, ADMIN = 1, REP = 3, MANAGER = 4, REP2 = 5;
const DAY = 86_400_000;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = (userId: number) => appRouter.createCaller({
  user: { id: userId, openId: `u${userId}`, email: `u${userId}@example.com`, name: `U${userId}`, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), mfaTotpEnabledAt: null },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const member = (id: number, userId: number, role: string) => ({ id, workspaceId: WS, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
/** A calendar date as the app stores one: noon UTC on that day. */
const cal = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
const deal = (id: number, o: Record<string, unknown>) => rows("opportunities").push({
  id, workspaceId: WS, accountId: 1, name: `Deal ${id}`, stage: "negotiation", value: "1000", winProb: 20, closeDate: null,
  pipelineId: 1, stageEnteredAt: new Date(), wonAt: null, lostAt: null, forecastCategory: null, ownerUserId: REP, createdAt: new Date(), updatedAt: new Date(), ...o,
});
const fyStartIs = (m: number) => {
  rows("workspace_settings").splice(0);
  rows("workspace_settings").push({ workspaceId: WS, timezone: "UTC", fiscalYearStartMonth: m, currency: "USD" });
  _clearRevenueSettingsCache();
};

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  invalidateStageIndex();
  _clearWorkspaceTimezoneCache();
  _clearRevenueSettingsCache();
  setDisplayCurrency("USD");
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ADMIN, archivedAt: null, plan: "trial" });
  rows("users").push({ id: ADMIN, name: "Admin" }, { id: REP, name: "Rep" }, { id: MANAGER, name: "Manager" }, { id: REP2, name: "Rep Two" });
  rows("workspace_members").push(member(1, ADMIN, "admin"), member(2, REP, "rep"), member(3, MANAGER, "manager"), member(4, REP2, "rep"));
  rows("crm_pipelines").push({ id: 1, workspaceId: WS, name: "Default", isDefault: true, sortOrder: 0 });
  rows("crm_pipeline_stages").push(
    { id: 11, workspaceId: WS, pipelineId: 1, key: "negotiation", label: "Negotiation", sortOrder: 10, defaultWinProb: 50, isWon: false, isLost: false },
    { id: 15, workspaceId: WS, pipelineId: 1, key: "won", label: "Won", sortOrder: 50, defaultWinProb: 100, isWon: true, isLost: false },
    { id: 16, workspaceId: WS, pipelineId: 1, key: "lost", label: "Lost", sortOrder: 60, defaultWinProb: 0, isWon: false, isLost: true },
  );
  rows("accounts").push({ id: 1, workspaceId: WS, name: "Acme" });
});

describe("F29/R41: the fiscal calendar", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  it("January is calendar quarters, as before", () => {
    const r = currentRanges("UTC", now);
    expect([r.quarter.start.toISOString(), r.quarter.end.toISOString(), r.quarterLabel, r.quarterKey]).toEqual(["2026-10-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", "Q4 2026 (Oct–Dec)", "2026-Q4"]);
    expect(r.year.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(quotaPeriodKey("2026-11", "quarterly")).toBe("2026-Q4");
    expect(quotaPeriodKey("2026-11", "annual")).toBe("2026-FY");
  });

  it("a July start: November is Q2 of FY2027, July–June", () => {
    const r = currentRanges("UTC", now, 7);
    expect([r.quarter.start.toISOString(), r.quarter.end.toISOString(), r.quarterKey]).toEqual(["2026-10-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", "2027-Q2"]);
    expect(r.quarterLabel).toBe("Q2 FY2027 (Oct 2026–Dec 2026)");
    expect([r.year.start.toISOString(), r.year.end.toISOString(), r.yearKey]).toEqual(["2026-07-01T00:00:00.000Z", "2027-07-01T00:00:00.000Z", "2027-FY"]);
    expect(quotaPeriodKey("2026-11", "quarterly", 7)).toBe("2027-Q2");
    expect(quotaPeriodKey("2026-11", "annual", 7)).toBe("2027-FY");
    const q1 = quotaPeriodRange("UTC", "2027-Q1", "quarterly", 7);
    expect([q1.start.toISOString(), q1.end.toISOString()]).toEqual(["2026-07-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
  });

  it("a February start moves the quarter boundaries off the calendar's", () => {
    const r = currentRanges("UTC", now, 2);
    expect([r.quarter.start.toISOString(), r.quarter.end.toISOString(), r.quarterKey]).toEqual(["2026-11-01T00:00:00.000Z", "2027-02-01T00:00:00.000Z", "2027-Q4"]);
    expect(r.nextQuarter.start.toISOString()).toBe("2027-02-01T00:00:00.000Z");
  });

  it("an admin sets the start month and currency; anyone reads them; a bad currency or a rep is refused", async () => {
    expect(await caller(REP).settings.revenue()).toMatchObject({ fiscalYearStartMonth: 1, currency: "USD", timezone: "UTC" });
    rows("workspace_settings").push({ workspaceId: WS, timezone: "UTC", fiscalYearStartMonth: 1, currency: "USD" });
    await caller(ADMIN).settings.save({ fiscalYearStartMonth: 7, currency: "EUR" });
    expect(await caller(REP).settings.revenue()).toMatchObject({ fiscalYearStartMonth: 7, currency: "EUR" });
    await expect(caller(ADMIN).settings.save({ currency: "XYZ" })).rejects.toThrow();
    await expect(caller(ADMIN).settings.save({ fiscalYearStartMonth: 13 })).rejects.toThrow();
    await expect(caller(REP).settings.save({ fiscalYearStartMonth: 2 })).rejects.toThrow();
    expect(read("server/_core/rawMigrations.ts")).toContain("ALTER TABLE `workspace_settings` ADD COLUMN `fiscalYearStartMonth` int NOT NULL DEFAULT 1");
  });
});

describe("F29: the forecast call for one period", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  beforeEach(() => {
    deal(1, { value: "100", forecastCategory: "commit", closeDate: cal("2026-12-15") });
    deal(2, { value: "200", winProb: 60, closeDate: cal("2026-11-20") });
    deal(3, { value: "400", forecastCategory: "commit", closeDate: cal("2027-02-10") });
    deal(4, { value: "800" });
    deal(5, { value: "1600", stage: "won", wonAt: new Date("2026-10-15T15:00:00Z"), winProb: 100 });
    deal(6, { value: "3200", winProb: 30, closeDate: cal("2026-09-01") });
    deal(7, { value: "6400", stage: "won", wonAt: new Date("2026-08-01T15:00:00Z"), winProb: 100 });
    deal(8, { value: "12800", stage: "lost", lostAt: new Date("2026-10-20T15:00:00Z"), winProb: 0, closeDate: cal("2026-11-01") });
    deal(9, { value: "25600", forecastCategory: "omitted", closeDate: cal("2026-11-30") });
  });

  it("this quarter: Closed, Commit, Best case, Pipeline, Omitted, overdue counted now, undated apart", async () => {
    const f = await buildForecastCall(h.db, { workspaceId: WS, ownerUserId: null, kind: "quarter", now });
    expect(f.period.label).toBe("Q4 2026 (Oct–Dec)");
    expect(f.totals).toMatchObject({ closed: 1600, commit: 100, bestCase: 300, pipeline: 3200, omitted: 25600, noCloseDate: 800, overdue: 3200 });
    expect(f.deals.map((d) => [d.id, d.category, d.overdue])).toEqual([
      [9, "omitted", false], [6, "pipeline", true], [5, "closed", false], [2, "best_case", false], [1, "commit", false],
    ]);
    expect(f.currency).toBe("USD");
  });

  it("next quarter and the year count their own deals", async () => {
    const next = await buildForecastCall(h.db, { workspaceId: WS, ownerUserId: null, kind: "next_quarter", now });
    expect(next.totals).toMatchObject({ closed: 0, commit: 400, overdue: 0 });
    expect(next.deals.map((d) => d.id)).toEqual([3]);
    const year = await buildForecastCall(h.db, { workspaceId: WS, ownerUserId: null, kind: "year", now });
    expect(year.totals.closed).toBe(8000);
  });

  it("a fiscal year starting in February moves deals between quarters", async () => {
    fyStartIs(2);
    const f = await buildForecastCall(h.db, { workspaceId: WS, ownerUserId: null, kind: "quarter", now });
    expect(f.period.label).toBe("Q4 FY2027 (Nov 2026–Jan 2027)");
    // The October win is last quarter now; the February deal is next quarter's.
    expect(f.totals.closed).toBe(0);
    expect(f.deals.map((d) => d.id).sort((a, b) => a - b)).toEqual([1, 2, 6, 9]);
  });

  it("a rep's call is their own deals; a manager sees the team or one rep", async () => {
    deal(20, { ownerUserId: REP2, value: "50", forecastCategory: "commit", closeDate: cal(new Date(Date.now() + DAY).toISOString().slice(0, 10)) });
    const mine = await caller(REP2).opportunities.forecastCall({ period: "quarter" });
    expect(mine.seesTeam).toBe(false);
    expect(mine.deals.map((d) => d.id)).toEqual([20]);
    expect((await caller(MANAGER).opportunities.forecastCall({ period: "quarter" })).reps.map((r) => r.ownerUserId).sort()).toEqual([REP, REP2]);
    expect((await caller(MANAGER).opportunities.forecastCall({ period: "quarter", ownerUserId: REP2 })).deals.map((d) => d.id)).toEqual([20]);
    // A rep asking for another rep's still gets their own.
    expect((await caller(REP2).opportunities.forecastCall({ period: "quarter", ownerUserId: REP })).deals.map((d) => d.id)).toEqual([20]);
  });

  it("the old win % rule decides an unmarked deal", () => {
    expect([effectiveCategory(null, 95), effectiveCategory(null, 60), effectiveCategory(null, 10), effectiveCategory("omitted", 99)]).toEqual(["commit", "best_case", "pipeline", "omitted"]);
  });
});

describe("F29: manager overrides are recorded", () => {
  beforeEach(() => deal(1, { forecastCategory: "best_case", closeDate: cal("2026-12-15") }));
  const history = () => rows("opportunity_forecast_changes");

  it("a manager's change of a rep's deal is an override: who, when, from what, why", async () => {
    await caller(MANAGER).opportunities.setForecastCategory({ id: 1, category: "commit", note: "Signed MSA in legal" });
    expect(rows("opportunities")[0].forecastCategory).toBe("commit");
    expect(history()).toEqual([expect.objectContaining({ opportunityId: 1, fromCategory: "best_case", toCategory: "commit", changedByUserId: MANAGER, ownerUserId: REP, isOverride: true, note: "Signed MSA in legal" })]);
    expect(history()[0].createdAt).toBeInstanceOf(Date);
    const listed = await caller(REP).opportunities.forecastHistory({ opportunityId: 1 });
    expect(listed[0]).toMatchObject({ isOverride: true, changedByUserId: MANAGER });
  });

  it("the owner's own call is not an override; another rep may not change it; the generic update records too", async () => {
    await caller(REP).opportunities.setForecastCategory({ id: 1, category: "pipeline" });
    expect(history()[0]).toMatchObject({ changedByUserId: REP, isOverride: false, fromCategory: "best_case", toCategory: "pipeline" });
    await expect(caller(REP2).opportunities.setForecastCategory({ id: 1, category: "commit" })).rejects.toThrow(/owner or a manager/);
    await caller(MANAGER).opportunities.update({ id: 1, patch: { forecastCategory: null } });
    expect(history()[1]).toMatchObject({ changedByUserId: MANAGER, isOverride: true, fromCategory: "pipeline", toCategory: null });
    // The same value again writes nothing.
    await caller(REP).opportunities.setForecastCategory({ id: 1, category: null });
    expect(history()).toHaveLength(2);
  });

  it("the forecast's deal list carries the last change", async () => {
    await caller(MANAGER).opportunities.setForecastCategory({ id: 1, category: "commit" });
    const f = await buildForecastCall(h.db, { workspaceId: WS, ownerUserId: null, kind: "quarter", now: new Date("2026-11-07T12:00:00Z") });
    expect(f.deals[0].lastChange).toMatchObject({ by: MANAGER, from: "best_case", to: "commit", isOverride: true });
  });
});

describe("F29: quota pacing and the team summary", () => {
  it("ahead, on track with Commit, behind, attained, against the time gone", () => {
    const range = { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2027-01-01T00:00:00Z") };
    const mid = new Date(range.start.getTime() + (range.end.getTime() - range.start.getTime()) / 2);
    expect(quotaPacing({ target: 100, closed: 60, commit: 0, range, now: mid })).toMatchObject({ status: "ahead", elapsedPct: 50, expectedToDate: 50, attainmentPct: 60 });
    expect(quotaPacing({ target: 100, closed: 40, commit: 70, range, now: mid })).toMatchObject({ status: "on_track", projected: 110, projectedPct: 110 });
    expect(quotaPacing({ target: 100, closed: 10, commit: 20, range, now: mid }).status).toBe("behind");
    expect(quotaPacing({ target: 100, closed: 100, commit: 0, range, now: mid }).status).toBe("attained");
    expect(quotaPacing({ target: 0, closed: 5, commit: 0, range, now: mid }).status).toBe("no_target");
  });

  it("a period's target comes from the quarter's own target, else its months, else a quarter of the year", () => {
    const p = forecastPeriod("quarter", "UTC", 1, new Date("2026-11-07T12:00:00Z"));
    const t = (r: any[]) => targetForPeriod(r, REP, p);
    expect(t([{ userId: REP, period: "2026-Q4", periodType: "quarterly", revenueTarget: "900" }, { userId: REP, period: "2026-11", periodType: "monthly", revenueTarget: "1" }])).toBe(900);
    expect(t([{ userId: REP, period: "2026-10", periodType: "monthly", revenueTarget: "100" }, { userId: REP, period: "2026-12", periodType: "monthly", revenueTarget: "200" }])).toBe(300);
    expect(t([{ userId: REP, period: "2026-FY", periodType: "annual", revenueTarget: "4000" }])).toBe(1000);
    expect(t([{ userId: REP2, period: "2026-Q4", periodType: "quarterly", revenueTarget: "900" }])).toBe(0);
  });

  it("quota.teamSummary is the team's pacing, for managers only; a rep reads their own", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const qKey = currentRanges("UTC").quarterKey;
    rows("quota_targets").push(
      { id: 1, workspaceId: WS, userId: REP, period: qKey, periodType: "quarterly", revenueTarget: "1000", dealsTarget: 0, activitiesTarget: 0 },
      { id: 2, workspaceId: WS, userId: REP2, period: qKey, periodType: "quarterly", revenueTarget: "500", dealsTarget: 0, activitiesTarget: 0 },
    );
    deal(30, { ownerUserId: REP, stage: "won", wonAt: new Date(), value: "400", winProb: 100 });
    deal(31, { ownerUserId: REP, value: "300", forecastCategory: "commit", closeDate: cal(today) });
    const team = await caller(MANAGER).quota.teamSummary({ period: "quarter" });
    const rep = team.rows.find((r) => r.userId === REP)!;
    expect(rep).toMatchObject({ target: 1000, closed: 400, commit: 300, projected: 700, attainmentPct: 40, projectedPct: 70 });
    expect(team.rows.find((r) => r.userId === REP2)).toMatchObject({ target: 500, closed: 0 });
    expect(team.team).toMatchObject({ target: 1500, closed: 400 });
    await expect(caller(REP).quota.teamSummary({ period: "quarter" })).rejects.toThrow();
    const mine = await caller(REP).quota.myPacing({ period: "quarter" });
    expect(mine.rows.map((r) => r.userId)).toEqual([REP]);
  });
});

describe("F29/R41: the workspace currency, and the Forecast page", () => {
  it("the display default moves every amount that names no currency", () => {
    expect(formatAmount(1500)).toBe("$1,500");
    setDisplayCurrency("EUR");
    expect(formatAmount(1500)).toBe("€1,500");
    expect(formatAmount(1500, { currency: "USD" })).toBe("$1,500");
    setDisplayCurrency("nonsense");
    expect(formatAmount(1)).toBe("$1");
  });

  it("no server file sets the display default (one process serves every workspace)", () => {
    const files = (dir: string): string[] => readdirSync(join(root, dir)).flatMap((n) => {
      const rel = `${dir}/${n}`;
      if (statSync(join(root, rel)).isDirectory()) return files(rel);
      return /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [rel] : [];
    });
    expect(files("server").filter((f) => read(f).includes("setDisplayCurrency("))).toEqual([]);
    expect(read("client/src/App.tsx")).toContain("<WorkspaceCurrencySync><WorkspaceAccessGate>{children}</WorkspaceAccessGate></WorkspaceCurrencySync>");
    expect(read("client/src/components/usip/WorkspaceCurrencySync.tsx")).toContain("return <Fragment key={currency}>{children}</Fragment>;");
  });

  it("the Forecast page runs on forecastCall, pacing from teamSummary or myPacing, and overrides inline", () => {
    const page = read("client/src/pages/usip/Forecast.tsx");
    expect(page).toContain("trpc.opportunities.forecastCall.useQuery({ period })");
    expect(page).toContain("trpc.quota.teamSummary.useQuery({ period }, { enabled: seesTeam, retry: false })");
    expect(page).toContain("trpc.quota.myPacing.useQuery({ period }, { enabled: !!data && !seesTeam, retry: false })");
    expect(page).toContain("setCategory.mutate({ id: d.id, category: (e.target.value || null) as ForecastCategory | null })");
    expect(page).toContain("formatAmount(n, { compact: true, currency: data?.currency })");
    expect(page).toContain('{ch.isOverride ? "Override: " : ""}');
    const detail = read("client/src/pages/usip/OpportunityDetail.tsx");
    expect(detail).toContain("trpc.opportunities.forecastHistory.useQuery({ opportunityId: id }");
    expect(detail).toContain('{ch.isOverride ? "Manager override: " : ""}');
    const settings = read("client/src/pages/usip/Settings.tsx");
    expect(settings).toContain('<RevenueCalendarSection settings={settings} save={save} canEdit={canEdit} />');
    expect(settings).toContain("save({ fiscalYearStartMonth: fyStart, currency })");
  });
});
