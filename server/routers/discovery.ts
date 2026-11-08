/**
 * Discovery v2 router — Phase 1 (raw aggregator only).
 *
 * Exposes:
 *   - search        — fan-out to scrapers, return runId + raw counts
 *   - getRun        — one run row
 *   - listRuns      — recent runs for the workspace
 *   - getRawFinds   — every raw_finds row for a run
 *   - getLogs       — per-step trace for a run
 *
 * Phase 2 will add:
 *   - consolidate(runId)  — cluster raw_finds into identity candidates
 *   - verify(runId)       — LinkedIn Unipile verification pass
 *   - persist(runId)      — score + write to prospects with verification
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { areCampaigns, discoveryLogs, discoveryRuns, rawFinds } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { associateDiscoveredPeople, failOrphanedDiscoveryRuns, queueDiscovery } from "../services/discovery";
import { alreadyInWorkspace, workspaceIdentityIndex } from "../services/prospectSources/dedupe";
import { processRun } from "../services/discovery/consolidate";

const PersonInput = z.object({
  jobTitle: z.string().optional(),
  industry: z.string().optional(),
  companyName: z.string().optional(),
  location: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  seniority: z.string().optional(),
  department: z.string().optional(),
  // A campaign launch's whole targeting (audit A56). Bounded: the LinkedIn
  // searches it makes are capped at CAMPAIGN_RUN_MAX_QUERIES anyway.
  jobTitles: z.array(z.string().max(200)).max(50).optional(),
  industries: z.array(z.string().max(200)).max(50).optional(),
  locations: z.array(z.string().max(200)).max(50).optional(),
});

const AccountInput = z.object({
  companyName: z.string().optional(),
  industry: z.string().optional(),
  location: z.string().optional(),
  companySize: z.string().optional(),
  revenueRange: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  website: z.string().optional(),
  buyerPersona: z.string().optional(),
});

export const discoveryRouter = router({
  search: workspaceProcedure
    .input(z.discriminatedUnion("mode", [
      // `sources` is the per-run picker (Find Prospects, owner ask 2026-09-22):
      // ids from @shared/areSources; the service drops anything the mode does
      // not offer and the workspace mask still wins. Absent = every enabled
      // candidate, as before.
      // `holdForReview` (audit F38): keep the finds unsaved, each labelled new
      // or already in People, until someone presses Save to People.
      // `addToCampaign` (audit A56): the Scraper tab's launch puts the saved people in its campaign too.
      z.object({ mode: z.literal("person"), input: PersonInput, campaignId: z.number().optional(), sources: z.array(z.string().max(40)).min(1).max(20).optional(), holdForReview: z.boolean().optional(), addToCampaign: z.boolean().optional() }),
      z.object({ mode: z.literal("account"), input: AccountInput, campaignId: z.number().optional(), sources: z.array(z.string().max(40)).min(1).max(20).optional(), holdForReview: z.boolean().optional() }),
    ]))
    .mutation(async ({ ctx, input }) => {
      // The run is stored against this campaign and shows in its Logs tab, so
      // it has to be one of this workspace's (audit 2026-10-20, P145).
      if (input.campaignId != null) {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const [c] = await db.select({ id: areCampaigns.id }).from(areCampaigns)
          .where(and(eq(areCampaigns.id, input.campaignId), eq(areCampaigns.workspaceId, ctx.workspace.id))).limit(1);
        if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "That campaign is not in this workspace." });
      }
      // A background job the page follows, not a long request (audit 2026-10-20,
      // P72): this answers with the run id at once; the same search already
      // queued or running is joined, not started and paid for again.
      return queueDiscovery(ctx.workspace.id, ctx.user.id, input.mode, input.input, input.campaignId ?? null, {
        sources: input.sources ?? null,
        holdForReview: input.holdForReview ?? false,
        addToCampaign: input.mode === "person" && input.campaignId != null && (input as { addToCampaign?: boolean }).addToCampaign === true,
      });
    }),

  /**
   * "Already in People?" for finds a page holds before saving them (audit
   * 2026-10-20, F38): the one identity check Source search and Find prospects
   * use, here for the LinkedIn search. Reads only.
   */
  checkInPeople: workspaceProcedure
    .input(z.object({
      records: z.array(z.object({
        email: z.string().max(320).nullish(),
        linkedinUrl: z.string().max(2048).nullish(),
        firstName: z.string().max(200).nullish(),
        lastName: z.string().max(200).nullish(),
        companyName: z.string().max(300).nullish(),
        companyDomain: z.string().max(300).nullish(),
      })).max(100),
    }))
    .query(async ({ ctx, input }) => {
      if (input.records.length === 0) return [];
      const index = await workspaceIdentityIndex(ctx.workspace.id);
      return input.records.map((r) => alreadyInWorkspace(index, r));
    }),

  /** Recent discovery runs scoped to a campaign (powers the per-campaign
   *  Logs tab's Discovery section). */
  listRunsForCampaign: workspaceProcedure
    .input(z.object({ campaignId: z.number(), limit: z.number().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return db.select().from(discoveryRuns)
        .where(and(
          eq(discoveryRuns.workspaceId, ctx.workspace.id),
          eq(discoveryRuns.campaignId, input.campaignId),
        ))
        .orderBy(desc(discoveryRuns.startedAt))
        .limit(input.limit);
    }),

  /** All discovery_logs across every run linked to a campaign — joined
   *  by runId in a single query. Powers the unified Logs feed on the
   *  ARE Campaign Detail page (merged with are_engine_logs client-side
   *  into one chronological timeline). */
  getLogsForCampaign: workspaceProcedure
    .input(z.object({ campaignId: z.number(), limit: z.number().min(1).max(1000).default(300) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Single SELECT JOIN discovery_logs ↔ discovery_runs on runId,
      // filtered to runs that belong to this workspace + campaign.
      const rows = await db
        .select({
          id: discoveryLogs.id,
          runId: discoveryLogs.runId,
          phase: discoveryLogs.phase,
          level: discoveryLogs.level,
          message: discoveryLogs.message,
          details: discoveryLogs.details,
          createdAt: discoveryLogs.createdAt,
        })
        .from(discoveryLogs)
        .innerJoin(discoveryRuns, eq(discoveryRuns.id, discoveryLogs.runId))
        .where(and(
          eq(discoveryRuns.workspaceId, ctx.workspace.id),
          eq(discoveryRuns.campaignId, input.campaignId),
        ))
        .orderBy(desc(discoveryLogs.createdAt))
        .limit(input.limit);
      return rows;
    }),

  getRun: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await failOrphanedDiscoveryRuns(ctx.workspace.id);
      const [row] = await db.select().from(discoveryRuns)
        .where(and(eq(discoveryRuns.id, input.id), eq(discoveryRuns.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),

  listRuns: workspaceProcedure
    .input(z.object({ limit: z.number().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // A run a restart cut off reads failed, not running for ever (P143).
      await failOrphanedDiscoveryRuns(ctx.workspace.id);
      return db.select().from(discoveryRuns)
        .where(eq(discoveryRuns.workspaceId, ctx.workspace.id))
        .orderBy(desc(discoveryRuns.startedAt))
        .limit(input.limit);
    }),

  getRawFinds: workspaceProcedure
    .input(z.object({ runId: z.number(), limit: z.number().min(1).max(500).default(200) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return db.select().from(rawFinds)
        .where(and(eq(rawFinds.runId, input.runId), eq(rawFinds.workspaceId, ctx.workspace.id)))
        .orderBy(desc(rawFinds.createdAt))
        .limit(input.limit);
    }),

  getLogs: workspaceProcedure
    .input(z.object({ runId: z.number(), limit: z.number().min(1).max(500).default(200) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // The newest `limit` lines, read in the order they happened (P147: the
      // trace read bottom-up). Id breaks a tie inside one second.
      const rows = await db.select().from(discoveryLogs)
        .where(and(eq(discoveryLogs.runId, input.runId), eq(discoveryLogs.workspaceId, ctx.workspace.id)))
        .orderBy(desc(discoveryLogs.createdAt), desc(discoveryLogs.id))
        .limit(input.limit);
      return rows.reverse();
    }),

  /** Re-run the consolidate + score + persist pass against an existing
   *  run's raw_finds. Useful when scoring weights change or the user
   *  wants to re-import a run's results without re-spending LLM tokens
   *  on a fresh scrape. */
  reprocess: workspaceProcedure
    .input(z.object({ runId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [run] = await db.select().from(discoveryRuns)
        .where(and(eq(discoveryRuns.id, input.runId), eq(discoveryRuns.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!run) throw new TRPCError({ code: "NOT_FOUND" });
      if (run.status === "running") throw new TRPCError({ code: "CONFLICT", message: "This run is still going; its finds can be saved once it ends." });
      const r = await processRun(ctx.workspace.id, input.runId, run.mode);
      // A run whose save failed is complete once the re-score has saved (P143).
      if (run.status === "failed" && run.rawFindCount > 0) {
        await db.update(discoveryRuns).set({ status: "complete", errorMessage: null })
          .where(and(eq(discoveryRuns.id, input.runId), eq(discoveryRuns.workspaceId, ctx.workspace.id)));
      }
      // A run kept for review is saved now (F38): Save to People is this call.
      if (run.heldForReview) {
        await db.update(discoveryRuns).set({ heldForReview: false })
          .where(and(eq(discoveryRuns.id, input.runId), eq(discoveryRuns.workspaceId, ctx.workspace.id)));
        associateDiscoveredPeople(ctx.workspace.id, input.runId);
      }
      const { saved: _saved, ...counts } = r;
      return counts;
    }),
});
