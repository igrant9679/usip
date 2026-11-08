/**
 * Sprint 4 — Quota Management
 * Procedures: get, set, progress (actual vs target for a period)
 *
 * Audit 2026-10-20, Phase 2 (R17): attainment counted won deals by updatedAt,
 * so editing an old win moved it into this period, and a QUARTERLY target was
 * measured against the one month it was saved under. Wins now count by wonAt,
 * through services/dealMetrics (the same deals the Dashboard and Forecast
 * count), over the range the period TYPE names, in the workspace's zone.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { activities, quotaTargets, workspaceMembers } from "../../drizzle/schema";
import { getDb } from "../db";
import { addMonths, closedIn, fiscalQuarterFirstMonth, fiscalQuarterOf, fiscalYearFirstMonth, loadMetricDeals, quotaPeriodRange } from "../services/dealMetrics";
import { getRevenueSettings } from "../services/workspaceRevenue";
import { FORECAST_PERIODS, quotaPacingRows } from "../services/forecastCall";
import { quotaPeriodLabel } from "@shared/quotaPeriod";
import { router } from "../_core/trpc";
import { managerProcedure, roleRank, workspaceProcedure } from "../_core/workspace";

const periodRegex = /^\d{4}-(0[1-9]|1[0-2]|Q[1-4]|FY)$/;

/**
 * The key a target is stored under, from the month picked and its type: a
 * monthly target under "2026-11", a quarterly one under "2026-Q4", an annual
 * one under "2026-FY". So a quarterly target is ONE row for the quarter, shown
 * whichever of its months is picked, not a row per month it was saved from.
 */
export function quotaPeriodKey(period: string, periodType: "monthly" | "quarterly" | "annual", fyStart = 1): string {
  const m = /^(\d{4})-(\d{2}|Q[1-4]|FY)$/.exec(period);
  if (!m) return period;
  const year = Number(m[1]);
  // Quarters and years are the workspace's fiscal ones (F29): a month belongs
  // to the fiscal quarter and year it falls in. With a January start (the
  // default) these are calendar quarters, as before.
  if (/^\d{2}$/.test(m[2])) {
    const fq = fiscalQuarterOf(year, Number(m[2]), fyStart);
    if (periodType === "annual") return `${fq.fy}-FY`;
    if (periodType === "quarterly") return `${fq.fy}-Q${fq.q}`;
    return period;
  }
  if (periodType === "annual") return `${year}-FY`;
  if (periodType === "quarterly") return m[2].startsWith("Q") ? period : `${year}-Q1`;
  const first = m[2].startsWith("Q") ? fiscalQuarterFirstMonth(year, Number(m[2][1]), fyStart) : fiscalYearFirstMonth(year, fyStart);
  return `${first.y}-${String(first.m).padStart(2, "0")}`;
}

/** The months a quarter or year key spans ("2026-Q4" → 2026-10…12), in the fiscal calendar. */
function monthKeysIn(period: string, fyStart = 1): string[] {
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  const fy = /^(\d{4})-FY$/.exec(period);
  if (!q && !fy) return [];
  const first = q ? fiscalQuarterFirstMonth(Number(q[1]), Number(q[2]), fyStart) : fiscalYearFirstMonth(Number(fy![1]), fyStart);
  return Array.from({ length: q ? 3 : 12 }, (_, i) => { const a = addMonths(first.y, first.m, i); return `${a.y}-${String(a.m).padStart(2, "0")}`; });
}

/** Every key a target covering this month could be stored under. */
function periodKeysCovering(period: string, fyStart = 1): string[] {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) return [period];
  const fq = fiscalQuarterOf(Number(m[1]), Number(m[2]), fyStart);
  return [period, `${fq.fy}-Q${fq.q}`, `${fq.fy}-FY`];
}

/**
 * For procedures that expose per-user quota / attainment data, restrict
 * non-managers to their OWN data only. Managers/admins see everyone.
 *
 * Returns the userId to filter to (or null = no filter, see all).
 */
function quotaScopeUserId(
  ctx: { user: { id: number }; member: { role: string } },
  requestedUserId?: number,
): number | null {
  const isManager = roleRank(ctx.member.role as any) >= roleRank("manager");
  if (isManager) {
    return requestedUserId ?? null; // manager: optional filter, default "everyone"
  }
  // Non-manager: ignore any requestedUserId override; you only see yourself.
  return ctx.user.id;
}

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
      // Non-managers see only their own quota — pinning the filter
      // server-side so a crafted client can't pass another rep's id.
      const scope = quotaScopeUserId(ctx, input?.userId);
      if (scope !== null) rows = rows.filter((r) => r.userId === scope);
      if (input?.period) {
        // A picked month also shows the (fiscal) quarter and year targets around it.
        const keys = periodKeysCovering(input.period, (await getRevenueSettings(ctx.workspace.id)).fiscalYearStartMonth);
        rows = rows.filter((r) => keys.includes(r.period));
      }
      return rows;
    }),

  /** Upsert a quota target for a user + period */
  set: managerProcedure
    .input(
      z.object({
        userId: z.number(),
        period: z.string().regex(periodRegex, "period must be YYYY-MM, YYYY-QN or YYYY-FY"),
        periodType: z.enum(["monthly", "quarterly", "annual"]).default("monthly"),
        revenueTarget: z.number().min(0).default(0),
        dealsTarget: z.number().int().min(0).default(0),
        activitiesTarget: z.number().int().min(0).default(0),
        /**
         * Add, not edit (R102): refuse when this person already has a target
         * for the period, instead of overwriting it without a word. Edit
         * leaves it out and replaces the target as before.
         */
        onlyIfNew: z.boolean().optional(),
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

      const fyStart = (await getRevenueSettings(ctx.workspace.id)).fiscalYearStartMonth;
      const period = quotaPeriodKey(input.period, input.periodType, fyStart);
      if (input.onlyIfNew) {
        const [existing] = await db.select({ id: quotaTargets.id }).from(quotaTargets).where(and(
          eq(quotaTargets.workspaceId, ctx.workspace.id),
          eq(quotaTargets.userId, input.userId),
          eq(quotaTargets.period, period),
        ));
        if (existing) {
          throw new TRPCError({ code: "CONFLICT", message: `This person already has a target for ${quotaPeriodLabel(period)}. Edit that target instead.` });
        }
      }
      await db
        .insert(quotaTargets)
        .values({
          workspaceId: ctx.workspace.id,
          userId: input.userId,
          period,
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
      // A quarterly or annual target saved before this was stored under the
      // month it was set from; the row just written supersedes it.
      if (period !== input.period || input.periodType !== "monthly") {
        const legacy = monthKeysIn(period, fyStart).filter((k) => k !== period);
        if (legacy.length > 0) {
          await db.delete(quotaTargets).where(and(
            eq(quotaTargets.workspaceId, ctx.workspace.id),
            eq(quotaTargets.userId, input.userId),
            eq(quotaTargets.periodType, input.periodType),
            inArray(quotaTargets.period, legacy),
          ));
        }
      }
      return { ok: true, period };
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
      // Reps may only inspect their own attainment numbers; managers+
      // can see any teammate's.
      const isManager = roleRank(ctx.member.role as any) >= roleRank("manager");
      const targetUserId = isManager ? input.userId : ctx.user.id;

      const [target] = await db
        .select()
        .from(quotaTargets)
        .where(
          and(
            eq(quotaTargets.workspaceId, ctx.workspace.id),
            eq(quotaTargets.userId, targetUserId),
            eq(quotaTargets.period, input.period),
          ),
        );

      if (!target) return null;

      const rs = await getRevenueSettings(ctx.workspace.id);
      const range = quotaPeriodRange(rs.timezone, target.period, target.periodType, rs.fiscalYearStartMonth);

      // Won deals by WHEN they were won — the same classification and the
      // same wonAt the Dashboard and Forecast read.
      const deals = await loadMetricDeals(db, ctx.workspace.id, { ownerUserId: targetUserId });
      const won = closedIn(deals, "won", range);
      const actualRevenue = won.value;
      const actualDeals = won.count;

      // Count activities
      const acts = await db
        .select({ id: activities.id })
        .from(activities)
        .where(
          and(
            eq(activities.workspaceId, ctx.workspace.id),
            eq(activities.actorUserId, targetUserId),
            gte(activities.createdAt, range.start),
            lt(activities.createdAt, range.end),
          ),
        );
      const actualActivities = acts.length;

      return {
        range: { start: range.start, end: range.end, label: range.label },
        target,
        actual: { revenue: actualRevenue, deals: actualDeals, activities: actualActivities },
        attainment: {
          revenue: target.revenueTarget && Number(target.revenueTarget) > 0 ? Math.round((actualRevenue / Number(target.revenueTarget)) * 100) : null,
          deals: target.dealsTarget > 0 ? Math.round((actualDeals / target.dealsTarget) * 100) : null,
          activities: target.activitiesTarget > 0 ? Math.round((actualActivities / target.activitiesTarget) * 100) : null,
        },
      };
    }),

  /**
   * Team quota pacing for a fiscal period (audit 2026-10-20, F29): each rep's
   * target, closed and Commit, set against how much of the period has gone,
   * and the team's total. It returned the raw target rows and no screen
   * called it; the Forecast page shows it to managers now.
   */
  // teamSummary returns everyone's targets/attainment — strictly a
  // manager+ view. Reps shouldn't see peer compensation numbers.
  teamSummary: managerProcedure
    .input(z.object({ period: z.enum(FORECAST_PERIODS).default("quarter") }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return quotaPacingRows(db, { workspaceId: ctx.workspace.id, userIds: null, kind: input?.period ?? "quarter" });
    }),

  /** The caller's own quota pacing for a fiscal period (F29): what a rep sees beside the forecast. */
  myPacing: workspaceProcedure
    .input(z.object({ period: z.enum(FORECAST_PERIODS).default("quarter") }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return quotaPacingRows(db, { workspaceId: ctx.workspace.id, userIds: [ctx.user.id], kind: input?.period ?? "quarter" });
    }),
});
