/**
 * emailDelivery.ts
 *
 * Shared helper for sending transactional emails (invites, notifications,
 * expiry warnings, pipeline alerts) via the workspace's configured SMTP
 * delivery settings (smtp_configs table / Settings → Email Delivery).
 *
 * This is intentionally separate from the sendingAccounts table, which is
 * used for outbound sales sequences via Unipile/IMAP.
 *
 * Usage:
 *   const result = await sendWorkspaceEmail(workspaceId, {
 *     to: "alice@acme.com",
 *     subject: "You've been invited",
 *     html: "<p>…</p>",
 *   });
 *   if (!result.ok) console.warn("Email not sent:", result.reason);
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  sendingAccounts,
  smtpConfigs,
  workspaceSettings,
  senderPools,
  senderPoolMembers,
  sendingAccountDailyStats,
} from "../drizzle/schema";
import { getDb } from "./db";
import { buildTransporter, decrypt } from "./routers/smtpConfig";

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  reason?: string;
}

/**
 * Send an OUTBOUND campaign email through the workspace's sender POOL, spreading
 * volume across the connected sending accounts with per-account daily-limit
 * enforcement — the deliverability-correct path for cold outreach (ARE engine).
 *
 * Selection: prefer the workspace's first sender pool's members; if no pool
 * exists, rotate across ALL enabled sending accounts. Among eligible accounts
 * (under their dailySendLimit today) it picks the LEAST-used one, which evenly
 * balances load and naturally round-robins. Records the send in
 * sending_account_daily_stats so the next pick — and the Mailboxes UI usage
 * readout — stay accurate.
 *
 * `fromName` overrides the display name (e.g. "Lucas Grant | LSI Media") while
 * the From address rotates with the account.
 *
 * Falls back to the single Email-Delivery config (sendWorkspaceEmail) when the
 * workspace has no usable sending accounts at all.
 */
export async function sendCampaignEmailViaPool(
  workspaceId: number,
  opts: SendEmailOptions & { fromName?: string },
): Promise<SendEmailResult & { accountId?: number; fromEmail?: string }> {
  try {
    const db = await getDb();
    if (!db) return { ok: false, reason: "DB unavailable" };

    // 1. Candidate accounts — pool members first, else all enabled accounts.
    const [pool] = await db
      .select()
      .from(senderPools)
      .where(and(eq(senderPools.workspaceId, workspaceId), eq(senderPools.enabled, true)))
      .orderBy(senderPools.id)
      .limit(1);

    let accounts: (typeof sendingAccounts.$inferSelect)[] = [];
    if (pool) {
      const members = await db
        .select({ accountId: senderPoolMembers.accountId })
        .from(senderPoolMembers)
        .where(eq(senderPoolMembers.poolId, pool.id));
      const ids = members.map((m) => m.accountId);
      if (ids.length > 0) {
        accounts = await db
          .select()
          .from(sendingAccounts)
          .where(and(
            eq(sendingAccounts.workspaceId, workspaceId),
            inArray(sendingAccounts.id, ids),
            eq(sendingAccounts.enabled, true),
          ));
      }
    }
    if (accounts.length === 0) {
      accounts = await db
        .select()
        .from(sendingAccounts)
        .where(and(eq(sendingAccounts.workspaceId, workspaceId), eq(sendingAccounts.enabled, true)));
    }
    // No sending accounts at all → fall back to the single Email-Delivery config.
    if (accounts.length === 0) {
      const r = await sendWorkspaceEmail(workspaceId, opts);
      return r;
    }

    // 2. Today's per-account usage.
    const today = new Date().toISOString().slice(0, 10);
    const ids = accounts.map((a) => a.id);
    const stats = await db
      .select({ accountId: sendingAccountDailyStats.accountId, sent: sendingAccountDailyStats.sentCount })
      .from(sendingAccountDailyStats)
      .where(and(inArray(sendingAccountDailyStats.accountId, ids), eq(sendingAccountDailyStats.date, today)));
    const usedMap = new Map(stats.map((s) => [s.accountId, s.sent]));

    // 3. Eligible = under daily limit; pick the least-used (balances + rotates).
    const eligible = accounts
      .map((a) => ({ a, used: usedMap.get(a.id) ?? 0 }))
      .filter((x) => x.used < (x.a.dailySendLimit ?? 500))
      .sort((x, y) => x.used - y.used || x.a.id - y.a.id);
    if (eligible.length === 0) {
      return { ok: false, reason: "All sending accounts have hit their daily limit" };
    }
    const chosen = eligible[0].a;

    // 4. Send via the account's adapter (SMTP/IMAP/OAuth).
    const { createEmailAdapter } = await import("./emailAdapter");
    const adapter = createEmailAdapter(chosen as any);
    await adapter.sendEmail({
      to: Array.isArray(opts.to) ? opts.to[0] : opts.to,
      subject: opts.subject,
      bodyHtml: opts.html,
      bodyText: opts.text,
      fromEmail: (chosen as any).fromEmail,
      fromName: opts.fromName ?? (chosen as any).fromName ?? undefined,
      replyTo: opts.replyTo ?? (chosen as any).replyTo ?? undefined,
    } as any);

    // 5. Record usage (no unique key on the table → read-then-write).
    const [existing] = await db
      .select({ id: sendingAccountDailyStats.id, sentCount: sendingAccountDailyStats.sentCount })
      .from(sendingAccountDailyStats)
      .where(and(eq(sendingAccountDailyStats.accountId, chosen.id), eq(sendingAccountDailyStats.date, today)))
      .limit(1);
    if (existing) {
      await db.update(sendingAccountDailyStats)
        .set({ sentCount: existing.sentCount + 1 })
        .where(eq(sendingAccountDailyStats.id, existing.id));
    } else {
      await db.insert(sendingAccountDailyStats)
        .values({ workspaceId, accountId: chosen.id, date: today, sentCount: 1 });
    }

    return { ok: true, accountId: chosen.id, fromEmail: (chosen as any).fromEmail };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Pool send failed: ${msg}` };
  }
}

/**
 * Send a transactional email using the workspace's Email Delivery SMTP config.
 *
 * Returns { ok: true } on success.
 * Returns { ok: false, reason } if no SMTP config is set, config is disabled,
 * or the send fails — callers should treat this as non-fatal.
 */
export async function sendWorkspaceEmail(
  workspaceId: number,
  opts: SendEmailOptions,
): Promise<SendEmailResult> {
  try {
    const db = await getDb();
    if (!db) return { ok: false, reason: "DB unavailable" };

    const [cfg] = await db
      .select()
      .from(smtpConfigs)
      .where(eq(smtpConfigs.workspaceId, workspaceId));

    if (!cfg) return { ok: false, reason: "No SMTP config found for workspace" };
    if (!cfg.enabled) return { ok: false, reason: "SMTP delivery is disabled for this workspace" };
    if (!cfg.host || !cfg.username || !cfg.encryptedPassword) {
      return { ok: false, reason: "Incomplete SMTP config (missing host, username, or password)" };
    }

    let password: string;
    try {
      password = decrypt(cfg.encryptedPassword);
    } catch {
      return { ok: false, reason: "Failed to decrypt SMTP password" };
    }

    const transporter = buildTransporter({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      username: cfg.username,
      password,
    });

    const fromName = cfg.fromName ?? cfg.username;
    const fromEmail = cfg.fromEmail ?? cfg.username;

    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: Array.isArray(opts.to) ? opts.to.join(", ") : opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: opts.replyTo ?? cfg.replyTo ?? undefined,
    });

    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `SMTP send failed: ${msg}` };
  }
}

/**
 * Send a SYSTEM / notification email (team invitations, invite-expiry warnings,
 * internal alerts) from the workspace's DEDICATED system sender account
 * (workspace_settings.systemSenderAccountId) when configured — so these are
 * never sent from a rep's own Outlook/sending account. Multi-user requirement.
 *
 * Falls back to the SMTP Email-Delivery config (sendWorkspaceEmail) when no
 * system sender is set or the account send fails — preserving prior behavior.
 * Non-fatal on failure.
 */
export async function sendSystemEmail(
  workspaceId: number,
  opts: SendEmailOptions,
): Promise<SendEmailResult> {
  try {
    const db = await getDb();
    if (!db) return { ok: false, reason: "DB unavailable" };

    const [ws] = await db
      .select({ systemSenderAccountId: workspaceSettings.systemSenderAccountId })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId));

    if (ws?.systemSenderAccountId) {
      const [account] = await db
        .select()
        .from(sendingAccounts)
        .where(and(
          eq(sendingAccounts.id, ws.systemSenderAccountId),
          eq(sendingAccounts.workspaceId, workspaceId),
          eq(sendingAccounts.enabled, true),
        ));
      if (account) {
        try {
          const { createEmailAdapter } = await import("./emailAdapter");
          const adapter = createEmailAdapter(account as any);
          await adapter.sendEmail({
            to: Array.isArray(opts.to) ? opts.to[0] : opts.to,
            subject: opts.subject,
            bodyHtml: opts.html,
            bodyText: opts.text,
            fromEmail: (account as any).fromEmail,
            fromName: (account as any).fromName ?? undefined,
          } as any);
          return { ok: true };
        } catch (e) {
          // System-account send failed — fall through to the SMTP fallback below.
          console.error(`[sendSystemEmail] system sender account failed (ws ${workspaceId}):`, e instanceof Error ? e.message : String(e));
        }
      }
    }

    // No system sender configured (or it failed) — use the SMTP Email-Delivery config.
    return await sendWorkspaceEmail(workspaceId, opts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `System email failed: ${msg}` };
  }
}
