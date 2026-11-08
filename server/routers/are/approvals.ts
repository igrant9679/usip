/**
 * ARE — the cross-campaign approval queue (audit 2026-10-20, F16).
 *
 * The hub's "N awaiting your approval" pill linked to the first campaign with
 * any, so approving across campaigns meant visiting each one. This is every
 * enriched prospect still waiting for a decision, in every campaign that is
 * not archived, filterable by campaign, ICP score, source and kind, ranked by
 * fit as each campaign's own review queue is.
 *
 *   kind "new"       never decided (sequenceStatus pending)
 *   kind "returned"  their sequence was canceled and they are back for a
 *                    fresh decision (canceled) — the Prospects tab's review
 *                    view holds both, and its row offers Approve for both
 *
 * "Approve all above a score" counts first (approveAbovePreview) and the run
 * names the count it was shown: if more match by then, it refuses rather than
 * approve people nobody counted. Approving queues work and sends nothing:
 * each campaign's engine writes the sequences and sends within its own cap,
 * window and the workspace pause, exactly as after any other approval.
 * Rejecting goes through are.prospects.bulkReject with the same reason
 * presets the campaign tab offers.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNull, like, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { areCampaigns, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";
import { recountCampaignCounters } from "../../services/are/campaignCounters";
import { affectedRowsOf } from "../../_core/claim";
import { promoteApprovedProspects } from "../../services/are/approvePromotion";
import { searchWords } from "@shared/areProspectViews";

export const APPROVAL_KINDS = ["new", "returned"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];
const STATUS_OF: Record<ApprovalKind, "pending" | "canceled"> = { new: "pending", returned: "canceled" };
/** Most an "approve all above" run approves at once; the count says when there are more. */
export const APPROVE_ABOVE_MAX = 2000;

const filterShape = {
  campaignId: z.number().int().positive().optional(),
  minScore: z.number().int().min(0).max(100).optional(),
  source: z.string().max(40).optional(),
  kind: z.enum(APPROVAL_KINDS).optional(),
  search: z.string().trim().max(200).optional(),
};
type Filter = { campaignId?: number; minScore?: number; source?: string; kind?: ApprovalKind; search?: string };

/* Each join to the row's campaign matches the workspace as well as the id, written out at the
   join so the guard in auditPassLeftovers.test.ts can read it; approvalWhere drops archived ones (F15). */

/** Waiting for a decision, enriched, in this workspace, in a campaign not archived, narrowed by the filter. */
export function approvalWhere(workspaceId: number, f: Filter): SQL {
  const conds: Array<SQL | undefined> = [
    eq(prospectQueue.workspaceId, workspaceId),
    eq(prospectQueue.enrichmentStatus, "complete"),
    f.kind ? eq(prospectQueue.sequenceStatus, STATUS_OF[f.kind]) : inArray(prospectQueue.sequenceStatus, ["pending", "canceled"]),
    isNull(areCampaigns.archivedAt),
    f.campaignId ? eq(prospectQueue.campaignId, f.campaignId) : undefined,
    f.minScore != null ? gte(prospectQueue.icpMatchScore, f.minScore) : undefined,
    f.source ? eq(prospectQueue.sourceType, f.source as never) : undefined,
  ];
  for (const w of searchWords(f.search)) {
    const s = `%${w}%`;
    conds.push(or(like(prospectQueue.firstName, s), like(prospectQueue.lastName, s), like(prospectQueue.email, s), like(prospectQueue.companyName, s), like(prospectQueue.title, s)));
  }
  return and(...conds)!;
}

async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  return db;
}

/** Approve these rows, stamping the decision once (as are.prospects.approve does), then recount their campaigns. */
async function approveRows(db: Awaited<ReturnType<typeof requireDb>>, workspaceId: number, userId: number, ids: number[]): Promise<{ approved: number; campaigns: number[] }> {
  if (ids.length === 0) return { approved: 0, campaigns: [] };
  const touched = await db.select({ campaignId: prospectQueue.campaignId }).from(prospectQueue)
    .where(and(eq(prospectQueue.workspaceId, workspaceId), inArray(prospectQueue.id, ids)));
  const r = await db.update(prospectQueue).set({
    sequenceStatus: "approved",
    approvedAt: sql`COALESCE(${prospectQueue.approvedAt}, NOW())`,
    approvedByUserId: sql`COALESCE(${prospectQueue.approvedByUserId}, ${userId})`,
  }).where(and(
    eq(prospectQueue.workspaceId, workspaceId),
    inArray(prospectQueue.id, ids),
    // Only from a state still waiting for a decision: one decided meanwhile is left alone.
    inArray(prospectQueue.sequenceStatus, ["pending", "canceled"]),
    eq(prospectQueue.enrichmentStatus, "complete"),
  ));
  // Rows changed, read the one way (X1.5, at the merge with PLAT 2026-11-07).
  const approved = affectedRowsOf(r);
  const campaigns = Array.from(new Set(touched.map((t) => Number(t.campaignId))));
  for (const c of campaigns) await recountCampaignCounters(db, workspaceId, c);
  // Companies for the approved people, as after any approval; never blocks it.
  void promoteApprovedProspects(workspaceId, { queueIds: ids });
  return { approved, campaigns };
}

export const approvalsRouter = router({
  /** A page of the queue, best fit first, with the counts its filters offer. */
  queue: workspaceProcedure
    .input(z.object({ ...filterShape, limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) }))
    .query(async ({ ctx, input }) => {
      const db = await requireDb();
      const ws = ctx.workspace.id;
      const where = approvalWhere(ws, input);
      const rows = await db.select({
        id: prospectQueue.id,
        campaignId: prospectQueue.campaignId,
        campaignName: areCampaigns.name,
        campaignStatus: areCampaigns.status,
        firstName: prospectQueue.firstName,
        lastName: prospectQueue.lastName,
        title: prospectQueue.title,
        companyName: prospectQueue.companyName,
        email: prospectQueue.email,
        icpMatchScore: prospectQueue.icpMatchScore,
        sourceType: prospectQueue.sourceType,
        sequenceStatus: prospectQueue.sequenceStatus,
        enrichmentStatus: prospectQueue.enrichmentStatus,
        personProspectId: prospectQueue.personProspectId,
        createdAt: prospectQueue.createdAt,
      })
        .from(prospectQueue)
        .innerJoin(areCampaigns, and(eq(areCampaigns.id, prospectQueue.campaignId), eq(areCampaigns.workspaceId, prospectQueue.workspaceId)))
        .where(where)
        .orderBy(desc(prospectQueue.icpMatchScore), desc(prospectQueue.id))
        .limit(input.limit)
        .offset(input.offset);
      const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(prospectQueue).innerJoin(areCampaigns, and(eq(areCampaigns.id, prospectQueue.campaignId), eq(areCampaigns.workspaceId, prospectQueue.workspaceId))).where(where);
      // The facets: every waiting row, whatever the filters (they are the filter's choices).
      const everything = approvalWhere(ws, {});
      const byCampaign = await db.select({ campaignId: prospectQueue.campaignId, name: areCampaigns.name, status: areCampaigns.status, n: sql<number>`count(*)` })
        .from(prospectQueue).innerJoin(areCampaigns, and(eq(areCampaigns.id, prospectQueue.campaignId), eq(areCampaigns.workspaceId, prospectQueue.workspaceId))).where(everything)
        .groupBy(prospectQueue.campaignId, areCampaigns.name, areCampaigns.status);
      const bySource = await db.select({ source: prospectQueue.sourceType, n: sql<number>`count(*)` })
        .from(prospectQueue).innerJoin(areCampaigns, and(eq(areCampaigns.id, prospectQueue.campaignId), eq(areCampaigns.workspaceId, prospectQueue.workspaceId))).where(everything)
        .groupBy(prospectQueue.sourceType);
      const byStatus = await db.select({ status: prospectQueue.sequenceStatus, n: sql<number>`count(*)` })
        .from(prospectQueue).innerJoin(areCampaigns, and(eq(areCampaigns.id, prospectQueue.campaignId), eq(areCampaigns.workspaceId, prospectQueue.workspaceId))).where(everything)
        .groupBy(prospectQueue.sequenceStatus);
      const statusCount = (s: string) => Number(byStatus.find((b) => b.status === s)?.n ?? 0);
      return {
        rows,
        total: Number(n),
        byCampaign: byCampaign.map((c) => ({ campaignId: Number(c.campaignId), name: c.name, status: c.status, count: Number(c.n) })).sort((a, b) => b.count - a.count),
        bySource: bySource.map((s) => ({ source: String(s.source), count: Number(s.n) })).sort((a, b) => b.count - a.count),
        byKind: { new: statusCount("pending"), returned: statusCount("canceled") },
      };
    }),

  /** The dry run: how many "approve all at or above" would approve now, campaign by campaign. Changes nothing. */
  approveAbovePreview: workspaceProcedure
    .input(z.object({ ...filterShape, minScore: z.number().int().min(0).max(100) }))
    .query(async ({ ctx, input }) => {
      const db = await requireDb();
      const where = approvalWhere(ctx.workspace.id, input);
      const groups = await db.select({ campaignId: prospectQueue.campaignId, name: areCampaigns.name, status: areCampaigns.status, n: sql<number>`count(*)` })
        .from(prospectQueue).innerJoin(areCampaigns, and(eq(areCampaigns.id, prospectQueue.campaignId), eq(areCampaigns.workspaceId, prospectQueue.workspaceId))).where(where)
        .groupBy(prospectQueue.campaignId, areCampaigns.name, areCampaigns.status);
      const byCampaign = groups.map((g) => ({ campaignId: Number(g.campaignId), name: g.name, status: g.status, count: Number(g.n) })).sort((a, b) => b.count - a.count);
      const count = byCampaign.reduce((s, c) => s + c.count, 0);
      return { count, capped: count > APPROVE_ABOVE_MAX, max: APPROVE_ABOVE_MAX, byCampaign };
    }),

  /**
   * Approve every waiting prospect at or above a score (with the same other
   * filters), up to the count the person was shown. More by now is refused.
   */
  approveAbove: workspaceProcedure
    .input(z.object({ ...filterShape, minScore: z.number().int().min(0).max(100), confirmedCount: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const ws = ctx.workspace.id;
      const ids = (await db.select({ id: prospectQueue.id }).from(prospectQueue).innerJoin(areCampaigns, and(eq(areCampaigns.id, prospectQueue.campaignId), eq(areCampaigns.workspaceId, prospectQueue.workspaceId)))
        .where(approvalWhere(ws, input))
        .orderBy(desc(prospectQueue.icpMatchScore), desc(prospectQueue.id))
        .limit(APPROVE_ABOVE_MAX + 1)).map((r) => Number(r.id));
      if (ids.length > Math.min(input.confirmedCount, APPROVE_ABOVE_MAX)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: ids.length > APPROVE_ABOVE_MAX
            ? `More than ${APPROVE_ABOVE_MAX.toLocaleString("en-US")} match; raise the score or narrow the filters, then count again.`
            : `More prospects match than the ${input.confirmedCount} you counted (now ${ids.length}). Count again before approving.`,
        });
      }
      const r = await approveRows(db, ws, ctx.user.id, ids);
      return { approved: r.approved, campaigns: r.campaigns.length };
    }),

  /** Approve a selection from the queue, in any campaigns. */
  approveSelected: workspaceProcedure
    .input(z.object({ prospectIds: z.array(z.number().int().positive()).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      // Only rows the queue would show: waiting, enriched, in a campaign not archived.
      const ids = (await db.select({ id: prospectQueue.id }).from(prospectQueue).innerJoin(areCampaigns, and(eq(areCampaigns.id, prospectQueue.campaignId), eq(areCampaigns.workspaceId, prospectQueue.workspaceId)))
        .where(and(approvalWhere(ctx.workspace.id, {}), inArray(prospectQueue.id, input.prospectIds)))).map((r) => Number(r.id));
      const r = await approveRows(db, ctx.workspace.id, ctx.user.id, ids);
      return { approved: r.approved, campaigns: r.campaigns.length };
    }),
});
