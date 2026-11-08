/**
 * ARE — Engine Router
 *
 * Exposes back-end engine activity (per-phase logs) for the campaign Logs
 * tab, plus a manual run trigger.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNotNull, like, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { areCampaigns, areEngineLogs, prospectIntelligence, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { router } from "../../_core/trpc";
import { managerProcedure, workspaceProcedure } from "../../_core/workspace";
import { enrollApprovedForCampaign, runAreEngine } from "../../areEngine";
import type { AreEngineResult } from "../../areEngine";
import { likeContains, logCursor, olderThan } from "../../services/logPaging";

export const engineRouter = router({
  /**
   * Per-campaign back-end activity log (newest first). `search` matches the
   * message, and `before` reads the page older than a row already shown
   * (audit 2026-10-20, U22): the Logs tab stopped at 300 lines, so anything
   * older scrolled away for good even though 30 days are kept.
   */
  getLogs: workspaceProcedure
    .input(z.object({
      campaignId: z.number().optional(),
      limit: z.number().min(1).max(500).default(200),
      phase: z.string().optional(),
      level: z.enum(["info", "warn", "error"]).optional(),
      search: z.string().trim().max(200).optional(),
      before: logCursor.optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const where: SQL[] = [eq(areEngineLogs.workspaceId, ctx.workspace.id)];
      if (input.campaignId !== undefined) {
        where.push(eq(areEngineLogs.campaignId, input.campaignId));
      }
      if (input.phase) where.push(eq(areEngineLogs.phase, input.phase));
      if (input.level) where.push(eq(areEngineLogs.level, input.level));
      if (input.search) where.push(like(areEngineLogs.message, likeContains(input.search)));
      if (input.before) where.push(olderThan(areEngineLogs.createdAt, areEngineLogs.id, input.before));
      return db
        .select()
        .from(areEngineLogs)
        .where(and(...where))
        // The id breaks createdAt ties, so a page boundary never skips a row.
        .orderBy(desc(areEngineLogs.createdAt), desc(areEngineLogs.id))
        .limit(input.limit);
    }),

  /**
   * When the engine last worked this campaign (U22's last-tick badge): the
   * latest engine line for it, by when it was last seen — a repeated line
   * keeps its first createdAt and moves lastSeenAt (migration 0217). Every
   * tick of an active campaign writes at least its discovery line.
   */
  lastTick: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const scope = and(eq(areEngineLogs.workspaceId, ctx.workspace.id), eq(areEngineLogs.campaignId, input.campaignId));
      const pick = { phase: areEngineLogs.phase, level: areEngineLogs.level, message: areEngineLogs.message, createdAt: areEngineLogs.createdAt, lastSeenAt: areEngineLogs.lastSeenAt };
      const [newest] = await db.select(pick).from(areEngineLogs).where(scope).orderBy(desc(areEngineLogs.createdAt), desc(areEngineLogs.id)).limit(1);
      const [repeated] = await db.select(pick).from(areEngineLogs).where(and(scope, isNotNull(areEngineLogs.lastSeenAt))).orderBy(desc(areEngineLogs.lastSeenAt)).limit(1);
      const seen = (r: typeof newest | undefined) => (r ? new Date(r.lastSeenAt ?? r.createdAt).getTime() : -1);
      const last = seen(repeated) > seen(newest) ? repeated : newest;
      if (!last) return { at: null, phase: null, level: null, message: null };
      return { at: new Date(seen(last)), phase: last.phase, level: last.level, message: last.message };
    }),

  /**
   * Manual tick — same as campaigns.runEngine; kept here for symmetry. It spends
   * and sends, so it is for managers, and it runs this workspace only: any member
   * used to run every workspace's campaigns and read back the platform's totals.
   */
  runOnce: managerProcedure.mutation(async ({ ctx }) => runAreEngine({ workspaceId: ctx.workspace.id })),

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
