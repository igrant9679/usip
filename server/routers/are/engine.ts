/**
 * ARE — Engine Router
 *
 * Exposes back-end engine activity (per-phase logs) for the campaign Logs
 * tab, plus a manual run trigger.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { areEngineLogs } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";
import { runAreEngine } from "../../areEngine";

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
});
