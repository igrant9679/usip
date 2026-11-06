/**
 * Deals, the deal page, the boards and the forecast (audit 2026-10-20, batch Ra).
 *
 *   R32 — deleting a deal deletes what its confirmation names, in one
 *         transaction, in this workspace only.
 *   R34 — a line item shows its product and its stored (discounted) total.
 *   R35 — line items and contact roles can be added and removed on the deal
 *         page; the procedures check every id against the workspace.
 *   L7, R66 — a board reads one pipeline's deals, their accounts' names and
 *         their latest AI snapshot, not the workspace's.
 *   R30 — the owner filter is read from the query string and the optimistic
 *         move writes the cache entry on screen.
 *   R36 — a new deal needs an account, starts in the pipeline's first open
 *         stage, and an empty Win % is the stage's default.
 *   R39 — the forecast tab, the CSV and the Deals header count what their
 *         board shows.
 *   R82 — only a dragged card moves a deal.
 *   R43 — the Deals autopilot copy and the Analyze result say what it does.
 *   R103 — the Deals board adds deals; its alert chips open them; #alerts lands.
 *   R42 — territory rules match ignoring case, also route the account a lead
 *         conversion creates, and are confirmed before deletion; the page says
 *         what they do and shows no unread JSON.
 *   R40 — AI suggestions are this pipeline's open stages; a failure throws and
 *         saves nothing; a closed deal's win % is left alone.
 *   R41 — a rep's forecast is their own; a deal's forecast category decides
 *         Commit and Best case, and an unmarked deal keeps the win % rule.
 *
 * Procedures run through the real router against the SQL-evaluating fake;
 * screens render with a stub trpc.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return {
    db: null as any,
    data: {} as Record<string, unknown>,
    // The model: what it was asked, and what it answers (or throws).
    llmCalls: [] as any[],
    llm: (() => ({})) as (args: any) => unknown,
  };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async (args: any) => {
    h.llmCalls.push(args);
    return { choices: [{ message: { content: JSON.stringify(h.llm(args)) } }] };
  },
}));
vi.mock("@/lib/trpc", () => {
  const noop: any = new Proxy(() => undefined, { get: () => noop, apply: () => undefined });
  const node = (path: string[]): any => new Proxy({}, {
    get(_t, key: string) {
      if (key === "useQuery") return () => ({ data: h.data[path.join(".")], isLoading: false, isError: false });
      if (key === "useMutation") return () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false });
      if (key === "useUtils") return () => noop;
      return node([...path, key]);
    },
  });
  return { trpc: node([]) };
});

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { _clearWorkspaceTimezoneCache } from "./services/workspaceTimezone";
import { OPPORTUNITY_DELETE_SCOPE } from "@shared/dealDelete";
import { DealContactRoles, DealLineItems } from "../client/src/pages/usip/OpportunityDetail";
import { DEAL_DRAG_TYPE, droppedDealId } from "../client/src/pages/usip/Pipeline";
import { firstOpenStage, newOpportunityInput } from "../client/src/components/usip/NewOpportunityDialog";
import { analyzeToast } from "../client/src/pages/usip/DealsV2";

const WS = 2, OTHER = 9, ME = 1, REP = 3, MANAGER = 4;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = (userId = ME, ws = WS) => appRouter.createCaller({
  user: { id: userId, openId: `u${userId}`, email: `u${userId}@example.com`, name: `U${userId}`, loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const page = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(Router, { ssrPath: "/opportunities/1" }, el));
const member = (id: number, userId: number, role: string, ws = WS) =>
  ({ id, workspaceId: ws, userId, role, deactivatedAt: null, inviteToken: null, lastActiveAt: new Date() });
const deal = (id: number, o: Record<string, unknown> = {}) => rows("opportunities").push({
  id, workspaceId: WS, accountId: 1, name: `Deal ${id}`, stage: "discovery", value: "10000", winProb: 20,
  closeDate: null, pipelineId: 1, daysInStage: 0, stageEnteredAt: new Date(), ownerUserId: ME, ...o,
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ realMembers: true });
  h.data = {};
  invalidateStageIndex();
  _clearWorkspaceTimezoneCache();
  rows("workspaces").push(
    { id: WS, name: "W", slug: "w", ownerUserId: ME, archivedAt: null, plan: "trial" },
    { id: OTHER, name: "O", slug: "o", ownerUserId: ME, archivedAt: null, plan: "trial" },
  );
  rows("users").push({ id: ME, name: "Me" }, { id: REP, name: "Rep" }, { id: MANAGER, name: "Manager" });
  rows("workspace_members").push(member(1, ME, "admin"), member(2, REP, "rep"), member(3, MANAGER, "manager"), member(4, ME, "admin", OTHER));
  rows("crm_pipelines").push({ id: 1, workspaceId: WS, name: "Default", isDefault: true, sortOrder: 0 });
  rows("crm_pipeline_stages").push(
    { id: 11, workspaceId: WS, pipelineId: 1, key: "discovery", label: "Discovery", sortOrder: 10, defaultWinProb: 20, isWon: false, isLost: false },
    { id: 12, workspaceId: WS, pipelineId: 1, key: "negotiation", label: "Negotiation", sortOrder: 20, defaultWinProb: 75, isWon: false, isLost: false },
    { id: 15, workspaceId: WS, pipelineId: 1, key: "signed", label: "Signed", sortOrder: 50, defaultWinProb: 100, isWon: true, isLost: false },
  );
  rows("accounts").push({ id: 1, workspaceId: WS, name: "Acme" }, { id: 2, workspaceId: OTHER, name: "Theirs" });
});

/* ── R32 ───────────────────────────────────────────────────────────────── */

describe("R32: deleting a deal deletes what the confirmation names", () => {
  const CHILDREN = ["deal_line_items", "opportunity_contact_roles", "opportunity_stage_history", "opportunity_intelligence", "stage_approvals", "pipeline_alerts"];
  beforeEach(() => {
    deal(1);
    deal(2);
    for (const opp of [1, 2]) {
      for (const t of CHILDREN) rows(t).push({ id: opp * 10, workspaceId: WS, opportunityId: opp });
      rows("quotes").push({ id: opp * 10, workspaceId: WS, opportunityId: opp });
      rows("quote_line_items").push({ id: opp * 10, quoteId: opp * 10 });
    }
    // Another workspace's rows that name the same deal id are not this one's.
    for (const t of CHILDREN) rows(t).push({ id: 99, workspaceId: OTHER, opportunityId: 1 });
  });

  it("the deal, its line items, roles, quotes, history and alerts go; the next deal's and another workspace's stay", async () => {
    await caller().opportunities.delete({ id: 1 });
    expect(rows("opportunities").map((o) => o.id)).toEqual([2]);
    for (const t of CHILDREN) {
      expect(rows(t).map((r) => `${r.workspaceId}:${r.opportunityId}`).sort(), t).toEqual([`${WS}:2`, `${OTHER}:1`]);
    }
    expect(rows("quotes").map((q) => q.opportunityId)).toEqual([2]);
    expect(rows("quote_line_items").map((q) => q.quoteId)).toEqual([20]);
    expect(h.db.txLog.committed).toBe(1);
  });

  it("one transaction: a failure part-way leaves the deal and all of its rows", async () => {
    // The fifth delete is the stage history's: quote lines, quotes, line items
    // and roles are already gone when it fails.
    const real = h.db.delete;
    let n = 0;
    h.db.delete = (t: any) => ({ where: (c: unknown) => { if (++n === 5) throw new Error("boom"); return real(t).where(c); } });
    await expect(caller().opportunities.delete({ id: 1 })).rejects.toThrow("boom");
    expect(rows("opportunities").map((o) => o.id)).toEqual([1, 2]);
    for (const t of CHILDREN) expect(rows(t).filter((r) => r.workspaceId === WS && r.opportunityId === 1), t).toHaveLength(1);
    expect(h.db.txLog.rolledBack).toBe(1);
  });

  it("another workspace's deal is not found, and nothing is touched", async () => {
    rows("opportunities").push({ id: 7, workspaceId: OTHER, accountId: 2, name: "Theirs", stage: "discovery", value: "1" });
    await expect(caller().opportunities.delete({ id: 7 })).rejects.toThrow(/not found/i);
    expect(rows("opportunities").map((o) => o.id)).toEqual([1, 2, 7]);
  });

  it("both confirmations name exactly what is deleted", () => {
    expect(OPPORTUNITY_DELETE_SCOPE).toBe("along with its line items, contact roles, quotes, stage history and alerts");
    expect(read("client/src/pages/usip/OpportunityDetail.tsx")).toContain("will be permanently deleted, ${OPPORTUNITY_DELETE_SCOPE}.");
    expect(read("client/src/components/usip/RecordDrawer.tsx")).toContain("will be permanently deleted, ${OPPORTUNITY_DELETE_SCOPE}.");
  });
});

/* ── R34, R35 ──────────────────────────────────────────────────────────── */

describe("R34: a line shows its product and its stored total", () => {
  it("the product's name, the discount, and the line total the server stored", async () => {
    deal(1);
    rows("products").push({ id: 4, workspaceId: WS, sku: "SEAT", name: "Seat licence", listPrice: "100", active: true });
    await caller().opportunities.addLineItem({ opportunityId: 1, productId: 4, quantity: 3, unitPrice: 100, discountPct: 10 });
    const items = await caller().opportunities.listLineItems({ opportunityId: 1 });
    expect(items[0]).toMatchObject({ lineTotal: "270.00", product: { name: "Seat licence" } });
    const html = page(createElement(DealLineItems, { opportunityId: 1, items, onChanged: () => {} }));
    expect(html).toContain("Seat licence");
    expect(html).toContain("$270.00");
    expect(html).toContain("− 10%");
    expect(html).not.toContain("Item #");
    expect(html).not.toContain("$300");
  });

  it("a line whose product was deleted says so instead of a bare id", () => {
    const html = page(createElement(DealLineItems, {
      opportunityId: 1, onChanged: () => {},
      items: [{ id: 1, productId: 8, product: null, quantity: 1, unitPrice: "5.00", discountPct: "0", lineTotal: "5.00" }],
    }));
    expect(html).toContain("Product #8 (removed)");
  });
});

describe("R35: the deal page adds and removes line items and contact roles", () => {
  it("offers a product picker and an add form, and a remove on each line", () => {
    h.data["products.list"] = [{ id: 4, name: "Seat licence", sku: "SEAT", listPrice: "100", active: true }, { id: 5, name: "Old", active: false }];
    const html = page(createElement(DealLineItems, {
      opportunityId: 1, onChanged: () => {},
      items: [{ id: 1, productId: 4, product: { name: "Seat licence" }, quantity: 1, unitPrice: "100", discountPct: "0", lineTotal: "100.00" }],
    }));
    expect(html).toContain('aria-label="Product"');
    expect(html).toContain("Seat licence (SEAT)");
    expect(html).not.toContain(">Old<");
    expect(html).toContain("Add line");
    expect(html).toContain('aria-label="Remove Seat licence"');
  });

  it("offers the account's contacts and the role list", () => {
    h.data["accounts.getWithContacts"] = { account: { id: 1 }, contacts: [{ id: 30, firstName: "Ada", lastName: "Lovelace", title: "CTO" }] };
    const html = page(createElement(DealContactRoles, {
      opportunityId: 1, accountId: 1, accountName: "Acme", onChanged: () => {},
      roles: [{ id: 2, contactId: 30, role: "decision_maker", isPrimary: true, contact: { id: 30, firstName: "Ada", lastName: "Lovelace" } }],
    }));
    expect(html).toContain("Ada Lovelace — CTO");
    expect(html).toContain("decision maker");
    expect(html).toContain("Add role");
    expect(html).toContain('aria-label="Remove this contact role"');
  });

  it("the page calls all four procedures", () => {
    const page = read("client/src/pages/usip/OpportunityDetail.tsx");
    for (const p of ["addLineItem", "removeLineItem", "addRole", "removeRole"]) expect(page).toContain(`trpc.opportunities.${p}.useMutation(`);
  });

  it("a role names this workspace's deal and contact; a line, this workspace's product", async () => {
    deal(1);
    rows("opportunities").push({ id: 7, workspaceId: OTHER, accountId: 2, name: "Theirs", stage: "discovery", value: "1" });
    rows("contacts").push({ id: 30, workspaceId: WS, accountId: 1, firstName: "Ada", lastName: "L" }, { id: 31, workspaceId: OTHER, accountId: 2, firstName: "Eve", lastName: "X" });
    rows("products").push({ id: 4, workspaceId: WS, sku: "S", name: "Seat", listPrice: "1", active: true }, { id: 5, workspaceId: OTHER, sku: "T", name: "Theirs", listPrice: "1", active: true });
    await caller().opportunities.addRole({ opportunityId: 1, contactId: 30, role: "champion" });
    await expect(caller().opportunities.addRole({ opportunityId: 1, contactId: 31, role: "champion" })).rejects.toThrow(/not in this workspace/);
    await expect(caller().opportunities.addRole({ opportunityId: 7, contactId: 30, role: "champion" })).rejects.toThrow(/not found/i);
    await expect(caller().opportunities.addLineItem({ opportunityId: 1, productId: 5, quantity: 1, unitPrice: 1 })).rejects.toThrow(/Product not found/);
    expect(rows("opportunity_contact_roles").map((r) => `${r.opportunityId}:${r.contactId}`)).toEqual(["1:30"]);
    expect(rows("deal_line_items")).toEqual([]);
  });

  it("removing a line removes it from its own deal only", async () => {
    deal(1);
    deal(2);
    rows("deal_line_items").push({ id: 1, workspaceId: WS, opportunityId: 2, productId: 4, quantity: 1, unitPrice: "5", discountPct: "0", lineTotal: "5" });
    await caller().opportunities.removeLineItem({ id: 1, opportunityId: 1 });
    expect(rows("deal_line_items").map((r) => r.id)).toEqual([1]);
  });
});

/* ── L7, R66, R39: a board is one pipeline ─────────────────────────────── */

describe("L7, R66: a board reads one pipeline's deals", () => {
  beforeEach(() => {
    rows("crm_pipelines").push({ id: 2, workspaceId: WS, name: "Renewals", isDefault: false, sortOrder: 1 }, { id: 3, workspaceId: OTHER, name: "Theirs", isDefault: true, sortOrder: 0 });
    rows("accounts").push({ id: 3, workspaceId: WS, name: "Unrelated" });
    deal(1, { pipelineId: 1, value: "100" });
    deal(2, { pipelineId: null, value: "200", ownerUserId: REP }); // legacy: the default board
    deal(3, { pipelineId: 2, value: "400", accountId: 3 });
    rows("opportunities").push({ id: 4, workspaceId: OTHER, accountId: 2, name: "Theirs", stage: "discovery", value: "800", pipelineId: 3 });
  });

  it("the default board holds its own and the pipeline-less deals; another pipeline only its own", async () => {
    expect((await caller().opportunities.board({ pipelineId: 1 })).map((d) => d.id).sort()).toEqual([1, 2]);
    expect((await caller().opportunities.board({ pipelineId: 2 })).map((d) => [d.id, d.accountName])).toEqual([[3, "Unrelated"]]);
    expect(await caller().opportunities.board({ pipelineId: 3 })).toEqual([]);
    expect((await caller().opportunities.board({ pipelineId: 1, ownerUserId: REP })).map((d) => d.id)).toEqual([2]);
    // No scope: the workspace, as the Dashboard reads it.
    expect((await caller().opportunities.board()).map((d) => d.id).sort()).toEqual([1, 2, 3]);
  });

  it("the board's AI snapshots: the latest per deal on it, only the columns a card shows", async () => {
    const snap = (id: number, opp: number, at: string, prob: string) => rows("opportunity_intelligence").push({
      id, workspaceId: WS, opportunityId: opp, winProbability: prob, winProbabilityRationale: "r", nextBestActions: [],
      suggestedStage: null, winStory: "a long story", altSubjectLines: [{ subject: "s" }], generatedAt: new Date(at),
    });
    snap(1, 1, "2026-10-01T00:00:00Z", "10");
    snap(2, 1, "2026-10-05T00:00:00Z", "40");
    snap(3, 3, "2026-10-05T00:00:00Z", "90");
    const intel = await caller().oppIntelligence.getIntelligenceForBoard({ pipelineId: 1 });
    expect(intel.map((i: any) => [i.opportunityId, i.winProbability])).toEqual([[1, "40"]]);
    expect(Object.keys(intel[0])).not.toContain("winStory");
    expect(Object.keys(intel[0])).not.toContain("altSubjectLines");
  });

  it("R39: the forecast and the header count the board's deals", async () => {
    expect((await caller().opportunities.forecast({ pipelineId: 1 })).grandTotal).toBe(300);
    expect((await caller().opportunities.forecast({ pipelineId: 1, ownerUserId: REP })).grandTotal).toBe(200);
    expect((await caller().opportunities.forecast({ pipelineId: 2 })).grandTotal).toBe(400);
    expect((await caller().opportunities.forecast()).grandTotal).toBe(700);
    expect((await caller().opportunities.summary({ pipelineId: 2 })).open).toMatchObject({ count: 1, value: 400 });
    expect((await caller().opportunities.summary()).open).toMatchObject({ count: 3, value: 700 });
  });

  it("the Pipeline page asks for its pipeline, and exports and forecasts what it shows", () => {
    const page = read("client/src/pages/usip/Pipeline.tsx");
    expect(page).toContain("const boardInput = useMemo(() => ({ ownerUserId, pipelineId }), [ownerUserId, pipelineId]);");
    expect(page).toContain("trpc.opportunities.board.useQuery(boardInput,");
    expect(page).toContain("trpc.oppIntelligence.getIntelligenceForBoard.useQuery(boardInput,");
    expect(page).not.toContain("trpc.accounts.list.useQuery()");
    const csv = page.slice(page.indexOf('{can("export_data") && ('), page.indexOf("Export CSV"));
    expect(csv).toContain("const rows = filteredOpps;");
    expect(page).toContain("<ForecastView scope={boardInput} scopeLabel={scopeLabel} />");
  });
});

/* ── R30, R82 ──────────────────────────────────────────────────────────── */

describe("R30: the owner filter clears, and a move updates the board on screen", () => {
  it("reads ?owner= from useSearch, and every cache call uses the board's own input", () => {
    const page = read("client/src/pages/usip/Pipeline.tsx");
    expect(page).toContain("const search = useSearch();");
    expect(page).toContain("new URLSearchParams(search).get(\"owner\")");
    expect(page).not.toContain("window.location.search");
    const move = page.slice(page.indexOf("const setStage = trpc.opportunities.setStage.useMutation({"), page.indexOf("const [addOpen, setAddOpen]"));
    expect(move).toContain("utils.opportunities.board.getData(boardInput)");
    expect(move).toContain("utils.opportunities.board.setData(boardInput, (old)");
    expect(move).toContain("utils.opportunities.board.setData(boardInput, ctx.prev)");
    expect(move).not.toContain("setData(undefined");
  });
});

describe("R82: only a dragged card moves a deal", () => {
  const dt = (data: Record<string, string>) => ({ types: Object.keys(data), getData: (t: string) => data[t] ?? "" });
  it("plain text that happens to be a number moves nothing", () => {
    expect(droppedDealId(dt({ "text/plain": "7" }))).toBeNull();
    expect(droppedDealId(dt({ [DEAL_DRAG_TYPE]: "7" }))).toBe(7);
    expect(droppedDealId(dt({ [DEAL_DRAG_TYPE]: "x" }))).toBeNull();
    const page = read("client/src/pages/usip/Pipeline.tsx");
    expect(page).toContain("e.dataTransfer.setData(DEAL_DRAG_TYPE, String(opp.id))");
    expect(page).not.toContain('getData("text/plain")');
  });
});

/* ── R36 ───────────────────────────────────────────────────────────────── */

describe("R36: a new deal", () => {
  const form = (o: Record<string, string>) => ({ get: (k: string) => (k in o ? o[k] : null) });
  const stages = [
    { id: "lead", label: "Lead", isWon: false, isLost: false, defaultWinProb: 10 },
    { id: "signed", label: "Signed", isWon: true, isLost: false },
  ];

  it("needs an account; an empty Win % is left to the stage", () => {
    expect(newOpportunityInput(form({ name: "D", accountId: "", stage: "lead", value: "5" }), 1)).toEqual({ ok: false, message: "Choose the account this deal is with." });
    expect(newOpportunityInput(form({ name: "D", accountId: "0", stage: "lead", value: "5" }), 1).ok).toBe(false);
    const r = newOpportunityInput(form({ name: " D ", accountId: "4", stage: "lead", value: "5", winProb: "" }), 1);
    expect(r).toEqual({ ok: true, input: { name: "D", accountId: 4, value: 5, stage: "lead", winProb: undefined, pipelineId: 1, closeDate: undefined } });
    expect(newOpportunityInput(form({ name: "D", accountId: "4", stage: "lead", value: "5", winProb: "0" }), 1)).toMatchObject({ input: { winProb: 0 } });
  });

  it("starts in the pipeline's first open stage, not a key it may not have", () => {
    expect(firstOpenStage([{ id: "won", label: "Won", isWon: true, isLost: false }, ...stages])?.id).toBe("lead");
  });

  it("the server gives an absent Win % the stage's default", async () => {
    await caller().opportunities.create({ name: "N", accountId: 1, value: 10, stage: "negotiation", pipelineId: 1 });
    expect(rows("opportunities").at(-1)).toMatchObject({ name: "N", winProb: 75 });
    await caller().opportunities.create({ name: "Z", accountId: 1, value: 10, stage: "negotiation", pipelineId: 1, winProb: 0 });
    expect(rows("opportunities").at(-1)).toMatchObject({ name: "Z", winProb: 0 });
  });

  it("the dialog searches accounts on the server, leaves archived ones out, and is the one both boards use", () => {
    const dialog = read("client/src/components/usip/NewOpportunityDialog.tsx");
    expect(dialog).toContain("trpc.accounts.list.useQuery({ search: q || undefined, limit: 50 }, { enabled: open })");
    expect(dialog).toContain("filter((a: any) => !a.archivedAt)");
    expect(dialog).toContain('<select id="accountId" name="accountId" required');
    expect(read("client/src/pages/usip/Pipeline.tsx")).toContain("<NewOpportunityDialog open={addOpen}");
  });
});

/* ── R43, R103: the Deals board ────────────────────────────────────────── */

describe("R43: the Deals autopilot says what it does", () => {
  it("Analyze reports drafts to review, and points at them", () => {
    expect(analyzeToast({ analyzed: 0, tasksCreated: 0 })).toBe("No open deals needed analysis");
    expect(analyzeToast({ analyzed: 3, tasksCreated: 2 })).toBe("AI analyzed 3 deals: 2 draft tasks to review in Tasks. Your deals are unchanged.");
    const page = read("client/src/pages/usip/DealsV2.tsx");
    expect(page).toContain('toast.success(analyzeToast(r), r.tasksCreated > 0 ? { action: { label: "Review", onClick: () => navigate("/v2/tasks") } } : undefined);');
  });

  it("Approve's copy no longer says the AI writes the deal", () => {
    const page = read("client/src/pages/usip/DealsV2.tsx");
    const meta = page.slice(page.indexOf("const MODE_META"), page.indexOf("export function analyzeToast"));
    const approve = meta.slice(meta.indexOf("approval:"), meta.indexOf("auto:"));
    expect(approve).toContain("as a task for you to review in Tasks");
    expect(approve).toContain("Your deals are not changed until you act.");
    expect(approve).not.toContain("on each open deal for you to act on");
    // And the service still keeps Approve off the deal row.
    expect(read("server/services/dealAutopilot.ts")).toContain('if (mode === "auto") {');
  });
});

describe("R103: the Deals board adds deals and its alerts open them", () => {
  it("a New deal button opens the shared dialog for this pipeline", () => {
    const page = read("client/src/pages/usip/DealsV2.tsx");
    expect(page).toContain("onClick={() => setAddOpen(true)}");
    expect(page).toContain("<NewOpportunityDialog open={addOpen} onOpenChange={setAddOpen} stages={dialogStages} pipelineId={pipelineId} />");
  });

  it("each alert chip links to its deal; #alerts scrolls to the strip once it has loaded", () => {
    const page = read("client/src/pages/usip/DealsV2.tsx");
    const strip = page.slice(page.indexOf('<div id="alerts"'), page.indexOf("{/* Kanban board */}"));
    expect(strip).toContain("<Link key={a.id ?? i} href={`/opportunities/${a.opportunityId}`}");
    expect(strip).not.toContain("<span key={a.id ?? i}");
    expect(strip).toContain('<Link href="/pipeline-alerts"');
    expect(page).toContain('document.getElementById("alerts")?.scrollIntoView(');
  });

  it("the board and its header read this pipeline", () => {
    const page = read("client/src/pages/usip/DealsV2.tsx");
    expect(page).toContain("trpc.opportunities.board.useQuery({ pipelineId }, { enabled: pipelines.data !== undefined })");
    expect(page).toContain("trpc.opportunities.summary.useQuery({ pipelineId }, { enabled: pipelines.data !== undefined })");
  });
});

/* ── R42: territories ──────────────────────────────────────────────────── */

describe("R42: territory rules do what the page says", () => {
  beforeEach(() => {
    rows("territories").push({ id: 5, workspaceId: WS, name: "Software East" }, { id: 6, workspaceId: OTHER, name: "Theirs" });
  });
  const rule = (o: Record<string, unknown>) => rows("crm_territory_rules").push({ id: rows("crm_territory_rules").length + 1, workspaceId: WS, name: "R", priority: 100, active: true, industry: null, country: null, state: null, companyContains: null, territoryId: 5, ownerUserId: REP, ...o });

  it("matching ignores case and surrounding spaces", async () => {
    rule({ industry: "Software", state: " CA " });
    const { id } = await caller().accounts.create({ name: "Globex", industry: "software", region: "ca" });
    expect(rows("accounts").find((a) => a.id === id)).toMatchObject({ territoryId: 5, ownerUserId: REP });
  });

  it("a lead conversion that creates an account routes it; a leaver's rule leaves it with the converter", async () => {
    rule({ companyContains: "INITECH" });
    rows("leads").push({ id: 1, workspaceId: WS, firstName: "Bo", lastName: "B", company: "Initech Ltd", email: "bo@initech.example", status: "new", ownerUserId: ME });
    const r = await caller().leads.convert({ id: 1, accountId: null, contactId: null });
    expect(rows("accounts").find((a) => a.id === r.accountId)).toMatchObject({ territoryId: 5, ownerUserId: REP });
    // The rep has left: the account is the converter's, as before.
    rows("workspace_members").find((m) => m.userId === REP).deactivatedAt = new Date();
    rows("leads").push({ id: 2, workspaceId: WS, firstName: "Cy", lastName: "C", company: "Initech Two", email: "cy@initech2.example", status: "new", ownerUserId: ME });
    const r2 = await caller().leads.convert({ id: 2, accountId: null, contactId: null });
    expect(rows("accounts").find((a) => a.id === r2.accountId)).toMatchObject({ ownerUserId: ME });
  });

  it("deleting a territory detaches the rules and accounts that named it, in this workspace", async () => {
    rule({ industry: "x" });
    rows("crm_territory_rules").push({ id: 9, workspaceId: OTHER, name: "Theirs", priority: 1, active: true, territoryId: 5 });
    rows("accounts").push({ id: 8, workspaceId: WS, name: "In it", territoryId: 5 }, { id: 9, workspaceId: OTHER, name: "Theirs", territoryId: 5 });
    await caller().territories.delete({ id: 5 });
    expect(rows("territories").map((t) => t.id)).toEqual([6]);
    expect(rows("crm_territory_rules").map((r) => [r.id, r.territoryId])).toEqual([[1, null], [9, 5]]);
    expect(rows("accounts").filter((a) => a.id >= 8).map((a) => [a.id, a.territoryId])).toEqual([[8, null], [9, 5]]);
  });

  it("the page shows no unread JSON, confirms both deletes, and says what the rules do", () => {
    const page = read("client/src/pages/usip/Territories.tsx");
    expect(page).not.toContain("JSON.stringify(t.rules");
    expect(page).not.toContain('label="Rules (JSON)"');
    expect(page).toContain("onConfirm={() => del.mutate({ id: t.id })}");
    expect(page).toContain("onConfirm={() => delRule.mutate({ id: r.id })}");
    expect(page).not.toMatch(/onClick=\{\(\) => (del|delRule)\.mutate/);
    expect(page).toContain("description={TERRITORIES_DESCRIPTION}");
    expect(page).not.toContain("automatically route new leads and accounts to the correct owner on creation");
  });
});

/* ── R40: AI deal intelligence ─────────────────────────────────────────── */

describe("R40: AI deal intelligence", () => {
  const answer = (o: Record<string, unknown> = {}) => ({
    winProbability: 64, winProbabilityRationale: "r", nextBestActions: [], conversationSignals: [], actionItems: [],
    emailEffectivenessScore: 50, altSubjectLines: [], winStory: "", suggestedStage: "negotiation", suggestedStageRationale: "s", ...o,
  });
  beforeEach(() => { h.llmCalls = []; h.llm = () => answer(); });
  const enumOf = (args: any) => args.response_format.json_schema.schema.properties.suggestedStage.enum;

  it("suggests only this pipeline's open stages", async () => {
    rows("crm_pipelines").push({ id: 2, workspaceId: WS, name: "Renewals", isDefault: false, sortOrder: 1 });
    rows("crm_pipeline_stages").push(
      { id: 21, workspaceId: WS, pipelineId: 2, key: "renewal_due", label: "Due", sortOrder: 1, defaultWinProb: 50, isWon: false, isLost: false },
      { id: 22, workspaceId: WS, pipelineId: 2, key: "renewed", label: "Renewed", sortOrder: 2, defaultWinProb: 100, isWon: true, isLost: false },
    );
    deal(1, { pipelineId: 2, stage: "renewal_due" });
    h.llm = () => answer({ suggestedStage: "renewed" });
    await caller().oppIntelligence.generateIntelligence({ opportunityId: 1 });
    expect(enumOf(h.llmCalls[0])).toEqual(["renewal_due", "none"]);
    // Anything else it says is no suggestion.
    expect(rows("opportunity_intelligence")[0].suggestedStage).toBeNull();
    deal(2, { pipelineId: 1 });
    h.llm = () => answer({ suggestedStage: "negotiation" });
    await caller().oppIntelligence.generateIntelligence({ opportunityId: 2 });
    expect(enumOf(h.llmCalls[1])).toEqual(["discovery", "negotiation", "none"]);
    expect(rows("opportunity_intelligence")[1].suggestedStage).toBe("negotiation");
  });

  it("a failure says so and saves nothing", async () => {
    deal(1);
    h.llm = () => { throw new Error("provider down"); };
    await expect(caller().oppIntelligence.generateIntelligence({ opportunityId: 1 })).rejects.toThrow(/AI analysis failed: provider down/);
    expect(rows("opportunity_intelligence")).toEqual([]);
    expect(rows("opportunities")[0].winProb).toBe(20);
  });

  it("moves an open deal's win %, never a closed one's", async () => {
    deal(1);
    deal(2, { stage: "signed", winProb: 100 });
    await caller().oppIntelligence.generateIntelligence({ opportunityId: 1 });
    await caller().oppIntelligence.generateIntelligence({ opportunityId: 2 });
    expect(rows("opportunities").map((o) => [o.id, o.winProb])).toEqual([[1, 64], [2, 100]]);
    expect(rows("opportunity_intelligence").map((i) => i.winProbability)).toEqual(["64", "64"]);
  });
});

/* ── R41: the Forecast page ────────────────────────────────────────────── */

describe("R41: the forecast", () => {
  beforeEach(() => {
    deal(1, { ownerUserId: REP, stage: "negotiation", winProb: 75, value: "100" });
    deal(2, { ownerUserId: REP, stage: "negotiation", winProb: 95, value: "1000" });
    deal(3, { ownerUserId: MANAGER, stage: "negotiation", winProb: 60, value: "10000" });
  });
  const row = (r: any[], owner: number) => r.find((x) => x.ownerUserId === owner);

  it("a rep sees their own row; a manager and an admin see the team", async () => {
    expect((await caller(REP).opportunities.forecastByRep()).map((r) => r.ownerUserId)).toEqual([REP]);
    expect((await caller(MANAGER).opportunities.forecastByRep()).map((r) => r.ownerUserId).sort()).toEqual([REP, MANAGER]);
    expect((await caller(ME).opportunities.forecastByRep()).map((r) => r.ownerUserId).sort()).toEqual([REP, MANAGER]);
  });

  it("a deal marked Commit counts in Commit at any win %; an unmarked one by its win %; Omitted in neither", async () => {
    // Unmarked: the old rule.
    expect(row(await caller().opportunities.forecastByRep(), REP)).toMatchObject({ commit: 1000, bestCase: 1100 });
    await caller(REP).opportunities.update({ id: 1, patch: { forecastCategory: "commit" } });
    await caller(REP).opportunities.update({ id: 2, patch: { forecastCategory: "omitted" } });
    await caller(MANAGER).opportunities.update({ id: 3, patch: { forecastCategory: "pipeline" } });
    const r = await caller().opportunities.forecastByRep();
    expect(row(r, REP)).toMatchObject({ commit: 100, bestCase: 100, total: 1100 });
    expect(row(r, MANAGER)).toMatchObject({ commit: 0, bestCase: 0, total: 10000 });
    // Back to "by win %".
    await caller(REP).opportunities.update({ id: 2, patch: { forecastCategory: null } });
    expect(row(await caller().opportunities.forecastByRep(), REP)).toMatchObject({ commit: 1100 });
    await expect(caller(REP).opportunities.update({ id: 2, patch: { forecastCategory: "maybe" as never } })).rejects.toThrow();
  });

  it("the page and the deal say what the numbers are", () => {
    const page = read("client/src/pages/usip/Forecast.tsx");
    expect(page).toContain("Quarters are calendar quarters. Reps see their own row; managers see the team.");
    expect(page).not.toContain("Commit = ≥90% win prob");
    const detail = read("client/src/pages/usip/OpportunityDetail.tsx");
    expect(detail).toContain('aria-label="Forecast category"');
    expect(detail).toContain("patch: { forecastCategory: (e.target.value || null)");
    expect(read("server/_core/rawMigrations.ts")).toContain("ALTER TABLE `opportunities` ADD COLUMN `forecastCategory` varchar(16) NULL");
  });
});
