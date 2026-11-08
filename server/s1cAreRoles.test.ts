/**
 * Revenue Engine role and ownership checks (audit 2026-10-20, A36, A41, A42).
 *
 *   A36 · re-evaluate, ICP changes, scrapes, campaign delete and release-hold
 *         are a manager's; a rep still approves, rejects and skips (tracker 9)
 *   A41 · the campaign prospect list is a capped page, and minIcpScore filters
 *   A42 · Add manual and every scrape refuse another workspace's campaign, and
 *         the engine joins a queue row to its own workspace's campaign only
 *
 * Procedures run against the SQL-evaluating fake; screens are pinned by source.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "b".repeat(64);
  return { db: null as any, role: "rep", fetched: [] as string[], llm: 0 };
});

vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./audit", async (a) => ({ ...(await a<typeof import("./audit")>()), recordAudit: async () => {} }));
vi.mock("./routers/are/notify", async (a) => ({ ...(await a<typeof import("./routers/are/notify")>()), areNotify: async () => {} }));
vi.mock("./services/scraper/ssrfGuard", async (a) => ({
  ...(await a<typeof import("./services/scraper/ssrfGuard")>()),
  safeFetch: async (url: string) => { h.fetched.push(url); throw new Error("no network in tests"); },
}));
vi.mock("./_core/llm", async (a) => ({
  ...(await a<typeof import("./_core/llm")>()),
  invokeLLM: async () => { h.llm++; throw new Error("no AI in tests"); },
}));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const WS = 2, FOREIGN = 9;
const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const caller = () => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const as = (role: string) => { h.role = role; return caller(); };
/** The block of `src` from `start` to the next `end` after it; throws if `start` is absent. */
const block = (src: string, start: string, end: string) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`missing ${start}`);
  const j = src.indexOf(end, i + start.length);
  return src.slice(i, j < 0 ? undefined : j);
};

beforeEach(() => {
  h.role = "rep";
  h.fetched = [];
  h.llm = 0;
  h.db = makeSqlFakeDb({ roles: new Proxy({}, { get: (_t, k) => (Number(k) === WS ? h.role : undefined) }) as Record<number, string>, wsId: () => WS });
  rows("workspaces").push({ id: WS, name: "W", slug: "w", ownerUserId: 1, archivedAt: null, plan: "trial" });
  rows("icp_profiles").push({ id: 1, workspaceId: WS, version: 1, isActive: true, targetTitles: [], targetIndustries: [], targetGeographies: [], antiPatterns: [] });
  rows("icp_profiles").push({ id: 2, workspaceId: WS, version: 2, isActive: false, targetTitles: [], targetIndustries: [], targetGeographies: [], antiPatterns: [] });
  rows("are_campaigns").push(
    { id: 7, workspaceId: WS, name: "Ours", status: "paused", icpOverrides: {}, autoApproveThreshold: 70 },
    { id: 77, workspaceId: FOREIGN, name: "Theirs", status: "active", icpOverrides: {}, minConfidence: null },
  );
  rows("prospect_queue").push(
    { id: 1, workspaceId: WS, campaignId: 7, firstName: "A", lastName: "A", email: "a@acme.example", icpMatchScore: 80, enrichmentStatus: "complete", sequenceStatus: "pending" },
    { id: 2, workspaceId: WS, campaignId: 7, firstName: "B", lastName: "B", email: "b@acme.example", icpMatchScore: 30, enrichmentStatus: "complete", sequenceStatus: "pending" },
  );
  rows("prospect_intelligence").push({ id: 11, workspaceId: WS, prospectQueueId: 1, copyHoldReason: "names a competitor" });
});

describe("A36: the manager-only engine actions refuse a rep", () => {
  const managerOnly: Array<[string, (c: ReturnType<typeof caller>) => Promise<unknown>]> = [
    ["re-evaluate one", (c) => c.are.prospects.reEvaluate({ prospectId: 1 })],
    ["re-evaluate all", (c) => c.are.prospects.reEvaluateAll({ campaignId: 7 })],
    ["release a held sequence", (c) => c.are.prospects.releaseCopyHold({ prospectId: 1 })],
    ["regenerate the ICP", (c) => c.are.icp.regenerate()],
    ["override the ICP", (c) => c.are.icp.override({ targetTitles: ["Clerk"] })],
    ["restore an ICP version", (c) => c.are.icp.restore({ id: 2 })],
    ["run a scrape", (c) => c.are.scraper.run({ campaignId: 7, source: "news", query: "funding" })],
    ["run every scraper", (c) => c.are.scraper.runFullScrape({ campaignId: 7, queries: { news: "funding" } })],
    ["scrape news", (c) => c.are.scraper.scrapeNews({ campaignId: 7, query: "funding" })],
    ["delete a campaign", (c) => c.are.campaigns.delete({ id: 7 })],
  ];
  for (const [what, run] of managerOnly) {
    it(`a rep cannot ${what}`, async () => {
      await expect(run(as("rep"))).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  }

  it("nothing a rep was refused changed anything", async () => {
    for (const [, run] of managerOnly) await run(as("rep")).catch(() => {});
    expect(rows("are_campaigns").map((c) => c.id)).toEqual([7, 77]);
    expect(rows("prospect_intelligence")[0].copyHoldReason).toBe("names a competitor");
    expect(rows("icp_profiles").find((p) => p.id === 2).isActive).toBe(false);
    expect(rows("are_scrape_jobs")).toHaveLength(0);
    expect(h.fetched).toHaveLength(0);
  });

  it("a manager can release a hold and restore an ICP; deleting a campaign is an admin's", async () => {
    const m = as("manager");
    expect(await m.are.prospects.releaseCopyHold({ prospectId: 1 })).toEqual({ released: true });
    expect(rows("prospect_intelligence")[0].copyHoldReason).toBeNull();
    await m.are.icp.restore({ id: 2 });
    expect(rows("icp_profiles").find((p) => p.id === 2).isActive).toBe(true);
    // 2026-11-07 (audit F15): archive is the everyday way out and a manager's;
    // delete moved up to admins. Still refused to a rep (the list above).
    await expect(m.are.campaigns.delete({ id: 7 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await as("admin").are.campaigns.delete({ id: 7 });
    expect(rows("are_campaigns").map((c) => c.id)).toEqual([77]);
  });

  it("a manager's scrape gets past the gate and searches", async () => {
    await as("manager").are.scraper.run({ campaignId: 7, source: "news", query: "funding" });
    expect(h.fetched).toHaveLength(1);
    expect(rows("are_scrape_jobs")).toHaveLength(1);
  });

  it("a rep still rejects and skips a prospect (tracker 9)", async () => {
    await as("rep").are.prospects.skip({ prospectId: 2 });
    expect(rows("prospect_queue").find((r) => r.id === 2).sequenceStatus).toBe("skipped");
  });

  it("the screens offer a rep none of them", () => {
    const detail = read("client/src/pages/usip/ARECampaignDetail.tsx");
    expect(block(detail, "function SequenceDrawer(", "const save = async")).toContain("const canRelease = useWorkspaceRole().isManager;");
    expect(block(detail, "{row.copyHoldReason && (", "No sequence generated yet.")).toContain("{canRelease && (\n              <Button size=\"sm\" variant=\"outline\" disabled={releaseHold.isPending}");
    expect(detail).toContain("const isManager = useWorkspaceRole().isManager;");
    expect(block(detail, "{isManager && (\n                    <Button", "Re-evaluate All")).toContain("setReEvaluateAllConfirmOpen(true);");
    expect(block(detail, "{isManager && (\n                      <Button", "Re-evaluate\n")).toContain("reEvaluate.mutate({ prospectId: item.id })");
    expect(block(detail, "{isManager ? (\n            <div className=\"max-w-2xl space-y-5 mt-6\">", "{/* Recent scrape jobs */}")).toContain("scrape.mutate(");
    const icp = read("client/src/pages/usip/AREIcpAgent.tsx");
    // 2026-11-07 (audit F8): Regenerate asks first (one AI call); the
    // manager-only button is still the one that runs it.
    expect(block(icp, "{canChange && (\n          <>", "</PageHeader>")).toContain("onClick={askRegenerate}");
    expect(block(icp, "const askRegenerate = () => confirmAction({", "const [restoringId")).toContain("() => regenerate.mutate()");
    expect(block(icp, "{canChange && (\n          <>", "</PageHeader>")).toContain("setOverrideOpen(true)");
    expect(icp).toContain("onRestore={canChange ? () => { setRestoringId(v.id); restore.mutate({ id: v.id }); } : undefined}");
    const list = read("client/src/pages/usip/ARECampaigns.tsx");
    expect(block(list, "{canDelete && (", "</Button>")).toContain('aria-label="Delete campaign"');
  });
});

describe("A41: the campaign prospect list is a page", () => {
  it("refuses a limit past one page", async () => {
    await expect(as("rep").are.prospects.list({ campaignId: 7, limit: 5000 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(as("rep").are.prospects.list({ campaignId: 7, limit: 200 })).resolves.toBeDefined();
  });

  // The list's own projection carries an SQL column the fake reads as an
  // aggregate, so its WHERE is run here directly: the one the list uses.
  it("applies minIcpScore", async () => {
    const { queueRowsWhere } = await import("./routers/are/prospects");
    const { prospectQueue } = await import("../drizzle/schema");
    const ids = async (minIcpScore?: number) =>
      (await h.db.select({ id: prospectQueue.id }).from(prospectQueue).where(queueRowsWhere(WS, { campaignId: 7, minIcpScore })))
        .map((r: { id: number }) => r.id);
    expect(await ids(50)).toEqual([1]);
    expect(await ids()).toEqual([1, 2]);
  });
});

describe("A42: a campaign must be this workspace's", () => {
  it("Add manual refuses another workspace's campaign and queues nobody", async () => {
    await expect(as("rep").are.prospects.addManual({ campaignId: 77, firstName: "Z", lastName: "Z", email: "z@else.example" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows("prospect_queue").map((r) => r.id)).toEqual([1, 2]);
    // …and still adds to this workspace's.
    await as("rep").are.prospects.addManual({ campaignId: 7, firstName: "Z", lastName: "Z", email: "z@else.example" });
    expect(rows("prospect_queue").filter((r) => r.campaignId === 7)).toHaveLength(3);
  });

  it("a scrape refuses another workspace's campaign before it searches anything", async () => {
    await expect(as("admin").are.scraper.run({ campaignId: 77, source: "news", query: "funding" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as("admin").are.scraper.scrapeNews({ campaignId: 77, query: "funding" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.fetched).toHaveLength(0);
    expect(rows("are_scrape_jobs")).toHaveLength(0);
  });

  /**
   * The fake can't evaluate the pass's confidence clause, so this reads the
   * join the engine really built for that query, and evaluates it on the two
   * rows: a row in this workspace filed under another one's campaign.
   */
  it("the engine's enrichment pass joins a queue row to its own workspace's campaign only", async () => {
    const dialect = new MySqlDialect();
    let join: string | null = null;
    const real = h.db.select;
    h.db.select = (p?: Record<string, unknown>) => {
      const b = real(p);
      const joins: unknown[] = [];
      const innerJoin = b.innerJoin;
      b.innerJoin = (t: unknown, on: unknown) => { joins.push(on); return innerJoin.call(b, t, on); };
      const where = b.where;
      b.where = (cond: any) => {
        const q = dialect.sqlToQuery(cond);
        if (q.sql.includes("`prospect_queue`.`enrichmentStatus`") && q.sql.includes("`are_campaigns`.`status`")) {
          join = dialect.sqlToQuery(joins[0] as any).sql;
        }
        return where.call(b, cond);
      };
      return b;
    };
    const { runAreEngine } = await import("./areEngine");
    await runAreEngine({ workspaceId: WS });
    expect(join).toBe("(`are_campaigns`.`id` = `prospect_queue`.`campaignId` and `are_campaigns`.`workspaceId` = `prospect_queue`.`workspaceId`)");
    // …and that join, evaluated, leaves the planted row without a campaign.
    h.db.select = real;
    rows("prospect_queue").push({ id: 3, workspaceId: WS, campaignId: 77, firstName: "P", lastName: "P", enrichmentStatus: "pending", sequenceStatus: "pending" });
    const { areCampaigns, prospectQueue } = await import("../drizzle/schema");
    const { and, eq } = await import("drizzle-orm");
    const got = await h.db.select({ id: prospectQueue.id }).from(prospectQueue)
      .innerJoin(areCampaigns, and(eq(areCampaigns.id, prospectQueue.campaignId), eq(areCampaigns.workspaceId, prospectQueue.workspaceId)))
      .where(eq(prospectQueue.id, 3));
    expect(got).toEqual([]);
  });
});
