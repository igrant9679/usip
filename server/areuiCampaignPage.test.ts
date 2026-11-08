/**
 * A Revenue Engine campaign's page (audit 2026-10-20, batch AREUI).
 *
 *   A26 the Prospects tab counts every staged prospect, from the server's
 *       tally, not the length of a 100-row list
 *   U24 each tab's queries start the first time it is opened, and the
 *       15-second "Approve all" poll stops while nobody can see it
 *   A74 every action on the page refreshes what it changed, and a tab that is
 *       loading says so instead of saying it is empty
 *
 * Server behaviour runs on the SQL-evaluating fake; the screen is pinned by
 * reading its source, block by block.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "c".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";

const WS = 2, OTHER = 9, CAMPAIGN = 41;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const detail = () => read("client/src/pages/usip/ARECampaignDetail.tsx");
const rows = (t: string) => h.db.rowsOf(t) as any[];
/** The text between two anchors, both of which must exist. */
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

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("are_campaigns").push({ id: CAMPAIGN, workspaceId: WS, name: "Counties", status: "active", targetProspectCount: 500, dailySendCap: 50 });
});

describe("A26: the staged count is every staged row", () => {
  it("statusCounts counts 250 staged prospects as 250, and only this campaign's", async () => {
    let id = 1;
    for (let i = 0; i < 250; i++) rows("prospect_queue").push({ id: id++, workspaceId: WS, campaignId: CAMPAIGN, sequenceStatus: "sourcing", enrichmentStatus: "pending" });
    for (let i = 0; i < 3; i++) rows("prospect_queue").push({ id: id++, workspaceId: WS, campaignId: CAMPAIGN, sequenceStatus: "pending", enrichmentStatus: "complete" });
    rows("prospect_queue").push({ id: id++, workspaceId: WS, campaignId: 99, sequenceStatus: "sourcing", enrichmentStatus: "pending" });
    rows("prospect_queue").push({ id: id++, workspaceId: OTHER, campaignId: CAMPAIGN, sequenceStatus: "sourcing", enrichmentStatus: "pending" });
    const c = await caller().are.prospects.statusCounts({ campaignId: CAMPAIGN, view: "review" });
    expect(c.byStatus.sourcing).toBe(250);
    // Staged rows stay out of the queue's own count, as the list leaves them out.
    expect(c.inQueue).toBe(3);
  });

  it("the tab reads that count; the 100-row staged list is gone", () => {
    const src = detail();
    expect(src).toContain("const stagedCount = queueCounts?.byStatus?.sourcing ?? 0;");
    expect(src).not.toContain('sequenceStatus: "sourcing", limit: 100');
    expect(src).not.toContain("sourcingRows");
    const chip = block(src, "{stagedCount > 0 && (", "</span>\n                )}");
    expect(chip).toContain("{stagedCount.toLocaleString()} staged, finding email");
  });
});

describe("U24: a tab's queries wait for the tab", () => {
  const page = () => block(detail(), "function ARECampaignDetailPage() {", "if (loadingCampaign) {");

  it("the page remembers which tabs were opened, and gates on it", () => {
    const p = page();
    expect(p).toContain('const [openedTabs, setOpenedTabs] = useState<ReadonlySet<string>>(() => new Set(["prospects"]));');
    expect(p).toContain("const opened = (t: string) => validId && (tab === t || openedTabs.has(t));");
    // The tab state is declared before the first query that reads it.
    // 2026-11-08 (audit U6): it is kept in ?tab= through the shared hook.
    const firstQuery = p.indexOf("trpc.are.prospects.list.useQuery(");
    expect(firstQuery).toBeGreaterThan(-1);
    expect(p.slice(0, firstQuery)).toContain('const [tab, setTabState] = useUrlState("tab", urlParam.oneOf(CAMPAIGN_TABS, "prospects"));');
  });

  for (const [query, tabKey] of [
    ["trpc.are.execution.getSignalLog.useQuery(", "signals"],
    ["trpc.are.metrics.stepFunnel.useQuery(", "ab"],
    ["trpc.are.prospects.getAbVariants.useQuery(", "ab"],
    ["trpc.are.prospects.getDispatches.useQuery(", "ab"],
    ["trpc.are.scraper.listJobs.useQuery(", "scraper"],
    ["trpc.are.prospects.getReevalHistory.useQuery(", "rejections"],
    ["trpc.are.prospects.getRejectionStats.useQuery(", "rejections"],
    ["trpc.are.prospects.list.useQuery(", "prospects"],
  ] as const) {
    it(`${query.replace("trpc.are.", "").replace(".useQuery(", "")} starts on the ${tabKey} tab`, () => {
      const p = page();
      const at = p.indexOf(query);
      expect(at).toBeGreaterThan(-1);
      // The query's own call, up to the statement's end.
      const call = p.slice(at, p.indexOf(");", at));
      expect(call).toContain(`enabled: opened("${tabKey}")`);
    });
  }

  it("the badges read counts the page loads anyway, not a tab's own query", () => {
    const src = detail();
    const strip = block(src, '<TabsTrigger value="prospects"', "</TabsList>");
    expect(strip).toContain("queueCounts?.byStatus?.skipped");
    expect(strip).not.toContain("rejectionStats?.total");
  });

  it("the approval poll runs only on the Prospects tab, in a visible browser tab, by design", () => {
    const p = page();
    const call = block(p, "const approvable = trpc.are.campaigns.pendingApprovalCount.useQuery(", "});");
    expect(call).toContain('enabled: opened("prospects")');
    expect(call).toContain('refetchInterval: tab === "prospects" && pageVisible ? APPROVAL_POLL_MS : false');
    expect(call).toContain("refetchIntervalInBackground: false");
    expect(call).not.toContain("refetchInterval: 15000");
    expect(p).toContain("const pageVisible = usePageVisible();");
    expect(detail()).toContain("const APPROVAL_POLL_MS = 15_000;");
  });

  it("usePageVisible follows visibilitychange", () => {
    const hook = read("client/src/hooks/usePageVisible.ts");
    expect(hook).toContain('document.addEventListener("visibilitychange", onChange)');
    expect(hook).toContain('document.removeEventListener("visibilitychange", onChange)');
    expect(hook).toContain('document.visibilityState !== "hidden"');
  });
});

describe("A74: every action refreshes what it changed", () => {
  it("the one sync covers the counts, Approve all, the stall panel, rows by id and the dossier", () => {
    // 2026-11-08 (audit X1.7): the sync is the campaign family's helper. It
    // invalidates every `are` read (the counts, Approve all, the stall panel,
    // rows by id, the dossier, dispatches, the funnel, signals) and the
    // attention panel, for every screen, not only this page's tabs.
    const sync = block(detail(), "function useCampaignSync(_campaignId: number) {", "/* ─── Prospect row");
    expect(sync).toContain("invalidateAll: () => invalidateCampaignReads(utils)");
    const helper = read("client/src/lib/entityCache.ts");
    const fn = block(helper, "export function invalidateCampaignReads(", "\n}\n");
    expect(fn).toContain("utils.are.invalidate()");
    expect(fn).toContain("utils.attention.summary.invalidate()");
  });

  it("approve all, re-evaluate, enrich batch, import, add existing and scrape go through it", () => {
    const p = detail();
    expect(block(p, "const approveAllPending = trpc.are.campaigns.approveAllPending.useMutation({", "onError:")).toContain("invalidateCampaign();");
    expect(block(p, "const reEvaluate = trpc.are.prospects.reEvaluate.useMutation({", "onError:")).toContain("invalidateCampaign();");
    expect(block(p, "const enrichBatch = trpc.are.prospects.enrichBatch.useMutation({", "onError:")).toContain("setTimeout(invalidateCampaign, 3000);");
    expect(block(p, "const runImport = async () => {", "const scrape = ")).toContain("invalidateCampaign();");
    expect(p).toContain("onPushed={invalidateCampaign}");
    const scrape = block(p, "const scrape = trpc.are.scraper.run.useMutation({", "onError:");
    expect(scrape).toContain("invalidateCampaign();");
    // 2026-11-08 (audit X1.7): scrape jobs are an `are` read the helper covers.
    expect(scrape).toContain("invalidateCampaignReads(utils);");
  });

  it("a settings save, a status change and a re-space refresh the stall panel", () => {
    const p = detail();
    // 2026-11-08 (audit X1.7): each through the campaign family's helper,
    // which covers the stall panel and the step states with every `are` read.
    expect(block(p, "const updateCampaign = trpc.are.campaigns.update.useMutation({", "onError:")).toContain("invalidateCampaignReads(utils);");
    expect(block(p, "const setStatus = trpc.are.campaigns.setStatus.useMutation({", "onError:")).toContain("invalidateCampaignReads(utils);");
    const respace = block(p, "const respace = trpc.are.campaigns.respaceSteps.useMutation({", "onError:");
    expect(respace).toContain("invalidateCampaignReads(utils);");
  });

  it("the shared bulk bar refreshes Approve all, the stall panel and rows by id", () => {
    const bar = read("client/src/components/usip/AreBulkActionBar.tsx");
    const refresh = block(bar, "const refreshAll = () => {", "};");
    // 2026-11-08 (audit X1.7): the campaign family's helper covers all three.
    expect(refresh).toContain("invalidateCampaignReads(utils);");
    expect(refresh).toContain("invalidateListReads(utils);");
  });

  it("the sequence drawer's edits refresh every tab, not only its own list", () => {
    expect(detail()).toContain("refetch={async () => { invalidateAll(); await refetch(); }}");
  });

  it("step performance, scrape jobs and run history say they are loading", () => {
    const p = detail();
    const ab = block(p, '<TabsContent value="ab"', "</TabsContent>");
    expect(ab.indexOf("{loadingAb ? (")).toBeGreaterThan(-1);
    expect(ab.indexOf("{loadingAb ? (")).toBeLessThan(ab.indexOf("No step performance yet"));
    const scraper = block(p, '<TabsContent value="scraper"', "</TabsContent>");
    expect(scraper.indexOf("{loadingScrapeJobs ? (")).toBeGreaterThan(-1);
    expect(scraper.indexOf("{loadingScrapeJobs ? (")).toBeLessThan(scraper.indexOf("No scrape jobs yet"));
    const rej = block(p, '<TabsContent value="rejections"', "</TabsContent>");
    expect(rej.indexOf("{loadingReevalHistory ? (")).toBeGreaterThan(-1);
    expect(rej.indexOf("{loadingReevalHistory ? (")).toBeLessThan(rej.indexOf("No runs yet"));
  });
});
