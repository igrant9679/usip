/**
 * The dashboard filter bar does what it says, on every date range.
 *
 *   "All time" means no dates, and nothing else: it used to drop Owner, Stage and
 *   Source too · Source reads the lead a deal came from, because it was offered and
 *   never read · Owner reaches activities · a filter a widget can't use is named on
 *   the widget rather than ignored · the Source list is this workspace's own ·
 *   a filter saved on a widget survives an unset one on the bar.
 *
 * Everything runs through the real resolveWidget against the SQL-evaluating fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { filtersNotApplied, widgetFilters } from "@shared/dashboardPresets";

const WS = 2, FOREIGN = 9, ANN = 21, BEN = 22;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

/** Each deal's value is a power of ten, so a sum says exactly which were counted. */
const deal = (id: number, value: number, o: Record<string, unknown> = {}) => ({ id, workspaceId: WS, accountId: 1, name: `D${id}`, stage: "discovery", value, ownerUserId: ANN, daysInStage: 0, createdAt: new Date("2026-10-10T12:00:00Z"), closeDate: null, ...o });
const widget = (id: number, type: string, config: Record<string, unknown> = {}, filters: unknown = null) => {
  rows("dashboard_widgets").push({ id, workspaceId: WS, dashboardId: 1, type, title: `W${id}`, config, filters, position: { x: 0, y: 0, w: 1, h: 1 } });
  return id;
};
const resolve = async (id: number, filters?: Parameters<ReturnType<typeof caller>["dashboards"]["resolveWidget"]>[0]["filters"]) =>
  (await caller().dashboards.resolveWidget({ id, filters })) as any;

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  invalidateStageIndex();
  _clearWorkspaceTimezoneCache();
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("users").push({ id: 1, name: "Me" }, { id: ANN, name: "Ann" }, { id: BEN, name: "Ben" });
  rows("workspace_members").push(
    { id: 1, workspaceId: WS, userId: 1, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    { id: 2, workspaceId: WS, userId: ANN, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    { id: 3, workspaceId: WS, userId: BEN, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
  );
  rows("dashboards").push({ id: 1, workspaceId: WS, name: "D", ownerUserId: 1, layout: [] });
  rows("opportunities").push(
    deal(1, 1, { ownerUserId: ANN, stage: "discovery" }),
    deal(2, 10, { ownerUserId: BEN, stage: "discovery" }),
    deal(3, 100, { ownerUserId: ANN, stage: "negotiation" }),
    deal(4, 1000, { ownerUserId: ANN, stage: "discovery", workspaceId: FOREIGN }),
  );
  rows("leads").push(
    { id: 1, workspaceId: WS, firstName: "A", lastName: "A", source: "webform", convertedOpportunityId: 1 },
    { id: 2, workspaceId: WS, firstName: "B", lastName: "B", source: "event", convertedOpportunityId: 2 },
    { id: 3, workspaceId: WS, firstName: "C", lastName: "C", source: "webform", convertedOpportunityId: null },
    { id: 4, workspaceId: WS, firstName: "D", lastName: "D", source: "  ", convertedOpportunityId: null },
    { id: 5, workspaceId: WS, firstName: "E", lastName: "E", source: null, convertedOpportunityId: null },
    { id: 6, workspaceId: FOREIGN, firstName: "F", lastName: "F", source: "webform", convertedOpportunityId: 3 },
    { id: 7, workspaceId: FOREIGN, firstName: "G", lastName: "G", source: "theirs", convertedOpportunityId: 2 },
  );
  rows("activities").push(
    { id: 1, workspaceId: WS, type: "call", subject: "S", relatedType: "lead", relatedId: 1, actorUserId: ANN, occurredAt: new Date("2026-10-10T12:00:00Z") },
    { id: 2, workspaceId: WS, type: "call", subject: "S", relatedType: "lead", relatedId: 1, actorUserId: BEN, occurredAt: new Date("2026-10-10T12:00:00Z") },
    { id: 3, workspaceId: WS, type: "meeting", subject: "S", relatedType: "lead", relatedId: 1, actorUserId: ANN, occurredAt: new Date("2026-10-11T12:00:00Z") },
    { id: 4, workspaceId: WS, type: "meeting", subject: "S", relatedType: "lead", relatedId: 1, actorUserId: BEN, occurredAt: new Date("2026-10-11T12:00:00Z") },
  );
});

/* ── What the bar sends ──────────────────────────────────────────────────── */

describe("what the filter bar sends a widget", () => {
  it("All time sends no dates, and nothing at all when nothing else is set", () => {
    expect(widgetFilters({ preset: "all" })).toBeUndefined();
    expect(widgetFilters({ preset: "all", dateFrom: "2026-01-01", dateTo: "2026-01-02" })).toBeUndefined();
  });
  it("All time keeps Owner, Stage and Source, which it used to drop", () => {
    expect(widgetFilters({ preset: "all", ownerUserId: ANN, stage: "discovery", source: "webform" })).toEqual({ ownerUserId: ANN, stage: "discovery", source: "webform" });
    expect(widgetFilters({ preset: "all", dateFrom: "2026-01-01", source: "webform" })).toEqual({ source: "webform" });
  });
  it("a date preset sends its dates with the rest", () => {
    expect(widgetFilters({ preset: "7d", dateFrom: "2026-01-01", dateTo: "2026-01-07", stage: "x" })).toEqual({ dateFrom: "2026-01-01", dateTo: "2026-01-07", stage: "x" });
  });
  it("leaves out what's unset, so it can't blank a filter saved on the widget", () => {
    const out = widgetFilters({ preset: "7d", dateFrom: "2026-01-01", ownerUserId: undefined, stage: undefined, source: undefined })!;
    expect(Object.keys(out)).toEqual(["dateFrom"]);
  });
  it("the page uses it", () => {
    const src = read("client/src/pages/usip/Dashboards.tsx");
    expect(src).toContain("const resolvedFilters = useMemo(() => widgetFilters(filters), [filters]);");
    expect(src).not.toContain('if (filters.preset === "all") return undefined;');
  });
});

/* ── What a deal widget does ─────────────────────────────────────────────── */

describe("a deal widget", () => {
  const pipeline = () => widget(10, "kpi", { metric: "pipeline_value" });

  it("with no filters counts this workspace's open deals", async () => {
    expect((await resolve(pipeline())).value).toBe(111);
  });
  it("Owner and Stage apply with no dates, which is what All time now sends", async () => {
    const id = pipeline();
    expect((await resolve(id, widgetFilters({ preset: "all", ownerUserId: BEN }))).value).toBe(10);
    expect((await resolve(id, widgetFilters({ preset: "all", stage: "negotiation" }))).value).toBe(100);
  });
  it("Source reads the lead a deal was converted from", async () => {
    const id = pipeline();
    expect((await resolve(id, { source: "webform" })).value).toBe(1);
    expect((await resolve(id, { source: "event" })).value).toBe(10);
  });
  it("a source with no converted deals counts nothing, not everything", async () => {
    expect((await resolve(pipeline(), { source: "nowhere" })).value).toBe(0);
    expect((await resolve(widget(11, "kpi", { metric: "pipeline_value" }), { source: "  " })).value).toBe(0);
  });
  it("another workspace's lead doesn't lend a deal its source", async () => {
    expect((await resolve(pipeline(), { source: "theirs" })).value).toBe(0);
  });
  it("a deal with no lead isn't in a source's numbers", async () => {
    rows("opportunities").push(deal(5, 10000));
    const id = pipeline();
    expect((await resolve(id)).value).toBe(10111);
    expect((await resolve(id, { source: "webform" })).value).toBe(1);
  });
  it("they combine", async () => {
    expect((await resolve(pipeline(), { source: "webform", ownerUserId: BEN })).value).toBe(0);
  });
  it("a comparison honours Source and Owner", async () => {
    // 2026-11-06 (audit G55): the comparison counts a win by when it was won,
    // as the Dashboard does, not by its expected close date, so the fixture
    // sets wonAt. What this pins, Source and Owner, is unchanged.
    const now = new Date();
    rows("opportunities").find((d) => d.id === 1).stage = "won";
    rows("opportunities").find((d) => d.id === 1).wonAt = now;
    rows("opportunities").find((d) => d.id === 2).stage = "won";
    rows("opportunities").find((d) => d.id === 2).wonAt = now;
    const id = widget(12, "comparison");
    expect((await resolve(id)).current).toBe(11);
    expect((await resolve(id, { source: "event" })).current).toBe(10);
    expect((await resolve(id, { ownerUserId: ANN })).current).toBe(1);
  });
});

/* ── What an activity widget does ────────────────────────────────────────── */

describe("an activity widget", () => {
  it("Owner means who did it, on the KPIs", async () => {
    const all = widget(20, "kpi", { metric: "activity_counts" });
    expect((await resolve(all)).value).toBe(4);
    expect((await resolve(all, { ownerUserId: ANN })).value).toBe(2);
    const meetings = widget(21, "kpi", { metric: "meetings_booked" });
    expect((await resolve(meetings)).value).toBe(2);
    expect((await resolve(meetings, { ownerUserId: BEN })).value).toBe(1);
  });
  it("and on the feed and the heatmap", async () => {
    const feed = widget(22, "activity_feed");
    expect((await resolve(feed, { ownerUserId: ANN })).items.map((a: any) => a.id).sort()).toEqual([1, 3]);
    const heat = widget(23, "heatmap");
    const total = (r: any) => r.series.reduce((n: number, c: any) => n + c.count, 0);
    expect(total(await resolve(heat))).toBe(4);
    expect(total(await resolve(heat, { ownerUserId: BEN }))).toBe(2);
  });
  it("and on the activity chart", async () => {
    const chart = widget(24, "bar", { metric: "activities" });
    const sum = (r: any) => r.series.reduce((n: number, m: any) => n + m.calls + m.meetings, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T12:00:00Z"));
    try {
      expect(sum(await resolve(chart))).toBe(4);
      expect(sum(await resolve(chart, { ownerUserId: ANN }))).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("still keeps its dates", async () => {
    const all = widget(25, "kpi", { metric: "activity_counts" });
    expect((await resolve(all, { dateFrom: "2026-10-11", dateTo: "2026-10-11", ownerUserId: ANN })).value).toBe(1);
  });
});

describe("the rep table", () => {
  it("with an Owner picked lists that person alone, not everyone who has activities", async () => {
    const id = widget(30, "rep_performance");
    const r = await resolve(id, { ownerUserId: BEN });
    expect(r.rows.map((x: any) => x.name)).toEqual(["Ben"]);
    expect(r.rows[0].activities).toBe(2);
  });
  it("counts activities in the dates picked", async () => {
    const r = await resolve(widget(31, "rep_performance"), { dateFrom: "2026-10-11", dateTo: "2026-10-11" });
    expect(r.rows.every((x: any) => x.activities === 1)).toBe(true);
  });
});

/* ── Saying so ───────────────────────────────────────────────────────────── */

describe("a filter a widget can't use is named on it", () => {
  const all = { dateFrom: "2026-01-01", ownerUserId: ANN, stage: "x", source: "y" };

  it.each([
    ["a deal KPI", "kpi", { metric: "pipeline_value" }, []],
    ["a funnel", "funnel", {}, []],
    ["a table", "table", {}, []],
    ["a leaderboard", "leaderboard", {}, []],
    ["an activity KPI", "kpi", { metric: "activity_counts" }, ["Stage", "Source"]],
    ["meetings booked", "single_value", { metric: "meetings_booked" }, ["Stage", "Source"]],
    ["the activity chart", "line", { metric: "activities" }, ["Stage", "Source"]],
    ["a deal chart", "line", { metric: "revenue" }, []],
    ["the feed", "activity_feed", {}, ["Stage", "Source"]],
    ["the heatmap", "heatmap", {}, ["Stage", "Source"]],
    ["a comparison", "comparison", {}, ["Dates", "Stage"]],
    ["email health", "email_health", {}, ["Dates", "Owner", "Stage", "Source"]],
    ["the proposal funnel", "proposal_expiry_funnel", {}, ["Dates", "Owner", "Stage", "Source"]],
  ])("%s", (_n, type, config, want) => {
    expect(filtersNotApplied({ type, config }, all)).toEqual(want);
  });

  it("only names what's actually on", () => {
    expect(filtersNotApplied({ type: "heatmap" }, {})).toEqual([]);
    expect(filtersNotApplied({ type: "heatmap" }, { source: "y" })).toEqual(["Source"]);
    expect(filtersNotApplied({ type: "email_health" }, { dateTo: "2026-01-01" })).toEqual(["Dates"]);
  });

  it("the real procedure returns it, counting a filter saved on the widget", async () => {
    expect((await resolve(widget(40, "heatmap"), { stage: "x" })).notApplied).toEqual(["Stage"]);
    expect((await resolve(widget(41, "kpi", { metric: "pipeline_value" }), { stage: "discovery" })).notApplied).toEqual([]);
    expect((await resolve(widget(42, "heatmap", {}, { source: "webform" }))).notApplied).toEqual(["Source"]);
  });

  it("the widget shows it", () => {
    const src = read("client/src/pages/usip/Dashboards.tsx");
    expect(src).toContain("{(data as any)?.notApplied?.length > 0 && (");
    expect(src).toContain("Not filtered by {(data as any).notApplied.join(\" or \")}");
  });
});

/* ── A filter saved on a widget ──────────────────────────────────────────── */

describe("a filter saved on a widget", () => {
  it("stands when the bar has nothing to say about it", async () => {
    const id = widget(50, "kpi", { metric: "pipeline_value" }, { ownerUserId: BEN });
    expect((await resolve(id)).value).toBe(10);
    expect((await resolve(id, { stage: "discovery", ownerUserId: undefined })).value).toBe(10);
  });
  it("gives way when the bar sets the same one", async () => {
    const id = widget(51, "kpi", { metric: "pipeline_value" }, { ownerUserId: BEN });
    expect((await resolve(id, { ownerUserId: ANN })).value).toBe(101);
  });
});

/* ── The Source list ─────────────────────────────────────────────────────── */

describe("the Source list", () => {
  it("is what this workspace's leads have: not blanks, not nulls, not another workspace's", async () => {
    expect(await caller().dashboards.leadSources()).toEqual(["event", "webform"]);
  });
  it("the bar uses it, in place of a fixed list leads could never match", () => {
    const src = read("client/src/components/usip/DashboardFilterBar.tsx");
    expect(src).toContain("const sources = trpc.dashboards.leadSources.useQuery(undefined, { staleTime: 60_000 });");
    expect(src).toContain("{(sources.data ?? []).map((s) => (");
    expect(src).not.toContain("const SOURCES = [");
    expect(src).not.toContain('value: "cold_call"');
  });
});
