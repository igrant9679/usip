/**
 * sendLimits.ts — persistent daily-cap enforcement for outbound mail.
 *
 * Audit found two gaps:
 *
 *  1. Workspace daily cap (default 100) lived as an in-memory Map in
 *     sequenceEngine.ts. It reset to zero on every server restart and
 *     was only checked by the sequence engine path — ad-hoc sends,
 *     manual mailbox sends, and the emailDrafts.send path bypassed it.
 *
 *  2. Per-account `sendingAccounts.dailySendLimit` was enforced only
 *     on the campaign-pool branch of `pickAccountForSequenceDraft`.
 *     Single-account campaigns and every ad-hoc / manual send ignored
 *     it, so a "warmed" SMTP account could be blasted past its safe
 *     daily ceiling.
 *
 * Both gaps closed here by counting sent rows from the DB rather than
 * RAM, so the count survives a restart, and every send path calls
 * `assertSendAllowed` before invoking the adapter.
 *
 * ── WHICH TABLE COUNTS WHAT (audit 2026-09-20) ──────────────────────
 * Three counters existed and each read a table only one engine wrote,
 * so a mailbox could spend its whole daily limit TWICE in a day:
 * `email_drafts` (sequences/CRM — campaign mail writes none),
 * `sending_account_daily_stats` (written only by emailDelivery's pool)
 * and warmup's own column. The PER-ACCOUNT number is now one function,
 * `accountsSentToday`, over `email_log` — the only table every
 * account-attributed transmission writes — plus the account's warmup
 * column, which stays out of the log on purpose (see below).
 *
 * The WORKSPACE-wide count deliberately still reads `email_drafts`; it
 * feeds a different, much smaller cap and moving it would break far
 * more than it fixed. See getWorkspaceSentToday.
 *
 * `assertSendAllowed` throws TRPCError instead of returning a flag so
 * callers don't have to remember to check. Failures surface as
 * actionable error messages.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { emailDrafts, emailLog, sendingAccounts, workspaceSettings } from "../drizzle/schema";
import { getDb } from "./db";
import { utcDayStart } from "@shared/timeWindows";

/** Conservative workspace-wide cap when no per-workspace override is set. */
const DEFAULT_WORKSPACE_DAILY_CAP = 100;

function todayStart(): Date {
  // UTC — see shared/timeWindows.ts. A send cap must not roll over at an hour
  // that depends on the host's timezone.
  return utcDayStart();
}

/** The same YYYY-MM-DD stamp warmupEngine writes into `warmupTodayDate`. */
function utcDateStr(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** One account's warmup counter, as `accountsSentToday` reads it. */
export interface WarmupUsageRow {
  id: number;
  warmupSentToday: number | null;
  warmupTodayDate: string | null;
}

/**
 * Fold warmup volume into the per-account log counts.
 *
 * Pure, because the two ways this silently mis-measures are worth testing
 * without a database:
 *   - an account with no rows must come back as 0, not absent. Every caller
 *     compares `used < dailySendLimit`, and `undefined < 500` is false — an
 *     unseen mailbox would be skipped as if it were exhausted.
 *   - `warmupTodayDate` is overwritten on the next send, never reset at
 *     midnight, so a stale date means the stored count belongs to yesterday
 *     and must contribute nothing (same trap as warmupEngine.ts:144-146).
 */
export function mergeWarmupUsage(
  accountIds: number[],
  logCounts: Array<{ accountId: number | null; cnt: number | string | null }>,
  warmupRows: WarmupUsageRow[],
  todayStr: string,
): Map<number, number> {
  const out = new Map<number, number>();
  accountIds.forEach((id) => out.set(id, 0));
  logCounts.forEach((r) => {
    if (r.accountId == null) return;
    out.set(r.accountId, (out.get(r.accountId) ?? 0) + (Number(r.cnt) || 0));
  });
  warmupRows.forEach((w) => {
    if (w.warmupTodayDate !== todayStr) return;
    out.set(w.id, (out.get(w.id) ?? 0) + (Number(w.warmupSentToday) || 0));
  });
  return out;
}

/**
 * Today's send count per account — the ONE number every sender gates on.
 *
 * Counts `email_log` rows (migration 0163): the only table every
 * account-attributed transmission writes. Deliberately NOT
 * `sending_account_daily_stats`, which only emailDelivery's pool writes, and
 * NOT `email_drafts`, which campaign mail never writes — counting either meant
 * one engine could not see the other's volume, which is what let a mailbox do
 * its full dailySendLimit twice in a day.
 *
 * Warmup is ADDED from the account's own counter rather than logged: warmup
 * mail leaves the same mailbox and receiving providers count it, but it is the
 * workspace mailing itself, so it must not enter the sitewide Emails feed, the
 * Home "emails sent" tile or the email_log report source.
 */
export async function accountsSentToday(
  workspaceId: number,
  accountIds: number[],
): Promise<Map<number, number>> {
  if (accountIds.length === 0) return new Map<number, number>();
  const db = await getDb();
  if (!db) return new Map<number, number>();
  const rows = await db
    .select({ accountId: emailLog.sendingAccountId, cnt: sql<number>`COUNT(*)` })
    .from(emailLog)
    .where(
      and(
        // Mandatory even though the account ids already imply the workspace:
        // it is the house rule, and it makes a stray cross-workspace id count
        // as nothing rather than as somebody else's volume.
        eq(emailLog.workspaceId, workspaceId),
        inArray(emailLog.sendingAccountId, accountIds),
        eq(emailLog.status, "sent"),
        sql`${emailLog.sentAt} >= ${todayStart()}`,
      ),
    )
    .groupBy(emailLog.sendingAccountId);
  const warm = await db
    .select({
      id: sendingAccounts.id,
      warmupSentToday: sendingAccounts.warmupSentToday,
      warmupTodayDate: sendingAccounts.warmupTodayDate,
    })
    .from(sendingAccounts)
    .where(
      and(
        eq(sendingAccounts.workspaceId, workspaceId),
        inArray(sendingAccounts.id, accountIds),
      ),
    );
  return mergeWarmupUsage(accountIds, rows, warm, utcDateStr());
}

/** Count everything this sending account dispatched today. */
export async function getAccountSentToday(
  accountId: number,
  workspaceId: number,
): Promise<number> {
  return (await accountsSentToday(workspaceId, [accountId])).get(accountId) ?? 0;
}

/**
 * Count what this account dispatched in the last rolling hour.
 *
 * A rolling window, not a clock hour: an account capped at 6/hour should not
 * be able to send 6 at 10:59 and 6 more at 11:01, which is a 12-in-two-minutes
 * burst — exactly the pattern the limit exists to prevent.
 *
 * Reads `email_log` for the same reason the daily count does, and this is the
 * first time the hourly limit can see campaign mail at all — campaign sends
 * write no email_drafts row, so the pool's own volume was invisible here.
 *
 * Warmup is NOT added: its counter is per UTC DAY with no hourly stamp, so
 * there is no honest way to attribute it to the last sixty minutes. The daily
 * ceiling is where warmup volume binds.
 */
export async function getAccountSentLastHour(
  accountId: number,
  workspaceId: number,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [row] = await db
    .select({ cnt: sql<number>`COUNT(*)` })
    .from(emailLog)
    .where(
      and(
        eq(emailLog.workspaceId, workspaceId),
        eq(emailLog.sendingAccountId, accountId),
        eq(emailLog.status, "sent"),
        sql`${emailLog.sentAt} >= ${since}`,
      ),
    );
  return Number(row?.cnt ?? 0);
}

/**
 * Count drafts dispatched today across the entire workspace.
 *
 * DELIBERATELY still email_drafts. This feeds workspaceSettings
 * .areDefaultDailySendCap (default 50) and a breach THROWS. email_log also
 * carries ARE campaign mail and transactional mail, so counting it here would
 * let one live campaign exhaust the workspace budget before mid-morning and
 * make every rep's Inbox compose throw TOO_MANY_REQUESTS. Widening or
 * re-pointing this cap is a separate decision, not a side effect of unifying
 * the per-ACCOUNT number.
 */
export async function getWorkspaceSentToday(workspaceId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ cnt: sql<number>`COUNT(*)` })
    .from(emailDrafts)
    .where(
      and(
        eq(emailDrafts.workspaceId, workspaceId),
        eq(emailDrafts.status, "sent"),
        sql`${emailDrafts.sentAt} >= ${todayStart()}`,
      ),
    );
  return Number(row?.cnt ?? 0);
}

/**
 * Throw if a send would breach the per-workspace OR per-account cap.
 *
 * - Workspace cap reads `workspaceSettings.areDefaultDailySendCap` if
 *   set, otherwise DEFAULT_WORKSPACE_DAILY_CAP (100). Calling this in
 *   the workspace-only mode (e.g. for an account-less manual send via
 *   `adapter.sendEmail` paths that don't have an account context) is
 *   supported — pass null for accountId.
 *
 * - Account cap reads `sendingAccounts.dailySendLimit`. If the account
 *   row can't be loaded (deleted mid-flight), we treat that as "not
 *   gated" rather than failing — the send-path should already have
 *   bailed on a bad account.
 *
 * Use right before adapter.sendEmail.
 */
export async function assertSendAllowed(
  workspaceId: number,
  accountId: number | null,
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Workspace-wide cap.
  const [settings] = await db
    .select({ cap: workspaceSettings.areDefaultDailySendCap })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const wsCap = settings?.cap ?? DEFAULT_WORKSPACE_DAILY_CAP;
  const wsSent = await getWorkspaceSentToday(workspaceId);
  if (wsSent >= wsCap) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Workspace daily send cap reached (${wsSent}/${wsCap}). Try again tomorrow or raise the cap in ARE settings.`,
    });
  }

  // Per-account cap (skipped when no account context, e.g. some adapter
  // paths that don't know their account id).
  if (accountId == null) return;
  const [acct] = await db
    .select({
      dailySendLimit: sendingAccounts.dailySendLimit,
      hourlySendLimit: sendingAccounts.hourlySendLimit,
      sendingLimitsCompleted: sendingAccounts.sendingLimitsCompleted,
      fromEmail: sendingAccounts.fromEmail,
    })
    .from(sendingAccounts)
    .where(
      and(
        eq(sendingAccounts.id, accountId),
        eq(sendingAccounts.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!acct) return;
  const acctSent = await getAccountSentToday(accountId, workspaceId);
  if (acctSent >= acct.dailySendLimit) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Sending account ${acct.fromEmail} hit its daily limit (${acctSent}/${acct.dailySendLimit}). Pick a different sender or wait until tomorrow.`,
    });
  }

  // Per-account HOURLY cap. Stored since the setup wizard shipped and enforced
  // by nothing until 2026-08-14 — the column was written, read back into the
  // form, and ignored by every send path.
  //
  // Gated on sendingLimitsCompleted on purpose. The column is NOT NULL with a
  // default of 6, so enforcing it unconditionally would suddenly throttle every
  // mailbox whose owner never opened that step — forcing a value nobody chose,
  // which is the opposite of the rule. Completing the step is the signal that
  // these numbers are the owner's.
  if (acct.sendingLimitsCompleted && acct.hourlySendLimit > 0) {
    const lastHour = await getAccountSentLastHour(accountId, workspaceId);
    if (lastHour >= acct.hourlySendLimit) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Sending account ${acct.fromEmail} hit its hourly limit (${lastHour}/${acct.hourlySendLimit}). It will resume automatically within the hour.`,
      });
    }
  }
}
