/**
 * sendingAccounts.ts — tRPC router for multi-provider sending accounts + sender pools
 *
 * Sending accounts: outlook_oauth | amazon_ses | generic_smtp
 * Sender pools: named groups with round_robin | weighted | random rotation
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db";
import {
  senderPoolMembers,
  senderPools,
  sendingAccountDailyStats,
  sendingAccounts,
  workspaceSettings,
} from "../../drizzle/schema";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";
import { buildTransporter } from "./smtpConfig";
import { encryptSecret, tryDecryptSecret } from "../_core/crypto";

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
/**
 * Test a sending account's connectivity. For generic_smtp and amazon_ses
 * this opens a real SMTP socket via nodemailer's verify() (EHLO + STARTTLS
 * + AUTH) — not just a field-presence check. For outlook_oauth we only
 * confirm a token is present; a full XOAUTH2 verify needs the token-endpoint
 * + refresh handshake and lives in the OAuth-flow code path.
 */
export async function testSmtpConnection(params: {
  provider: string;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUsername?: string | null;
  smtpPassword?: string | null;
  sesRegion?: string | null;
  oauthAccessToken?: string | null;
  /** Decrypted SendGrid key. Only read when provider === "sendgrid". */
  sendgridApiKey?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const { provider } = params;

  // SendGrid has no SMTP socket to open — the meaningful check is whether the
  // key authenticates AND carries Mail Send scope. A key that passes a naive
  // "is it valid" test but cannot send fails on the first real campaign.
  if (provider === "sendgrid") {
    const { verifySendGridKey } = await import("../services/sendgrid");
    return verifySendGridKey(params.sendgridApiKey ?? "");
  }

  if (provider === "outlook_oauth" || provider === "google_oauth") {
    if (!params.oauthAccessToken) {
      return { ok: false, error: "This mailbox is linked without OAuth credentials yet — reconnect it or use SMTP/IMAP." };
    }
    return { ok: true };
  }

  // ── Field validation common to generic_smtp + amazon_ses ────────────
  let host = params.smtpHost ?? "";
  const port = params.smtpPort ?? 587;
  if (port < 1 || port > 65535) return { ok: false, error: "Invalid SMTP port" };
  if (!params.smtpUsername) return { ok: false, error: "SMTP username is required" };
  if (!params.smtpPassword) return { ok: false, error: "SMTP password is required" };

  if (provider === "amazon_ses") {
    if (!params.sesRegion) return { ok: false, error: "AWS region is required for Amazon SES" };
    const expectedHost = `email-smtp.${params.sesRegion}.amazonaws.com`;
    if (host && host !== expectedHost) {
      return { ok: false, error: `SES SMTP host should be ${expectedHost} for region ${params.sesRegion}` };
    }
    if (!host) host = expectedHost;
  } else {
    // generic_smtp
    if (!host) return { ok: false, error: "SMTP host is required" };
  }

  // ── Real connection check ──────────────────────────────────────────
  // 465 = implicit TLS; everything else uses STARTTLS upgrade.
  try {
    const transporter = buildTransporter({
      host,
      port,
      secure: port === 465,
      username: params.smtpUsername,
      password: params.smtpPassword,
    });
    await transporter.verify();
    return { ok: true };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // nodemailer often returns multi-line errors with the full SMTP banner.
    // Trim to the first line so the UI toast stays readable.
    const msg = raw.split("\n")[0].slice(0, 240);
    return { ok: false, error: `SMTP connect failed: ${msg}` };
  }
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

// Exported so provider acceptance is tested against THIS schema, not a copy.
export const AccountCreateInput = z.object({
  name: z.string().min(1).max(120),
  provider: z.enum(["outlook_oauth", "amazon_ses", "generic_smtp", "google_oauth", "sendgrid"]),
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
  /**
   * SendGrid API key, plaintext in transit and ENCRYPTED at rest (0140).
   * Blank on an edit means "keep the stored key" — the UI never receives the
   * existing one back, so it cannot echo it and has nothing to resubmit.
   */
  sendgridApiKey: z.string().max(500).optional(),
  imapHost: z.string().max(255).optional(),
  imapPort: z.number().int().min(1).max(65535).optional(),
  imapSecure: z.boolean().optional(),
  imapUsername: z.string().max(255).optional(),
  imapPassword: z.string().optional(),
  dailySendLimit: z.number().int().min(1).max(10000).default(500),
  warmupStatus: z.enum(["not_started", "in_progress", "complete"]).default("not_started"),
  /* Mailbox setup flow (migration 0118) */
  isDefault: z.boolean().optional(),
  hourlySendLimit: z.number().int().min(1).max(1000).optional(),
  delaySeconds: z.number().int().min(0).max(86_400).optional(),
  signature: z.string().max(8000).nullable().optional(),
  signatureCompleted: z.boolean().optional(),
  sendingLimitsCompleted: z.boolean().optional(),
  optOutCompleted: z.boolean().optional(),
  optOutEnabled: z.boolean().optional(),
  optOutMessage: z.string().max(2000).nullable().optional(),
  forwardingEmail: z.string().email().nullable().optional(),
});

const PoolMemberInput = z.object({
  accountId: z.number().int(),
  weight: z.number().int().min(1).max(100).default(10),
  /** UI uses "priority"; DB column is `position`. Either key accepted. */
  priority: z.number().int().optional(),
  position: z.number().int().optional(),
});

const PoolCreateInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().optional(),
  rotationStrategy: z.enum(["round_robin", "weighted", "random"]).default("round_robin"),
  /**
   * Members can be set in one shot when creating/updating a pool. The
   * UI takes this path; the separate addMember/removeMember endpoints
   * exist for incremental edits but aren't currently used by the page.
   */
  members: z.array(PoolMemberInput).optional(),
});

// ─── Sending Accounts Router ─────────────────────────────────────────────────

export const sendingAccountsRouter = router({
  /**
   * SendGrid inbound-reply routing (owner ask 2026-08-13): replies to
   * SendGrid-sent mail collect ONLY in Velocity. Read the current config +
   * the exact values the SendGrid dashboard needs.
   */
  getInboundReplyConfig: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [ws] = await db
      .select({ domain: workspaceSettings.sendgridInboundDomain, token: workspaceSettings.sendgridInboundToken })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
      .limit(1);
    const { appBaseUrl } = await import("../appUrl");
    const configured = !!(ws?.domain && ws?.token);
    return {
      configured,
      domain: ws?.domain ?? null,
      replyAddress: configured ? `r-${ws!.token}@${ws!.domain}` : null,
      webhookUrl: `${appBaseUrl().replace(/\/+$/, "")}/api/sendgrid/inbound`,
      mxTarget: "mx.sendgrid.net",
    };
  }),

  /**
   * Enable/change/disable inbound reply routing. Setting a domain mints the
   * unguessable token on first use (the token IS the webhook's auth — the
   * endpoint is public because Inbound Parse cannot sign). Clearing the
   * domain stops the auto Reply-To; the token is kept so re-enabling does
   * not orphan mail already in flight carrying the old address.
   */
  setInboundReplyDomain: adminWsProcedure
    .input(z.object({
      /** e.g. "reply.lsimedia.com" — the subdomain whose MX points at SendGrid. Null disables. */
      domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "Enter a bare domain like reply.yourcompany.com").nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [ws] = await db
        .select({ token: workspaceSettings.sendgridInboundToken })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id))
        .limit(1);
      const { randomBytes } = await import("node:crypto");
      const token = ws?.token ?? randomBytes(16).toString("hex");
      await db.update(workspaceSettings)
        .set({ sendgridInboundDomain: input.domain, sendgridInboundToken: token } as never)
        .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      return { ok: true as const, replyAddress: input.domain ? `r-${token}@${input.domain}` : null };
    }),

  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const wsId = ctx.workspace.id;
    // /sending-accounts is the workspace's *outreach* infrastructure
    // (shared SMTP for sequences/campaigns). Unipile-bridged personal
    // M365 mailboxes — identified by unipileAccountId being non-null —
    // are excluded here; they appear in /my-mailbox + /my-calendar
    // filtered to their owner instead.
    const accounts = await db
      .select()
      .from(sendingAccounts)
      .where(
        and(
          eq(sendingAccounts.workspaceId, wsId),
          isNull(sendingAccounts.unipileAccountId),
        ),
      )
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
    return accounts.map(({ sendgridApiKeyEnc, ...a }) => ({
      ...a,
      // The key never leaves the server, not even as ciphertext. The UI only
      // needs to know whether one is set, so it can say "leave blank to keep
      // the current key" instead of implying the field is empty.
      hasSendgridKey: !!sendgridApiKeyEnc,
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
      const { sendgridApiKeyEnc, ...safe } = account;
      return {
        ...safe,
        hasSendgridKey: !!sendgridApiKeyEnc,
        sentToday: stat?.sentCount ?? 0,
        bouncedToday: stat?.bounceCount ?? 0,
        remainingToday: account.dailySendLimit - (stat?.sentCount ?? 0),
      };
    }),

  // Sending accounts hold SMTP/IMAP credentials + per-account daily
  // send caps. Admin-gated to match the SMTP-config peer endpoints.
  create: adminWsProcedure
    .input(AccountCreateInput)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // `sendgridApiKey` is an INPUT field, not a column. It has to be split out
      // and mapped to the encrypted column — spreading it straight through would
      // write a column that does not exist, which fails at runtime, not compile.
      const { sendgridApiKey, ...cols } = input;
      const [result] = await db.insert(sendingAccounts).values({
        workspaceId: ctx.workspace.id,
        ...cols,
        ...(sendgridApiKey?.trim() ? { sendgridApiKeyEnc: encryptSecret(sendgridApiKey.trim()) } : {}),
        connectionStatus: "untested",
      });
      return { id: (result as any).insertId as number };
    }),

  update: adminWsProcedure
    .input(AccountCreateInput.partial().extend({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { id, sendgridApiKey, ...rest } = input;
      const patch: Record<string, unknown> = { ...rest };
      // A BLANK key means "keep the stored one", not "clear it". The UI never
      // receives the existing key back (it cannot — only the ciphertext is
      // stored), so an empty field is the absence of a change. Without this,
      // saving any other field would silently wipe the key and every campaign
      // send would start failing with no visible cause.
      if (sendgridApiKey?.trim()) patch.sendgridApiKeyEnc = encryptSecret(sendgridApiKey.trim());
      await db
        .update(sendingAccounts)
        .set(patch as never)
        .where(
          and(
            eq(sendingAccounts.id, id),
            eq(sendingAccounts.workspaceId, ctx.workspace.id),
          ),
        );
      return { ok: true };
    }),

  delete: adminWsProcedure
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

  /**
   * Test arbitrary SMTP credentials without saving — used by the Connect/
   * Edit dialog so users can validate before clicking Save. When editId is
   * supplied and smtpPassword is blank, falls back to the saved password so
   * users can re-test an existing account without re-typing the password.
   */
  /**
   * Make one account the workspace default sender (exclusive — clears the
   * flag on every other account). Used by the Mailboxes settings table.
   */
  setDefault: adminWsProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(sendingAccounts)
        .set({ isDefault: false })
        .where(eq(sendingAccounts.workspaceId, ctx.workspace.id));
      await db
        .update(sendingAccounts)
        .set({ isDefault: true })
        .where(and(eq(sendingAccounts.id, input.id), eq(sendingAccounts.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /**
   * Bulk-create SMTP/IMAP mailboxes from a parsed CSV (Settings → Mailboxes
   * → Bulk Import). The client parses/validates; this caps at 100 rows and
   * skips duplicates of already-linked fromEmails.
   */
  bulkCreateSmtp: adminWsProcedure
    .input(z.object({
      rows: z.array(z.object({
        fromEmail: z.string().email(),
        fromName: z.string().max(120).optional(),
        smtpHost: z.string().max(255).optional(),
        smtpPort: z.number().int().min(1).max(65535).optional(),
        smtpUsername: z.string().max(255).optional(),
        smtpPassword: z.string().optional(),
        imapHost: z.string().max(255).optional(),
        imapPort: z.number().int().min(1).max(65535).optional(),
        dailySendLimit: z.number().int().min(1).max(10000).optional(),
        hourlySendLimit: z.number().int().min(1).max(1000).optional(),
        delaySeconds: z.number().int().min(0).max(86_400).optional(),
      })).min(1).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const existing = await db
        .select({ fromEmail: sendingAccounts.fromEmail })
        .from(sendingAccounts)
        .where(eq(sendingAccounts.workspaceId, ctx.workspace.id));
      const taken = new Set(existing.map((e) => e.fromEmail.toLowerCase()));
      let created = 0, skipped = 0;
      for (const row of input.rows) {
        const email = row.fromEmail.toLowerCase();
        if (taken.has(email)) { skipped++; continue; }
        taken.add(email);
        await db.insert(sendingAccounts).values({
          workspaceId: ctx.workspace.id,
          name: row.fromName || row.fromEmail,
          provider: "generic_smtp",
          fromEmail: row.fromEmail,
          fromName: row.fromName ?? null,
          smtpHost: row.smtpHost ?? null,
          smtpPort: row.smtpPort ?? 587,
          smtpUsername: row.smtpUsername ?? row.fromEmail,
          smtpPassword: row.smtpPassword ?? null,
          imapHost: row.imapHost ?? null,
          imapPort: row.imapPort ?? 993,
          dailySendLimit: row.dailySendLimit ?? 50,
          hourlySendLimit: row.hourlySendLimit ?? 6,
          delaySeconds: row.delaySeconds ?? 600,
          connectionStatus: "untested",
        } as never);
        created++;
      }
      return { created, skipped };
    }),

  /**
   * Refresh a mailbox's send-as aliases. TODO(provider-api): real alias
   * discovery needs the Gmail sendAs / Graph API — until an OAuth backend
   * exists this re-reads what's stored and reports that no provider sync ran.
   */
  refreshAliases: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [account] = await db
        .select({ aliases: sendingAccounts.aliases })
        .from(sendingAccounts)
        .where(and(eq(sendingAccounts.id, input.id), eq(sendingAccounts.workspaceId, ctx.workspace.id)));
      if (!account) throw new TRPCError({ code: "NOT_FOUND" });
      const aliases = Array.isArray(account.aliases) ? (account.aliases as string[]) : [];
      return { aliases, providerSynced: false };
    }),

  testConfig: workspaceProcedure
    .input(
      z.object({
        editId: z.number().int().optional(),
        provider: z.enum(["outlook_oauth", "amazon_ses", "generic_smtp", "google_oauth", "sendgrid"]),
        smtpHost: z.string().optional(),
        smtpPort: z.number().int().optional(),
        smtpUsername: z.string().optional(),
        smtpPassword: z.string().optional(),
        sesRegion: z.string().optional(),
        sendgridApiKey: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let smtpPassword = input.smtpPassword;
      let sendgridApiKey = input.sendgridApiKey;
      let oauthAccessToken: string | null | undefined;
      // Testing a SAVED SendGrid account without retyping the key: fall back to
      // the stored one, same as the SMTP password below.
      if (input.editId && input.provider === "sendgrid" && !sendgridApiKey) {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const [existing] = await db
          .select({ enc: sendingAccounts.sendgridApiKeyEnc })
          .from(sendingAccounts)
          .where(and(
            eq(sendingAccounts.id, input.editId),
            eq(sendingAccounts.workspaceId, ctx.workspace.id),
          ));
        if (existing) sendgridApiKey = tryDecryptSecret(existing.enc) || undefined;
      }
      // For an existing account being edited, fall back to the stored
      // password / OAuth token when the form left those fields blank.
      if (input.editId && (!smtpPassword || input.provider === "outlook_oauth")) {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const [existing] = await db
          .select()
          .from(sendingAccounts)
          .where(
            and(
              eq(sendingAccounts.id, input.editId),
              eq(sendingAccounts.workspaceId, ctx.workspace.id),
            ),
          );
        if (existing) {
          if (!smtpPassword) smtpPassword = existing.smtpPassword ?? undefined;
          oauthAccessToken = existing.oauthAccessToken ?? null;
        }
      }
      return testSmtpConnection({
        provider: input.provider,
        smtpHost: input.smtpHost ?? null,
        smtpPort: input.smtpPort ?? null,
        smtpUsername: input.smtpUsername ?? null,
        smtpPassword: smtpPassword ?? null,
        sesRegion: input.sesRegion ?? null,
        oauthAccessToken: oauthAccessToken ?? null,
        sendgridApiKey: sendgridApiKey ?? null,
      });
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
        sendgridApiKey: tryDecryptSecret(account.sendgridApiKeyEnc),
      });

      await db
        .update(sendingAccounts)
        .set({
          connectionStatus: result.ok ? "connected" : "error",
          lastTestedAt: new Date(),
          lastTestError: result.error ?? null,
          reputationTier: reputationTierFromRate(parseFloat(account.bounceRate ?? "0")),
        })
        .where(and(eq(sendingAccounts.id, input.id), eq(sendingAccounts.workspaceId, ctx.workspace.id)));

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

  toggleEnabled: adminWsProcedure
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
      // Pool row first — strip `members` since it isn't a senderPools column.
      const { members, ...poolFields } = input;
      const [result] = await db.insert(senderPools).values({
        workspaceId: ctx.workspace.id,
        ...poolFields,
      });
      const poolId = (result as any).insertId as number;

      // Members second — validate each is a real workspace account AND
      // not a personal Unipile-bridged mailbox (same rule as addMember).
      if (members && members.length > 0) {
        const accountIds = members.map((m) => m.accountId);
        const validAccounts = await db
          .select({ id: sendingAccounts.id, unipileAccountId: sendingAccounts.unipileAccountId })
          .from(sendingAccounts)
          .where(
            and(
              eq(sendingAccounts.workspaceId, ctx.workspace.id),
              inArray(sendingAccounts.id, accountIds),
            ),
          );
        const validMap = new Map(validAccounts.map((a) => [a.id, a]));
        const rejected: number[] = [];
        const memberRows = members
          .map((m, idx) => {
            const acct = validMap.get(m.accountId);
            if (!acct) {
              rejected.push(m.accountId);
              return null;
            }
            if (acct.unipileAccountId) {
              // Skip Unipile-bridged personal mailboxes silently rather
              // than failing the whole pool create — they shouldn't have
              // been selectable in the UI.
              rejected.push(m.accountId);
              return null;
            }
            return {
              workspaceId: ctx.workspace.id,
              poolId,
              accountId: m.accountId,
              weight: m.weight ?? 10,
              position: m.position ?? m.priority ?? idx,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        if (memberRows.length > 0) {
          await db.insert(senderPoolMembers).values(memberRows);
        }
        if (rejected.length > 0) {
          console.warn(
            `[senderPools.create] pool ${poolId} skipped ${rejected.length} member(s) not in workspace or personal-mailbox-bridged: ${rejected.join(",")}`,
          );
        }
      }

      return { id: poolId, memberCount: members?.length ?? 0 };
    }),

  update: workspaceProcedure
    .input(PoolCreateInput.partial().extend({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { id, members, ...rest } = input;
      // Verify ownership before mutating either pool or members.
      const [existing] = await db
        .select({ id: senderPools.id })
        .from(senderPools)
        .where(and(eq(senderPools.id, id), eq(senderPools.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });

      // Pool fields (name / description / rotationStrategy). Skip the
      // db.update call entirely if there's nothing to set — empty SET
      // throws on some MySQL versions.
      if (Object.keys(rest).length > 0) {
        await db
          .update(senderPools)
          .set(rest)
          .where(
            and(
              eq(senderPools.id, id),
              eq(senderPools.workspaceId, ctx.workspace.id),
            ),
          );
      }

      // Members: if the caller passed an array (even empty), treat it
      // as the authoritative new list — delete then re-insert. If
      // members is undefined, leave existing members alone.
      if (members !== undefined) {
        await db.delete(senderPoolMembers).where(eq(senderPoolMembers.poolId, id));
        if (members.length > 0) {
          const accountIds = members.map((m) => m.accountId);
          const validAccounts = await db
            .select({ id: sendingAccounts.id, unipileAccountId: sendingAccounts.unipileAccountId })
            .from(sendingAccounts)
            .where(
              and(
                eq(sendingAccounts.workspaceId, ctx.workspace.id),
                inArray(sendingAccounts.id, accountIds),
              ),
            );
          const validMap = new Map(validAccounts.map((a) => [a.id, a]));
          const memberRows = members
            .map((m, idx) => {
              const acct = validMap.get(m.accountId);
              if (!acct || acct.unipileAccountId) return null;
              return {
                workspaceId: ctx.workspace.id,
                poolId: id,
                accountId: m.accountId,
                weight: m.weight ?? 10,
                position: m.position ?? m.priority ?? idx,
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null);
          if (memberRows.length > 0) {
            await db.insert(senderPoolMembers).values(memberRows);
          }
        }
      }

      return { ok: true };
    }),

  // Sender pools control which SMTP accounts an entire campaign sends from.
  // Admin-gated for parity with sending-account CRUD.
  delete: adminWsProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Verify the pool belongs to this workspace BEFORE wiping members.
      // Without the ownership check + workspaceId on the member delete,
      // any caller passing a numeric poolId from another workspace would
      // wipe that workspace's sender_pool_members rows.
      const [owns] = await db
        .select({ id: senderPools.id })
        .from(senderPools)
        .where(
          and(
            eq(senderPools.id, input.id),
            eq(senderPools.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!owns) throw new TRPCError({ code: "NOT_FOUND" });

      await db
        .delete(senderPoolMembers)
        .where(
          and(
            eq(senderPoolMembers.poolId, input.id),
            eq(senderPoolMembers.workspaceId, ctx.workspace.id),
          ),
        );
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
        .select({ id: sendingAccounts.id, unipileAccountId: sendingAccounts.unipileAccountId })
        .from(sendingAccounts)
        .where(
          and(
            eq(sendingAccounts.id, input.accountId),
            eq(sendingAccounts.workspaceId, ctx.workspace.id),
          ),
        );
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });
      // Unipile-bridged personal M365 mailboxes cannot be added to a
      // sender pool — those are for personal inbox/calendar access, not
      // shared outreach sending.
      if (account.unipileAccountId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Personal Microsoft accounts can't be added to a sender pool. Use a workspace IMAP/SMTP account.",
        });
      }

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
        .where(and(eq(senderPools.id, input.poolId), eq(senderPools.workspaceId, ctx.workspace.id)));

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
