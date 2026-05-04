/**
 * sendingAccounts.ts — tRPC router for multi-provider sending accounts + sender pools
 *
 * Sending accounts: outlook_oauth | amazon_ses | generic_smtp
 * Sender pools: named groups with round_robin | weighted | random rotation
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db";
import {
  senderPoolMembers,
  senderPools,
  sendingAccountDailyStats,
  sendingAccounts,
} from "../../drizzle/schema";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";

// ─── helpers ────────────────────────────────────────────────────────────────

/** UTC date string YYYY-MM-DD */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Derive reputation tier from bounce rate (0–1 float).
 * < 2%  → excellent
 * < 5%  → good
 * < 10% → fair
 * ≥ 10% → poor
 */
export function reputationTierFromRate(
  bounceRate: number,
): "excellent" | "good" | "fair" | "poor" {
  if (bounceRate < 0.02) return "excellent";
  if (bounceRate < 0.05) return "good";
  if (bounceRate < 0.10) return "fair";
  return "poor";
}

/**
 * Validate sending account credentials (lightweight — no live socket).
 * Real production impl would call nodemailer.createTransport().verify().
 */
export async function testSmtpConnection(params: {
  provider: string;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUsername?: string | null;
  smtpPassword?: string | null;
  sesRegion?: string | null;
  oauthAccessToken?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const { provider } = params;

  if (provider === "outlook_oauth") {
    if (!params.oauthAccessToken) {
      return { ok: false, error: "OAuth access token is required" };
    }
    return { ok: true };
  }

  if (provider === "amazon_ses") {
    if (!params.smtpUsername || !params.smtpPassword) {
      return { ok: false, error: "SES SMTP username and password are required" };
    }
    if (!params.sesRegion) {
      return { ok: false, error: "AWS region is required for Amazon SES" };
    }
    const expectedHost = `email-smtp.${params.sesRegion}.amazonaws.com`;
    if (params.smtpHost && params.smtpHost !== expectedHost) {
      return {
        ok: false,
        error: `SES SMTP host should be ${expectedHost} for region ${params.sesRegion}`,
      };
    }
    return { ok: true };
  }

  // generic_smtp
  if (!params.smtpHost) return { ok: false, error: "SMTP host is required" };
  if (!params.smtpUsername) return { ok: false, error: "SMTP username is required" };
  if (!params.smtpPassword) return { ok: false, error: "SMTP password is required" };
  const port = params.smtpPort ?? 587;
  if (port < 1 || port > 65535) return { ok: false, error: "Invalid SMTP port" };
  return { ok: true };
}

// ─── Rotation engine ─────────────────────────────────────────────────────────

export interface PoolMemberWithAccount {
  memberId: number;
  accountId: number;
  weight: number;
  position: number;
  dailySendLimit: number;
  sentToday: number;
  enabled: boolean;
}

/**
 * Pick the next available account from a pool, respecting daily send limits.
 * Returns null when all accounts are at or over their daily limit.
 */
export function pickAccountFromPool(
  strategy: "round_robin" | "weighted" | "random",
  members: PoolMemberWithAccount[],
  lastUsedIndex: number,
): { accountId: number; newLastUsedIndex: number } | null {
  const available = members.filter(
    (m) => m.enabled && m.sentToday < m.dailySendLimit,
  );
  if (available.length === 0) return null;

  if (strategy === "round_robin") {
    const sorted = [...members].sort((a, b) => a.position - b.position);
    const startIdx = (lastUsedIndex + 1) % sorted.length;
    for (let i = 0; i < sorted.length; i++) {
      const idx = (startIdx + i) % sorted.length;
      const m = sorted[idx];
      if (m.enabled && m.sentToday < m.dailySendLimit) {
        return { accountId: m.accountId, newLastUsedIndex: idx };
      }
    }
    return null;
  }

  if (strategy === "weighted") {
    const pool: PoolMemberWithAccount[] = [];
    for (const m of available) {
      for (let w = 0; w < m.weight; w++) pool.push(m);
    }
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    const newIdx = members.findIndex((m) => m.accountId === chosen.accountId);
    return { accountId: chosen.accountId, newLastUsedIndex: newIdx };
  }

  // random
  const chosen = available[Math.floor(Math.random() * available.length)];
  const newIdx = members.findIndex((m) => m.accountId === chosen.accountId);
  return { accountId: chosen.accountId, newLastUsedIndex: newIdx };
}

// ─── Input schemas ───────────────────────────────────────────────────────────

const AccountCreateInput = z.object({
  name: z.string().min(1).max(120),
  provider: z.enum(["outlook_oauth", "amazon_ses", "generic_smtp"]),
  fromEmail: z.string().email(),
  fromName: z.string().max(120).optional(),
  replyTo: z.string().email().optional(),
  oauthAccessToken: z.string().optional(),
  oauthRefreshToken: z.string().optional(),
  oauthTokenExpiry: z.date().optional(),
  oauthScope: z.string().optional(),
  smtpHost: z.string().max(255).optional(),
  smtpPort: z.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUsername: z.string().max(255).optional(),
  smtpPassword: z.string().optional(),
  sesRegion: z.string().max(32).optional(),
  imapHost: z.string().max(255).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapSecure: z.boolean().optional(),
  imapUsername: z.string().max(255).optional(),
  imapPassword: z.string().optional(),
  dailySendLimit: z.number().int().min(1).max(10000).default(500),
  warmupStatus: z.enum(["not_started", "in_progress", "complete"]).default("not_started"),
});

const PoolCreateInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  rotationStrategy: z.enum(["round_robin", "weighted", "random"]).default("round_robin"),
});

// ─── Sending Accounts Router ─────────────────────────────────────────────────

export const sendingAccountsRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const wsId = ctx.workspace.id;
    const accounts = await db
      .select()
      .from(sendingAccounts)
      .where(eq(sendingAccounts.workspaceId, wsId))
      .orderBy(desc(sendingAccounts.createdAt));

    const today = todayUtc();
    const accountIds = accounts.map((a) => a.id);
    const stats =
      accountIds.length > 0
        ? await db
            .select()
            .from(sendingAccountDailyStats)
            .where(
              and(
                inArray(sendingAccountDailyStats.accountId, accountIds),
                eq(sendingAccountDailyStats.date, today),
              ),
            )
        : [];

    const statsMap = new Map(stats.map((s) => [s.accountId, s]));
    return accounts.map((a) => ({
      ...a,
      sentToday: statsMap.get(a.id)?.sentCount ?? 0,
      bouncedToday: statsMap.get(a.id)?.bounceCount ?? 0,
      remainingToday: a.dailySendLimit - (statsMap.get(a.id)?.sentCount ?? 0),
    }));
  }),

  get: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [account] = await db
        .select()
        .from(sendingAccounts)
        .where(
          and(
            eq(sendingAccounts.id, input.id),
            eq(sendingAccounts.workspaceId, ctx.workspace.id),
          ),
        );
      if (!account) throw new TRPCError({ code: "NOT_FOUND" });

      const today = todayUtc();
      const [stat] = await db
        .select()
        .from(sendingAccountDailyStats)
        .where(
          and(
            eq(sendingAccountDailyStats.accountId, input.id),
            eq(sendingAccountDailyStats.date, today),
          ),
        );
      return {
        ...account,
        sentToday: stat?.sentCount ?? 0,
        bouncedToday: stat?.bounceCount ?? 0,
        remainingToday: account.dailySendLimit - (stat?.sentCount ?? 0),
      };
    }),

  create: workspaceProcedure
    .input(AccountCreateInput)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [result] = await db.insert(sendingAccounts).values({
        workspaceId: ctx.workspace.id,
        ...input,
        connectionStatus: "untested",
      });
      return { id: (result as any).insertId as number };
    }),

  update: workspaceProcedure
    .input(AccountCreateInput.partial().extend({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { id, ...rest } = input;
      await db
        .update(sendingAccounts)
        .set(rest)
        .where(
          and(
            eq(sendingAccounts.id, id),
            eq(sendingAccounts.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  delete: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(senderPoolMembers)
        .where(
          and(
            eq(senderPoolMembers.accountId, input.id),
            eq(senderPoolMembers.workspaceId, ctx.workspace.id),
          ),
        );
      await db
        .delete(sendingAccounts)
        .where(
          and(
            eq(sendingAccounts.id, input.id),
            eq(sendingAccounts.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  testConnection: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [account] = await db
        .select()
        .from(sendingAccounts)
        .where(
          and(
            eq(sendingAccounts.id, input.id),
            eq(sendingAccounts.workspaceId, ctx.workspace.id),
          ),
        );
      if (!account) throw new TRPCError({ code: "NOT_FOUND" });

      const result = await testSmtpConnection({
        provider: account.provider,
        smtpHost: account.smtpHost,
        smtpPort: account.smtpPort,
        smtpUsername: account.smtpUsername,
        smtpPassword: account.smtpPassword,
        sesRegion: account.sesRegion,
        oauthAccessToken: account.oauthAccessToken,
      });

      await db
        .update(sendingAccounts)
        .set({
          connectionStatus: result.ok ? "connected" : "error",
          lastTestedAt: new Date(),
          lastTestError: result.error ?? null,
          reputationTier: reputationTierFromRate(parseFloat(account.bounceRate ?? "0")),
        })
        .where(eq(sendingAccounts.id, input.id));

      return result;
    }),

  getDailyStats: workspaceProcedure
    .input(
      z.object({
        accountId: z.number().int(),
        days: z.number().int().min(1).max(90).default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [account] = await db
        .select({ id: sendingAccounts.id })
        .from(sendingAccounts)
        .where(
          and(
            eq(sendingAccounts.id, input.accountId),
            eq(sendingAccounts.workspaceId, ctx.workspace.id),
          ),
        );
      if (!account) throw new TRPCError({ code: "NOT_FOUND" });

      return db
        .select()
        .from(sendingAccountDailyStats)
        .where(eq(sendingAccountDailyStats.accountId, input.accountId))
        .orderBy(desc(sendingAccountDailyStats.date))
        .limit(input.days);
    }),

  toggleEnabled: workspaceProcedure
    .input(z.object({ id: z.number().int(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(sendingAccounts)
        .set({ enabled: input.enabled })
        .where(
          and(
            eq(sendingAccounts.id, input.id),
            eq(sendingAccounts.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),
});

// ─── Sender Pools Router ──────────────────────────────────────────────────────

export const senderPoolsRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const pools = await db
      .select()
      .from(senderPools)
      .where(eq(senderPools.workspaceId, ctx.workspace.id))
      .orderBy(desc(senderPools.createdAt));

    const poolIds = pools.map((p) => p.id);
    const memberCounts =
      poolIds.length > 0
        ? await db
            .select({
              poolId: senderPoolMembers.poolId,
              count: sql<number>`COUNT(*)`,
            })
            .from(senderPoolMembers)
            .where(inArray(senderPoolMembers.poolId, poolIds))
            .groupBy(senderPoolMembers.poolId)
        : [];

    const countMap = new Map(memberCounts.map((r) => [r.poolId, r.count]));
    return pools.map((p) => ({ ...p, memberCount: countMap.get(p.id) ?? 0 }));
  }),

  get: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [pool] = await db
        .select()
        .from(senderPools)
        .where(
          and(
            eq(senderPools.id, input.id),
            eq(senderPools.workspaceId, ctx.workspace.id),
          ),
        );
      if (!pool) throw new TRPCError({ code: "NOT_FOUND" });

      const members = await db
        .select({
          memberId: senderPoolMembers.id,
          accountId: senderPoolMembers.accountId,
          weight: senderPoolMembers.weight,
          position: senderPoolMembers.position,
          accountName: sendingAccounts.name,
          fromEmail: sendingAccounts.fromEmail,
          provider: sendingAccounts.provider,
          dailySendLimit: sendingAccounts.dailySendLimit,
          connectionStatus: sendingAccounts.connectionStatus,
          reputationTier: sendingAccounts.reputationTier,
          enabled: sendingAccounts.enabled,
        })
        .from(senderPoolMembers)
        .innerJoin(
          sendingAccounts,
          eq(senderPoolMembers.accountId, sendingAccounts.id),
        )
        .where(eq(senderPoolMembers.poolId, input.id))
        .orderBy(senderPoolMembers.position);

      return { ...pool, members };
    }),

  create: workspaceProcedure
    .input(PoolCreateInput)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [result] = await db.insert(senderPools).values({
        workspaceId: ctx.workspace.id,
        ...input,
      });
      return { id: (result as any).insertId as number };
    }),

  update: workspaceProcedure
    .input(PoolCreateInput.partial().extend({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { id, ...rest } = input;
      await db
        .update(senderPools)
        .set(rest)
        .where(
          and(
            eq(senderPools.id, id),
            eq(senderPools.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  delete: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(senderPoolMembers)
        .where(eq(senderPoolMembers.poolId, input.id));
      await db
        .delete(senderPools)
        .where(
          and(
            eq(senderPools.id, input.id),
            eq(senderPools.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  addMember: workspaceProcedure
    .input(
      z.object({
        poolId: z.number().int(),
        accountId: z.number().int(),
        weight: z.number().int().min(1).max(100).default(10),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [pool] = await db
        .select({ id: senderPools.id })
        .from(senderPools)
        .where(
          and(
            eq(senderPools.id, input.poolId),
            eq(senderPools.workspaceId, ctx.workspace.id),
          ),
        );
      if (!pool) throw new TRPCError({ code: "NOT_FOUND" });

      const [account] = await db
        .select({ id: sendingAccounts.id })
        .from(sendingAccounts)
        .where(
          and(
            eq(sendingAccounts.id, input.accountId),
            eq(sendingAccounts.workspaceId, ctx.workspace.id),
          ),
        );
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });

      const [maxPos] = await db
        .select({ pos: sql<number>`COALESCE(MAX(position), -1)` })
        .from(senderPoolMembers)
        .where(eq(senderPoolMembers.poolId, input.poolId));

      await db.insert(senderPoolMembers).values({
        workspaceId: ctx.workspace.id,
        poolId: input.poolId,
        accountId: input.accountId,
        weight: input.weight,
        position: (maxPos?.pos ?? -1) + 1,
      });
      return { ok: true };
    }),

  removeMember: workspaceProcedure
    .input(z.object({ memberId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(senderPoolMembers)
        .where(
          and(
            eq(senderPoolMembers.id, input.memberId),
            eq(senderPoolMembers.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  updateMemberWeight: workspaceProcedure
    .input(
      z.object({
        memberId: z.number().int(),
        weight: z.number().int().min(1).max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(senderPoolMembers)
        .set({ weight: input.weight })
        .where(
          and(
            eq(senderPoolMembers.id, input.memberId),
            eq(senderPoolMembers.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  pickAccount: workspaceProcedure
    .input(z.object({ poolId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [pool] = await db
        .select()
        .from(senderPools)
        .where(
          and(
            eq(senderPools.id, input.poolId),
            eq(senderPools.workspaceId, ctx.workspace.id),
          ),
        );
      if (!pool) throw new TRPCError({ code: "NOT_FOUND" });

      const today = todayUtc();
      const membersRaw = await db
        .select({
          memberId: senderPoolMembers.id,
          accountId: senderPoolMembers.accountId,
          weight: senderPoolMembers.weight,
          position: senderPoolMembers.position,
          dailySendLimit: sendingAccounts.dailySendLimit,
          enabled: sendingAccounts.enabled,
        })
        .from(senderPoolMembers)
        .innerJoin(
          sendingAccounts,
          eq(senderPoolMembers.accountId, sendingAccounts.id),
        )
        .where(eq(senderPoolMembers.poolId, input.poolId))
        .orderBy(senderPoolMembers.position);

      if (membersRaw.length === 0) return { accountId: null, reason: "empty_pool" };

      const accountIds = membersRaw.map((m) => m.accountId);
      const stats = await db
        .select()
        .from(sendingAccountDailyStats)
        .where(
          and(
            inArray(sendingAccountDailyStats.accountId, accountIds),
            eq(sendingAccountDailyStats.date, today),
          ),
        );
      const statsMap = new Map(stats.map((s) => [s.accountId, s.sentCount]));

      const members: PoolMemberWithAccount[] = membersRaw.map((m) => ({
        ...m,
        sentToday: statsMap.get(m.accountId) ?? 0,
      }));

      const result = pickAccountFromPool(
        pool.rotationStrategy as "round_robin" | "weighted" | "random",
        members,
        pool.lastUsedIndex,
      );

      if (!result) return { accountId: null, reason: "all_maxed" };

      await db
        .update(senderPools)
        .set({ lastUsedIndex: result.newLastUsedIndex })
        .where(eq(senderPools.id, input.poolId));

      return { accountId: result.accountId, reason: "ok" };
    }),

  getWithMembers: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const pool = await db
        .select()
        .from(senderPools)
        .where(and(eq(senderPools.id, input.id), eq(senderPools.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!pool[0]) throw new TRPCError({ code: "NOT_FOUND" });
      const members = await db
        .select({
          id: senderPoolMembers.id,
          accountId: senderPoolMembers.accountId,
          weight: senderPoolMembers.weight,
          position: senderPoolMembers.position,
          account: {
            id: sendingAccounts.id,
            name: sendingAccounts.name,
            fromEmail: sendingAccounts.fromEmail,
            provider: sendingAccounts.provider,
            dailySendLimit: sendingAccounts.dailySendLimit,
            connectionStatus: sendingAccounts.connectionStatus,
            enabled: sendingAccounts.enabled,
          },
        })
        .from(senderPoolMembers)
        .innerJoin(sendingAccounts, eq(senderPoolMembers.accountId, sendingAccounts.id))
        .where(eq(senderPoolMembers.poolId, input.id))
        .orderBy(senderPoolMembers.position);
      // Attach sentToday from daily stats
      const todayStr = new Date().toISOString().slice(0, 10);
      const stats = members.length > 0 ? await db
        .select({ accountId: sendingAccountDailyStats.accountId, sent: sendingAccountDailyStats.sentCount })
        .from(sendingAccountDailyStats)
        .where(
          and(
            inArray(sendingAccountDailyStats.accountId, members.map((m) => m.accountId)),
            eq(sendingAccountDailyStats.date, todayStr),
          )
        ) : [];
      const statsMap = new Map(stats.map((s) => [s.accountId, s.sent]));
      return {
        ...pool[0],
        members: members.map((m) => ({
          ...m,
          account: { ...m.account, sentToday: statsMap.get(m.accountId) ?? 0 },
        })),
      };
    }),
});
