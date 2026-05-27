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
import { discoveryLogs, discoveryRuns, rawFinds } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { runDiscovery } from "../services/discovery";
import { processRun } from "../services/discovery/consolidate";

const PersonInput = z.object({
  jobTitle: z.string().optional(),
  industry: z.string().optional(),
  companyName: z.string().optional(),
  location: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  seniority: z.string().optional(),
  department: z.string().optional(),
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
      z.object({ mode: z.literal("person"), input: PersonInput, campaignId: z.number().optional() }),
      z.object({ mode: z.literal("account"), input: AccountInput, campaignId: z.number().optional() }),
    ]))
    .mutation(async ({ ctx, input }) => {
      return runDiscovery(ctx.workspace.id, ctx.user.id, input.mode, input.input, input.campaignId ?? null);
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

  getRun: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
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
      return db.select().from(discoveryLogs)
        .where(and(eq(discoveryLogs.runId, input.runId), eq(discoveryLogs.workspaceId, ctx.workspace.id)))
        .orderBy(desc(discoveryLogs.createdAt))
        .limit(input.limit);
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
      return processRun(ctx.workspace.id, input.runId, run.mode);
    }),
});
