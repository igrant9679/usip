/**
 * ARE — Engine Router
 *
 * Exposes back-end engine activity (per-phase logs) for the campaign Logs
 * tab, plus a manual run trigger.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { areCampaigns, areEngineLogs, prospectIntelligence, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";
import { enrollApprovedForCampaign, runAreEngine } from "../../areEngine";
import type { AreEngineResult } from "../../areEngine";

export const engineRouter = router({
  /** Per-campaign back-end activity log (newest first). */
  getLogs: workspaceProcedure
    .input(z.object({
      campaignId: z.number().optional(),
      limit: z.number().min(1).max(500).default(200),
      phase: z.string().optional(),
      level: z.enum(["info", "warn", "error"]).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const where = [eq(areEngineLogs.workspaceId, ctx.workspace.id)];
      if (input.campaignId !== undefined) {
        where.push(eq(areEngineLogs.campaignId, input.campaignId));
      }
      if (input.phase) where.push(eq(areEngineLogs.phase, input.phase));
      if (input.level) where.push(eq(areEngineLogs.level, input.level));
      return db
        .select()
        .from(areEngineLogs)
        .where(and(...where))
        .orderBy(desc(areEngineLogs.createdAt))
        .limit(input.limit);
    }),

  /** Manual tick — same as campaigns.runEngine; kept here for symmetry. */
  runOnce: workspaceProcedure.mutation(async () => runAreEngine()),

  /**
   * Run ONLY the enrol phase for one campaign — paused or not — and nothing
   * else. No screen, no sequence generation, no dispatch, no discovery.
   *
   * Enrolment is bookkeeping: it turns already-approved, already-generated
   * sequences into scheduled steps. Dispatch is outreach. Until now the two
   * were only reachable together, through a full engine tick on an ACTIVE
   * campaign — so putting a paused campaign's approved prospects into their
   * correct "enrolled" state meant unpausing, ticking, and re-pausing before
   * dispatch found anything due. From a browser session that could time out
   * and complete late, that left campaigns active with nobody watching.
   *
   * This runs on a paused campaign by design. Steps it creates are scheduled
   * from each prospect's real first-send anchor and go nowhere until the
   * campaign is unpaused; that decision stays with the human.
   *
   * Bounded per call by the same ENROLL_PER_CAMPAIGN_TICK the engine uses, so
   * call it repeatedly for a backlog — each call reports what it did and how
   * many approved-with-sequence prospects remain.
   */
  enrollOnly: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [campaign] = await db.select().from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.campaignId), eq(areCampaigns.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND" });
      const result: AreEngineResult = {
        campaignsProcessed: 1, enriched: 0, approved: 0, rejected: 0,
        sequencesGenerated: 0, enrolled: 0, sent: 0, discovered: 0,
      };
      await enrollApprovedForCampaign(campaign, result);
      const [remaining] = await db
        .select({ n: sql<number>`count(*)` })
        .from(prospectQueue)
        .innerJoin(prospectIntelligence, eq(prospectIntelligence.prospectQueueId, prospectQueue.id))
        .where(and(
          eq(prospectQueue.campaignId, input.campaignId),
          eq(prospectQueue.workspaceId, ctx.workspace.id),
          eq(prospectQueue.sequenceStatus, "approved"),
          sql`${prospectIntelligence.generatedSequence} IS NOT NULL`,
        ));
      return {
        campaignStatus: campaign.status,
        enrolled: result.enrolled,
        remainingApproved: Number(remaining?.n ?? 0),
        /** True when this call did nothing because another enrol run held the
         *  campaign lock. Call again; do not read enrolled:0 as finished. */
        skippedInFlight: (result.enrolSkippedInFlight ?? 0) > 0,
      };
    }),
});
