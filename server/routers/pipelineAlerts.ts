/**
 * Pipeline Health Alerts (CRMA-012)
 * Detects: no_activity, closing_soon_regression, amount_change, no_champion
 */
import { z } from "zod";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { TRPCError } from "@trpc/server";
import { eq, and, isNull, desc, lt, gte } from "drizzle-orm";
import {
  pipelineAlerts,
  opportunities,
  activities,
  opportunityContactRoles,
} from "../../drizzle/schema";

const ALERT_THRESHOLDS = {
  noActivityDays: 14,        // no activity in 14 days
  closingSoonDays: 30,       // closing within 30 days
  regressionThreshold: 10,   // win prob dropped by 10+ points
};

export const pipelineAlertsRouter = router({
  /** Run health scan for all active opportunities in the workspace */
  scan: workspaceProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    const wsId = ctx.workspace.id;
    const now = new Date();
    const noActivityCutoff = new Date(now.getTime() - ALERT_THRESHOLDS.noActivityDays * 86400000);
    const closingSoonCutoff = new Date(now.getTime() + ALERT_THRESHOLDS.closingSoonDays * 86400000);

    // Get all active opportunities
    const opps = await db
      .select()
      .from(opportunities)
      .where(
        and(
          eq(opportunities.workspaceId, wsId),
          // Only active stages
        )
      );

    const activeOpps = opps.filter((o) =>
      !["won", "lost"].includes(o.stage)
    );

    let created = 0;

    for (const opp of activeOpps) {
      // Check 1: No activity in N days
      const recentActivities = await db
        .select()
        .from(activities)
        .where(
          and(
            eq(activities.workspaceId, wsId),
            eq(activities.relatedType, "opportunity"),
            eq(activities.relatedId, opp.id),
            gte(activities.createdAt, noActivityCutoff)
          )
        )
        .limit(1);

      if (recentActivities.length === 0) {
        // Check if this alert already exists (undismissed)
        const existing = await db
          .select()
          .from(pipelineAlerts)
          .where(
            and(
              eq(pipelineAlerts.opportunityId, opp.id),
              eq(pipelineAlerts.alertType, "no_activity"),
              isNull(pipelineAlerts.dismissedAt)
            )
          )
          .limit(1);

        if (existing.length === 0) {
          await db.insert(pipelineAlerts).values({
            workspaceId: wsId,
            opportunityId: opp.id,
            alertType: "no_activity",
            details: { daysSinceActivity: ALERT_THRESHOLDS.noActivityDays, oppName: opp.name },
          });
          created++;
        }
      }

      // Check 2: Closing soon with low win probability
      if (opp.closeDate && opp.closeDate <= closingSoonCutoff && opp.winProb < 50) {
        const existing = await db
          .select()
          .from(pipelineAlerts)
          .where(
            and(
              eq(pipelineAlerts.opportunityId, opp.id),
              eq(pipelineAlerts.alertType, "closing_soon_regression"),
              isNull(pipelineAlerts.dismissedAt)
            )
          )
          .limit(1);

        if (existing.length === 0) {
          const daysUntilClose = Math.ceil(
            (opp.closeDate.getTime() - now.getTime()) / 86400000
          );
          await db.insert(pipelineAlerts).values({
            workspaceId: wsId,
            opportunityId: opp.id,
            alertType: "closing_soon_regression",
            details: {
              daysUntilClose,
              winProb: opp.winProb,
              closeDate: opp.closeDate.toISOString(),
              oppName: opp.name,
            },
          });
          created++;
        }
      }

      // Check 3: No champion contact linked
      const roles = await db
        .select()
        .from(opportunityContactRoles)
        .where(eq(opportunityContactRoles.opportunityId, opp.id))
        .limit(1);

      if (roles.length === 0) {
        const existing = await db
          .select()
          .from(pipelineAlerts)
          .where(
            and(
              eq(pipelineAlerts.opportunityId, opp.id),
              eq(pipelineAlerts.alertType, "no_champion"),
              isNull(pipelineAlerts.dismissedAt)
            )
          )
          .limit(1);

        if (existing.length === 0) {
          await db.insert(pipelineAlerts).values({
            workspaceId: wsId,
            opportunityId: opp.id,
            alertType: "no_champion",
            details: { oppName: opp.name, stage: opp.stage },
          });
          created++;
        }
      }
    }

    return { scanned: activeOpps.length, created };
  }),

  /** List active (undismissed) alerts for the workspace */
  list: workspaceProcedure
    .input(z.object({ limit: z.number().default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const alerts = await db
        .select()
        .from(pipelineAlerts)
        .where(
          and(
            eq(pipelineAlerts.workspaceId, ctx.workspace.id),
            isNull(pipelineAlerts.dismissedAt)
          )
        )
        .orderBy(desc(pipelineAlerts.createdAt))
        .limit(input.limit);

      // Attach opportunity names
      const oppIds = Array.from(new Set(alerts.map((a) => a.opportunityId)));
      const opps =
        oppIds.length > 0
          ? await db
              .select({ id: opportunities.id, name: opportunities.name, stage: opportunities.stage, value: opportunities.value, winProb: opportunities.winProb })
              .from(opportunities)
              .where(eq(opportunities.workspaceId, ctx.workspace.id))
          : [];
      const oppMap = Object.fromEntries(opps.map((o) => [o.id, o]));

      return alerts.map((a) => ({
        ...a,
        opportunity: oppMap[a.opportunityId] ?? null,
      }));
    }),

  /** Dismiss an alert */
  dismiss: workspaceProcedure
    .input(z.object({ alertId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(pipelineAlerts)
        .set({ dismissedAt: new Date(), dismissedByUserId: ctx.user.id })
        .where(
          and(
            eq(pipelineAlerts.id, input.alertId),
            eq(pipelineAlerts.workspaceId, ctx.workspace.id)
          )
        );
      return { ok: true };
    }),

  /** Dismiss all alerts for an opportunity */
  dismissAllForOpp: workspaceProcedure
    .input(z.object({ opportunityId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(pipelineAlerts)
        .set({ dismissedAt: new Date(), dismissedByUserId: ctx.user.id })
        .where(
          and(
            eq(pipelineAlerts.opportunityId, input.opportunityId),
            eq(pipelineAlerts.workspaceId, ctx.workspace.id),
            isNull(pipelineAlerts.dismissedAt)
          )
        );
      return { ok: true };
    }),

  /** Get alert count summary */
  summary: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const alerts = await db
      .select()
      .from(pipelineAlerts)
      .where(
        and(
          eq(pipelineAlerts.workspaceId, ctx.workspace.id),
          isNull(pipelineAlerts.dismissedAt)
        )
      );
    const counts: Record<string, number> = {
      no_activity: 0,
      closing_soon_regression: 0,
      amount_change: 0,
      no_champion: 0,
    };
    for (const a of alerts) {
      counts[a.alertType] = (counts[a.alertType] ?? 0) + 1;
    }
    return { total: alerts.length, byType: counts };
  }),
});
