/**
 * Audit final pass, batch CRMP (2026-11-07): unbounded reads and long lists.
 *
 *   X4.1 · contacts.list filters in SQL and is capped; opportunities.list is
 *          capped and searchable; the deal board draws every open deal and the
 *          latest of each won or lost column, its headers counted in SQL, and
 *          its CSV is the whole board; the screens that read them ask for what
 *          they show
 *   X4.2 · Tasks v1 and the QBR groups render 50 at a time
 *
 * Against the real routers and the SQL fake; screens pinned by source.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "9".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { invalidateStageIndex } from "./_core/stageSemantics";
import { BOARD_CLOSED_LIMIT, CONTACT_LIST_DEFAULT, OPPORTUNITY_LIST_DEFAULT } from "./routers/crm";

const WS = 2, OTHER = 9, ME = 1;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u1", email: "u1@example.com", name: "U1", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const deal = (id: number, o: Record<string, unknown> = {}) => rows("opportunities").push({
  id, workspaceId: WS, accountId: 1, name: `Deal ${id}`, stage: "discovery", value: "100", winProb: 20,
  closeDate: null, pipelineId: 1, ownerUserId: ME, updatedAt: new Date(Date.UTC(2026, 0, 1) + id * 60_000), createdAt: new Date(), ...o,
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin" }, wsId: () => WS });
  invalidateStageIndex();
  rows("crm_pipelines").push({ id: 1, workspaceId: WS, name: "Default", isDefault: true, sortOrder: 0 });
  rows("crm_pipeline_stages").push(
    { id: 11, workspaceId: WS, pipelineId: 1, key: "discovery", label: "Discovery", sortOrder: 10, defaultWinProb: 20, isWon: false, isLost: false },
    { id: 15, workspaceId: WS, pipelineId: 1, key: "won", label: "Won", sortOrder: 50, defaultWinProb: 100, isWon: true, isLost: false },
    { id: 16, workspaceId: WS, pipelineId: 1, key: "lost", label: "Lost", sortOrder: 60, defaultWinProb: 0, isWon: false, isLost: true },
  );
  rows("accounts").push({ id: 1, workspaceId: WS, name: "Acme" }, { id: 2, workspaceId: OTHER, name: "Theirs" });
});

describe("contacts.list asks the database and is capped (X4.1)", () => {
  beforeEach(() => {
    rows("contacts").push(
      { id: 1, workspaceId: WS, accountId: 1, firstName: "Jane", lastName: "Doe", email: "jane@acme.example", updatedAt: new Date(3) },
      { id: 2, workspaceId: WS, accountId: 3, firstName: "John", lastName: "Roe", email: "john@beta.example", updatedAt: new Date(2) },
      { id: 3, workspaceId: OTHER, accountId: 1, firstName: "Jane", lastName: "Doe", email: "jane@theirs.example", updatedAt: new Date(4) },
    );
  });
  it("filters by account and by every word of the search, in this workspace", async () => {
    expect((await caller().contacts.list({ accountId: 1 })).map((c) => c.id)).toEqual([1]);
    expect((await caller().contacts.list({ search: "jane doe" })).map((c) => c.id)).toEqual([1]);
    expect((await caller().contacts.list({ search: "beta.example" })).map((c) => c.id)).toEqual([2]);
    expect((await caller().contacts.list()).map((c) => c.id)).toEqual([1, 2]);
  });
  it("returns at most 200 unless asked", async () => {
    for (let id = 10; id < 10 + CONTACT_LIST_DEFAULT + 5; id++) rows("contacts").push({ id, workspaceId: WS, accountId: null, firstName: "P", lastName: `${id}`, email: null, updatedAt: new Date(id) });
    expect(await caller().contacts.list()).toHaveLength(CONTACT_LIST_DEFAULT);
    expect(await caller().contacts.list({ limit: 1000 })).toHaveLength(CONTACT_LIST_DEFAULT + 7);
  });
  it("no longer filters in JavaScript", () => {
    const src = read("server/routers/crm.ts");
    const start = src.indexOf("export const contactsRouter = router({");
    expect(start).toBeGreaterThan(-1);
    const proc = src.slice(start, src.indexOf("  get: workspaceProcedure", start));
    expect(proc).not.toMatch(/rows = rows\.filter/);
    expect(proc).toContain(".limit(input?.limit ?? CONTACT_LIST_DEFAULT);");
  });
});

describe("opportunities.list is capped, searchable and readable by id (X4.1)", () => {
  it("at most 200 unless asked, newest first; a name search; these ids only", async () => {
    for (let id = 1; id <= OPPORTUNITY_LIST_DEFAULT + 5; id++) deal(id, id === 3 ? { name: "Big renewal" } : {});
    deal(999, { workspaceId: OTHER, name: "Big renewal theirs" });
    const all = await caller().opportunities.list();
    expect(all).toHaveLength(OPPORTUNITY_LIST_DEFAULT);
    expect(all[0].id).toBe(OPPORTUNITY_LIST_DEFAULT + 5);
    expect((await caller().opportunities.list({ search: "renewal" })).map((o) => o.id)).toEqual([3]);
    expect((await caller().opportunities.list({ ids: [3, 999, 4] })).map((o) => o.id).sort()).toEqual([3, 4]);
    expect(await caller().opportunities.list({ ids: [] })).toEqual([]);
  });
  it("the screens that read it ask for what they show", () => {
    expect(read("client/src/components/usip/RelatedRecordPicker.tsx")).toContain("trpc.opportunities.list.useQuery({ search: q, limit: 8 },");
    expect(read("client/src/pages/usip/ProposalDetail.tsx")).toContain("trpc.opportunities.list.useQuery({ search: search.trim() || undefined, limit: 50 },");
    expect(read("client/src/pages/usip/Calendar.tsx")).toContain("trpc.opportunities.list.useQuery(\n    { limit: 200 },");
    // 2026-11-07 (audit F34, batch CRMD): the Quotes page that read its deals
    // by id is retired — a quote is a proposal's pricing, read with its
    // proposal — so nothing there reads opportunities.list any more.
    expect(existsSync(join(__dirname, "..", "client/src/pages/usip/Quotes.tsx"))).toBe(false);
  });
});

describe("the deal board draws every open deal and the latest closed ones, counted in SQL (X4.1)", () => {
  beforeEach(() => {
    deal(1); deal(2); deal(3, { stage: "discovery", accountId: 2 });
    for (let id = 100; id < 100 + BOARD_CLOSED_LIMIT + 10; id++) deal(id, { stage: "won", value: "10" });
    deal(500, { stage: "lost", value: "5" });
    deal(600, { workspaceId: OTHER, stage: "won" });
  });

  it("open deals all; a won column its latest 50", async () => {
    const board = await caller().opportunities.board({ pipelineId: 1 });
    const won = board.filter((d) => d.stage === "won");
    expect(board.filter((d) => d.stage === "discovery")).toHaveLength(3);
    expect(won).toHaveLength(BOARD_CLOSED_LIMIT);
    expect(Math.min(...won.map((d) => d.id))).toBe(110); // the latest, by update
    expect(board.filter((d) => d.stage === "lost").map((d) => d.id)).toEqual([500]);
  });

  it("the totals count every deal in each column; the export is the whole board", async () => {
    const totals = await caller().opportunities.boardTotals({ pipelineId: 1 });
    const by = new Map(totals.map((t) => [t.stage, t]));
    expect(by.get("won")).toMatchObject({ count: BOARD_CLOSED_LIMIT + 10, value: (BOARD_CLOSED_LIMIT + 10) * 10 });
    expect(by.get("discovery")).toMatchObject({ count: 3, value: 300, avgWinProb: 20 });
    const csv = await caller().opportunities.boardExport({ pipelineId: 1 });
    expect(csv).toHaveLength(3 + BOARD_CLOSED_LIMIT + 10 + 1);
    expect(csv.find((r) => r.id === 1)).toMatchObject({ name: "Deal 1", accountName: "Acme" });
    // Another workspace's account name never rides along.
    expect(csv.find((r) => r.id === 3)!.accountName).toBe("");
  });

  it("both boards head their columns with the server's counts, say when a column is cut, and export the whole board", () => {
    const pipeline = read("client/src/pages/usip/Pipeline.tsx");
    expect(pipeline).toContain("trpc.opportunities.boardTotals.useQuery(boardInput,");
    expect(pipeline).toContain("const count = t?.count ?? items.length;");
    expect(pipeline).toContain("The latest {items.length} of {count.toLocaleString()} shown.");
    expect(pipeline).toContain("const rows = await utils.opportunities.boardExport.fetch(boardInput)");
    const deals = read("client/src/pages/usip/DealsV2.tsx");
    expect(deals).toContain("trpc.opportunities.boardTotals.useQuery({ pipelineId },");
    expect(deals).toContain("const colCount = t?.count ?? list.length;");
  });
});

describe("long lists render 50 at a time (X4.2)", () => {
  it("Tasks v1 shows 50, then more on request, and starts over on a new tab or filter", () => {
    const src = read("client/src/pages/usip/Tasks.tsx");
    expect(src).toContain("const rowsShown = useShowMore(visible, { tab, assigneeFilter, relTypeFilter });");
    expect(src).toContain("{rowsShown.shown.map((t) => (");
    expect(src).not.toContain("{visible.map((t) => (");
    expect(src).toContain("onClick={rowsShown.showMore}");
  });
  it("each QBR group shows 50, then more on request", () => {
    const src = read("client/src/pages/usip/QBRs.tsx");
    expect(src).toContain("const rows = useShowMore(items, scope);");
    expect(src).toContain("<ShowMoreList items={groups[g.key]} scope={g.key}");
  });
});
