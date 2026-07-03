/**
 * deals router — the autonomy layer for /v2/deals (the pipeline surface itself
 * is served by the existing `opportunities`, `crmPipelines`, `pipelineAlerts`
 * and `forecastAi` routers, which /v2/deals reuses). This router only adds the
 * Deal Autopilot: on-demand analysis + the per-workspace autonomy config.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { recordAudit } from "../audit";
import { router } from "../_core/trpc";
import { adminWsProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";
import { runDealAutopilotForWorkspace } from "../services/dealAutopilot";

export const dealsRouter = router({
  /** On-demand: AI-analyze open deals (approval — writes next steps, no tasks). */
  analyzeAll: repProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const res = await runDealAutopilotForWorkspace(ctx.workspace.id, "approval", input?.limit ?? 15);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "ai_analyze", entityType: "opportunity", entityId: 0, after: res });
      return res;
    }),

  getAutopilotSettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { mode: "off" as const, dailyCap: 50, lastRunAt: null as Date | null };
    const [row] = await db.select({
      mode: workspaceSettings.dealAutopilotMode,
      dailyCap: workspaceSettings.dealAutopilotDailyCap,
      lastRunAt: workspaceSettings.dealAutopilotLastRunAt,
    }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
    return row ?? { mode: "off" as const, dailyCap: 50, lastRunAt: null };
  }),

  setAutopilotSettings: adminWsProcedure
    .input(z.object({ mode: z.enum(["off", "approval", "auto"]), dailyCap: z.number().int().min(1).max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: any = { dealAutopilotMode: input.mode };
      if (input.dailyCap !== undefined) set.dealAutopilotDailyCap = input.dailyCap;
      await db.insert(workspaceSettings)
        .values({ workspaceId: ctx.workspace.id, ...set } as never)
        .onDuplicateKeyUpdate({ set });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "deal_autopilot_settings", entityId: ctx.workspace.id, after: input });
      return { ok: true };
    }),
});
