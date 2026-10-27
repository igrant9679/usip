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
 *
 * The platform procedures use adminProcedure (users.role = 'admin', the
 * owner's account), never a workspace role: a self-registered workspace's
 * super_admin must not be able to switch the platform's keys on for itself.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { adminProcedure, router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { checkPermission, getDb } from "../db";
import { workspaceSettings, workspaces } from "../../drizzle/schema";
import { tryDecryptSecret } from "../_core/crypto";
import { spendDay, spendSince, sharedUsedToday } from "../services/spend";
import { dayRange, summarizeSpend } from "@shared/spendReport";
import { recordAudit } from "../audit";

const periodInput = z.object({ days: z.number().int().min(1).max(92).default(7) }).optional();

function periodDays(days: number): string[] {
  const today = spendDay();
  return dayRange(spendDay(new Date(Date.now() - (days - 1) * 86_400_000)), today);
}

export const spendRouter = router({
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

    const byWorkspace = new Map<number, typeof rows>();
    for (const r of rows) byWorkspace.set(r.workspaceId, [...(byWorkspace.get(r.workspaceId) ?? []), r]);

    const list = [];
    for (const w of wsRows) {
      list.push({
        id: w.id,
        name: w.name,
        archived: !!w.archivedAt,
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
});
