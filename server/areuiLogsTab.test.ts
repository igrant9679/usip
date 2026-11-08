/**
 * A campaign's Logs tab (audit 2026-10-20, U22): search, "load older" past
 * the 300-line page, and a last-tick badge.
 *
 * The two feeds' paging and search run on the SQL-evaluating fake; the tab is
 * pinned by reading its source.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "e".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { likeContains } from "./services/logPaging";

const WS = 2, OTHER = 9, CAMPAIGN = 41;
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
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const at = (sec: number) => new Date(T0 + sec * 1000);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("are_campaigns").push({ id: CAMPAIGN, workspaceId: WS, name: "Counties", status: "active" });
});

describe("the engine feed pages past its first page and searches on the server", () => {
  beforeEach(() => {
    // Ten lines; 4 and 5 share a second, so the boundary must break the tie by id.
    for (let i = 1; i <= 10; i++) {
      rows("are_engine_logs").push({ id: i, workspaceId: WS, campaignId: CAMPAIGN, phase: i % 2 ? "dispatch" : "discovery", level: "info", message: i === 7 ? "Pool spent: every mailbox at its limit" : `line ${i}`, repeatCount: 1, lastSeenAt: null, createdAt: at(i === 5 ? 4 : i) });
    }
    rows("are_engine_logs").push({ id: 11, workspaceId: OTHER, campaignId: CAMPAIGN, phase: "dispatch", level: "info", message: "another workspace", repeatCount: 1, lastSeenAt: null, createdAt: at(20) });
  });

  it("a page, then everything older than its last row, without repeating or skipping a line", async () => {
    const first = await caller().are.engine.getLogs({ campaignId: CAMPAIGN, limit: 4 });
    expect(first.map((r: any) => r.id)).toEqual([10, 9, 8, 7]);
    const last = first[first.length - 1] as any;
    const second = await caller().are.engine.getLogs({ campaignId: CAMPAIGN, limit: 4, before: { createdAt: last.createdAt, id: last.id } });
    expect(second.map((r: any) => r.id)).toEqual([6, 5, 4, 3]);
    const l2 = second[second.length - 1] as any;
    const third = await caller().are.engine.getLogs({ campaignId: CAMPAIGN, limit: 4, before: { createdAt: l2.createdAt, id: l2.id } });
    expect(third.map((r: any) => r.id)).toEqual([2, 1]);
  });

  it("search matches the message, in this workspace only", async () => {
    const hit = await caller().are.engine.getLogs({ campaignId: CAMPAIGN, search: "pool spent" });
    expect(hit.map((r: any) => r.id)).toEqual([7]);
    expect(await caller().are.engine.getLogs({ campaignId: CAMPAIGN, search: "another workspace" })).toEqual([]);
  });

  it("a user's % and _ are matched literally", () => {
    expect(likeContains("50%_off")).toBe("%50\\%\\_off%");
  });
});

describe("the discovery feed pages and searches the same way", () => {
  beforeEach(() => {
    rows("discovery_runs").push({ id: 70, workspaceId: WS, campaignId: CAMPAIGN }, { id: 71, workspaceId: WS, campaignId: 99 });
    for (let i = 1; i <= 5; i++) rows("discovery_logs").push({ id: i, workspaceId: WS, runId: 70, phase: "search", level: "info", message: i === 2 ? "Apollo: 0 found" : `step ${i}`, createdAt: at(i) });
    rows("discovery_logs").push({ id: 6, workspaceId: WS, runId: 71, phase: "search", level: "info", message: "Apollo: other campaign", createdAt: at(9) });
  });

  it("older than a row, and by message", async () => {
    const page = await caller().discovery.getLogsForCampaign({ campaignId: CAMPAIGN, limit: 2 });
    expect(page.map((r) => r.id)).toEqual([5, 4]);
    const older = await caller().discovery.getLogsForCampaign({ campaignId: CAMPAIGN, limit: 10, before: { createdAt: page[1].createdAt, id: page[1].id } });
    expect(older.map((r) => r.id)).toEqual([3, 2, 1]);
    const hit = await caller().discovery.getLogsForCampaign({ campaignId: CAMPAIGN, search: "apollo" });
    expect(hit.map((r) => r.id)).toEqual([2]);
  });
});

describe("the last tick is the latest line by when it was last seen", () => {
  it("a repeated old line seen later wins over a newer single line", async () => {
    rows("are_engine_logs").push(
      { id: 1, workspaceId: WS, campaignId: CAMPAIGN, phase: "discovery", level: "info", message: "queue full", repeatCount: 40, lastSeenAt: at(500), createdAt: at(10) },
      { id: 2, workspaceId: WS, campaignId: CAMPAIGN, phase: "dispatch", level: "warn", message: "window closed", repeatCount: 1, lastSeenAt: null, createdAt: at(300) },
      { id: 3, workspaceId: OTHER, campaignId: CAMPAIGN, phase: "dispatch", level: "info", message: "x", repeatCount: 1, lastSeenAt: null, createdAt: at(900) },
    );
    const t = await caller().are.engine.lastTick({ campaignId: CAMPAIGN });
    expect(t).toMatchObject({ phase: "discovery", message: "queue full" });
    expect(new Date(t.at!).getTime()).toBe(at(500).getTime());
  });

  it("a newer single line wins when nothing repeated since", async () => {
    rows("are_engine_logs").push(
      { id: 1, workspaceId: WS, campaignId: CAMPAIGN, phase: "discovery", level: "info", message: "queue full", repeatCount: 3, lastSeenAt: at(100), createdAt: at(10) },
      { id: 2, workspaceId: WS, campaignId: CAMPAIGN, phase: "dispatch", level: "info", message: "sent 4", repeatCount: 1, lastSeenAt: null, createdAt: at(300) },
    );
    const t = await caller().are.engine.lastTick({ campaignId: CAMPAIGN });
    expect(t.phase).toBe("dispatch");
    expect(new Date(t.at!).getTime()).toBe(at(300).getTime());
  });

  it("none yet", async () => {
    expect(await caller().are.engine.lastTick({ campaignId: CAMPAIGN })).toEqual({ at: null, phase: null, level: null, message: null });
  });
});

describe("the tab searches, loads older and shows the last tick", () => {
  const tab = () => block(read("client/src/pages/usip/ARECampaignDetail.tsx"), "function LogsTab(", "/** Collapsible log row");

  it("search goes to both feeds", () => {
    const t = tab();
    expect(t).toContain('<Input aria-label="Search the logs"');
    expect(t).toContain("...(logSearchQ ? { search: logSearchQ } : {}),");
    expect(t).toContain("const discoveryFilter = { campaignId, limit: LOG_PAGE, ...(logSearchQ ? { search: logSearchQ } : {}) };");
  });

  it("Load older fetches each feed from its oldest row, and a filter change starts again", () => {
    const t = tab();
    expect(t).toContain("utils.are.engine.getLogs.fetch({ ...engineFilter, before: eCur })");
    expect(t).toContain("utils.discovery.getLogsForCampaign.fetch({ ...discoveryFilter, before: dCur })");
    expect(t).toContain("useClearOnChange({ levelFilter, phaseFilter, logSearchQ }");
    expect(t).toContain("Load older");
    expect(t).not.toContain("campaignId, limit: 300,");
  });

  it("the last-tick badge reads engine.lastTick and warns on an active campaign gone quiet", () => {
    const t = tab();
    expect(t).toContain("trpc.are.engine.lastTick.useQuery({ campaignId }");
    expect(t).toContain('const tickStale = campaignStatus === "active" && (!tickAt || Date.now() - tickAt.getTime() > TICK_STALE_MS);');
    expect(t).toContain("Last engine tick ${relativeWhen(tickAt)}");
    expect(read("client/src/pages/usip/ARECampaignDetail.tsx")).toContain("<LogsTab campaignId={campaignId} campaignStatus={campaign.status} />");
  });

  it("Run engine now refreshes every tab", () => {
    expect(tab()).toContain("sync.invalidateAll();");
  });
});
