/**
 * One deal board (audit 2026-10-20, U13 and X6.3; batch CONB, 2026-11-08).
 *
 *   /v2/deals folded into /pipeline and redirects (hash kept). The board has
 *   the pipeline switcher, drag and a Move menu (both through the lost-reason
 *   prompt), owner and close-date filters as controls, CRMP's paging with
 *   "Show more" on closed columns, closed columns that fold, and /v2/deals'
 *   autopilot, header numbers, commentary, alerts and confetti. The close
 *   range is part of the board's scope on the server, so the columns, counts,
 *   header numbers, forecast and AI snapshots count the same deals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => ({
  db: null as any,
  queries: {} as Record<string, unknown>,
  inputs: {} as Record<string, unknown[]>,
  calls: [] as Array<{ path: string; vars: any }>,
  asks: [] as Array<{ v: any; meta: any }>,
  confirms: [] as Array<{ opts: any; fn: () => void }>,
  items: [] as any[],
  search: "",
  nav: [] as string[],
}));

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("@/lib/trpc", () => {
  const proc = (path: string) => ({
    useQuery: (input: any) => {
      (h.inputs[path] ??= []).push(input);
      const q = h.queries[path];
      return (typeof q === "function" ? q(input) : q) ?? { data: undefined, isLoading: false, error: null };
    },
    useMutation: () => ({ mutate: (vars: any) => { h.calls.push({ path, vars }); }, isPending: false }),
  });
  const leaf = { invalidate: () => {}, cancel: async () => {}, getData: () => undefined, setData: () => {}, fetch: async () => [] };
  const utils = new Proxy({}, { get: () => new Proxy({}, { get: () => leaf }) });
  return {
    trpc: new Proxy({ useUtils: () => utils } as Record<string, unknown>, {
      get: (t, r: string) => (r in t ? t[r] : new Proxy({}, { get: (_u, p: string) => proc(`${r}.${p}`) })),
    }),
  };
});
vi.mock("@/components/usip/Shell", async () => {
  const { createElement: el } = await import("react");
  return {
    Shell: ({ children }: any) => el("main", null, children),
    PageHeader: ({ title, description, children }: any) => el("header", null, el("h1", null, title), el("p", null, description), children),
  };
});
vi.mock("wouter", async () => {
  const { createElement: el } = await import("react");
  return {
    Link: ({ href, children, className }: any) => el("a", { href, className }, children),
    useLocation: () => ["/pipeline", (to: string) => { h.nav.push(to); }],
    useSearch: () => h.search,
  };
});
vi.mock("@/hooks/usePermissions", () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock("@/components/usip/RecordDrawer", () => ({ RecordDrawer: () => null }));
vi.mock("@/components/usip/NewOpportunityDialog", () => ({ NewOpportunityDialog: () => null }));
vi.mock("@/components/usip/QueryState", () => ({ FailedLoadsBanner: () => null }));
vi.mock("@/components/usip/LostReasonDialog", () => ({
  useLostReasonPrompt: () => ({ ask: (v: any, meta: any) => { h.asks.push({ v, meta }); }, dialog: null }),
}));
vi.mock("@/components/usip/Common", () => ({
  fmt$: (n: number) => `$${n}`,
  confirmAction: (opts: any, fn: () => void) => { h.confirms.push({ opts, fn }); },
}));
vi.mock("@/components/ui/dropdown-menu", async () => {
  const { createElement: el } = await import("react");
  const pass = ({ children }: any) => el("div", null, children);
  return {
    DropdownMenu: pass, DropdownMenuTrigger: pass, DropdownMenuContent: pass, DropdownMenuLabel: pass,
    DropdownMenuItem: (props: any) => { h.items.push(props); return el("div", { role: "menuitem" }, props.children); },
  };
});
vi.mock("@/components/ui/select", async () => {
  const { createElement: el } = await import("react");
  const pass = ({ children }: any) => el("div", null, children);
  return { Select: pass, SelectTrigger: ({ children, ...p }: any) => el("div", { "aria-label": p["aria-label"] }, children), SelectValue: () => null, SelectContent: pass, SelectItem: pass };
});
vi.mock("@/components/ui/tooltip", async () => {
  const { createElement: el } = await import("react");
  const pass = ({ children }: any) => el("span", null, children);
  return { Tooltip: pass, TooltipContent: () => null, TooltipProvider: pass, TooltipTrigger: pass };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import { closeRangeBounds } from "./services/dealMetrics";
import Pipeline from "../client/src/pages/usip/Pipeline";
import { CLOSE_RANGE_OPTIONS, DEAL_AUTOPILOT_MODES, closeRangeFrom } from "../client/src/lib/dealAutopilot";
import { RETIRED_ROUTES, retiredRedirectUrl } from "../client/src/lib/retiredRoutes";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const WS = 2, ME = 1, REP = 3;
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u1", email: "u1@example.com", name: "Me", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
/** Wednesday 2026-11-18, noon New York. */
const NOW = new Date("2026-11-18T17:00:00Z");
const day = (d: string) => new Date(`${d}T12:00:00Z`);

describe("the close-date ranges, in days", () => {
  it("this month, the fiscal quarter, the next 90 days, passed, none", () => {
    const ny = "America/New_York";
    expect(closeRangeBounds("this_month", ny, NOW)).toEqual({ from: new Date("2026-11-01T00:00:00Z"), before: new Date("2026-12-01T00:00:00Z") });
    expect(closeRangeBounds("this_quarter", ny, NOW)).toEqual({ from: new Date("2026-10-01T00:00:00Z"), before: new Date("2027-01-01T00:00:00Z") });
    // A fiscal year from February: the quarter is Nov–Jan.
    expect(closeRangeBounds("this_quarter", ny, NOW, 2)).toEqual({ from: new Date("2026-11-01T00:00:00Z"), before: new Date("2027-02-01T00:00:00Z") });
    expect(closeRangeBounds("next_90", ny, NOW)).toEqual({ from: new Date("2026-11-18T00:00:00Z"), before: new Date("2027-02-16T00:00:00Z") });
    expect(closeRangeBounds("overdue", ny, NOW)).toEqual({ before: new Date("2026-11-18T00:00:00Z") });
    expect(closeRangeBounds("none", ny, NOW)).toEqual({ none: true });
  });
  it("'today' is the workspace's day: 11pm in Los Angeles is still the 18th there", () => {
    const late = new Date("2026-11-19T07:00:00Z");
    expect(closeRangeBounds("overdue", "America/Los_Angeles", late).before).toEqual(new Date("2026-11-18T00:00:00Z"));
    expect(closeRangeBounds("overdue", "UTC", late).before).toEqual(new Date("2026-11-19T00:00:00Z"));
  });
  it("the client offers exactly the server's ranges, and a stray ?close= is no filter", () => {
    expect(CLOSE_RANGE_OPTIONS.map((o) => o.value).filter(Boolean)).toEqual(["overdue", "this_month", "this_quarter", "next_90", "none"]);
    expect(closeRangeFrom("this_month")).toBe("this_month");
    expect(closeRangeFrom("drop table")).toBeUndefined();
  });
});

describe("every board read takes the close-date range", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    h.db = makeSqlFakeDb({ realMembers: true });
    invalidateStageIndex();
    _clearWorkspaceTimezoneCache();
    rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: ME, archivedAt: null, plan: "trial" });
    rows("users").push({ id: ME, name: "Me" }, { id: REP, name: "Rep" });
    rows("workspace_members").push(
      { id: 1, workspaceId: WS, userId: ME, role: "admin", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
      { id: 2, workspaceId: WS, userId: REP, role: "rep", deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() },
    );
    rows("workspace_settings").push({ id: 1, workspaceId: WS, timezone: "America/New_York", fiscalYearStartMonth: 1, currency: "USD" });
    rows("crm_pipelines").push({ id: 1, workspaceId: WS, name: "Default", isDefault: true, sortOrder: 0 });
    rows("crm_pipeline_stages").push(
      { id: 11, workspaceId: WS, pipelineId: 1, key: "discovery", label: "Discovery", sortOrder: 10, defaultWinProb: 20, isWon: false, isLost: false },
      { id: 15, workspaceId: WS, pipelineId: 1, key: "signed", label: "Signed", sortOrder: 50, defaultWinProb: 100, isWon: true, isLost: false },
    );
    rows("accounts").push({ id: 1, workspaceId: WS, name: "Acme" });
    const deal = (id: number, closeDate: Date | null, o: Record<string, unknown> = {}) => rows("opportunities").push({
      id, workspaceId: WS, accountId: 1, name: `Deal ${id}`, stage: "discovery", value: String(id * 100), winProb: 50,
      closeDate, pipelineId: 1, stageEnteredAt: new Date(), ownerUserId: ME, createdAt: new Date(), updatedAt: new Date(), ...o,
    });
    deal(1, day("2026-11-25"));
    deal(2, day("2026-12-10"));
    deal(3, day("2026-10-05"));
    deal(4, null);
    deal(5, day("2026-11-03"), { stage: "signed", ownerUserId: REP });
  });
  afterEach(() => { vi.useRealTimers(); });

  it("the board's columns", async () => {
    const ids = async (closeRange?: any) => (await caller().opportunities.board({ pipelineId: 1, closeRange })).map((d: any) => d.id).sort();
    expect(await ids()).toEqual([1, 2, 3, 4, 5]);
    expect(await ids("this_month")).toEqual([1, 5]);
    expect(await ids("this_quarter")).toEqual([1, 2, 3, 5]);
    expect(await ids("overdue")).toEqual([3, 5]);
    expect(await ids("next_90")).toEqual([1, 2]);
    expect(await ids("none")).toEqual([4]);
  });

  it("the column counts and the header numbers count the same deals", async () => {
    const totals = await caller().opportunities.boardTotals({ pipelineId: 1, closeRange: "this_month" });
    expect(totals.find((t) => t.stage === "discovery")?.count).toBe(1);
    expect(totals.find((t) => t.stage === "signed")?.count).toBe(1);
    const s = await caller().opportunities.summary({ pipelineId: 1, closeRange: "this_month" });
    expect(s.open).toMatchObject({ count: 1, value: 100 });
    expect(s.won.count).toBe(1);
    expect((await caller().opportunities.summary({ pipelineId: 1 })).open.count).toBe(4);
  });

  it("the forecast and the export do too, with the owner filter beside it", async () => {
    expect((await caller().opportunities.forecast({ pipelineId: 1, closeRange: "this_quarter" })).grandTotal).toBe(600);
    expect((await caller().opportunities.boardExport({ pipelineId: 1, closeRange: "none" })).map((r: any) => r.id)).toEqual([4]);
    expect((await caller().opportunities.board({ pipelineId: 1, ownerUserId: REP, closeRange: "this_month" })).map((d: any) => d.id)).toEqual([5]);
  });

  it("the AI snapshots for the board read its scope", async () => {
    rows("opportunity_intelligence").push(
      { id: 1, workspaceId: WS, opportunityId: 1, winProbability: "60", generatedAt: new Date() },
      { id: 2, workspaceId: WS, opportunityId: 2, winProbability: "30", generatedAt: new Date() },
    );
    const intel = await caller().oppIntelligence.getIntelligenceForBoard({ pipelineId: 1, closeRange: "this_month" });
    expect(intel.map((i: any) => i.opportunityId)).toEqual([1]);
  });

  it("only a named range is accepted", async () => {
    await expect(caller().opportunities.board({ pipelineId: 1, closeRange: "1=1" as any })).rejects.toThrow();
  });
});

/* ── the page ──────────────────────────────────────────────────────────── */

const STAGES = [
  { key: "discovery", label: "Discovery", isWon: false, isLost: false, defaultWinProb: 20 },
  { key: "negotiation", label: "Negotiation", isWon: false, isLost: false, defaultWinProb: 60 },
  { key: "signed", label: "Signed", isWon: true, isLost: false, defaultWinProb: 100 },
  { key: "lost", label: "Lost", isWon: false, isLost: true, defaultWinProb: 0 },
];
function render(search = "", folded = false): string {
  h.search = search;
  h.items = [];
  h.inputs = {};
  (globalThis as any).localStorage = { getItem: (k: string) => (k === "velocity_board_closed_folded" && folded ? "1" : null), setItem: () => {} };
  return renderToStaticMarkup(createElement(Pipeline));
}

describe("the one board's screen", () => {
  beforeEach(() => {
    h.calls = [];
    h.asks = [];
    h.confirms = [];
    h.nav = [];
    h.queries = {
      "crmPipelines.list": { data: [{ id: 1, name: "Default", isDefault: true }, { id: 2, name: "Renewals", isDefault: false }] },
      "crmPipelines.get": { data: { stages: STAGES } },
      "opportunities.board": { data: [
        { id: 7, name: "Acme expansion", stage: "discovery", value: 5000, winProb: 20, accountName: "Acme" },
        { id: 8, name: "Globex renewal", stage: "signed", value: 9000, winProb: 100, accountName: "Globex" },
      ], isLoading: false },
      "opportunities.boardTotals": { data: [{ stage: "discovery", count: 1, value: 5000, avgWinProb: 20 }, { stage: "signed", count: 120, value: 900000, avgWinProb: 100 }] },
      "opportunities.summary": { data: { open: { count: 1, value: 5000, weighted: 1000 }, won: { count: 120 } } },
      "oppIntelligence.getIntelligenceForBoard": { data: [] },
      "deals.getAutopilotSettings": { data: { mode: "approval" } },
      "forecastAi.getCommentary": { data: { commentary: "Pipeline steady." } },
      "pipelineAlerts.list": { data: [{ id: 1, opportunityId: 7, alertType: "stale_deal", opportunity: { name: "Acme expansion" } }], isFetched: true },
      "team.list": { data: [{ userId: 1, name: "Me" }, { userId: 3, name: "Rita Rep" }, { userId: 4, name: "Gone", deactivatedAt: new Date() }] },
    };
  });
  afterEach(() => { delete (globalThis as any).localStorage; });

  it("owner and close date are labelled controls that read and write the URL", () => {
    const html = render("?owner=3&close=this_month");
    expect(html).toContain('<label for="board-owner"');
    expect(html).toMatch(/<select id="board-owner"[^>]*>.*<option value="3" selected="">Rita Rep<\/option>/s);
    expect(html).not.toContain(">Gone</option>");
    expect(html).toMatch(/<select id="board-close"[^>]*>.*<option value="this_month" selected="">Closing this month<\/option>/s);
    expect(html).toContain("Showing deals for Rita Rep.");
    // Both go to the server as the board's scope, with the closed columns' page size.
    expect(h.inputs["opportunities.board"]?.at(-1)).toEqual({ ownerUserId: 3, pipelineId: 1, closeRange: "this_month", closedLimit: 50 });
    expect(h.inputs["opportunities.boardTotals"]?.at(-1)).toEqual({ ownerUserId: 3, pipelineId: 1, closeRange: "this_month" });
    expect(h.inputs["opportunities.summary"]?.at(-1)).toEqual({ ownerUserId: 3, pipelineId: 1, closeRange: "this_month" });
  });

  it("a filter change keeps the other filter", () => {
    const src = read("client/src/pages/usip/Pipeline.tsx");
    const set = src.slice(src.indexOf("const setFilterParam = "), src.indexOf("const { data: team }"));
    expect(set).toContain("const p = new URLSearchParams(search);");
    expect(set).toContain("if (value) p.set(key, value); else p.delete(key);");
    expect(src).toContain('onChange={(e) => setFilterParam("close", e.target.value || null)}');
    expect(src).toContain('onChange={(e) => setFilterParam("owner", e.target.value || null)}');
  });

  it("every card has a Move menu to any other stage, and it goes through the lost-reason prompt", () => {
    render();
    const moves = h.items.filter((i) => JSON.stringify(i.children).includes("Lost") || JSON.stringify(i.children).includes("Negotiation"));
    expect(moves.length).toBeGreaterThan(0);
    const toLost = h.items.find((i) => JSON.stringify(i.children).includes('"Lost"'));
    toLost.onClick();
    expect(h.asks.at(-1)).toMatchObject({ v: { id: 7, stage: "lost" }, meta: { isLost: true, dealName: "Acme expansion" } });
    // Not a direct write: the menu only asks.
    expect(h.calls.some((c) => c.path === "opportunities.setStage")).toBe(false);
  });

  it("a closed column cut at its latest deals offers the next page", () => {
    const html = render();
    expect(html).toContain("The latest 1 of 120 shown.");
    expect(html).toMatch(/<button[^>]*>Show 50 more<\/button>/);
  });

  it("closed columns fold, and a folded one still names itself and its count", () => {
    expect(render()).toContain('aria-label="Fold the closed columns"');
    const folded = render("", true);
    expect(folded).toContain('aria-label="Show the Signed column (120)"');
    expect(folded).toContain('aria-label="Show the Lost column (0)"');
    expect(folded).not.toContain("Globex renewal");
    expect(folded).toContain("Acme expansion");
  });

  it("the autopilot, header numbers, commentary and alerts came across from /v2/deals", () => {
    const html = render();
    expect(html).toContain(DEAL_AUTOPILOT_MODES.approval.label);
    expect(html).toContain(DEAL_AUTOPILOT_MODES.approval.blurb);
    expect(html).toContain('aria-label="Deal Autopilot"');
    expect(html).toContain("Open deals");
    expect(html).toContain("Pipeline steady.");
    expect(html).toContain('<div id="alerts"');
    expect(html).toContain('href="/opportunities/7"');
  });

  it("Analyze with AI says how many AI calls it makes and asks first", () => {
    render();
    const src = read("client/src/pages/usip/Pipeline.tsx");
    expect(src).toContain("onClick={() => confirmAction({");
    expect(h.confirms).toHaveLength(0);
    // The handler is the confirm; pressing it records the question, and only its OK runs the analysis.
    const block = src.slice(src.indexOf("title: `Analyze up to ${ANALYZE_LIMIT} open deals with AI?`"), src.indexOf('<Sparkles className="size-3.5" /> {analyze.isPending'));
    expect(block).toContain("One AI call per deal, up to ${ANALYZE_LIMIT}");
    expect(block).toContain("() => analyze.mutate({ limit: ANALYZE_LIMIT })");
  });

  it("a deal moved to a won stage gets the confetti", () => {
    const src = read("client/src/pages/usip/Pipeline.tsx");
    expect(src).toContain("if (STAGES.find((s) => s.id === vars.stage)?.isWon) { setCelebrate(Date.now()); setTimeout(() => setCelebrate(0), 1800); }");
    expect(src).toContain("{celebrate > 0 && <WonConfetti />}");
  });
});

describe("/v2/deals is retired into /pipeline, folding first", () => {
  it("redirects with its query and hash", () => {
    expect(RETIRED_ROUTES["/v2/deals"]).toBe("/pipeline");
    expect(retiredRedirectUrl("/v2/deals", { search: "?owner=3" })).toBe("/pipeline?owner=3");
    expect(read("client/src/pages/usip/RetiredRedirect.tsx")).toContain("const hash = typeof window !== \"undefined\" ? window.location.hash : \"\";");
    expect(read("client/src/App.tsx")).toContain('<Route path="/v2/deals"><AuthGate><RetiredRedirect from="/v2/deals" /></AuthGate></Route>');
  });
  it("the old page file stays, unrouted", () => {
    expect(read("client/src/App.tsx")).toContain('const DealsV2 = lazyChunk(() => import("@/pages/usip/DealsV2"));');
  });
  it("links that went to /v2/deals go to the board", () => {
    for (const f of ["client/src/pages/usip/CompanyProfile.tsx", "client/src/pages/usip/Home.tsx", "client/src/pages/usip/OpportunityDetail.tsx", "client/src/pages/usip/WorkflowsV2.tsx", "client/src/lib/toolRegistry.ts", "client/src/lib/helpText.ts", "server/seedHelpContent.ts"]) {
      expect(read(f), f).not.toContain('"/v2/deals');
    }
  });
});
