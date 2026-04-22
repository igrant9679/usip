/**
 * Dashboard Layouts router — per-user, per-dashboard widget layout persistence.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { dashboardLayouts } from "../../drizzle/schema";
import { getDb } from "../db";
import { workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";

const widgetSchema = z.object({
  widgetId: z.string(),
  col: z.number().int().min(0).max(11),
  row: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1),
  title: z.string().optional(),
});

export const dashboardLayoutsRouter = router({
  getLayout: workspaceProcedure
    .input(z.object({ dashboardId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;
      const [row] = await db
        .select()
        .from(dashboardLayouts)
        .where(
          and(
            eq(dashboardLayouts.workspaceId, ctx.workspace.id),
            eq(dashboardLayouts.userId, ctx.user.id),
            eq(dashboardLayouts.dashboardId, input.dashboardId),
          ),
        );
      return row ?? null;
    }),

  saveLayout: workspaceProcedure
    .input(
      z.object({
        dashboardId: z.number(),
        layout: z.array(widgetSchema),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [existing] = await db
        .select()
        .from(dashboardLayouts)
        .where(
          and(
            eq(dashboardLayouts.workspaceId, ctx.workspace.id),
            eq(dashboardLayouts.userId, ctx.user.id),
            eq(dashboardLayouts.dashboardId, input.dashboardId),
          ),
        );

      if (existing) {
        await db
          .update(dashboardLayouts)
          .set({ layout: input.layout })
          .where(eq(dashboardLayouts.id, existing.id));
      } else {
        await db.insert(dashboardLayouts).values({
          workspaceId: ctx.workspace.id,
          userId: ctx.user.id,
          dashboardId: input.dashboardId,
          layout: input.layout,
        });
      }
      return { ok: true };
    }),
});
