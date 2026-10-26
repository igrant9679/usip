/**
 * Phase 2 of the 2026-10-20 audit, slice A — "revenue data you can trust" —
 * run against the real routers and services and the SQL-evaluating fake
 * (`__fakes__/sqlFakeDb`).
 *
 * The doc's gate is the first describe: one seeded workspace, and the
 * Dashboard, Pipeline (board and forecast tab), Deals, Forecast and Quota all
 * report the same open pipeline, the same weighted value and the same wins.
 * Then the pieces the gate stands on:
 *   one stage-change service for every path (R13, R20, R21, R25) ·
 *   stage dates, the backfill and days in stage (R14, R16) ·
 *   wins counted by wonAt, in the workspace's zone (R16, R17, R83) ·
 *   close dates as calendar dates (R16, R29) ·
 *   pipeline settings that carry deals with them (R18) ·
 *   forecast commentary from open deals, kept on failure (R19).
 *
 * Time is frozen at T0 — Wednesday 2026-11-18, 15:00 UTC (10:00 in New York).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  tz: "America/New_York",
  notices: [] as any[],
  fired: [] as any[],
  audits: [] as any[],
  race: null as null | ((table: string) => void),
  llm: null as null | ((input: any) => Promise<any>),
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async (x: any) => { h.audits.push(x); } }));
vi.mock("./services/workspaceTimezone", async (a) => ({
  ...(await a<typeof import("./services/workspaceTimezone")>()),
  getWorkspaceTimezone: async () => h.tz,
}));
vi.mock("./services/policyNotify", async (a) => ({
  ...(await a<typeof import("./services/policyNotify")>()),
  notifyIfEnabled: async (n: any) => { h.notices.push(n); return true; },
}));
vi.mock("./services/workflowEngine", async (a) => ({
  ...(await a<typeof import("./services/workflowEngine")>()),
  fireStageChanged: async (...args: unknown[]) => { h.fired.push(args); },
  fireRecordCreated: async () => {},
  fireRecordUpdated: async () => {},
}));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async (input: any) => h.llm!(input),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { backfillDealDates, refreshDaysInStage } from "./services/dealDates";
import { quotaPeriodRange, zonedMidnight, zonedYmd } from "./services/dealMetrics";
import { scanPipelineAlertsForWorkspace } from "./routers/pipelineAlerts";
import { calendarDateToStored, calendarMonthKey, normalizeCalendarDate, storedToCalendarDate } from "@shared/calendarDate";

const LSI = 2;
const CF = 4;
const ADMIN = 20;
const REP = 21;
const DAY = 86_400_000;
/** Wednesday 2026-11-18, 15:00 UTC. */
const T0 = new Date("2026-11-18T15:00:00Z").getTime();
const at = (iso: string) => new Date(iso);
const daysAgo = (n: number) => new Date(T0 - n * DAY);

const rows = (t: string) => h.db.rowsOf(t) as any[];
const row = (t: string, id: number) => rows(t).find((r) => r.id === id);
const opp = (id: number) => row("opportunities", id);
const historyOf = (id: number) => rows("opportunity_stage_history").filter((r) => r.opportunityId === id);

/** Default pipeline (1) with the six legacy stages; "Enterprise" (2) with its own keys. */
const STAGES = [
  { id: 11, pipelineId: 1, key: "discovery", label: "Discovery", sortOrder: 10, defaultWinProb: 20, isWon: false, isLost: false },
  { id: 12, pipelineId: 1, key: "qualified", label: "Qualified", sortOrder: 20, defaultWinProb: 35, isWon: false, isLost: false },
  { id: 13, pipelineId: 1, key: "proposal", label: "Proposal", sortOrder: 30, defaultWinProb: 50, isWon: false, isLost: false },
  { id: 14, pipelineId: 1, key: "negotiation", label: "Negotiation", sortOrder: 40, defaultWinProb: 70, isWon: false, isLost: false },
  { id: 15, pipelineId: 1, key: "won", label: "Won", sortOrder: 50, defaultWinProb: 100, isWon: true, isLost: false },
  { id: 16, pipelineId: 1, key: "lost", label: "Lost", sortOrder: 60, defaultWinProb: 0, isWon: false, isLost: true },
  { id: 21, pipelineId: 2, key: "intro", label: "Intro", sortOrder: 10, defaultWinProb: 10, isWon: false, isLost: false },
  { id: 22, pipelineId: 2, key: "pilot", label: "Pilot", sortOrder: 20, defaultWinProb: 60, isWon: false, isLost: false },
  { id: 23, pipelineId: 2, key: "signed", label: "Signed", sortOrder: 30, defaultWinProb: 100, isWon: true, isLost: false },
  { id: 24, pipelineId: 2, key: "dead", label: "Dead", sortOrder: 40, defaultWinProb: 0, isWon: false, isLost: true },
];

function deal(id: number, over: Record<string, unknown>) {
  rows("opportunities").push({
    id, workspaceId: LSI, accountId: 501, name: `Deal ${id}`, stage: "discovery", value: "0.00", winProb: 20,
    closeDate: null, daysInStage: 0, stageEnteredAt: daysAgo(10), wonAt: null, lostAt: null, aiNote: null, nextStep: null,
    lostReason: null, winReason: null, lastActivityAt: null, pipelineId: 1, campaignId: null, ownerUserId: REP,
    customFields: null, createdAt: at("2026-09-01T12:00:00Z"), updatedAt: daysAgo(3),
    ...over,
  });
}

/**
 * The gate's workspace. Open: D1 + D2 + D3 = $52,500.50, weighted $27,250.25.
 * Won: D4 this month ($7,000), D5 last month but EDITED TODAY ($12,000), D7 in
 * July with an expected close date in November ($3,000). Lost: D6 ($9,000).
 */
function seedGate() {
  deal(1, { name: "Acme expansion", stage: "discovery", value: "10000.00", winProb: 20, closeDate: at("2026-11-30T12:00:00Z") });
  // No pipelineId: it sits on the default board. Close date stored the old way, UTC midnight.
  deal(2, { name: "Beta pilot", stage: "proposal", value: "2500.50", winProb: 50, pipelineId: null, closeDate: at("2026-12-01T00:00:00Z"), ownerUserId: ADMIN });
  deal(3, { name: "Gamma enterprise", stage: "pilot", value: "40000.00", winProb: 60, pipelineId: 2, createdAt: at("2026-11-10T12:00:00Z"), accountId: 502 });
  deal(4, { name: "Delta renewal", stage: "won", value: "7000.00", winProb: 100, wonAt: at("2026-11-05T16:00:00Z"), stageEnteredAt: at("2026-11-05T16:00:00Z") });
  deal(5, { name: "Epsilon platform", stage: "signed", value: "12000.00", winProb: 100, pipelineId: 2, wonAt: at("2026-10-20T16:00:00Z"), stageEnteredAt: at("2026-10-20T16:00:00Z"), updatedAt: new Date(T0) });
  deal(6, { name: "Zeta lost", stage: "lost", value: "9000.00", winProb: 0, lostAt: at("2026-11-10T16:00:00Z"), ownerUserId: ADMIN });
  deal(7, { name: "Eta summer", stage: "won", value: "3000.00", winProb: 100, wonAt: at("2026-07-15T16:00:00Z"), closeDate: at("2026-11-20T12:00:00Z"), ownerUserId: ADMIN });
  // Another tenant's deal never counts here.
  rows("opportunities").push({ ...opp(1), id: 99, workspaceId: CF, value: "99999.00", accountId: 601 });
}

function seed() {
  rows("workspaces").push(
    { id: LSI, name: "LSI Media", slug: "lsi", ownerUserId: ADMIN, archivedAt: null, plan: "trial" },
    { id: CF, name: "CommunityForce", slug: "cf", ownerUserId: 10, archivedAt: null, plan: "trial" },
  );
  const user = (id: number, mail: string) => ({
    id, openId: `local:${id}`, name: `User ${id}`, email: mail, loginMethod: "password", role: "user",
    passwordHash: `hash-${id}`, createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(), emailSignature: null,
  });
  rows("users").push(user(ADMIN, "admin@lsi.example"), user(REP, "rep@lsi.example"));
  const member = (id: number, workspaceId: number, userId: number, role: string) => ({
    id, workspaceId, userId, role, title: null, quota: null, deactivatedAt: null, lastActiveAt: new Date(),
    inviteToken: null, inviteExpiresAt: null, createdAt: new Date(),
  });
  rows("workspace_members").push(member(1, LSI, ADMIN, "admin"), member(2, LSI, REP, "rep"));
  rows("crm_pipelines").push(
    { id: 1, workspaceId: LSI, name: "Default", isDefault: true, sortOrder: 0 },
    { id: 2, workspaceId: LSI, name: "Enterprise", isDefault: false, sortOrder: 1 },
  );
  for (const s of STAGES) rows("crm_pipeline_stages").push({ ...s, workspaceId: LSI });
  rows("accounts").push(
    { id: 501, workspaceId: LSI, name: "Acme", domain: null },
    { id: 502, workspaceId: LSI, name: "Gamma", domain: null },
    { id: 601, workspaceId: CF, name: "Other tenant", domain: null },
  );
}

function caller(userId: number, ws = LSI) {
  const user = rows("users").find((u) => u.id === userId);
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(ws) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}
function publicCaller() {
  return appRouter.createCaller({
    user: null,
    req: { protocol: "https", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie: () => {} },
  } as unknown as TrpcContext);
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error("expected a refusal, but it resolved");
}

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0));
  h.db = makeSqlFakeDb({ realMembers: true, beforeUpdate: (t) => h.race?.(t) });
  h.tz = "America/New_York";
  h.notices = [];
  h.fired = [];
  h.audits = [];
  h.race = null;
  h.llm = null;
  invalidateStageIndex();
  seed();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ── The gate ───────────────────────────────────────────────────────────── */

describe("gate: Dashboard, Pipeline, Deals, Forecast and Quota agree on the same deals", () => {
  it("one open pipeline, one weighted value, one count", async () => {
    seedGate();
    const admin = caller(ADMIN);
    const dash = await admin.opportunities.dashboardStats();
    const fc = await admin.opportunities.forecast();
    const deals = await admin.opportunities.summary();
    const reps = await admin.opportunities.forecastByRep();

    // The Pipeline board: each pipeline's columns, totalled the way the page
    // does — every open column's cards.
    const board = await admin.opportunities.board();
    const pipelines = await admin.crmPipelines.list();
    let boardOpen = 0;
    for (const p of pipelines) {
      const { stages } = await admin.crmPipelines.get({ pipelineId: p.id });
      const openKeys = stages.filter((s) => !s.isWon && !s.isLost).map((s) => s.key);
      const onBoard = board.filter((o) => (o.pipelineId ?? 1) === p.id && openKeys.includes(o.stage));
      boardOpen += onBoard.reduce((a, o) => a + Number(o.value), 0);
    }

    expect(dash.pipelineValue).toBe(52500.5);
    expect(fc.grandTotal).toBe(52500.5);
    expect(deals.open.value).toBe(52500.5);
    expect(sum(reps.map((r) => r.total))).toBe(52500.5);
    expect(Math.round(boardOpen * 100) / 100).toBe(52500.5);

    expect(dash.weightedPipeline).toBe(27250.25);
    expect(fc.grandWeighted).toBe(27250.25);
    expect(deals.open.weighted).toBe(27250.25);
    expect(sum(reps.map((r) => r.weighted))).toBe(27250.25);

    expect(dash.openOppsCount).toBe(3);
    expect(deals.open.count).toBe(3);
    expect(reps.reduce((a, r) => a + r.openCount, 0)).toBe(3);
  });

  it("one set of wins: this month, this quarter, all time — and Quota measures the same ones", async () => {
    seedGate();
    const admin = caller(ADMIN);
    await admin.quota.set({ userId: REP, period: "2026-11", periodType: "monthly", revenueTarget: 14000, dealsTarget: 2 });
    await admin.quota.set({ userId: REP, period: "2026-11", periodType: "quarterly", revenueTarget: 38000, dealsTarget: 4 });
    await admin.quota.set({ userId: ADMIN, period: "2026-11", periodType: "quarterly", revenueTarget: 10000 });

    const dash = await admin.opportunities.dashboardStats();
    const deals = await admin.opportunities.summary();
    const reps = await admin.opportunities.forecastByRep();
    const repMonth = await admin.quota.progress({ userId: REP, period: "2026-11" });
    const repQuarter = await admin.quota.progress({ userId: REP, period: "2026-Q4" });
    const adminQuarter = await admin.quota.progress({ userId: ADMIN, period: "2026-Q4" });

    // This month: D4 only. D5 was edited today, but it was won in October.
    expect(dash.closedWonCount).toBe(1);
    expect(dash.closedWonValue).toBe(7000);
    expect(deals.wonThisMonth).toEqual({ count: 1, value: 7000 });
    expect(repMonth!.actual).toMatchObject({ revenue: 7000, deals: 1 });
    expect(repMonth!.attainment.revenue).toBe(50);

    // This quarter: D4 + D5. D7 is expected to close in November but was won in July.
    expect(deals.wonThisQuarter).toEqual({ count: 2, value: 19000 });
    expect(sum(reps.map((r) => r.wonThisQuarter))).toBe(19000);
    expect(reps.find((r) => r.ownerUserId === ADMIN)!.wonThisQuarter).toBe(0);
    expect(repQuarter!.actual).toMatchObject({ revenue: 19000, deals: 2 });
    expect(repQuarter!.range.label).toBe("Q4 2026 (Oct–Dec)");
    expect(adminQuarter!.actual).toMatchObject({ revenue: 0, deals: 0 });
    expect(repQuarter!.actual.revenue + adminQuarter!.actual.revenue).toBe(deals.wonThisQuarter.value);

    // All time.
    expect(dash.totalWonValue).toBe(22000);
    expect(deals.won).toEqual({ count: 3, value: 22000 });
  });

  it("a stage key means what the deal's OWN pipeline says it means", async () => {
    // "closed" is Won on Enterprise and Lost on the default board.
    rows("crm_pipeline_stages").push(
      { id: 17, workspaceId: LSI, pipelineId: 1, key: "closed", label: "Closed", sortOrder: 70, defaultWinProb: 0, isWon: false, isLost: true },
      { id: 25, workspaceId: LSI, pipelineId: 2, key: "closed", label: "Closed", sortOrder: 50, defaultWinProb: 100, isWon: true, isLost: false },
    );
    deal(41, { stage: "closed", pipelineId: 2, value: "5000.00", wonAt: at("2026-11-02T16:00:00Z") });
    deal(42, { stage: "closed", pipelineId: 1, value: "800.00", lostAt: at("2026-11-03T16:00:00Z") });
    const s = await caller(ADMIN).opportunities.summary();
    expect(s.won).toEqual({ count: 1, value: 5000 });
    expect(s.lost).toEqual({ count: 1, value: 800 });
  });

  it("another workspace's deals count nowhere", async () => {
    seedGate();
    const other = await caller(ADMIN).opportunities.summary();
    expect(other.open.value).not.toBe(52500.5 + 99999);
    expect(other.open.value).toBe(52500.5);
  });
});

/* ── The rest of the Dashboard reads the same numbers ───────────────────── */

describe("the Dashboard widgets count wins by when they were won", () => {
  it("revenue chart: won value in the month it was won, forecast by close month", async () => {
    seedGate();
    const chart = await caller(ADMIN).opportunities.revenueChart({ months: 6 });
    expect(chart.map((b) => b.label)).toEqual(["Jun", "Jul", "Aug", "Sep", "Oct", "Nov"]);
    expect(chart.map((b) => b.revenue)).toEqual([0, 3000, 0, 0, 12000, 7000]);
    // Only D1 expects to close inside the window (Nov 30, 20% of $10,000).
    expect(chart.map((b) => b.forecast)).toEqual([0, 0, 0, 0, 0, 2000]);
  });

  it("revenue chart months are stepped from day 1, so the 31st neither skips nor repeats (R83)", async () => {
    h.tz = "UTC";
    vi.setSystemTime(new Date("2026-10-31T15:00:00Z"));
    const chart = await caller(ADMIN).opportunities.revenueChart({ months: 3 });
    expect(chart.map((b) => b.label)).toEqual(["Aug", "Sep", "Oct"]);
  });

  it("pipeline delta compares with the pipeline as it stood when the month began", async () => {
    seedGate();
    const dash = await caller(ADMIN).opportunities.dashboardStats();
    // Then: D1 + D2 open, D4 and D6 still open (closed in November). D3 did not exist yet.
    // (52,500.50 − 28,500.50) / 28,500.50 = 84%.
    expect(dash.pipelineDelta).toBe(84);
  });

  it("top reps, win/loss and the funnel read the same classification", async () => {
    seedGate();
    const admin = caller(ADMIN);
    const top = await admin.opportunities.topReps();
    expect(top).toEqual([expect.objectContaining({ userId: REP, value: 7000, count: 1 })]);
    // Last 90 days: D4 and D5 won, D6 lost; D7 (July) is outside.
    expect(await admin.opportunities.winLoss()).toEqual({ won: 2, lost: 1, wonValue: 19000, lostValue: 9000 });
    const funnel = await admin.opportunities.stageFunnel();
    // Columns in the workspace's stage order (sortOrder across pipelines).
    expect(funnel.map((f) => [f.stage, f.count, f.value])).toEqual([
      ["Discovery", 1, 10000], ["Pilot", 1, 40000], ["Proposal", 1, 2500.5],
    ]);
  });

  it("the forecast tab leaves won and lost deals out of every bucket (R19)", async () => {
    seedGate();
    const fc = await caller(ADMIN).opportunities.forecast();
    expect(fc.months).toEqual([
      expect.objectContaining({ month: "2026-11", total: 10000, weighted: 2000, count: 1 }),
      expect.objectContaining({ month: "2026-12", total: 2500.5, weighted: 1250.25, count: 1 }),
      expect.objectContaining({ month: "no-date", total: 40000, weighted: 24000, count: 1 }),
    ]);
    expect(fc.stages.map((s) => s.stage).sort()).toEqual(["discovery", "pilot", "proposal"]);
    expect(fc.availableStages).toEqual(["discovery", "pilot", "proposal"]);
  });
});

/* ── Periods, in the workspace's zone ───────────────────────────────────── */

describe("periods are cut in the workspace's time zone", () => {
  it("a deal won at 10pm on Oct 31 in New York is an October win there and a November win in UTC", async () => {
    deal(8, { stage: "won", value: "500.00", wonAt: at("2026-11-01T02:00:00Z") });
    h.tz = "America/New_York";
    expect((await caller(ADMIN).opportunities.summary()).wonThisMonth.count).toBe(0);
    h.tz = "UTC";
    expect((await caller(ADMIN).opportunities.summary()).wonThisMonth.count).toBe(1);
  });

  it("local midnight is found across a DST change", () => {
    // New York leaves daylight time at 2am on Nov 1, 2026: midnight that day is still EDT.
    expect(zonedMidnight("America/New_York", 2026, 11, 1).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(zonedMidnight("America/New_York", 2026, 12, 1).toISOString()).toBe("2026-12-01T05:00:00.000Z");
    expect(zonedMidnight("Asia/Kolkata", 2026, 1, 1).toISOString()).toBe("2025-12-31T18:30:00.000Z");
    expect(zonedMidnight("UTC", 2026, 3, 1).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    // Sydney leaves daylight time at 3am on Apr 5, 2026: midnight that day is
    // still +11, though the first guess lands after the change, at +10.
    expect(zonedMidnight("Australia/Sydney", 2026, 4, 5).toISOString()).toBe("2026-04-04T13:00:00.000Z");
    expect(zonedYmd("America/New_York", at("2026-11-01T03:59:00Z"))).toEqual({ y: 2026, m: 10, day: 31 });
  });

  it("a quota period type decides its range (R17)", () => {
    const q = quotaPeriodRange("UTC", "2026-11", "quarterly");
    expect([q.start.toISOString(), q.end.toISOString(), q.label]).toEqual(["2026-10-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", "Q4 2026 (Oct–Dec)"]);
    const m = quotaPeriodRange("UTC", "2026-11", "monthly");
    expect([m.start.toISOString(), m.end.toISOString(), m.label]).toEqual(["2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z", "Nov 2026"]);
    const y = quotaPeriodRange("UTC", "2026-FY", "annual");
    expect([y.start.toISOString(), y.end.toISOString(), y.label]).toEqual(["2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z", "2026"]);
    // A legacy quarterly row stored under a month still measures its quarter.
    expect(quotaPeriodRange("UTC", "2026-10", "quarterly").end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("a quarterly target is stored once for its quarter and shows from each of its months", async () => {
    const admin = caller(ADMIN);
    const saved = await admin.quota.set({ userId: REP, period: "2026-11", periodType: "quarterly", revenueTarget: 1 });
    expect(saved.period).toBe("2026-Q4");
    await admin.quota.set({ userId: REP, period: "2026-12", periodType: "quarterly", revenueTarget: 2 });
    expect(rows("quota_targets").filter((t) => t.periodType === "quarterly")).toHaveLength(1);
    await admin.quota.set({ userId: REP, period: "2026-11", periodType: "annual", revenueTarget: 3 });
    expect(rows("quota_targets").map((t) => t.period).sort()).toEqual(["2026-FY", "2026-Q4"]);
    for (const month of ["2026-10", "2026-11", "2026-12"]) {
      expect((await admin.quota.list({ period: month })).map((t) => t.period).sort()).toEqual(["2026-FY", "2026-Q4"]);
    }
    expect((await admin.quota.list({ period: "2027-01" })).length).toBe(0);
  });

  it("re-saving a quarterly target stored the old way, under a month, replaces it", async () => {
    rows("quota_targets").push(
      { id: 81, workspaceId: LSI, userId: REP, period: "2026-10", periodType: "quarterly", revenueTarget: "30000.00", dealsTarget: 0, activitiesTarget: 0 },
      { id: 82, workspaceId: LSI, userId: REP, period: "2026-11", periodType: "monthly", revenueTarget: "9000.00", dealsTarget: 0, activitiesTarget: 0 },
    );
    await caller(ADMIN).quota.set({ userId: REP, period: "2026-10", periodType: "quarterly", revenueTarget: 36000 });
    expect(rows("quota_targets").map((t) => [t.period, t.periodType]).sort()).toEqual([["2026-11", "monthly"], ["2026-Q4", "quarterly"]]);
  });
});

/* ── One stage-change service ───────────────────────────────────────────── */

describe("every stage move goes through one service", () => {
  it("dropping a card back on its own column changes nothing (R13)", async () => {
    deal(1, { stage: "proposal" });
    const before = { ...opp(1) };
    const r = await caller(ADMIN).opportunities.setStage({ id: 1, stage: "proposal" });
    expect(r.changed).toBe(false);
    expect(opp(1)).toEqual(before);
    expect(historyOf(1)).toHaveLength(0);
    expect(h.fired).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
  });

  it("a stage from another pipeline is refused, and the deal stays put (R20)", async () => {
    deal(1, { stage: "discovery", pipelineId: 1 });
    const no = await refusal(caller(REP).opportunities.setStage({ id: 1, stage: "pilot" }));
    expect(no.code).toBe("BAD_REQUEST");
    expect(no.message).toMatch(/not a stage in this deal's pipeline/);
    expect(opp(1).stage).toBe("discovery");
  });

  it("moving to Won stamps the dates, records the move and runs closed-won once", async () => {
    deal(1, { stage: "negotiation", value: "8000.00", winProb: 70, stageEnteredAt: daysAgo(10) });
    const r = await caller(ADMIN).opportunities.setStage({ id: 1, stage: "won" });
    expect(r).toMatchObject({ changed: true, customerCreated: true });
    expect(opp(1)).toMatchObject({ stage: "won", winProb: 100, daysInStage: 0 });
    expect(opp(1).wonAt.getTime()).toBe(T0);
    expect(opp(1).stageEnteredAt.getTime()).toBe(T0);
    expect(opp(1).lostAt).toBeNull();
    expect(historyOf(1)).toEqual([expect.objectContaining({ fromStage: "negotiation", toStage: "won", changedByUserId: ADMIN, daysInPrevStage: 10 })]);
    expect(rows("customers")).toEqual([expect.objectContaining({ workspaceId: LSI, accountId: 501, arr: "8000.00" })]);
    // The owner is told; the mover is not.
    expect(h.notices).toEqual([expect.objectContaining({ userId: REP, event: "dealMoved" })]);
    expect(h.audits).toEqual([expect.objectContaining({ entityId: 1, after: expect.objectContaining({ stage: "won", source: "board" }) })]);
    await vi.waitFor(() => expect(h.fired).toHaveLength(1));
    expect(h.fired[0].slice(0, 4)).toEqual([LSI, 1, "negotiation", "won"]);
    expect(h.fired[0][4]).toMatchObject({ isWon: true, value: 8000 });

    // Re-opened, it stops being a win.
    await caller(ADMIN).opportunities.setStage({ id: 1, stage: "proposal" });
    expect(opp(1).wonAt).toBeNull();
    expect(opp(1).winProb).toBe(50);
    expect((await caller(ADMIN).opportunities.summary()).won.count).toBe(0);
  });

  it("the owner moving their own deal is not told about it", async () => {
    deal(1, { stage: "discovery" });
    await caller(REP).opportunities.setStage({ id: 1, stage: "qualified" });
    expect(h.notices).toHaveLength(0);
  });

  it("moving to Lost raises one win-back task, not one per loss", async () => {
    deal(1, { stage: "proposal" });
    const admin = caller(ADMIN);
    await admin.opportunities.setStage({ id: 1, stage: "lost" });
    expect(opp(1).lostAt.getTime()).toBe(T0);
    expect(opp(1).winProb).toBe(0);
    await admin.opportunities.setStage({ id: 1, stage: "proposal" });
    expect(opp(1).lostAt).toBeNull();
    await admin.opportunities.setStage({ id: 1, stage: "lost" });
    const winBack = rows("tasks").filter((t) => t.relatedId === 1 && String(t.title).startsWith("Win-back:"));
    expect(winBack).toHaveLength(1);
    expect(winBack[0]).toMatchObject({ ownerUserId: REP, status: "open" });
  });

  it("of two simultaneous moves only one lands and runs its side effects", async () => {
    deal(1, { stage: "proposal" });
    // Another request moves the deal between our read and our write.
    h.race = (t) => { if (t === "opportunities" && opp(1).stage === "proposal") opp(1).stage = "negotiation"; };
    const r = await caller(ADMIN).opportunities.setStage({ id: 1, stage: "won" });
    expect(r.changed).toBe(false);
    expect(opp(1).stage).toBe("negotiation");
    expect(opp(1).wonAt).toBeNull();
    expect(historyOf(1)).toHaveLength(0);
    expect(rows("customers")).toHaveLength(0);
    expect(h.fired).toHaveLength(0);
  });

  it("the Alerts page move now sets the win %, writes the history and tells the owner (R21)", async () => {
    deal(1, { stage: "discovery", winProb: 20 });
    const r = await caller(ADMIN).pipelineAlerts.moveDealStage({ opportunityId: 1, newStage: "negotiation" });
    expect(r.changed).toBe(true);
    expect(opp(1)).toMatchObject({ stage: "negotiation", winProb: 70 });
    expect(historyOf(1)).toHaveLength(1);
    expect(h.notices).toEqual([expect.objectContaining({ userId: REP, event: "dealMoved" })]);
    expect(h.audits[0].after.source).toBe("alerts");
    expect((await refusal(caller(ADMIN).pipelineAlerts.moveDealStage({ opportunityId: 1, newStage: "pilot" }))).code).toBe("BAD_REQUEST");
  });

  it("an approved stage change moves through the same service, with the manager's note", async () => {
    deal(1, { stage: "negotiation" });
    rows("stage_approvals").push({ id: 71, workspaceId: LSI, opportunityId: 1, requestedByUserId: REP, approverUserId: null, fromStage: "negotiation", toStage: "won", status: "pending", note: null, reviewNote: null });
    await caller(ADMIN).oppIntelligence.reviewStageChange({ approvalId: 71, approved: true, reviewNote: "Signed PO" });
    expect(opp(1).stage).toBe("won");
    expect(opp(1).wonAt.getTime()).toBe(T0);
    expect(historyOf(1)).toEqual([expect.objectContaining({ note: "Approved by manager. Signed PO" })]);
    expect(rows("customers")).toHaveLength(1);
  });

  it("accepting a proposal closes its linked deal even with no account on the proposal (R25), once", async () => {
    deal(1, { stage: "proposal", value: "5000.00" });
    rows("proposals").push({ id: 901, workspaceId: LSI, title: "Acme renewal", clientName: "Acme", budget: "8000.00", linkedOpportunityId: 1, accountId: null, status: "sent", shareToken: "tok-901" });
    await caller(REP).proposals.acceptProposal({ id: 901 });
    expect(opp(1)).toMatchObject({ stage: "won", value: "8000.00", winProb: 100 });
    expect(opp(1).wonAt.getTime()).toBe(T0);
    expect(historyOf(1)).toEqual([expect.objectContaining({ fromStage: "proposal", toStage: "won", note: 'Proposal "Acme renewal" accepted' })]);
    // Accepting again leaves the deal alone.
    await caller(REP).proposals.acceptProposal({ id: 901 });
    expect(historyOf(1)).toHaveLength(1);
    await vi.waitFor(() => expect(h.fired).toHaveLength(1));
  });

  it("a client accepting on the portal wins the deal into ITS pipeline's won stage", async () => {
    deal(3, { stage: "pilot", pipelineId: 2, value: "40000.00", accountId: 502 });
    rows("proposals").push({ id: 902, workspaceId: LSI, title: "Gamma rollout", clientName: "Gamma", budget: "42000.00", linkedOpportunityId: 3, accountId: null, status: "sent", shareToken: "tok-902" });
    await publicCaller().proposals.acceptByToken({ token: "tok-902" });
    expect(opp(3)).toMatchObject({ stage: "signed", value: "42000.00" });
    expect(opp(3).wonAt.getTime()).toBe(T0);
    expect(historyOf(3)).toEqual([expect.objectContaining({ toStage: "signed", changedByUserId: null })]);
    expect(h.notices).toEqual([expect.objectContaining({ userId: REP, body: expect.stringMatching(/^Gamma moved/) })]);
    // The CSM is an active member: the workspace's notify user, as on every session-less path.
    expect(rows("customers")).toEqual([expect.objectContaining({ accountId: 502, cmUserId: REP })]);
  });

  it("on the portal, a departed owner's win is filed under an active member", async () => {
    rows("workspace_members").find((m) => m.userId === REP).deactivatedAt = daysAgo(30);
    deal(3, { stage: "pilot", pipelineId: 2, value: "40000.00", accountId: 502 });
    rows("proposals").push({ id: 904, workspaceId: LSI, title: "Gamma rollout", clientName: "Gamma", budget: "42000.00", linkedOpportunityId: 3, accountId: null, status: "sent", shareToken: "tok-904" });
    await publicCaller().proposals.acceptByToken({ token: "tok-904" });
    expect(rows("customers")).toEqual([expect.objectContaining({ accountId: 502, cmUserId: ADMIN })]);
  });

  it("a deal created with a proposal accept carries its won date", async () => {
    rows("proposals").push({ id: 903, workspaceId: LSI, title: "New logo", clientName: "Kappa", budget: "6000.00", linkedOpportunityId: null, accountId: 501, status: "sent", shareToken: "tok-903" });
    await caller(REP).proposals.acceptProposal({ id: 903 });
    const created = rows("opportunities").find((o) => o.name === "New logo");
    expect(created).toMatchObject({ stage: "won", winProb: 100 });
    expect(created.wonAt.getTime()).toBe(T0);
    expect(created.stageEnteredAt.getTime()).toBe(T0);
    expect((await caller(ADMIN).opportunities.summary()).wonThisMonth).toEqual({ count: 1, value: 6000 });
  });

  it("creating a deal checks the stage against the pipeline and stamps its dates", async () => {
    const rep = caller(REP);
    expect((await refusal(rep.opportunities.create({ name: "x", accountId: 501, pipelineId: 2, stage: "discovery" }))).code).toBe("BAD_REQUEST");
    const { id } = await rep.opportunities.create({ name: "Open one", accountId: 501, pipelineId: 2, stage: "intro", closeDate: "2026-12-15" });
    expect(opp(id).closeDate.toISOString()).toBe("2026-12-15T12:00:00.000Z");
    expect(opp(id).stageEnteredAt.getTime()).toBe(T0);
    expect(opp(id).wonAt).toBeNull();
    const won = await rep.opportunities.create({ name: "Already won", accountId: 501, pipelineId: 2, stage: "signed" });
    expect(opp(won.id).wonAt.getTime()).toBe(T0);
  });

  it("the generic update still refuses a stage change", async () => {
    deal(1, { stage: "proposal" });
    expect((await refusal(caller(REP).opportunities.update({ id: 1, patch: { stage: "won" } }))).code).toBe("BAD_REQUEST");
    expect(opp(1).stage).toBe("proposal");
  });
});

/* ── Close dates are calendar dates ─────────────────────────────────────── */

describe("a close date is the day that was picked (R16, R29)", () => {
  it("is stored at noon UTC and read back as the same day", () => {
    expect(calendarDateToStored("2026-11-14")!.toISOString()).toBe("2026-11-14T12:00:00.000Z");
    expect(calendarDateToStored("2026-02-31")).toBeNull();
    expect(calendarDateToStored("next week")).toBeNull();
    // Old rows, stored at UTC midnight, keep the day they meant.
    expect(storedToCalendarDate(at("2026-12-01T00:00:00Z"))).toBe("2026-12-01");
    expect(storedToCalendarDate("2026-12-01")).toBe("2026-12-01");
    expect(calendarMonthKey(at("2026-12-01T00:00:00Z"))).toBe("2026-12");
    expect(normalizeCalendarDate("2026-12-01T23:30:00.000Z")!.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    expect(normalizeCalendarDate(null)).toBeNull();
  });

  it("can be set and cleared from the deal page, and lands in its own month on the forecast", async () => {
    deal(1, { stage: "proposal", value: "1000.00", winProb: 50 });
    const rep = caller(REP);
    await rep.opportunities.update({ id: 1, patch: { closeDate: "2026-12-01" } });
    expect(opp(1).closeDate.toISOString()).toBe("2026-12-01T12:00:00.000Z");
    for (const tz of ["America/Los_Angeles", "Pacific/Auckland", "UTC"]) {
      h.tz = tz;
      expect((await rep.opportunities.forecast()).months.map((m) => m.month)).toEqual(["2026-12"]);
    }
    await rep.opportunities.update({ id: 1, patch: { closeDate: null } });
    expect(opp(1).closeDate).toBeNull();
    expect((await rep.opportunities.forecast()).months.map((m) => m.month)).toEqual(["no-date"]);
  });
});

/* ── Stage dates for deals from before 0211, and days in stage ──────────── */

describe("deals from before migration 0211 get their dates once (R14, R16)", () => {
  it("from the stage history first, then the close date for a win, then the last update", async () => {
    deal(31, { stage: "qualified", stageEnteredAt: null, createdAt: daysAgo(40), updatedAt: daysAgo(2) });
    rows("opportunity_stage_history").push(
      { id: 1, workspaceId: LSI, opportunityId: 31, fromStage: null, toStage: "discovery", changedByUserId: REP, daysInPrevStage: null, note: null, createdAt: daysAgo(40) },
      { id: 2, workspaceId: LSI, opportunityId: 31, fromStage: "discovery", toStage: "qualified", changedByUserId: REP, daysInPrevStage: 28, note: null, createdAt: daysAgo(12) },
    );
    deal(32, { stage: "won", stageEnteredAt: null, closeDate: daysAgo(20), updatedAt: daysAgo(0.1) });
    deal(33, { stage: "won", stageEnteredAt: null, closeDate: new Date(T0 + 30 * DAY), updatedAt: daysAgo(3) });
    deal(34, { stage: "lost", stageEnteredAt: null, updatedAt: daysAgo(1) });
    rows("opportunity_stage_history").push({ id: 3, workspaceId: LSI, opportunityId: 34, fromStage: "proposal", toStage: "lost", changedByUserId: REP, daysInPrevStage: 3, note: null, createdAt: daysAgo(5) });
    deal(35, { stage: "signed", pipelineId: 2, stageEnteredAt: null, closeDate: null, updatedAt: daysAgo(4) });
    deal(36, { stage: "proposal", stageEnteredAt: daysAgo(7), updatedAt: daysAgo(6) });
    const updatedBefore = new Map(rows("opportunities").map((o) => [o.id, o.updatedAt]));

    expect(await backfillDealDates(h.db, new Date(T0))).toEqual({ updated: 5 });
    expect(opp(31).stageEnteredAt).toEqual(daysAgo(12));
    expect(opp(31).daysInStage).toBe(12);
    expect(opp(31).wonAt).toBeNull();
    expect(opp(32).wonAt).toEqual(daysAgo(20));
    expect(opp(33).wonAt).toEqual(daysAgo(3)); // a future close date is no evidence of a win
    expect(opp(34).lostAt).toEqual(daysAgo(5));
    expect(opp(35).wonAt).toEqual(daysAgo(4)); // won by its own pipeline's flags
    expect(opp(36).stageEnteredAt).toEqual(daysAgo(7)); // untouched
    // Housekeeping is not an edit.
    for (const o of rows("opportunities")) expect(o.updatedAt).toBe(updatedBefore.get(o.id));
    expect(await backfillDealDates(h.db, new Date(T0))).toEqual({ updated: 0 });
  });

  it("the backfill is scheduled once at boot, not on an interval", () => {
    const boot = readFileSync(join(__dirname, "_core", "index.ts"), "utf8").replace(/\r\n/g, "\n");
    const call = boot.indexOf(".then((m) => m.backfillDealDates())");
    expect(call).toBeGreaterThan(-1);
    expect(boot.lastIndexOf("setTimeout(", call)).toBeGreaterThan(boot.lastIndexOf("setInterval(", call));
  });

  it("days in stage count up from when the deal entered it, on the alert sweep", async () => {
    deal(1, { stage: "proposal", stageEnteredAt: daysAgo(15), daysInStage: 0, updatedAt: daysAgo(9) });
    deal(2, { stage: "won", stageEnteredAt: daysAgo(2), daysInStage: 2, updatedAt: daysAgo(2) });
    await scanPipelineAlertsForWorkspace(LSI);
    expect(opp(1).daysInStage).toBe(15);
    expect(opp(1).updatedAt).toEqual(daysAgo(9));
    expect(await refreshDaysInStage(h.db, LSI, new Date(T0))).toBe(0);
    vi.setSystemTime(new Date(T0 + DAY));
    expect(await refreshDaysInStage(h.db, LSI, new Date(T0 + DAY))).toBe(2);
    expect(opp(1).daysInStage).toBe(16);
  });
});

/* ── Pipeline settings carry deals with them (R18) ──────────────────────── */

describe("deleting or re-keying a stage or pipeline keeps its deals on a board", () => {
  it("each stage reports how many deals it holds", async () => {
    seedGate();
    const def = await caller(ADMIN).crmPipelines.get({ pipelineId: 1 });
    expect(Object.fromEntries(def.stages.map((s) => [s.key, s.dealCount]))).toEqual({
      discovery: 1, qualified: 0, proposal: 1, negotiation: 0, won: 2, lost: 1,
    });
    expect(def.dealCount).toBe(5);
    expect((await caller(ADMIN).crmPipelines.get({ pipelineId: 2 })).dealCount).toBe(2);
  });

  it("a stage with deals is deleted only by moving them to a stage of the same kind", async () => {
    seedGate();
    const admin = caller(ADMIN);
    const ask = await refusal(admin.crmPipelines.deleteStage({ id: 22 }));
    expect([ask.code, ask.message]).toEqual(["BAD_REQUEST", "1 deal is in this stage. Pick a stage to move it to."]);
    expect((await refusal(admin.crmPipelines.deleteStage({ id: 22, moveToKey: "signed" }))).message).toMatch(/another open stage/);
    const r = await admin.crmPipelines.deleteStage({ id: 22, moveToKey: "intro" });
    expect(r.moved).toBe(1);
    expect(opp(3).stage).toBe("intro");
    expect(historyOf(3)).toEqual([expect.objectContaining({ fromStage: "pilot", toStage: "intro", note: 'Stage "Pilot" deleted — moved to "Intro"' })]);
    expect(rows("crm_pipeline_stages").some((s) => s.id === 22)).toBe(false);
    expect((await admin.opportunities.summary()).open.value).toBe(52500.5);
  });

  it("the pipeline's only Won stage cannot be deleted; with a second one, its wins move and stay wins", async () => {
    seedGate();
    const admin = caller(ADMIN);
    expect((await refusal(admin.crmPipelines.deleteStage({ id: 23, moveToKey: "intro" }))).message).toMatch(/only Won stage/);
    await admin.crmPipelines.createStage({ pipelineId: 2, key: "renewed", label: "Renewed", sortOrder: 35, isWon: true });
    const wonAt = opp(5).wonAt;
    await admin.crmPipelines.deleteStage({ id: 23, moveToKey: "renewed" });
    expect(opp(5).stage).toBe("renewed");
    expect(opp(5).wonAt).toBe(wonAt);
    expect((await admin.opportunities.summary()).wonThisQuarter).toEqual({ count: 2, value: 19000 });
  });

  it("a stage key is unique in its pipeline, and a new key carries the stage's deals", async () => {
    seedGate();
    const admin = caller(ADMIN);
    expect((await refusal(admin.crmPipelines.createStage({ pipelineId: 2, key: "pilot", label: "Pilot 2" }))).code).toBe("CONFLICT");
    expect((await refusal(admin.crmPipelines.updateStage({ id: 22, patch: { key: "intro" } }))).code).toBe("CONFLICT");
    await admin.crmPipelines.updateStage({ id: 22, patch: { key: "trial" } });
    expect(opp(3).stage).toBe("trial");
    // Another pipeline's deal with the same key is not touched.
    expect(opp(1).stage).toBe("discovery");
    // A stage cannot be created in another tenant's pipeline.
    rows("crm_pipelines").push({ id: 9, workspaceId: CF, name: "Theirs", isDefault: true, sortOrder: 0 });
    expect((await refusal(admin.crmPipelines.createStage({ pipelineId: 9, key: "x", label: "X" }))).code).toBe("BAD_REQUEST");
  });

  it("flagging a stage Won dates its deals' wins from when they entered it; unflagging undoes it", async () => {
    deal(1, { stage: "negotiation", value: "4000.00", stageEnteredAt: at("2026-11-12T12:00:00Z") });
    const admin = caller(ADMIN);
    await admin.crmPipelines.updateStage({ id: 14, patch: { isWon: true } });
    expect(opp(1).wonAt).toEqual(at("2026-11-12T12:00:00Z"));
    expect((await admin.opportunities.summary()).wonThisMonth).toEqual({ count: 1, value: 4000 });
    await admin.crmPipelines.updateStage({ id: 14, patch: { isWon: false } });
    expect(opp(1).wonAt).toBeNull();
    expect((await admin.opportunities.summary()).open.value).toBe(4000);
  });

  it("a pipeline with deals is deleted only by moving them, each to a stage of its kind", async () => {
    seedGate();
    const admin = caller(ADMIN);
    expect((await refusal(admin.crmPipelines.deletePipeline({ id: 2 }))).message).toBe("2 deals are in this pipeline. Pick a pipeline to move them to.");
    const before = await admin.opportunities.summary();
    const r = await admin.crmPipelines.deletePipeline({ id: 2, moveToPipelineId: 1 });
    expect(r.moved).toBe(2);
    expect(opp(3)).toMatchObject({ pipelineId: 1, stage: "discovery" });
    expect(opp(5)).toMatchObject({ pipelineId: 1, stage: "won" });
    expect(historyOf(5)).toEqual([expect.objectContaining({ fromStage: "signed", toStage: "won" })]);
    const after = await admin.opportunities.summary();
    expect(after.open).toEqual(before.open);
    expect(after.won).toEqual(before.won);
    expect(rows("crm_pipelines").map((p) => p.id)).toEqual([1]);
  });
});

/* ── Forecast commentary (R19) ──────────────────────────────────────────── */

describe("the AI forecast commentary", () => {
  it("is written from the open pipeline, and a failure keeps the last good one", async () => {
    seedGate();
    const prompts: string[] = [];
    h.llm = async (input) => {
      prompts.push(input.messages[0].content);
      return { choices: [{ message: { content: JSON.stringify({ commentary: "Pipeline is healthy.", highlights: [] }) } }] };
    };
    const admin = caller(ADMIN);
    await admin.forecastAi.generateCommentary();
    expect(prompts[0]).toContain("Open pipeline value: $52,500.5 across 3 open deals");
    expect(prompts[0]).toContain("Weighted forecast (open deals): $27,250");
    expect(prompts[0]).toContain("Won so far this month: 1 deals worth $7,000");
    expect(prompts[0]).toContain("Open deals expected to close this month: 1 worth $10,000");
    expect(prompts[0]).not.toMatch(/lost: 1|won: 2/);

    h.llm = async () => { throw new Error("model down"); };
    expect((await refusal(admin.forecastAi.generateCommentary())).code).toBe("INTERNAL_SERVER_ERROR");
    expect((await admin.forecastAi.getCommentary())?.commentary).toBe("Pipeline is healthy.");
  });
});
