/**
 * LinkedIn Activity Limits router — reads and writes the policy the gate
 * enforces, and reports what each account has actually been doing.
 *
 * The panel is the point: before this the protections were four hardcoded
 * numbers nobody could see or change, one of which (the invite cap) silently
 * overrode the only setting that existed. @shared/linkedinLimits carries the
 * reasoning; server/services/linkedin/activityGate.ts does the enforcing.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  linkedinActivityLimits,
  linkedinActivityLog,
  unipileAccounts,
  users,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { accountAgeDays, getUsage, loadPolicy } from "../services/linkedin/activityGate";
import {
  DEFAULT_LINKEDIN_POLICY,
  POLICY_BOUNDS,
  clampPolicy,
  evaluateLinkedInAction,
  warmupFactor,
  type LinkedInLimitPolicy,
} from "@shared/linkedinLimits";

const policyInput = z.object({
  enabled: z.boolean().optional(),
  weeklyInviteCap: z.number().int().min(POLICY_BOUNDS.weeklyInviteCap.min).max(POLICY_BOUNDS.weeklyInviteCap.max).optional(),
  dailyInviteCap: z.number().int().min(POLICY_BOUNDS.dailyInviteCap.min).max(POLICY_BOUNDS.dailyInviteCap.max).optional(),
  dailyMessageCap: z.number().int().min(POLICY_BOUNDS.dailyMessageCap.min).max(POLICY_BOUNDS.dailyMessageCap.max).optional(),
  dailyLookupCap: z.number().int().min(POLICY_BOUNDS.dailyLookupCap.min).max(POLICY_BOUNDS.dailyLookupCap.max).optional(),
  dailyActionCap: z.number().int().min(POLICY_BOUNDS.dailyActionCap.min).max(POLICY_BOUNDS.dailyActionCap.max).optional(),
  minSpacingSeconds: z.number().int().min(POLICY_BOUNDS.minSpacingSeconds.min).max(POLICY_BOUNDS.minSpacingSeconds.max).optional(),
  jitterSeconds: z.number().int().min(POLICY_BOUNDS.jitterSeconds.min).max(POLICY_BOUNDS.jitterSeconds.max).optional(),
  workingHourStart: z.number().int().min(0).max(23).optional(),
  workingHourEnd: z.number().int().min(1).max(24).optional(),
  workingDays: z.array(z.number().int().min(1).max(7)).optional(),
  timezone: z.string().max(64).optional(),
  warmupDays: z.number().int().min(POLICY_BOUNDS.warmupDays.min).max(POLICY_BOUNDS.warmupDays.max).optional(),
});

function policyToRow(p: LinkedInLimitPolicy) {
  return {
    enabled: p.enabled,
    weeklyInviteCap: p.weeklyInviteCap,
    dailyInviteCap: p.dailyInviteCap,
    dailyMessageCap: p.dailyMessageCap,
    dailyLookupCap: p.dailyLookupCap,
    dailyActionCap: p.dailyActionCap,
    minSpacingSeconds: p.minSpacingSeconds,
    jitterSeconds: p.jitterSeconds,
    workingHourStart: p.workingHourStart,
    workingHourEnd: p.workingHourEnd,
    workingDays: p.workingDays.join(","),
    timezone: p.timezone,
    warmupDays: p.warmupDays,
  };
}

export const linkedinLimitsRouter = {
  /**
   * Every connected LinkedIn account, its effective policy, and what it has
   * done today and over the trailing week.
   *
   * The week is ROLLING, not calendar: LinkedIn's restriction does not reset
   * because it became Monday, and a calendar week would let an account spend
   * its whole allowance on Sunday night and again on Monday morning.
   */
  overview: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const now = new Date();

    const accounts = await db
      .select({
        unipileAccountId: unipileAccounts.unipileAccountId,
        userId: unipileAccounts.userId,
        status: unipileAccounts.status,
        createdAt: unipileAccounts.createdAt,
        ownerName: users.name,
        ownerEmail: users.email,
      })
      .from(unipileAccounts)
      .leftJoin(users, eq(users.id, unipileAccounts.userId))
      .where(and(
        eq(unipileAccounts.workspaceId, ctx.workspace.id),
        eq(unipileAccounts.provider, "LINKEDIN"),
      ));

    const workspaceDefault = await loadPolicy(ctx.workspace.id, null);

    const rows = await Promise.all(accounts.map(async (a) => {
      const [{ policy, source }, usage, ageDays] = await Promise.all([
        loadPolicy(ctx.workspace.id, a.unipileAccountId),
        getUsage(a.unipileAccountId, now),
        accountAgeDays(a.unipileAccountId, now),
      ]);
      // The same verdict the gate would return right now, so the panel shows
      // the live state rather than a number the user has to interpret.
      const verdict = evaluateLinkedInAction({ policy, usage, kind: "invite", now, accountAgeDays: ageDays });
      return {
        unipileAccountId: a.unipileAccountId,
        ownerName: a.ownerName ?? null,
        ownerEmail: a.ownerEmail ?? null,
        status: a.status,
        connectedAt: a.createdAt,
        ageDays,
        warmupFactor: warmupFactor(ageDays, policy.warmupDays),
        policy,
        policySource: source,
        usage: {
          invitesToday: usage.today.invite ?? 0,
          invitesWeek: usage.week.invite ?? 0,
          messagesToday: usage.today.message ?? 0,
          lookupsToday: usage.today.lookup ?? 0,
          reactionsToday: usage.today.reaction ?? 0,
          totalToday: usage.todayTotal,
          lastActionAt: usage.lastActionAt,
        },
        effectiveCaps: verdict.effectiveCaps,
        currentVerdict: { allowed: verdict.allowed, reason: verdict.reason, message: verdict.message },
      };
    }));

    return {
      accounts: rows,
      workspaceDefault: workspaceDefault.policy,
      /** True when no default row exists yet, so the UI can say "built-in". */
      usingBuiltinDefault: workspaceDefault.source === "builtin",
      builtinDefault: DEFAULT_LINKEDIN_POLICY,
    };
  }),

  /**
   * Save the workspace default, or one account's override.
   *
   * Admin-only: these limits are the difference between a working LinkedIn
   * account and a restricted one, so they are not a per-rep preference.
   */
  setPolicy: adminWsProcedure
    .input(z.object({
      /** Null / omitted saves the WORKSPACE DEFAULT. */
      unipileAccountId: z.string().max(200).nullable().optional(),
      policy: policyInput,
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const accountId = input.unipileAccountId ?? null;

      if (accountId) {
        // Never let one workspace write another's account row.
        const [owned] = await db
          .select({ id: unipileAccounts.id })
          .from(unipileAccounts)
          .where(and(
            eq(unipileAccounts.workspaceId, ctx.workspace.id),
            eq(unipileAccounts.unipileAccountId, accountId),
          ))
          .limit(1);
        if (!owned) throw new TRPCError({ code: "NOT_FOUND", message: "That LinkedIn account isn't in this workspace." });
      }

      // Merge onto what is in force today, so saving one field cannot silently
      // reset the rest to defaults.
      const { policy: current } = await loadPolicy(ctx.workspace.id, accountId);
      const merged = clampPolicy({ ...current, ...input.policy });

      const existing = await db
        .select({ id: linkedinActivityLimits.id })
        .from(linkedinActivityLimits)
        .where(and(
          eq(linkedinActivityLimits.workspaceId, ctx.workspace.id),
          accountId === null
            ? isNull(linkedinActivityLimits.unipileAccountId)
            : eq(linkedinActivityLimits.unipileAccountId, accountId),
        ))
        .limit(1);

      if (existing.length) {
        await db
          .update(linkedinActivityLimits)
          .set({ ...policyToRow(merged), updatedByUserId: ctx.user.id } as never)
          .where(eq(linkedinActivityLimits.id, existing[0].id));
      } else {
        await db.insert(linkedinActivityLimits).values({
          workspaceId: ctx.workspace.id,
          unipileAccountId: accountId,
          updatedByUserId: ctx.user.id,
          ...policyToRow(merged),
        } as never);
      }
      return { ok: true, policy: merged };
    }),

  /** Drop an account's override so it follows the workspace default again. */
  clearAccountPolicy: adminWsProcedure
    .input(z.object({ unipileAccountId: z.string().max(200) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(linkedinActivityLimits)
        .where(and(
          eq(linkedinActivityLimits.workspaceId, ctx.workspace.id),
          eq(linkedinActivityLimits.unipileAccountId, input.unipileAccountId),
        ));
      return { ok: true };
    }),

  /** Recent actions on one account — what the budget was actually spent on. */
  recentActivity: workspaceProcedure
    .input(z.object({ unipileAccountId: z.string().max(200), limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return db
        .select({
          id: linkedinActivityLog.id,
          kind: linkedinActivityLog.kind,
          source: linkedinActivityLog.source,
          targetIdentifier: linkedinActivityLog.targetIdentifier,
          occurredAt: linkedinActivityLog.occurredAt,
        })
        .from(linkedinActivityLog)
        .where(and(
          eq(linkedinActivityLog.workspaceId, ctx.workspace.id),
          eq(linkedinActivityLog.unipileAccountId, input.unipileAccountId),
        ))
        .orderBy(desc(linkedinActivityLog.occurredAt))
        .limit(input.limit);
    }),

  /** Actions per day for the trailing fortnight — the panel's sparkline. */
  history: workspaceProcedure
    .input(z.object({ unipileAccountId: z.string().max(200), days: z.number().int().min(1).max(90).default(14) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const since = new Date(Date.now() - input.days * 24 * 60 * 60 * 1000);
      const rows = await db
        .select({
          day: sql<string>`DATE(${linkedinActivityLog.occurredAt})`,
          kind: linkedinActivityLog.kind,
          n: sql<number>`count(*)`,
        })
        .from(linkedinActivityLog)
        .where(and(
          eq(linkedinActivityLog.workspaceId, ctx.workspace.id),
          eq(linkedinActivityLog.unipileAccountId, input.unipileAccountId),
          gte(linkedinActivityLog.occurredAt, since),
        ))
        .groupBy(sql`DATE(${linkedinActivityLog.occurredAt})`, linkedinActivityLog.kind);
      return rows.map((r) => ({ day: String(r.day), kind: String(r.kind), count: Number(r.n) || 0 }));
    }),
};
