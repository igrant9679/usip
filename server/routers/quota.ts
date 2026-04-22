/**
 * Sprint 4 — Quota Management
 * Procedures: get, set, progress (actual vs target for a period)
 */
import { TRPCError } from "@trpc/server";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { activities, opportunities, quotaTargets, workspaceMembers } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { managerProcedure, workspaceProcedure } from "../_core/workspace";

const periodRegex = /^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/;

export const quotaRouter = router({
  /** List all quota targets for the workspace (optionally filtered by userId or period) */
  list: workspaceProcedure
    .input(z.object({ userId: z.number().optional(), period: z.string().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      let rows = await db
        .select()
        .from(quotaTargets)
        .where(eq(quotaTargets.workspaceId, ctx.workspace.id));
      if (input?.userId) rows = rows.filter((r) => r.userId === input.userId);
      if (input?.period) rows = rows.filter((r) => r.period === input.period);
      return rows;
    }),

  /** Upsert a quota target for a user + period */
  set: managerProcedure
    .input(
      z.object({
        userId: z.number(),
        period: z.string().regex(periodRegex, "period must be YYYY-MM or YYYY-QN"),
        periodType: z.enum(["monthly", "quarterly", "annual"]).default("monthly"),
        revenueTarget: z.number().min(0).default(0),
        dealsTarget: z.number().int().min(0).default(0),
        activitiesTarget: z.number().int().min(0).default(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Verify user is a member of this workspace
      const [member] = await db
        .select()
        .from(workspaceMembers)
        .where(and(eq(workspaceMembers.userId, input.userId), eq(workspaceMembers.workspaceId, ctx.workspace.id)));
      if (!member) throw new TRPCError({ code: "NOT_FOUND", message: "User is not a member of this workspace" });

      await db
        .insert(quotaTargets)
        .values({
          workspaceId: ctx.workspace.id,
          userId: input.userId,
          period: input.period,
          periodType: input.periodType,
          revenueTarget: String(input.revenueTarget),
          dealsTarget: input.dealsTarget,
          activitiesTarget: input.activitiesTarget,
        })
        .onDuplicateKeyUpdate({
          set: {
            periodType: input.periodType,
            revenueTarget: String(input.revenueTarget),
            dealsTarget: input.dealsTarget,
            activitiesTarget: input.activitiesTarget,
            updatedAt: new Date(),
          },
        });
      return { ok: true };
    }),

  /** Delete a quota target */
  remove: managerProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.delete(quotaTargets).where(and(eq(quotaTargets.id, input.id), eq(quotaTargets.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /** Get quota progress (actual vs target) for a user + period */
  progress: workspaceProcedure
    .input(z.object({ userId: z.number(), period: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;

      const [target] = await db
        .select()
        .from(quotaTargets)
        .where(
          and(
            eq(quotaTargets.workspaceId, ctx.workspace.id),
            eq(quotaTargets.userId, input.userId),
            eq(quotaTargets.period, input.period),
          ),
        );

      if (!target) return null;

      // Derive date range from period string (YYYY-MM or YYYY-QN)
      let startDate: Date;
      let endDate: Date;
      if (/^\d{4}-Q[1-4]$/.test(input.period)) {
        const [yearStr, qStr] = input.period.split("-Q");
        const year = parseInt(yearStr);
        const q = parseInt(qStr);
        const startMonth = (q - 1) * 3;
        startDate = new Date(year, startMonth, 1);
        endDate = new Date(year, startMonth + 3, 0, 23, 59, 59);
      } else {
        const [yearStr, monthStr] = input.period.split("-");
        const year = parseInt(yearStr);
        const month = parseInt(monthStr) - 1;
        startDate = new Date(year, month, 1);
        endDate = new Date(year, month + 1, 0, 23, 59, 59);
      }

      // Count closed-won opportunities (revenue + deals)
      const wonOpps = await db
        .select()
        .from(opportunities)
        .where(
          and(
            eq(opportunities.workspaceId, ctx.workspace.id),
            eq(opportunities.ownerUserId, input.userId),
            eq(opportunities.stage, "won"),
            gte(opportunities.updatedAt, startDate),
            lte(opportunities.updatedAt, endDate),
          ),
        );

      const actualRevenue = wonOpps.reduce((sum, o) => sum + Number(o.value ?? 0), 0);
      const actualDeals = wonOpps.length;

      // Count activities
      const acts = await db
        .select()
        .from(activities)
        .where(
          and(
            eq(activities.workspaceId, ctx.workspace.id),
            eq(activities.actorUserId, input.userId),
            gte(activities.createdAt, startDate),
            lte(activities.createdAt, endDate),
          ),
        );
      const actualActivities = acts.length;

      return {
        target,
        actual: { revenue: actualRevenue, deals: actualDeals, activities: actualActivities },
        attainment: {
          revenue: target.revenueTarget && Number(target.revenueTarget) > 0 ? Math.round((actualRevenue / Number(target.revenueTarget)) * 100) : null,
          deals: target.dealsTarget > 0 ? Math.round((actualDeals / target.dealsTarget) * 100) : null,
          activities: target.activitiesTarget > 0 ? Math.round((actualActivities / target.activitiesTarget) * 100) : null,
        },
      };
    }),

  /** Team-wide quota summary for current period */
  teamSummary: workspaceProcedure
    .input(z.object({ period: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const targets = await db
        .select()
        .from(quotaTargets)
        .where(and(eq(quotaTargets.workspaceId, ctx.workspace.id), eq(quotaTargets.period, input.period)));
      return targets;
    }),
});
