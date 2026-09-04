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

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  sendingAccounts,
  smtpConfigs,
  workspaceSettings,
  senderPools,
  senderPoolMembers,
  sendingAccountDailyStats,
} from "../drizzle/schema";
import { getDb } from "./db";
import { logEmailSend, type EmailLogMeta, type EmailLogSource } from "./services/email/logSend";
import { recordEmailsSent } from "./usageCounters";
import { buildTransporter, decrypt } from "./routers/smtpConfig";
import { resolveSenderTokens, scrubForSend, senderDisplayName } from "./mergeVars";

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /**
   * How this message should be classified on the Emails page (migration 0163).
   * Defaults to `transactional`, which is what everything on this path is
   * unless the caller says otherwise.
   */
  logSource?: EmailLogSource | string;
  /** Human label for the source — "Weekly pipeline report", a campaign name. */
  logLabel?: string | null;
}

export interface SendEmailResult {
  ok: boolean;
  reason?: string;
}

/**
 * Every function in this file carries template-rendered content (campaign
 * steps, notifications, reports) — never human-composed mail, which goes
 * through emailAdapter and must NOT be scrubbed. So the no-braces-on-the-wire
 * guarantee is enforced here once, at the shared boundary, rather than hoped
 * for in every renderer upstream (they deliberately disagree — see
 * scrubUnresolvedMergeTags). Idempotent, so the pool's fallback into
 * sendWorkspaceEmail scrubbing twice is harmless.
 */
function scrubTemplateOpts<T extends SendEmailOptions>(opts: T, where: string): T {
  return {
    ...opts,
    subject: scrubForSend(opts.subject, `${where}.subject`),
    html: scrubForSend(opts.html, `${where}.html`),
    ...(opts.text !== undefined ? { text: scrubForSend(opts.text, `${where}.text`) } : {}),
  };
}

/**
 * Fill {{senderName}} / {{senderFirstName}} / {{senderLastName}} / {{senderEmail}}
 * against the mailbox that is about to send. Must run BEFORE the scrub: the
 * scrub deletes any brace token left on the wire, and until the pool has
 * chosen an account these four cannot be filled. (Owner report 2026-09-03:
 * campaign sign-offs went out "Best," / blank line / "CommunityForce".)
 */
function fillSenderTokens<T extends SendEmailOptions>(
  opts: T,
  sender: { fromName?: string | null; name?: string | null; fromEmail?: string | null },
): T {
  return {
    ...opts,
    subject: resolveSenderTokens(opts.subject, sender),
    html: resolveSenderTokens(opts.html, sender),
    ...(opts.text !== undefined ? { text: resolveSenderTokens(opts.text, sender) } : {}),
  };
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
 * `fromName` overrides the display name (e.g. "Jane Doe | Acme Inc.") while
 * the From address rotates with the account.
 *
 * Falls back to the single Email-Delivery config (sendWorkspaceEmail) when the
 * workspace has no usable sending accounts at all.
 */
export async function sendCampaignEmailViaPool(
  workspaceId: number,
  opts: SendEmailOptions & { fromName?: string; logMeta?: EmailLogMeta },
): Promise<SendEmailResult & { accountId?: number; fromEmail?: string }> {
  // The scrub runs AFTER the account is chosen (step 3c below) so the sender
  // tokens can be filled from it first. The no-accounts fallback scrubs
  // inside sendWorkspaceEmail, after filling them from the SMTP config.
  try {
    const db = await getDb();
    if (!db) return { ok: false, reason: "DB unavailable" };

    // 1–3. Which mailbox sends — the ONE selection rule (choosePoolAccount),
    //      shared with the message preview so "will send from" names the
    //      pool's real pick rather than a guess.
    const pick = await choosePoolAccount(workspaceId);
    // No sending accounts at all → fall back to the single Email-Delivery config.
    // The classification travels with it: a campaign email that went out
    // through the fallback is still a campaign email on the Emails page.
    if (pick.kind === "no_accounts") {
      const r = await sendWorkspaceEmail(workspaceId, {
        ...opts,
        logSource: opts.logMeta?.source ?? opts.logSource ?? "campaign",
        logLabel: opts.logMeta?.sourceLabel ?? opts.logLabel ?? null,
      });
      return r;
    }
    if (pick.kind === "blocked") return { ok: false, reason: pick.reason };
    const chosen = pick.account;
    const today = new Date().toISOString().slice(0, 10);

    // 3c. Now the sender is known: fill the sender tokens, THEN scrub whatever
    //     is still unresolved so no brace reaches the wire.
    opts = scrubTemplateOpts(fillSenderTokens(opts, chosen), "emailDelivery.pool");

    // 4. Send via the account's adapter (SMTP/IMAP/OAuth).
    const { createEmailAdapter } = await import("./emailAdapter");
    const adapter = createEmailAdapter(chosen as any);
    await adapter.sendEmail({
      to: Array.isArray(opts.to) ? opts.to[0] : opts.to,
      subject: opts.subject,
      bodyHtml: opts.html,
      bodyText: opts.text,
      fromEmail: (chosen as any).fromEmail,
      // A mailbox linked by address has no fromName; the From header then
      // showed a bare address. One rule (senderDisplayName) for the header
      // and the signature, so they cannot disagree.
      fromName: opts.fromName ?? (senderDisplayName(chosen) || undefined),
      replyTo: opts.replyTo ?? (chosen as any).replyTo ?? undefined,
      // Carried through to the email_log row the adapter writes, so campaign
      // mail lands on the Emails page naming its campaign, step and prospect
      // rather than as an anonymous "other".
      logMeta: opts.logMeta ?? { source: opts.logSource ?? "campaign", sourceLabel: opts.logLabel ?? null },
    } as any);

    // 5. Record usage (no unique key on the table → read-then-write).
    const [existing] = await db
      .select({ id: sendingAccountDailyStats.id, sentCount: sendingAccountDailyStats.sentCount })
      .from(sendingAccountDailyStats)
      .where(and(eq(sendingAccountDailyStats.accountId, chosen.id), eq(sendingAccountDailyStats.date, today)))
      .limit(1);
    if (existing) {
      // Atomic in SQL. `existing.sentCount + 1` computed in JS is a lost-update
      // race: two concurrent sends both read 5 and both write 6, so two sends
      // are recorded as one and the account quietly runs past its daily limit —
      // which is the one thing this counter exists to prevent.
      await db.update(sendingAccountDailyStats)
        .set({ sentCount: sql`${sendingAccountDailyStats.sentCount} + 1` } as never)
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

export type PoolPick =
  | { kind: "account"; account: typeof sendingAccounts.$inferSelect }
  | { kind: "no_accounts" }
  | { kind: "blocked"; reason: string };

/**
 * The mailbox the pool sends from RIGHT NOW. Extracted from
 * sendCampaignEmailViaPool (2026-09-03) so the message preview can name the
 * sender a not-yet-sent step will go out from — through the same rule, not a
 * copy of it. Read-only: usage is recorded by the send, not the pick.
 *
 * Selection: prefer the workspace's first sender pool's members; if no pool
 * exists, rotate across ALL enabled sending accounts. Among eligible accounts
 * (under their dailySendLimit today) it picks the LEAST-used one, which evenly
 * balances load and naturally round-robins; then skips any whose owner-set
 * hourly limit is spent.
 */
export async function choosePoolAccount(workspaceId: number): Promise<PoolPick> {
  const db = await getDb();
  if (!db) return { kind: "blocked", reason: "DB unavailable" };

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
  if (accounts.length === 0) return { kind: "no_accounts" };

  // 2. Today's per-account usage.
  const today = new Date().toISOString().slice(0, 10);
  const ids = accounts.map((a) => a.id);
  // SUM, not the first row: there is no unique key on (accountId, date), so
  // two sends racing on the first send of a day can both insert and leave two
  // rows. Reading one of them undercounts usage for the rest of that day, and
  // this number is what enforces the mailbox's daily limit.
  const stats = await db
    .select({
      accountId: sendingAccountDailyStats.accountId,
      sent: sql<number>`COALESCE(SUM(${sendingAccountDailyStats.sentCount}), 0)`,
    })
    .from(sendingAccountDailyStats)
    .where(and(inArray(sendingAccountDailyStats.accountId, ids), eq(sendingAccountDailyStats.date, today)))
    .groupBy(sendingAccountDailyStats.accountId);
  const usedMap = new Map(stats.map((s) => [s.accountId, Number(s.sent) || 0]));

  // 3. Eligible = under daily limit; pick the least-used (balances + rotates).
  const eligible = accounts
    .map((a) => ({ a, used: usedMap.get(a.id) ?? 0 }))
    .filter((x) => x.used < (x.a.dailySendLimit ?? 500))
    .sort((x, y) => x.used - y.used || x.a.id - y.a.id);
  if (eligible.length === 0) {
    return { kind: "blocked", reason: "All sending accounts have hit their daily limit" };
  }

  // 3b. …and under its HOURLY limit, for accounts whose owner configured one
  //     (owner ask 2026-08-14: inbox sending limits are global defaults for
  //     that inbox). Campaign sends pick their account HERE, so a limit
  //     enforced only in sendLimits.assertSendAllowed never reached them.
  //     Skipping the account is better than failing the send — that is what
  //     a pool is for.
  const { getAccountSentLastHour } = await import("./sendLimits");
  let chosen = eligible[0].a;
  let hourlyBlocked = 0;
  for (const cand of eligible) {
    const limit = (cand.a as { hourlySendLimit?: number }).hourlySendLimit ?? 0;
    const configured = (cand.a as { sendingLimitsCompleted?: boolean }).sendingLimitsCompleted === true;
    if (!configured || limit <= 0) { chosen = cand.a; break; }
    const lastHour = await getAccountSentLastHour(cand.a.id, workspaceId);
    if (lastHour < limit) { chosen = cand.a; break; }
    hourlyBlocked++;
  }
  if (hourlyBlocked === eligible.length) {
    return { kind: "blocked", reason: "Every eligible sending account has hit its hourly limit — it will resume within the hour" };
  }
  return { kind: "account", account: chosen };
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
  // Scrubbed below, once the config's sender is known (see fillSenderTokens).
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

    const fromEmail = cfg.fromEmail ?? cfg.username;
    const fromName = senderDisplayName({ fromName: cfg.fromName, fromEmail }) || cfg.username;
    opts = scrubTemplateOpts(fillSenderTokens(opts, { fromName: cfg.fromName, fromEmail }), "emailDelivery.workspace");

    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: Array.isArray(opts.to) ? opts.to.join(", ") : opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: opts.replyTo ?? cfg.replyTo ?? undefined,
    });

    /**
     * Transmission point 2 of 3. This branch builds its own nodemailer
     * transporter from the workspace's SMTP config and never touches
     * createEmailAdapter, so the meter inside that factory cannot see it.
     *
     * The adapter branch of this same function (sendCampaignEmailViaPool) is
     * already counted by the factory — counting again here would double every
     * pooled send.
     *
     * The email_log row (migration 0163) is written for exactly the same
     * reason and with the same split: this branch logs itself, the adapter
     * branch is logged by the factory.
     */
    await recordEmailsSent(workspaceId, 1);
    await logEmailSend({
      workspaceId,
      meta: { source: opts.logSource ?? "transactional", sourceLabel: opts.logLabel ?? null },
      fromEmail,
      fromName,
      to: opts.to,
      subject: opts.subject,
      bodyHtml: opts.html,
      bodyText: opts.text,
      status: "sent",
    });
    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Logged as a failure so "the invite never arrived" is answerable from the
    // Emails page instead of only from the server console.
    await logEmailSend({
      workspaceId,
      meta: { source: opts.logSource ?? "transactional", sourceLabel: opts.logLabel ?? null },
      to: opts.to,
      subject: opts.subject,
      bodyHtml: opts.html,
      bodyText: opts.text,
      status: "failed",
      failureReason: msg,
    });
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
  opts = scrubTemplateOpts(opts, "emailDelivery.system");
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
