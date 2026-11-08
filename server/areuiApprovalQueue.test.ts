/**
 * The cross-campaign approval queue (audit 2026-10-20, F16): filters for
 * campaign, score, source and kind; "approve all above a score" with a
 * dry-run count first; reject with the campaign tab's reason presets.
 * Approving queues work and sends nothing.
 *
 * Runs on the SQL-evaluating fake; the screen is pinned by its source.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrpcContext } from "./_core/context";

const h = vi.hoisted(() => {
  if (!process.env.ENCRYPTION_KEY && !process.env.JWT_SECRET) process.env.ENCRYPTION_KEY = "9".repeat(64);
  return { db: null as any };
});
vi.mock("./db", async (a) => ({ ...(await a<typeof import("./db")>()), getDb: async () => h.db, checkPermission: async () => {} }));
vi.mock("./services/are/approvePromotion", async (a) => ({ ...(await a<typeof import("./services/are/approvePromotion")>()), promoteApprovedProspects: async () => ({}) }));

import { makeSqlFakeDb } from "./__fakes__/sqlFakeDb";
import { appRouter } from "./routers";
import { approveAboveMessage } from "../client/src/pages/usip/AREApprovals";
import { PERSON_REJECT_PRESETS } from "@shared/rejectionKind";

const WS = 2, OTHER = 9, ME = 3;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const rows = (t: string) => h.db.rowsOf(t) as any[];
const pq = (id: number) => rows("prospect_queue").find((r) => r.id === id);
const caller = () => appRouter.createCaller({
  user: { id: ME, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(WS) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);
const q = (id: number, o: Record<string, unknown>) => ({
  id, workspaceId: WS, campaignId: 10, firstName: `P${id}`, lastName: "X", email: `p${id}@example.com`, companyName: "Co", title: "Clerk",
  sequenceStatus: "pending", enrichmentStatus: "complete", icpMatchScore: 50, sourceType: "linkedin_people", approvedAt: null, approvedByUserId: null, ...o,
});

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
  rows("are_campaigns").push(
    { id: 10, workspaceId: WS, name: "Counties", status: "active", archivedAt: null },
    { id: 11, workspaceId: WS, name: "Cities", status: "paused", archivedAt: null },
    { id: 12, workspaceId: WS, name: "Old", status: "paused", archivedAt: new Date() },
    { id: 10, workspaceId: OTHER, name: "Theirs", status: "active", archivedAt: null },
  );
  rows("prospect_queue").push(
    q(1, { icpMatchScore: 90 }),
    q(2, { icpMatchScore: 75, campaignId: 11, sourceType: "apollo" }),
    q(3, { icpMatchScore: 60, sequenceStatus: "canceled" }),
    q(4, { icpMatchScore: 95, enrichmentStatus: "pending" }),          // not enriched: not waiting
    q(5, { icpMatchScore: 99, sequenceStatus: "approved" }),            // decided
    q(6, { icpMatchScore: 88, campaignId: 12 }),                        // archived campaign
    q(7, { icpMatchScore: 97, workspaceId: OTHER }),                    // another workspace
    q(8, { icpMatchScore: 40, campaignId: 11 }),
  );
});

describe("the queue", () => {
  it("every enriched prospect waiting, in campaigns not archived, best fit first, with its campaign", async () => {
    const r = await caller().are.approvals.queue({});
    expect(r.rows.map((x) => x.id)).toEqual([1, 2, 3, 8]);
    expect(r.total).toBe(4);
    expect(r.rows[1]).toMatchObject({ campaignName: "Cities", campaignStatus: "paused", sourceType: "apollo" });
    expect(r.byCampaign).toEqual([{ campaignId: 10, name: "Counties", status: "active", count: 2 }, { campaignId: 11, name: "Cities", status: "paused", count: 2 }]);
    expect(r.bySource).toEqual([{ source: "linkedin_people", count: 3 }, { source: "apollo", count: 1 }]);
    expect(r.byKind).toEqual({ new: 3, returned: 1 });
  });

  it("filters by campaign, score, source, kind and search, on the server", async () => {
    const ids = async (f: Record<string, unknown>) => (await caller().are.approvals.queue(f as never)).rows.map((x) => x.id);
    expect(await ids({ campaignId: 11 })).toEqual([2, 8]);
    expect(await ids({ minScore: 70 })).toEqual([1, 2]);
    expect(await ids({ source: "apollo" })).toEqual([2]);
    expect(await ids({ kind: "returned" })).toEqual([3]);
    expect(await ids({ kind: "new", minScore: 50 })).toEqual([1, 2]);
    expect(await ids({ search: "p8@" })).toEqual([8]);
    expect((await caller().are.approvals.queue({ minScore: 70 })).total).toBe(2);
  });
});

describe("approve all above a score: a count first, then no more than it", () => {
  it("the dry run counts, campaign by campaign, and changes nothing", async () => {
    const p = await caller().are.approvals.approveAbovePreview({ minScore: 70 });
    expect(p).toMatchObject({ count: 2, capped: false });
    expect(p.byCampaign.map((c) => [c.name, c.count])).toEqual([["Counties", 1], ["Cities", 1]]);
    expect(rows("prospect_queue").filter((r) => r.sequenceStatus === "approved").map((r) => r.id)).toEqual([5]);
  });

  it("the run approves exactly what was counted, stamped once, and recounts each campaign", async () => {
    const r = await caller().are.approvals.approveAbove({ minScore: 70, confirmedCount: 2 });
    expect(r).toEqual({ approved: 2, campaigns: 2 });
    expect([pq(1).sequenceStatus, pq(2).sequenceStatus, pq(3).sequenceStatus, pq(8).sequenceStatus]).toEqual(["approved", "approved", "canceled", "pending"]);
    expect(pq(1).approvedByUserId).toBe(ME);
    // Never the archived campaign's, the unenriched, or another workspace's.
    expect([pq(4).sequenceStatus, pq(6).sequenceStatus, pq(7).sequenceStatus]).toEqual(["pending", "pending", "pending"]);
  });

  it("more matching than was counted is refused, and nothing changes", async () => {
    await expect(caller().are.approvals.approveAbove({ minScore: 50, confirmedCount: 2 })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("now 3") });
    expect(rows("prospect_queue").filter((r) => r.sequenceStatus === "approved").map((r) => r.id)).toEqual([5]);
  });

  it("the confirm says how many, where, and that approving sends nothing by itself", () => {
    const msg = approveAboveMessage({ count: 3, byCampaign: [{ name: "Counties", status: "active", count: 2 }, { name: "Cities", status: "paused", count: 1 }] }, 70);
    expect(msg).toContain("3 people score 70 or more: 2 in Counties (active), 1 in Cities (paused).");
    expect(msg).toContain("it sends nothing by itself");
    expect(msg).toContain("The 2 in active campaigns are written and sent on each campaign's cadence, within its daily cap and send window.");
    expect(msg).toContain("Nothing is sent while outbound is paused for the workspace.");
    expect(approveAboveMessage({ count: 1, byCampaign: [{ name: "Cities", status: "paused", count: 1 }] }, 80)).toContain("nothing goes until a campaign is activated");
  });
});

describe("a selection", () => {
  it("approves only queue rows: not another workspace's, an archived campaign's, or one already decided", async () => {
    const r = await caller().are.approvals.approveSelected({ prospectIds: [3, 5, 6, 7] });
    expect(r.approved).toBe(1);
    expect([pq(3).sequenceStatus, pq(5).sequenceStatus, pq(6).sequenceStatus, pq(7).sequenceStatus]).toEqual(["approved", "approved", "pending", "pending"]);
  });

  it("rejects across campaigns with a reason, through bulkReject", async () => {
    const r = await caller().are.prospects.bulkReject({ prospectIds: [1, 2], reason: PERSON_REJECT_PRESETS[0] });
    expect(r.rejected).toBe(2);
    expect(pq(1)).toMatchObject({ sequenceStatus: "skipped", rejectionReason: "Wrong industry", rejectionKind: "person" });
    expect(pq(2)).toMatchObject({ sequenceStatus: "skipped", rejectionReason: "Wrong industry" });
  });
});

describe("the screen", () => {
  const page = read("client/src/pages/usip/AREApprovals.tsx");

  it("is a lazy route on the engine's sub-nav, and the hub's pill and the attention card open it", () => {
    const app = read("client/src/App.tsx");
    expect(app).toContain('const AREApprovals = lazyChunk(() => import("@/pages/usip/AREApprovals"));');
    expect(app).toContain('<Route path="/are/approvals"><AuthGate><AREApprovals /></AuthGate></Route>');
    expect(read("client/src/components/usip/are/AreSubNav.tsx")).toContain('{ href: "/are/approvals", label: "Approvals"');
    const hub = read("client/src/pages/usip/AREHub.tsx");
    expect(hub).toContain('href="/are/approvals"');
    expect(hub).not.toContain("attention!.areApprovals.byCampaign[0]?.campaignId");
    expect(read("client/src/components/usip/AttentionPanel.tsx")).toContain('count={s.areApprovals.count} cta="Approve" href="/are/approvals">');
  });

  it("filters on the server, counts before approving above a score, and rejects with the shared presets", () => {
    expect(page).toContain("trpc.are.approvals.queue.useQuery({ ...filter, limit: PAGE, offset: (page - 1) * PAGE }");
    expect(page).toContain("utils.are.approvals.approveAbovePreview.fetch({ ...rest, minScore: aboveScore }, { staleTime: 0 })");
    expect(page).toContain("}, () => approveAbove.mutate({ ...rest, minScore: aboveScore, confirmedCount: preview.count }));");
    expect(page).toContain("const PRESETS: string[] = [...PERSON_REJECT_PRESETS];");
    expect(page).toContain("<RejectProspectDialog target={rejectTarget} presets={PRESETS}");
    expect(page).toContain("<RejectReasonPicker presets={PRESETS}");
    expect(page).toContain("bulkReject.mutate({ prospectIds: Array.from(selected), reason: rejectReason.trim() || undefined })");
  });

  it("the campaign tab offers the same reasons", () => {
    expect(read("client/src/pages/usip/ARECampaignDetail.tsx")).toContain("const REJECT_TEMPLATES: string[] = [...PERSON_REJECT_PRESETS];");
  });
});
