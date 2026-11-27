/**
 * Spend — the cost report and the shared-key switches (audit 2026-10-20,
 * Phase 3).
 *
 *   spend.report        this workspace's paid usage per UTC day (Settings →
 *                       Billing; access_billing, like usage.currentMonth)
 *   spend.platform      every workspace, for the PLATFORM OWNER: the shared
 *                       keys bill one vendor account, so its dashboard is
 *                       matched against the sum across workspaces
 *   spend.setSharedKey  the owner's per-workspace switch and daily cap for
 *                       the deployment's Reoon / QuickEnrich keys (owner
 *                       decision 2026-10-27: opt-in per workspace)
 *   spend.setMembershipPlan  the owner's per-workspace membership plan, which
 *                       sets the monthly prospect-data allowance (owner
 *                       approved 2026-11-25; services/prospectAllowance)
 *   spend.allowance     this workspace's allowance this month, for Settings →
 *                       Data sources (anyone in the workspace; counts only)
 *
 * The platform procedures use adminProcedure (users.role = 'admin', the
 * owner's account), never a workspace role: a self-registered workspace's
 * super_admin must not be able to switch the platform's keys on for itself.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { adminProcedure, router } from "../_core/trpc";
import { isAdminRole, workspaceProcedure } from "../_core/workspace";
import { checkPermission, getDb } from "../db";
import { workspaceSettings, workspaces } from "../../drizzle/schema";
import { tryDecryptSecret } from "../_core/crypto";
import { spendDay, spendSince, sharedUsedToday } from "../services/spend";
import { dayRange, summarizeSpend } from "@shared/spendReport";
import { recordAudit } from "../audit";
import { MEMBERSHIP_PLANS } from "@shared/prospectAllowance";
import { PROSPECT_SOURCE_SLUGS, isProspectDatabase } from "@shared/prospectSources";

const periodInput = z.object({ days: z.number().int().min(1).max(92).default(7) }).optional();

function periodDays(days: number): string[] {
  const today = spendDay();
  return dayRange(spendDay(new Date(Date.now() - (days - 1) * 86_400_000)), today);
}

export const spendRouter = router({
  /**
   * This workspace's prospect-data allowance this month: the plan, the
   * number, what is used and when it resets; `{ plan: null }` on no plan;
   * `{ plan: null, unreadable: true }` when it could not be read (said on the
   * page, never shown as unlimited). Counts only, no keys.
   */
  allowance: workspaceProcedure.query(async ({ ctx }) => {
    const { allowanceFor } = await import("../services/prospectAllowance");
    try {
      return await allowanceFor(ctx.workspace.id);
    } catch (e) {
      console.error(`[spend] prospect-data allowance of workspace ${ctx.workspace.id} unreadable:`, (e as Error)?.message);
      return { plan: null, unreadable: true as const };
    }
  }),

  /**
   * Each paid source's allowance left today and the AI budget (audit
   * 2026-10-20, F8, U16): what the launchers and the cost confirmations show
   * BEFORE a run. Anyone who can start a run can see what it may spend, so
   * it is not billing-gated; it reads counts, never keys.
   */
  budgets: workspaceProcedure.query(async ({ ctx }) => {
    const { sourceBudgets } = await import("../services/sourceBudgets");
    const { isPlatformOwner } = await import("../services/prospectPool");
    return sourceBudgets(ctx.workspace.id, ctx.user.id, isAdminRole(ctx.member.role), { platformOwner: isPlatformOwner(ctx.user) });
  }),

  /**
   * This calendar month's paid usage, the "monthly spend card" (audit F8): the
   * report's own summary over the UTC days from the 1st to today.
   */
  month: workspaceProcedure.query(async ({ ctx }) => {
    await checkPermission(ctx, "access_billing");
    const today = spendDay();
    const days = dayRange(`${today.slice(0, 8)}01`, today);
    const rows = await spendSince(days[0], ctx.workspace.id);
    return { month: today.slice(0, 7), ...summarizeSpend(rows, days) };
  }),

  report: workspaceProcedure.input(periodInput).query(async ({ ctx, input }) => {
    await checkPermission(ctx, "access_billing");
    const days = periodDays(input?.days ?? 7);
    const rows = await spendSince(days[0], ctx.workspace.id);
    return summarizeSpend(rows, days);
  }),

  platform: adminProcedure.input(periodInput).query(async ({ input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const days = periodDays(input?.days ?? 7);
    const rows = await spendSince(days[0]);
    const wsRows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        archivedAt: workspaces.archivedAt,
        sharedReoonKey: workspaceSettings.sharedReoonKey,
        sharedQuickenrichKey: workspaceSettings.sharedQuickenrichKey,
        sharedReoonDailyCap: workspaceSettings.sharedReoonDailyCap,
        sharedQuickenrichDailyCap: workspaceSettings.sharedQuickenrichDailyCap,
        reoonApiKeyEnc: workspaceSettings.reoonApiKeyEnc,
        quickenrichApiKeyEnc: workspaceSettings.quickenrichApiKeyEnc,
      })
      .from(workspaces)
      .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaces.id));
    // Each workspace's membership plan and this month's prospect data, read
    // through the one service; an unreadable one is shown as such.
    const { allowanceFor } = await import("../services/prospectAllowance");

    const byWorkspace = new Map<number, typeof rows>();
    for (const r of rows) byWorkspace.set(r.workspaceId, [...(byWorkspace.get(r.workspaceId) ?? []), r]);

    const list = [];
    for (const w of wsRows) {
      let allowance: Awaited<ReturnType<typeof allowanceFor>> | { plan: null; unreadable: true };
      try {
        allowance = await allowanceFor(w.id);
      } catch (e) {
        console.error(`[spend] prospect-data allowance of workspace ${w.id} unreadable:`, (e as Error)?.message);
        allowance = { plan: null, unreadable: true };
      }
      list.push({
        id: w.id,
        name: w.name,
        archived: !!w.archivedAt,
        /** The membership plan and this month's prospect data; plan null = no plan (nothing counted). */
        allowance,
        ownReoonKey: !!tryDecryptSecret(w.reoonApiKeyEnc),
        ownQuickenrichKey: !!tryDecryptSecret(w.quickenrichApiKeyEnc),
        sharedReoonKey: !!w.sharedReoonKey,
        sharedQuickenrichKey: !!w.sharedQuickenrichKey,
        sharedReoonDailyCap: w.sharedReoonDailyCap ?? null,
        sharedQuickenrichDailyCap: w.sharedQuickenrichDailyCap ?? null,
        sharedUsedToday: {
          reoon: await sharedUsedToday(w.id, "reoon"),
          quickenrich: await sharedUsedToday(w.id, "quickenrich"),
        },
        summary: summarizeSpend(byWorkspace.get(w.id) ?? [], days),
      });
    }
    return {
      days,
      workspaces: list,
      /** Calls no workspace could be found for (workspaceId 0). The goal is none. */
      unattributed: summarizeSpend(byWorkspace.get(0) ?? [], days),
      /** The deployment's own accounts: what the shared keys' vendor dashboards show. */
      sharedKeys: summarizeSpend(rows.filter((r) => r.keySource === "shared"), days),
      sharedKeysConfigured: {
        reoon: !!process.env.REOON_API_KEY,
        quickenrich: !!process.env.QUICKENRICH_API_KEY,
      },
    };
  }),

  setSharedKey: adminProcedure
    .input(
      z.object({
        workspaceId: z.number().int().positive(),
        vendor: z.enum(["reoon", "quickenrich"]),
        allowed: z.boolean(),
        dailyCap: z.number().int().min(0).max(1_000_000).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
      if (!ws) throw new TRPCError({ code: "NOT_FOUND", message: "No such workspace." });
      const patch = input.vendor === "reoon"
        ? { sharedReoonKey: input.allowed, sharedReoonDailyCap: input.dailyCap }
        : { sharedQuickenrichKey: input.allowed, sharedQuickenrichDailyCap: input.dailyCap };
      const [existing] = await db
        .select({ workspaceId: workspaceSettings.workspaceId })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, input.workspaceId))
        .limit(1);
      if (existing) {
        await db.update(workspaceSettings).set(patch).where(eq(workspaceSettings.workspaceId, input.workspaceId));
      } else {
        await db.insert(workspaceSettings).values({ workspaceId: input.workspaceId, ...patch });
      }
      await recordAudit({
        workspaceId: input.workspaceId,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "workspace_settings",
        entityId: input.workspaceId,
        after: { [`shared_${input.vendor}_key`]: input.allowed, dailyCap: input.dailyCap },
      });
      return { ok: true };
    }),

  /**
   * The shared prospect pool (owner 2026-11-25, services/prospectPool), for
   * the platform owner only: the pool workspace, and per source its true
   * name, shared switch, monthly platform ceiling, use this month, number
   * and description; plus the workspaces the pool can be.
   */
  pool: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const { poolOverview } = await import("../services/prospectPool");
    const list = await db.select({ id: workspaces.id, name: workspaces.name, archivedAt: workspaces.archivedAt }).from(workspaces);
    return { ...(await poolOverview()), workspaces: list.filter((w) => !w.archivedAt).map((w) => ({ id: w.id, name: w.name })) };
  }),

  /** Name (or clear) the pool workspace. Platform owner only. */
  setPoolWorkspace: adminProcedure
    .input(z.object({ workspaceId: z.number().int().positive().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.workspaceId != null) {
        const [ws] = await db.select({ id: workspaces.id, archivedAt: workspaces.archivedAt }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
        if (!ws || ws.archivedAt) throw new TRPCError({ code: "NOT_FOUND", message: "No such workspace." });
      }
      const { setPoolWorkspace } = await import("../services/prospectPool");
      await setPoolWorkspace(input.workspaceId);
      await recordAudit({
        workspaceId: input.workspaceId ?? 0, actorUserId: ctx.user.id, action: "update",
        entityType: "platform_settings", entityId: null, after: { prospectPoolWorkspaceId: input.workspaceId },
      });
      return { ok: true as const };
    }),

  /**
   * One pool source: shared with every workspace or not, its monthly platform
   * ceiling (the vendor account's real monthly allowance), its public number
   * and description. Platform owner only.
   */
  setPoolSource: adminProcedure
    .input(z.object({
      slug: z.enum(PROSPECT_SOURCE_SLUGS),
      shared: z.boolean().optional(),
      monthlyCeiling: z.number().int().min(0).max(100_000_000).nullable().optional(),
      number: z.number().int().min(1).max(99).nullable().optional(),
      description: z.string().trim().max(255).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!isProspectDatabase(input.slug)) throw new TRPCError({ code: "BAD_REQUEST", message: "That source cannot be pooled." });
      const { setPoolSource, poolConfig } = await import("../services/prospectPool");
      const { slug, ...patch } = input;
      await setPoolSource(slug, patch);
      const cfg = await poolConfig();
      await recordAudit({
        workspaceId: cfg.poolWorkspaceId ?? 0, actorUserId: ctx.user.id, action: "update",
        entityType: "prospect_pool_sources", entityId: null, after: { slug, ...patch },
      });
      return { ok: true as const };
    }),

  /**
   * The platform owner's per-workspace membership plan (owner approved
   * 2026-11-25). A plan sets the monthly number of records the workspace may
   * take from the platform's prospect databases (shared or lent keys; never
   * its own); null takes it off every plan, and then nothing is counted or
   * held back. The setter is services/prospectAllowance.setMembershipPlan, the
   * one a membership-site sync can call later.
   */
  setMembershipPlan: adminProcedure
    .input(
      z.object({
        workspaceId: z.number().int().positive(),
        plan: z.enum(MEMBERSHIP_PLANS).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
      if (!ws) throw new TRPCError({ code: "NOT_FOUND", message: "No such workspace." });
      const { setMembershipPlan } = await import("../services/prospectAllowance");
      const r = await setMembershipPlan(input.workspaceId, input.plan);
      await recordAudit({
        workspaceId: input.workspaceId,
        actorUserId: ctx.user.id,
        action: "update",
        entityType: "workspace_settings",
        entityId: input.workspaceId,
        before: { membershipPlan: r.previous },
        after: { membershipPlan: r.plan },
      });
      return { ok: true, plan: r.plan };
    }),
});
