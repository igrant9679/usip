/**
 * Batch Ga: the dashboards, analytics and the two home pages say what they count.
 *
 *   G25  the revenue chart is labelled, and months are the workspace's, from the 1st
 *   G53  "Active Leads" is active leads; deltas compare like with like; recent deals are newest first
 *   G55  widget maths: no rate over 100%, nothing-to-nothing isn't +100%, no NaN, no fixed gauge;
 *        a deleted dashboard takes its schedules with it
 *   G56  "Set as home" decides where "/" lands; both homes read the same drafts and open deals
 *   G57  "Your tasks" are yours; no made-up recommendation; no social rate over 100%
 *   G58  dashboard numbers are counted in SQL, from the columns they need
 *   G69  goals per workspace; "Updated" keeps time; top reps is this month; no option that always fails
 *
 * Procedures run against the SQL-evaluating fake; screens are rendered where they
 * can be, and read where the repo already pins them that way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableName } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import { ComparisonWidget, GoalProgressWidget } from "../client/src/components/usip/DashboardWidgets";
import { DashboardChartRenderer } from "../client/src/components/usip/DashboardChartRenderer";
import { goalsKey, LEGACY_GOALS_KEY, readGoals, writeGoals } from "../client/src/lib/dashboardGoals";
import { DEFAULT_HOME_VIEW, HOME_CHOICES, homeViewFrom } from "../client/src/lib/homeChoice";
import { socialFunnelSteps, socialStepNote } from "../client/src/lib/socialFunnel";

const WS = 2, FOREIGN = 9, ME = 1, ANN = 21;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

const deal = (id: number, value: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: WS, accountId: 1, name: `D${id}`, stage: "discovery", value, ownerUserId: ANN, winProb: 20,
  daysInStage: 0, pipelineId: null, createdAt: new Date("2026-10-10T12:00:00Z"), updatedAt: null, closeDate: null,
  wonAt: null, lostAt: null, stageEnteredAt: null, ...o,
});
const widget = (id: number, type: string, config: Record<string, unknown> = {}) => {
  rows("dashboard_widgets").push({ id, workspaceId: WS, dashboardId: 1, type, title: `W${id}`, config, filters: null, position: { x: 0, y: 0, w: 1, h: 1 } });
  return id;
};
const resolve = async (id: number) => (await caller().dashboards.resolveWidget({ id })) as any;
const setZone = (tz: string) => { rows("workspace_settings").push({ workspaceId: WS, timezone: tz }); _clearWorkspaceTimezoneCache(); };
const at = (iso: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(iso)); _clearWorkspaceTimezoneCache(); };

/** Records each select's table and projection, to see what a procedure reads. */
function watchSelects() {
  const seen: Array<{ table: string; keys: string[] | null }> = [];
  const real = h.db.select;
  h.db.select = (proj?: Record<string, unknown>) => {
    const b = real(proj);
    const from = b.from;
    b.from = (t: any) => { seen.push({ table: getTableName(t), keys: proj ? Object.keys(proj) : null }); return from(t); };
    return b;
  };
  return seen;
}

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  invalidateStageIndex();
  _clearWorkspaceTimezoneCache();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ME, archivedAt: null, plan: "trial" });
  rows("users").push({ id: ME, name: "Me" }, { id: ANN, name: "Ann" });
  rows("workspace_members").push(
    { id: 1, workspaceId: WS, userId: ME, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    { id: 2, workspaceId: WS, userId: ANN, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
  );
  rows("dashboards").push({ id: 1, workspaceId: WS, name: "D", ownerUserId: ME, layout: [] });
  rows("accounts").push({ id: 1, workspaceId: WS, name: "Acme" }, { id: 2, workspaceId: WS, name: "Globex" });
});
afterEach(() => { vi.useRealTimers(); });

/* ── G25 ──────────────────────────────────────────────────────────────────── */

describe("the revenue chart's months (G25)", () => {
  it("the Dashboard's x-axis reads the field the chart sends", async () => {
    at("2026-11-15T12:00:00Z");
    const chart = await caller().opportunities.revenueChart({ months: 3 });
    const axis = read("client/src/pages/usip/Dashboard.tsx").match(/<XAxis dataKey="(\w+)" tick=/)?.[1];
    expect(axis).toBeDefined();
    expect(Object.keys(chart[0]!)).toContain(axis);
  });

  it("on the 31st in New York the months are the zone's, stepped from the 1st", async () => {
    setZone("America/New_York");
    // 23:30 on 31 October in New York is already 1 November in UTC.
    at("2026-11-01T03:30:00Z");
    expect((await caller().opportunities.revenueChart({ months: 3 })).map((b) => b.label)).toEqual(["Aug", "Sep", "Oct"]);
    at("2026-10-31T15:00:00Z");
    expect((await caller().opportunities.revenueChart({ months: 6 })).map((b) => b.label)).toEqual(["May", "Jun", "Jul", "Aug", "Sep", "Oct"]);
  });

  it("across the clocks going back, a win lands in the month it was won there", async () => {
    setZone("America/New_York");
    rows("opportunities").push(
      deal(1, 100, { stage: "won", wonAt: new Date("2026-11-01T03:59:59Z") }), // 23:59:59 EDT, 31 Oct
      deal(2, 10, { stage: "won", wonAt: new Date("2026-11-01T04:00:00Z") }), //  00:00 EDT, 1 Nov
      deal(3, 1, { stage: "won", wonAt: new Date("2026-11-01T06:30:00Z") }), //  01:30 EST, after the change
    );
    at("2026-11-01T07:00:00Z");
    const chart = await caller().opportunities.revenueChart({ months: 2 });
    expect(chart.map((b) => [b.label, b.revenue])).toEqual([["Oct", 100], ["Nov", 11]]);
  });

  it("past twelve months a repeated name carries its year", async () => {
    at("2026-11-15T12:00:00Z");
    const labels = (await caller().opportunities.revenueChart({ months: 24 })).map((b) => b.label);
    expect(new Set(labels).size).toBe(24);
    expect(labels[0]).toBe("Dec '24");
    expect(labels[23]).toBe("Nov '26");
  });

  it("a six-month widget on the 31st shows six different months in order", async () => {
    at("2026-10-31T15:00:00Z");
    const r = await resolve(widget(10, "bar", { metric: "pipeline_created" }));
    expect(r.series.map((m: any) => m.label)).toEqual(["May", "Jun", "Jul", "Aug", "Sep", "Oct"]);
  });

  it("a widget puts a New York evening on the 31st in October", async () => {
    setZone("America/New_York");
    rows("opportunities").push(deal(1, 7, { createdAt: new Date("2026-11-01T02:00:00Z") }));
    at("2026-11-02T12:00:00Z");
    const r = await resolve(widget(11, "bar", { metric: "pipeline_created" }));
    expect(r.series.slice(-2)).toEqual([{ label: "Oct", value: 7 }, { label: "Nov", value: 0 }]);
  });

  it("a won-by-month widget counts a win in the month it was won, as the chart does", async () => {
    rows("opportunities").push(deal(1, 9, { stage: "won", wonAt: new Date("2026-09-10T12:00:00Z"), closeDate: new Date("2026-11-20T00:00:00Z") }));
    at("2026-11-15T12:00:00Z");
    const r = await resolve(widget(12, "line", { metric: "closed_won" }));
    expect(r.series.find((m: any) => m.label === "Sep").value).toBe(9);
    expect(r.series.find((m: any) => m.label === "Nov").value).toBe(0);
  });
});

/* ── G55 ──────────────────────────────────────────────────────────────────── */

describe("widget maths (G55)", () => {
  it("'with activity %' is a share of the deals it counts, never over 100%", async () => {
    rows("opportunities").push(deal(1, 1), deal(2, 1), deal(4, 1, { workspaceId: FOREIGN }));
    // Deal 1 has one; 7, 8 and 9 are deals that no longer exist; 4 is another workspace's.
    for (const [id, relatedId, ws] of [[1, 1, WS], [2, 1, WS], [3, 7, WS], [4, 8, WS], [5, 9, WS], [6, 4, FOREIGN]]) {
      rows("activities").push({ id, workspaceId: ws, type: "call", relatedType: "opportunity", relatedId, actorUserId: ANN, occurredAt: new Date() });
    }
    expect((await resolve(widget(20, "kpi", { metric: "response_rate" }))).value).toBe(50);
  });

  it("a comparison: nothing to nothing is no change, growth from nothing is no percentage", async () => {
    at("2026-11-03T12:00:00Z");
    const id = widget(21, "comparison");
    expect(await resolve(id)).toMatchObject({ current: 0, previous: 0, changePct: 0 });
    rows("opportunities").push(deal(1, 10, { stage: "won", wonAt: new Date("2026-11-02T12:00:00Z") }));
    expect(await resolve(id)).toMatchObject({ current: 10, previous: 0, changePct: null });
  });

  it("a comparison sets this month so far against the same days of last month", async () => {
    at("2026-11-03T12:00:00Z");
    rows("opportunities").push(
      deal(1, 10, { stage: "won", wonAt: new Date("2026-11-02T12:00:00Z") }),
      deal(2, 5, { stage: "won", wonAt: new Date("2026-10-02T12:00:00Z") }),
      deal(3, 100, { stage: "won", wonAt: new Date("2026-10-20T12:00:00Z") }),
    );
    expect(await resolve(widget(22, "comparison"))).toMatchObject({ current: 10, previous: 5, changePct: 100 });
  });

  it("a goal with no usable target has none, rather than NaN% or a full bar", async () => {
    for (const [id, target] of [[23, 0], [24, "abc"], [25, -5]] as const) {
      const r = await resolve(widget(id, "goal_progress", { target }));
      expect(r.target).toBeNull();
      expect(r.pct).toBeNull();
    }
    // A widget saved without one keeps the $1M it always had.
    expect((await resolve(widget(26, "goal_progress", {}))).target).toBe(1000000);
  });

  it("the goal and comparison widgets say so instead of drawing NaN or +100%", () => {
    const goal = renderToStaticMarkup(createElement(GoalProgressWidget, { data: { current: 0, target: null, pct: null } }));
    expect(goal).toContain("No target set");
    expect(goal).not.toContain("NaN");
    const cmp = renderToStaticMarkup(createElement(ComparisonWidget, { data: { current: 10, previous: 0, changePct: null, format: "currency" } }));
    expect(cmp).toContain("Up from nothing");
    expect(cmp).not.toMatch(/\d+% increase/);
  });

  it("a gauge of a number that isn't a percentage isn't filled to a made-up 75%", () => {
    const src = read("client/src/components/usip/DashboardChartRenderer.tsx");
    expect(src).not.toMatch(/: 75;/);
    const html = renderToStaticMarkup(createElement(DashboardChartRenderer, { data: { type: "gauge", value: 1234, format: "currency" } }));
    expect(html).toContain("Not a percentage, so the gauge isn");
  });

  it("deleting a dashboard deletes its schedules, and nobody else's", async () => {
    rows("dashboards").push({ id: 2, workspaceId: WS, name: "Other", ownerUserId: ME, layout: [] });
    rows("report_schedules").push(
      { id: 1, workspaceId: WS, dashboardId: 1, frequency: "weekly", recipients: [], enabled: true },
      { id: 2, workspaceId: WS, dashboardId: 2, frequency: "weekly", recipients: [], enabled: true },
      { id: 3, workspaceId: FOREIGN, dashboardId: 1, frequency: "weekly", recipients: [], enabled: true },
    );
    await caller().dashboards.delete({ id: 1 });
    expect(rows("report_schedules").map((s) => s.id).sort()).toEqual([2, 3]);
  });
});

/* ── G58 ──────────────────────────────────────────────────────────────────── */

describe("dashboard numbers are counted in SQL (G58)", () => {
  const seed = () => {
    rows("opportunities").push(
      deal(1, 100, { stage: "won", ownerUserId: ANN, accountId: 1 }),
      deal(2, 50, { stage: "won", ownerUserId: ME, accountId: 2 }),
      deal(3, 30, { stage: "lost", ownerUserId: ANN, accountId: 2 }),
      deal(4, 20, { stage: "discovery", ownerUserId: ANN, accountId: 1 }),
      deal(5, 1000, { stage: "won", workspaceId: FOREIGN }),
    );
    rows("activities").push(
      { id: 1, workspaceId: WS, type: "call", relatedType: "lead", relatedId: 1, actorUserId: ANN, occurredAt: new Date("2026-10-10T12:00:00Z") },
      { id: 2, workspaceId: WS, type: "email", relatedType: "lead", relatedId: 1, actorUserId: ME, occurredAt: new Date("2026-10-11T12:00:00Z") },
    );
    rows("contacts").push(
      { id: 1, workspaceId: WS, firstName: "A", lastName: "A", emailVerificationStatus: "valid" },
      { id: 2, workspaceId: WS, firstName: "B", lastName: "B", emailVerificationStatus: "valid" },
      { id: 3, workspaceId: WS, firstName: "C", lastName: "C", emailVerificationStatus: "risky" },
      { id: 4, workspaceId: WS, firstName: "D", lastName: "D", emailVerificationStatus: null },
      { id: 5, workspaceId: FOREIGN, firstName: "E", lastName: "E", emailVerificationStatus: "valid" },
    );
  };

  it("no widget reads whole rows", async () => {
    seed();
    const seen = watchSelects();
    const types: Array<[string, Record<string, unknown>]> = [
      ["kpi", { metric: "win_rate" }], ["kpi", { metric: "avg_deal" }], ["kpi", { metric: "sales_cycle_length" }],
      ["kpi", { metric: "activity_counts" }], ["kpi", { metric: "response_rate" }], ["kpi", { metric: "reply_rate" }],
      ["funnel", {}], ["bar", { metric: "closed_won" }], ["bar", { metric: "pipeline_created" }], ["bar", { metric: "activities" }],
      ["pie", { metric: "stage_distribution" }], ["donut", {}], ["scatter", {}], ["heatmap", {}], ["table", {}],
      ["leaderboard", {}], ["comparison", {}], ["rep_performance", {}], ["email_health", {}],
    ];
    let id = 100;
    for (const [type, config] of types) await resolve(widget(id++, type, config));
    const whole = seen.filter((s) => s.keys === null && ["opportunities", "activities", "contacts", "accounts"].includes(s.table));
    expect(whole).toEqual([]);
  });

  it("and the numbers are the same numbers", async () => {
    seed();
    expect((await resolve(widget(30, "kpi", { metric: "win_rate" }))).value).toBe(67);
    expect((await resolve(widget(31, "kpi", { metric: "avg_deal" }))).value).toBe(75);
    expect((await resolve(widget(32, "kpi", { metric: "activity_counts" })))).toMatchObject({ value: 2, breakdown: { calls: 1, emails: 1, meetings: 0 } });
    expect((await resolve(widget(33, "kpi", { metric: "reply_rate" }))).value).toBe(75);
    const funnel = await resolve(widget(34, "funnel"));
    expect(funnel.series.filter((s: any) => s.count > 0)).toEqual([{ stage: "discovery", count: 1, value: 20 }, { stage: "won", count: 2, value: 150 }]);
    expect((await resolve(widget(35, "donut"))).series).toEqual([{ name: "Won", value: 2 }, { name: "Lost", value: 1 }, { name: "Open", value: 1 }]);
    expect((await resolve(widget(36, "table"))).rows).toEqual([{ id: 1, name: "Acme", value: 120 }, { id: 2, name: "Globex", value: 80 }]);
    expect((await resolve(widget(37, "leaderboard"))).rows).toEqual([
      { rank: 1, name: "Ann", count: 1, value: 100 }, { rank: 2, name: "Me", count: 1, value: 50 },
    ]);
    expect((await resolve(widget(38, "rep_performance"))).rows).toEqual([
      { name: "Ann", deals: 1, revenue: 100, pipeline: 20, winRate: 50, activities: 1 },
      { name: "Me", deals: 1, revenue: 50, pipeline: 0, winRate: 100, activities: 1 },
    ]);
    expect(await resolve(widget(39, "email_health"))).toMatchObject({ total: 4, valid: 2, risky: 1, unknown: 1, verifiedPct: 75 });
  });

  it("the Dashboard's stat cards count leads, customers and proposals in SQL", async () => {
    for (let i = 1; i <= 5; i++) rows("leads").push({ id: i, workspaceId: WS, firstName: "L", lastName: `${i}`, status: "new", createdAt: new Date("2026-10-10T12:00:00Z") });
    rows("customers").push({ id: 1, workspaceId: WS, accountId: 1, createdAt: new Date("2026-09-01T12:00:00Z") });
    rows("proposals").push({ id: 1, workspaceId: WS, status: "sent", sentAt: new Date("2026-01-01T00:00:00Z"), emailOpenedAt: null, expiresAt: null });
    const seen = watchSelects();
    const stats = await caller().opportunities.dashboardStats();
    expect(stats).toMatchObject({ activeLeads: 5, customerCount: 1, staleProposals: 1 });
    const counted = seen.filter((s) => ["leads", "customers", "proposals"].includes(s.table));
    expect(counted.length).toBeGreaterThan(0);
    expect(counted.every((s) => s.keys?.join() === "n")).toBe(true);
  });

  it("both homes count drafts awaiting review from one query, without their bodies (G56)", async () => {
    const draft = (id: number, o: Record<string, unknown>) => ({ id, workspaceId: WS, subject: `S${id}`, body: "long body", toEmail: `p${id}@example.com`, sequenceId: null, aiGenerated: true, status: "pending_review", ...o });
    rows("email_drafts").push(
      draft(1, {}), draft(2, { sequenceId: 5 }), draft(3, { aiGenerated: false, status: "ai_pending_review" }),
      draft(4, { status: "approved" }), draft(5, { status: "sent" }), draft(6, { workspaceId: FOREIGN }),
    );
    const s = await caller().attention.summary();
    expect(s.awaitingDrafts.count).toBe(3);
    expect(s.awaitingDrafts.count).toBe(s.aiDrafts.count + s.crmDrafts.count + s.sequenceDrafts.count);
    expect(s.awaitingDrafts.items.map((d: any) => d.id)).toEqual([3, 2, 1]);
    expect(Object.keys(s.awaitingDrafts.items[0]!).sort()).toEqual(["id", "subject", "toEmail"]);
    const dash = read("client/src/pages/usip/Dashboard.tsx");
    expect(dash).toContain("trpc.attention.summary.useQuery()");
    expect(dash).not.toContain("trpc.emailDrafts.list.useQuery");
  });
});

/* ── G53 ──────────────────────────────────────────────────────────────────── */

describe("the Dashboard's stat cards (G53)", () => {
  it("Active Leads leaves out the unqualified and the converted", async () => {
    for (const [id, status] of [[1, "new"], [2, "working"], [3, "qualified"], [4, "unqualified"], [5, "converted"]] as const) {
      rows("leads").push({ id, workspaceId: WS, firstName: "L", lastName: `${id}`, status, createdAt: new Date("2026-10-10T12:00:00Z") });
    }
    rows("leads").push({ id: 6, workspaceId: FOREIGN, firstName: "L", lastName: "6", status: "new", createdAt: new Date() });
    expect((await caller().opportunities.dashboardStats()).activeLeads).toBe(3);
  });

  it("a flow compares with the same days of last month, and growth from nothing is null", async () => {
    at("2026-11-03T12:00:00Z");
    const lead = (id: number, iso: string) => ({ id, workspaceId: WS, firstName: "L", lastName: `${id}`, status: "new", createdAt: new Date(iso) });
    rows("leads").push(lead(1, "2026-11-02T12:00:00Z"), lead(2, "2026-10-02T12:00:00Z"), lead(3, "2026-10-20T12:00:00Z"), lead(4, "2026-10-21T12:00:00Z"));
    rows("opportunities").push(deal(1, 10, { stage: "won", wonAt: new Date("2026-11-02T12:00:00Z") }));
    const s = await caller().opportunities.dashboardStats();
    expect(s.leadsThisMonth).toBe(1);
    expect(s.leadsDelta).toBe(0);
    expect(s.closedWonDelta).toBeNull();
  });

  it("recent deals are the newest, in order, and open ones are open by their own pipeline", async () => {
    rows("crm_pipelines").push({ id: 7, workspaceId: WS, name: "Custom", isDefault: false });
    rows("crm_pipeline_stages").push({ id: 1, workspaceId: WS, pipelineId: 7, key: "signed", label: "Signed", sortOrder: 1, isWon: true, isLost: false });
    rows("opportunities").push(
      deal(1, 1, { createdAt: new Date("2026-10-01T00:00:00Z") }),
      deal(2, 2, { createdAt: new Date("2026-10-03T00:00:00Z") }),
      deal(3, 3, { createdAt: new Date("2026-10-02T00:00:00Z"), accountId: 2 }),
      deal(4, 4, { createdAt: new Date("2026-10-04T00:00:00Z"), stage: "signed", pipelineId: 7 }),
      deal(5, 5, { createdAt: new Date("2026-10-05T00:00:00Z"), workspaceId: FOREIGN }),
    );
    const recent = await caller().opportunities.recent({ limit: 3 });
    expect(recent.map((d) => d.id)).toEqual([4, 2, 3]);
    expect(recent[2]).toMatchObject({ value: 3, accountName: "Globex" });
    expect((await caller().opportunities.recent({ openOnly: true, limit: 5 })).map((d) => d.id)).toEqual([2, 3, 1]);
  });

  it("the cards say what they count", () => {
    const src = read("client/src/pages/usip/Dashboard.tsx");
    expect(src).toContain("hint={fmt$(stats?.closedWonValue ?? 0)}");
    expect(src).not.toContain("stats?.totalWonValue");
    expect(src).toContain('deltaLabel="vs same days last month"');
    expect(src).toContain("trpc.opportunities.recent.useQuery({ limit: 6 })");
    // A limit to stay under, not a goal to reach.
    const stale = src.slice(src.indexOf('goalKey="staleProposals"'), src.indexOf('goalKey="staleProposals"') + 200);
    expect(stale).toContain("lowerIsBetter");
    expect(src).toContain("Connections · all time");
  });
});

/* ── G56 ──────────────────────────────────────────────────────────────────── */

describe("two homes, one choice of where to land (G56)", () => {
  // 2026-11-08 (batch CONB, U33): the two homes are one page with two views,
  // and the choice is the person's, on the server (conbHome.test.ts pins the
  // page, the server and the one-time carry-over). What this block protected
  // still holds: a saved value counts only if it is still a home, the
  // dashboard is the default for anyone who never chose, and Dashboards
  // offers both.
  it("a saved home is used only if it is still a home", () => {
    expect(DEFAULT_HOME_VIEW).toBe("pipeline");
    expect(homeViewFrom("/v2/home")).toBe("today");
    expect(homeViewFrom("/dashboard")).toBe("pipeline");
    for (const old of [null, undefined, "/", "/dashboard-home2", "javascript:alert(1)"]) expect(homeViewFrom(old)).toBe(null);
  });

  it("'/' opens the chosen home, and Dashboards offers both", () => {
    expect(read("client/src/App.tsx")).toContain('<Route path="/"><AuthGate><Home /></AuthGate></Route>');
    const page = read("client/src/pages/usip/Dashboards.tsx");
    expect(page).toContain("{HOME_CHOICES.map((p) => {");
    expect(page).toContain("setHomeView(p.view);");
    expect(HOME_CHOICES.map((c) => c.href)).toEqual(["/v2/home?view=today", "/v2/home?view=pipeline"]);
  });

  it("Home's open deals come from the server's reading, not the default pipeline's stages", () => {
    const home = read("client/src/pages/usip/Home.tsx");
    expect(home).toContain("trpc.opportunities.recent.useQuery({ openOnly: true, limit: 5 })");
    expect(home).not.toContain("buildStageIndex");
    expect(home).not.toContain("trpc.opportunities.list.useQuery");
  });
});

/* ── G57 ──────────────────────────────────────────────────────────────────── */

describe("Home and Analytics (G57)", () => {
  it("'Your tasks' asks for the viewer's own open tasks, and gets only those", async () => {
    expect(read("client/src/pages/usip/Home.tsx")).toContain("trpc.tasks.list.useQuery({ ownerOnly: true, status: \"open\" })");
    rows("tasks").push(
      { id: 1, workspaceId: WS, title: "Mine", status: "open", ownerUserId: ME, dueAt: null },
      { id: 2, workspaceId: WS, title: "Ann's", status: "open", ownerUserId: ANN, dueAt: null },
      { id: 3, workspaceId: WS, title: "Mine, done", status: "done", ownerUserId: ME, dueAt: null },
    );
    expect((await caller().tasks.list({ ownerOnly: true, status: "open" })).map((t) => t.id)).toEqual([1]);
  });

  it("no recommendation the data doesn't support", () => {
    const home = read("client/src/pages/usip/Home.tsx");
    expect(home).not.toContain("Authenticate domains");
    expect(home).toContain("Nothing to recommend right now.");
  });

  it("the social funnel gives a rate only where a band is part of the one before", () => {
    const steps = socialFunnelSteps({ invitesSent: 10, invitesAccepted: 5, openersSent: 40, inboundReplies: 60, willingToMeet: 6, meetingsFromSocial: 9 });
    const notes = steps.map((_, i) => socialStepNote(steps, i));
    expect(notes).toEqual(["", "50% conversion", "a different count — no rate", "a different count — no rate", "10% conversion", "a different count — no rate"]);
    expect(notes.join(" ")).not.toMatch(/\d{3,}% conversion/);
    expect(read("client/src/pages/usip/AnalyticsV2.tsx")).toContain("{socialStepNote(socialSteps, i)}");
  });
});

/* ── G69 ──────────────────────────────────────────────────────────────────── */

describe("the small things (G69)", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  };
  const DEF = { pipelineValue: 5, customers: 2 };

  it("goals belong to one workspace, and the old shared key moves into the first that reads it", () => {
    const s = store();
    s.setItem(LEGACY_GOALS_KEY, JSON.stringify({ pipelineValue: 99 }));
    expect(readGoals(s, 2, DEF)).toEqual({ pipelineValue: 99, customers: 2 });
    expect(s.m.has(LEGACY_GOALS_KEY)).toBe(false);
    expect(readGoals(s, 4, DEF)).toEqual(DEF);
    writeGoals(s, 4, { pipelineValue: 7, customers: 2 });
    expect(readGoals(s, 2, DEF).pipelineValue).toBe(99);
    expect(readGoals(s, 4, DEF).pipelineValue).toBe(7);
    expect(Array.from(s.m.keys()).sort()).toEqual([goalsKey(2), goalsKey(4)]);
  });

  it("the Dashboard reads goals per workspace and dates 'Updated' from the data", () => {
    const src = read("client/src/pages/usip/Dashboard.tsx");
    expect(src).toContain("setGoals(readGoals(localStorage, wsId, DEFAULT_GOALS))");
    expect(src).not.toContain('"velocity_dashboard_goals"');
    expect(src).toContain("<UpdatedAgo at={dataUpdatedAt} />");
    const tick = src.slice(src.indexOf("function UpdatedAgo("), src.indexOf("/* ─── Goal progress bar"));
    expect(tick).toContain("setInterval(");
  });

  it("top reps is this month's, with no fall back to all time", async () => {
    at("2026-11-15T12:00:00Z");
    rows("opportunities").push(deal(1, 100, { stage: "won", wonAt: new Date("2026-10-10T12:00:00Z") }));
    expect(await caller().opportunities.topReps()).toEqual([]);
    rows("opportunities").push(deal(2, 5, { stage: "won", ownerUserId: ME, wonAt: new Date("2026-11-10T12:00:00Z") }));
    expect(await caller().opportunities.topReps()).toEqual([{ userId: ME, name: "Me", value: 5, count: 1 }]);
  });

  it("every widget the Add dialog offers is one the server accepts", () => {
    const page = read("client/src/pages/usip/Dashboards.tsx");
    const offered = (block: string) => Array.from(page.slice(page.indexOf(block), page.indexOf("];", page.indexOf(block))).matchAll(/value: "(\w+)"/g)).map((m) => m[1]);
    const ops = read("server/routers/operations.ts");
    const enumBlock = ops.slice(ops.indexOf("addWidget: workspaceProcedure"), ops.indexOf("title: z.string().min(1),", ops.indexOf("addWidget: workspaceProcedure")));
    const accepted = Array.from(enumBlock.matchAll(/"(\w+)"/g)).map((m) => m[1]);
    const all = [...offered("const CHART_TYPES = ["), ...offered("const WIDGET_TYPES = [")];
    expect(all.length).toBeGreaterThan(15);
    expect(all.filter((t) => !accepted.includes(t))).toEqual([]);
  });
});
