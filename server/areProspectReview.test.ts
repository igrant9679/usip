/**
 * A campaign's Prospects tab, as the tester used it (tracker 9, 12, 13; audit
 * 2026-10-20 A45, A50, A51).
 *
 *   the tab opens on the review queue, so an approved prospect leaves it ·
 *   every view, every enrichment state and the search are counted by the
 *   server with the same rule the list reads by · a reject or skip refuses a
 *   replied or finished prospect and stops a sequence's unsent steps · Undo
 *   puts a rejected prospect back in review · a rep can approve, reject and
 *   skip a selection, and nothing else · the header counts one funnel,
 *   recounted on read, so it neither changes meaning nor freezes.
 *
 * Everything runs against the real routers on the SQL-evaluating fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, getTableName } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
import { queueRowsWhere } from "./routers/are/prospects";
import { areCampaigns, areExecutionQueue, prospectQueue, prospects } from "../drizzle/schema";
import { PROSPECT_VIEWS, bulkActionNeedsManager } from "@shared/areProspectViews";
import { RejectReasonPicker, rejectConsequence } from "../client/src/components/usip/are/RejectProspectDialog";
import { actionsForRole } from "../client/src/components/usip/AreBulkActionBar";

const WS = 2, OTHER = 9, CAMPAIGN = 38;
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8").replace(/\r\n/g, "\n");
const T = (t: any) => h.db.rowsOf(getTableName(t)) as any[];
const caller = (ws = WS) => appRouter.createCaller({
  user: { id: 1, openId: "u", email: "o@example.com", name: "O", loginMethod: "password", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() },
  req: { protocol: "https", headers: { "x-workspace-id": String(ws) } },
  res: { clearCookie: () => {} },
} as unknown as TrpcContext);

const q = (id: number, o: Record<string, unknown> = {}) => ({
  id, workspaceId: WS, campaignId: CAMPAIGN, firstName: `Q${id}`, lastName: "R", email: `q${id}@example.com`, title: "VP", companyName: "Co",
  sequenceStatus: "pending", enrichmentStatus: "complete", icpMatchScore: 50, personProspectId: null,
  approvedAt: null, approvedByUserId: null, rejectedAt: null, rejectedByUserId: null, rejectionReason: null, ...o,
});
const row = (id: number) => T(prospectQueue).find((r) => r.id === id);
/** The rows `list` would return for a filter — its own WHERE, on the fake. */
const listed = async (f: Parameters<typeof queueRowsWhere>[1]): Promise<number[]> =>
  (await h.db.select({ id: prospectQueue.id }).from(prospectQueue)
    .leftJoin(prospects, and(eq(prospects.id, prospectQueue.personProspectId), eq(prospects.workspaceId, prospectQueue.workspaceId)))
    .where(queueRowsWhere(WS, f))).map((r: any) => r.id).sort((a: number, b: number) => a - b);

beforeEach(() => {
  h.db = makeSqlFakeDb({ roles: { [WS]: "admin", [OTHER]: "admin" }, wsId: () => WS });
  T(areCampaigns).push({ id: CAMPAIGN, workspaceId: WS, name: "Counties", status: "paused", prospectsApproved: 0, prospectsEnrolled: 0, prospectsDiscovered: 0 });
});

/* ── Views (tracker 12, 13; A45) ─────────────────────────────────────── */

describe("the Prospects tab opens on the review queue and filters on the server", () => {
  beforeEach(() => {
    T(prospectQueue).push(
      q(1), q(2, { enrichmentStatus: "pending" }), q(3, { enrichmentStatus: "failed" }), q(4, { sequenceStatus: "canceled" }),
      q(5, { sequenceStatus: "approved" }), q(6, { sequenceStatus: "enrolled", enrichmentStatus: "complete" }), q(7, { sequenceStatus: "paused" }),
      q(8, { sequenceStatus: "replied" }), q(9, { sequenceStatus: "completed" }),
      q(10, { sequenceStatus: "skipped" }), q(11, { sequenceStatus: "sourcing", enrichmentStatus: "enriching" }),
      q(12, { enrichmentStatus: "enriching", firstName: null, lastName: null, personProspectId: 500 }),
      q(13, { campaignId: 39 }), q(14, { workspaceId: OTHER }),
    );
    T(prospects).push({ id: 500, workspaceId: WS, firstName: "Jane", lastName: "Doe", email: "jane@acme.example", company: "Acme" });
  });

  it("an approved prospect is not in the review queue, and is under Approved", async () => {
    expect(await listed({ campaignId: CAMPAIGN, view: "review" })).toEqual([1, 2, 3, 4, 12]);
    expect(await listed({ campaignId: CAMPAIGN, view: "approved" })).toEqual([5]);
    expect(await listed({ campaignId: CAMPAIGN, view: "in_sequence" })).toEqual([6, 7]);
    expect(await listed({ campaignId: CAMPAIGN, view: "finished" })).toEqual([8, 9]);
    // "All" is the list as it was: everything but rejected and staged rows.
    expect(await listed({ campaignId: CAMPAIGN, view: "all" })).toEqual(await listed({ campaignId: CAMPAIGN }));
    expect(await listed({ campaignId: CAMPAIGN })).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 12]);

    await caller().are.prospects.approve({ prospectId: 1 });
    expect(await listed({ campaignId: CAMPAIGN, view: "review" })).not.toContain(1);
    expect(await listed({ campaignId: CAMPAIGN, view: "approved" })).toContain(1);
  });

  it("each view and enrichment state is counted, and `matching` is the list's length", async () => {
    const c = await caller().are.prospects.statusCounts({ campaignId: CAMPAIGN, view: "review" });
    expect(c.byView).toEqual({ review: 5, approved: 1, in_sequence: 2, finished: 2, all: 10 });
    expect(c.byEnrichment).toEqual({ complete: 2, enriching: 1, pending: 1, failed: 1 });
    expect(c.matching).toBe(5);
    // The badge and the tab's old numbers are unchanged.
    expect(c).toMatchObject({ inQueue: 10, pendingEnrich: 1, awaitingApproval: 1 });

    for (const view of Object.keys(PROSPECT_VIEWS) as Array<keyof typeof PROSPECT_VIEWS>) {
      for (const enrichmentStatus of [undefined, "complete", "enriching", "pending", "failed"] as const) {
        const counts = await caller().are.prospects.statusCounts({ campaignId: CAMPAIGN, view, enrichmentStatus });
        expect(counts.matching, `${view}/${enrichmentStatus}`).toBe((await listed({ campaignId: CAMPAIGN, view, enrichmentStatus })).length);
      }
    }
  });

  it("search finds a person by the linked record's name too, and every word must match", async () => {
    expect(await listed({ campaignId: CAMPAIGN, view: "all", search: "jane" })).toEqual([12]);
    expect(await listed({ campaignId: CAMPAIGN, view: "all", search: "Jane Acme" })).toEqual([12]);
    expect(await listed({ campaignId: CAMPAIGN, view: "all", search: "Jane Nowhere" })).toEqual([]);
    expect(await listed({ campaignId: CAMPAIGN, view: "all", search: "q5@example" })).toEqual([5]);
    const c = await caller().are.prospects.statusCounts({ campaignId: CAMPAIGN, view: "review", search: "jane" });
    expect(c.matching).toBe(1);
    expect(c.byEnrichment).toEqual({ complete: 0, enriching: 1, pending: 0, failed: 0 });
    // The tab's badge stays the whole queue while a search is typed.
    expect(c.inQueue).toBe(10);
  });
});

/* ── Reject, skip, Undo (A51) ────────────────────────────────────────── */

describe("a reject or skip leaves a reply alone and stops a running sequence", () => {
  beforeEach(() => {
    T(prospectQueue).push(q(1), q(2, { sequenceStatus: "enrolled" }), q(3, { sequenceStatus: "replied" }), q(4, { sequenceStatus: "completed" }));
    T(areExecutionQueue).push(
      { id: 21, workspaceId: WS, campaignId: CAMPAIGN, prospectQueueId: 2, stepIndex: 0, status: "sent", failureReason: null },
      { id: 22, workspaceId: WS, campaignId: CAMPAIGN, prospectQueueId: 2, stepIndex: 1, status: "scheduled", failureReason: null },
      { id: 23, workspaceId: WS, campaignId: CAMPAIGN, prospectQueueId: 2, stepIndex: 2, status: "paused", failureReason: "Held: sequence paused" },
    );
  });
  const step = (id: number) => T(areExecutionQueue).find((s) => s.id === id);

  it("refuses a replied or finished prospect, for reject and skip alike", async () => {
    await expect(caller().are.prospects.reject({ prospectId: 3, reason: "Wrong industry" })).rejects.toThrow(/replied/);
    await expect(caller().are.prospects.skip({ prospectId: 4 })).rejects.toThrow(/finished/);
    expect(row(3).sequenceStatus).toBe("replied");
    expect(row(4).sequenceStatus).toBe("completed");
  });

  it("a rejected prospect mid-sequence has its unsent steps stopped, with the reason recorded", async () => {
    const r = await caller().are.prospects.reject({ prospectId: 2, reason: "Competitor" });
    expect(r).toMatchObject({ before: "enrolled", stepsStopped: 2 });
    expect(row(2)).toMatchObject({ sequenceStatus: "skipped", rejectionReason: "Competitor", rejectedByUserId: 1 });
    expect(step(21).status).toBe("sent");
    expect(step(22)).toMatchObject({ status: "skipped", failureReason: "Rejected — Competitor" });
    expect(step(23).status).toBe("skipped");
  });

  it("a skip stops them too; rejecting twice is a no-op", async () => {
    expect(await caller().are.prospects.skip({ prospectId: 2 })).toMatchObject({ stepsStopped: 2 });
    expect(await caller().are.prospects.reject({ prospectId: 2 })).toMatchObject({ before: "skipped", stepsStopped: 0 });
  });

  it("Undo puts a rejected prospect back in review, and only a rejected one", async () => {
    await caller().are.prospects.reject({ prospectId: 1, reason: "Wrong industry" });
    await caller().are.prospects.restore({ prospectId: 1 });
    expect(row(1)).toMatchObject({ sequenceStatus: "pending", rejectedAt: null, rejectionReason: null });
    await expect(caller().are.prospects.restore({ prospectId: 3 })).rejects.toThrow("not rejected (status replied)");
    // The bulk bar's Restore is the same procedure.
    await caller().are.prospects.reject({ prospectId: 1 });
    const bulk = await caller().are.prospects.bulk({ campaignId: CAMPAIGN, prospectIds: [1, 3], action: "restore", reason: "misclick" });
    expect(bulk.ok).toBe(1);
    expect(bulk.failed).toEqual([{ id: 3, error: "not rejected (status replied)" }]);
    expect(row(1)).toMatchObject({ sequenceStatus: "pending", rejectionReason: "Restored — misclick" });
  });

  it("the older bulkReject follows the same rule", async () => {
    expect(await caller().are.prospects.bulkReject({ prospectIds: [1, 2, 3], reason: "x" })).toEqual({ rejected: 2 });
    expect(row(3).sequenceStatus).toBe("replied");
    expect(step(22).status).toBe("skipped");
  });
});

/* ── A rep's bulk bar (tracker 9) ────────────────────────────────────── */

describe("a rep can approve, reject and skip a selection", () => {
  beforeEach(() => {
    h.db = makeSqlFakeDb({ roles: { [WS]: "rep" }, wsId: () => WS });
    T(areCampaigns).push({ id: CAMPAIGN, workspaceId: WS, name: "Counties", status: "paused" });
    T(prospectQueue).push(q(1, { personProspectId: 501 }), q(2, { personProspectId: 502 }), q(3, { personProspectId: 503 }));
  });

  it("approve and reject run for a rep", async () => {
    expect((await caller().are.prospects.bulk({ campaignId: CAMPAIGN, prospectIds: [1], action: "approve" })).ok).toBe(1);
    expect(row(1).sequenceStatus).toBe("approved");
    expect((await caller().are.prospects.bulk({ campaignId: CAMPAIGN, prospectIds: [2], action: "reject", reason: "Too small" })).ok).toBe(1);
    expect(row(2)).toMatchObject({ sequenceStatus: "skipped", rejectionReason: "Too small" });
    expect((await caller().are.prospects.bulk({ campaignId: CAMPAIGN, prospectIds: [3], action: "skip" })).ok).toBe(1);
  });

  it("everything else stays a manager's", async () => {
    await expect(caller().are.prospects.bulk({ campaignId: CAMPAIGN, prospectIds: [1], action: "suppress" })).rejects.toThrow(/managers/);
    await expect(caller().are.prospects.bulk({ campaignId: CAMPAIGN, prospectIds: [1], action: "restore" })).rejects.toThrow(/managers/);
    for (const a of ["enrich", "generateSequence", "activateSequence", "cancelSequence", "addToList", "createTasks", "linkToPeople", "reEvaluate", "editTimeline", "pauseSequence", "resumeSequence"]) {
      expect(bulkActionNeedsManager(a), a).toBe(true);
    }
  });
});

/* ── The header counters (A50) ───────────────────────────────────────── */

describe("the header counts one funnel, and a paused campaign's is fresh", () => {
  beforeEach(() => {
    T(prospectQueue).push(
      q(1), q(2), q(3, { sequenceStatus: "enrolled" }), q(4, { sequenceStatus: "paused" }), q(5, { sequenceStatus: "replied" }),
      q(6, { sequenceStatus: "approved" }), q(7, { sequenceStatus: "skipped", enrichmentStatus: "pending" }), q(8, { campaignId: 39, sequenceStatus: "approved" }),
    );
    T(areExecutionQueue).push(
      { id: 31, workspaceId: WS, campaignId: CAMPAIGN, prospectQueueId: 3, stepIndex: 0, status: "sent" },
      { id: 32, workspaceId: WS, campaignId: CAMPAIGN, prospectQueueId: 5, stepIndex: 0, status: "sent" },
      { id: 33, workspaceId: WS, campaignId: CAMPAIGN, prospectQueueId: 4, stepIndex: 0, status: "scheduled" },
    );
  });
  const campaign = () => T(areCampaigns).find((c) => c.id === CAMPAIGN);

  it("reading a paused campaign recounts it, and stores the count", async () => {
    const c = await caller().are.campaigns.get({ id: CAMPAIGN });
    expect(c).toMatchObject({
      prospectsDiscovered: 7, prospectsEnriched: 6, prospectsApproved: 4, prospectsEnrolled: 3, prospectsContacted: 2, prospectsReplied: 1,
    });
    expect(campaign().prospectsApproved).toBe(4);
  });

  it("Approve all keeps Approved meaning everyone approved or further along", async () => {
    const { approved } = await caller().are.campaigns.approveAllPending({ campaignId: CAMPAIGN });
    expect(approved).toBe(2);
    // 4 who were already approved or further, plus the 2 just approved —
    // not the 3 whose status happens to read `approved` right now.
    expect(campaign().prospectsApproved).toBe(6);
    expect(campaign().prospectsEnrolled).toBe(3);
  });

  // 2026-11-06 (audit A69, batch E1): approveBatch was removed — no screen
  // called it, and it approved rows in any state. What this pinned still
  // holds: no door in the campaigns router writes the Approved counter itself;
  // the one recount does.
  it("no other door writes the Approved counter itself (approveBatch is gone)", () => {
    const src = read("server/routers/are/campaigns.ts");
    expect(src).not.toContain("approveBatch: workspaceProcedure");
    expect(src).not.toMatch(/prospectsApproved:\s/);
    expect(src).toContain("await recountCampaignCounters(db, ctx.workspace.id, input.campaignId);");
  });
});

/* ── The tab itself ──────────────────────────────────────────────────── */

describe("the tab opens on review, filters by state, and its ✕ is a Reject with Undo", () => {
  const page = read("client/src/pages/usip/ARECampaignDetail.tsx");
  const rowFn = page.slice(page.indexOf("function ProspectRow("), page.indexOf("/* ─── Intelligence dossier"));
  const tab = page.slice(page.indexOf("{/* ── Prospects tab ── */}"), page.indexOf("{/* ── Scraper tab ── */}"));

  it("opens on the review queue and sends the view, enrichment state and search to the server", () => {
    expect(rowFn.length).toBeGreaterThan(1000);
    expect(tab.length).toBeGreaterThan(1000);
    // 2026-11-08 (audit U6): still opens on review, now kept in ?view=.
    expect(page).toContain('const [prospectView, setProspectView] = useUrlState<ProspectView>("view", urlParam.oneOf(PROSPECT_VIEW_KEYS, "review"));');
    expect(page).toContain("...(enrichFilter ? { enrichmentStatus: enrichFilter } : {}),");
    expect(page).toContain("...(prospectSearchQ ? { search: prospectSearchQ } : {}),");
    // One chip per view and per enrichment state, each with the server's count.
    expect(tab).toContain("PROSPECT_VIEW_KEYS.map((v) =>");
    expect(tab).toContain("queueCounts?.byView?.[v]");
    expect(tab).toContain("ENRICHMENT_STATES.map((e) =>");
    expect(tab).toContain("onClick={() => setEnrichFilter(enrichFilter === e ? null : e)}");
    expect(tab).toContain("queueCounts?.byEnrichment?.[e]");
    expect(tab).toContain('aria-label="Search prospects"');
  });

  it("the row's ✕ opens the Reject dialog instead of skipping, and is not offered on a reply", () => {
    expect(rowFn).not.toContain("trpc.are.prospects.skip.useMutation");
    expect(rowFn).toContain("onClick={() => onReject({ id: p.id, name: fullName, sequenceStatus: p.sequenceStatus })}");
    expect(rowFn).toContain("Reject…");
    expect(rowFn).toContain('{p.sequenceStatus !== "replied" && p.sequenceStatus !== "completed" && (');
    expect(tab).toContain("<RejectProspectDialog target={rejectTarget} presets={REJECT_TEMPLATES}");
    expect(tab).toContain("onReject={setRejectTarget}");
    const dialog = read("client/src/components/usip/are/RejectProspectDialog.tsx");
    expect(dialog).toContain('action: { label: "Undo", onClick: () => restore.mutate({ prospectId: vars.prospectId }) }');
    expect(dialog).toContain("reject.mutate({ prospectId: target.id, reason: reason.trim() || undefined })");
  });

  it("the dialog offers the bulk bar's reasons and says what happens to a running sequence", () => {
    const html = renderToStaticMarkup(createElement(RejectReasonPicker, { presets: ["Wrong industry", "Competitor"], reason: "Competitor", onChange: () => {} }));
    expect(html).toContain("Wrong industry");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Competitor</);
    expect(rejectConsequence("enrolled")).toMatch(/steps not yet sent are canceled/);
    expect(rejectConsequence("pending")).toMatch(/leave the review queue/);
  });

  it("a rep's bulk bar offers approve, reject and skip, and nothing they would be refused", () => {
    const defs = ["approve", "reject", "skip", "enrich", "suppress", "addToList"].map((key) => ({ key, label: key })) as any[];
    expect(actionsForRole(defs, "rep").map((a) => a.key)).toEqual(["approve", "reject", "skip"]);
    expect(actionsForRole(defs, null).map((a) => a.key)).toEqual(["approve", "reject", "skip"]);
    expect(actionsForRole(defs, "manager")).toHaveLength(6);
    expect(read("client/src/components/usip/AreBulkActionBar.tsx")).toContain("const offered = actionsForRole(actions, current?.role);");
  });
});
