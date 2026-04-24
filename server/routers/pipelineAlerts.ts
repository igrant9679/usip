/**
 * Pipeline Health Alerts (CRMA-012)
 * Detects: no_activity, closing_soon_regression, amount_change, no_champion
 */
import { z } from "zod";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { TRPCError } from "@trpc/server";
import { eq, and, isNull, desc, lt, gte, sql } from "drizzle-orm";
import {
  pipelineAlerts,
  opportunities,
  activities,
  opportunityContactRoles,
  workflowRules,
  users,
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

  /**
   * Return all open deals stuck in a stage for longer than the configured threshold.
   * Uses deal_stuck workflow rules as the source of thresholds; falls back to 7 days.
   */
  getStuckDeals: workspaceProcedure
    .input(z.object({ minDays: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Gather all deal_stuck rules to determine the lowest threshold
      const rules = await db
        .select()
        .from(workflowRules)
        .where(
          and(
            eq(workflowRules.workspaceId, ctx.workspace.id),
            eq(workflowRules.enabled, true),
            eq(workflowRules.triggerType, "deal_stuck"),
          )
        );

      // Build per-stage thresholds from rules; default to input.minDays ?? 7
      const defaultMinDays = input.minDays ?? 7;
      const stageThresholds: Record<string, number> = {};
      for (const rule of rules) {
        const cfg = (rule.triggerConfig ?? {}) as { stage?: string; days?: number };
        const days = cfg.days ?? defaultMinDays;
        if (cfg.stage) {
          stageThresholds[cfg.stage] = Math.min(stageThresholds[cfg.stage] ?? Infinity, days);
        }
      }
      const globalMin = rules.length > 0
        ? Math.min(...rules.map((r) => ((r.triggerConfig ?? {}) as { days?: number }).days ?? defaultMinDays))
        : defaultMinDays;

      // Fetch all open opportunities
      const openOpps = await db
        .select({
          id: opportunities.id,
          name: opportunities.name,
          stage: opportunities.stage,
          value: opportunities.value,
          winProb: opportunities.winProb,
          closeDate: opportunities.closeDate,
          daysInStage: opportunities.daysInStage,
          ownerId: opportunities.ownerId,
        })
        .from(opportunities)
        .where(
          and(
            eq(opportunities.workspaceId, ctx.workspace.id),
            sql`${opportunities.stage} NOT IN ('closed_won', 'closed_lost')`,
          )
        );

      // Filter to stuck deals
      const stuckDeals = openOpps.filter((opp) => {
        const days = opp.daysInStage ?? 0;
        const threshold = opp.stage && stageThresholds[opp.stage] !== undefined
          ? stageThresholds[opp.stage]!
          : globalMin;
        return days >= threshold;
      });

      // Attach owner names
      const ownerIds = Array.from(new Set(stuckDeals.map((d) => d.ownerId).filter(Boolean) as number[]));
      const owners = ownerIds.length > 0
        ? await db.select({ id: users.id, name: users.name }).from(users).where(sql`${users.id} IN (${sql.join(ownerIds.map((id) => sql`${id}`), sql`, `)})`)
        : [];
      const ownerMap = Object.fromEntries(owners.map((u) => [u.id, u.name]));

      return stuckDeals.map((d) => ({
        ...d,
        ownerName: d.ownerId ? (ownerMap[d.ownerId] ?? null) : null,
        threshold: d.stage && stageThresholds[d.stage] !== undefined
          ? stageThresholds[d.stage]!
          : globalMin,
      }));
    }),

  /** Log a quick activity note on an opportunity from the alerts page */
  logActivityOnDeal: workspaceProcedure
    .input(z.object({
      opportunityId: z.number(),
      note: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.insert(activities).values({
        workspaceId: ctx.workspace.id,
        opportunityId: input.opportunityId,
        type: "note",
        body: input.note,
        createdByUserId: ctx.user.id,
      });
      return { ok: true };
    }),

  /** Move a deal to a new stage from the alerts page */
  moveDealStage: workspaceProcedure
    .input(z.object({
      opportunityId: z.number(),
      newStage: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(opportunities)
        .set({ stage: input.newStage, daysInStage: 0 })
        .where(
          and(
            eq(opportunities.id, input.opportunityId),
            eq(opportunities.workspaceId, ctx.workspace.id),
          )
        );
      return { ok: true };
    }),

  /**
   * Send a digest email of stuck deals to the workspace owner (or configured notif email).
   * Uses the workspace system sender account if configured.
   */
  sendDigest: workspaceProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

    const wsId = ctx.workspace.id;

    // Gather stuck deals (reuse same logic as getStuckDeals)
    const rules = await db
      .select()
      .from(workflowRules)
      .where(and(eq(workflowRules.workspaceId, wsId), eq(workflowRules.enabled, true), eq(workflowRules.triggerType, "deal_stuck")));

    const defaultMinDays = 7;
    const stageThresholds: Record<string, number> = {};
    for (const rule of rules) {
      const cfg = (rule.triggerConfig ?? {}) as { stage?: string; days?: number };
      const days = cfg.days ?? defaultMinDays;
      if (cfg.stage) stageThresholds[cfg.stage] = Math.min(stageThresholds[cfg.stage] ?? Infinity, days);
    }
    const globalMin = rules.length > 0
      ? Math.min(...rules.map((r) => ((r.triggerConfig ?? {}) as { days?: number }).days ?? defaultMinDays))
      : defaultMinDays;

    const openOpps = await db
      .select({ id: opportunities.id, name: opportunities.name, stage: opportunities.stage, value: opportunities.value, daysInStage: opportunities.daysInStage, ownerId: opportunities.ownerId })
      .from(opportunities)
      .where(and(eq(opportunities.workspaceId, wsId), sql`${opportunities.stage} NOT IN ('closed_won', 'closed_lost')`));

    const stuckDeals = openOpps.filter((opp) => {
      const days = opp.daysInStage ?? 0;
      const threshold = opp.stage && stageThresholds[opp.stage] !== undefined ? stageThresholds[opp.stage]! : globalMin;
      return days >= threshold;
    });

    if (stuckDeals.length === 0) {
      return { ok: true, sent: false, reason: "No stuck deals found" };
    }

    // Find the workspace owner's email (user with ownerOpenId or the calling user)
    const { ENV } = await import("../_core/env");
    const [ownerUser] = await db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(sql`${users.openId} = ${ENV.ownerOpenId}`);
    const recipientEmail = ownerUser?.email ?? ctx.user.email;
    if (!recipientEmail) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No recipient email found for workspace owner" });
    }

    // Build email HTML
    const rows = stuckDeals
      .map((d) => `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${d.name}</td><td style="padding:4px 8px;border-bottom:1px solid #eee">${d.stage}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${d.daysInStage ?? 0} days</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">$${Number(d.value ?? 0).toLocaleString()}</td></tr>`)
      .join("");
    const html = `<h2 style="font-family:sans-serif">Pipeline Alerts Digest</h2>
<p style="font-family:sans-serif">${stuckDeals.length} deal${stuckDeals.length !== 1 ? "s" : ""} are stuck in their current stage as of ${new Date().toLocaleDateString()}.</p>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;width:100%">
  <thead><tr style="background:#f5f5f5"><th style="padding:6px 8px;text-align:left">Deal</th><th style="padding:6px 8px;text-align:left">Stage</th><th style="padding:6px 8px;text-align:right">Days Stuck</th><th style="padding:6px 8px;text-align:right">Value</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p style="font-family:sans-serif;color:#666;font-size:12px;margin-top:16px">Sent by USIP Pipeline Alerts</p>`;

    // Get system sender
    const [settings] = await db
      .select({ systemSenderAccountId: workspaceSettings.systemSenderAccountId })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, wsId));

    if (!settings?.systemSenderAccountId) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No system sender configured. Please set a system sender in Settings → General." });
    }

    const { sendingAccounts } = await import("../../drizzle/schema");
    const { buildTransporter, decrypt } = await import("./smtpConfig");
    const [sender] = await db.select().from(sendingAccounts).where(eq(sendingAccounts.id, settings.systemSenderAccountId));
    if (!sender?.smtpHost || !sender?.smtpUsername || !sender?.smtpPassword) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "System sender is not fully configured (missing SMTP credentials)." });
    }

    const password = decrypt(sender.smtpPassword);
    const transporter = buildTransporter({
      host: sender.smtpHost,
      port: sender.smtpPort ?? 587,
      secure: sender.smtpSecure ?? false,
      username: sender.smtpUsername,
      password,
    });

    await transporter.sendMail({
      from: `"${sender.fromName ?? ctx.workspace.name}" <${sender.fromEmail}>`,
      to: recipientEmail,
      subject: `Pipeline Digest: ${stuckDeals.length} stuck deal${stuckDeals.length !== 1 ? "s" : ""} — ${new Date().toLocaleDateString()}`,
      html,
    });

    return { ok: true, sent: true, count: stuckDeals.length, recipient: recipientEmail };
  }),
});
