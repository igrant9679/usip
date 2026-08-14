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
 * Both gaps closed here by counting from `email_drafts` rows where
 * `status = "sent"` AND `sentAt >= today`. The count is persistent
 * across restarts (it reads the DB, not RAM), and every send path
 * calls `assertSendAllowed` before invoking the adapter.
 *
 * `assertSendAllowed` throws TRPCError instead of returning a flag so
 * callers don't have to remember to check. Failures surface as
 * actionable error messages.
 */
import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { emailDrafts, sendingAccounts, workspaceSettings } from "../drizzle/schema";
import { getDb } from "./db";
import { utcDayStart } from "@shared/timeWindows";

/** Conservative workspace-wide cap when no per-workspace override is set. */
const DEFAULT_WORKSPACE_DAILY_CAP = 100;

function todayStart(): Date {
  // UTC — see shared/timeWindows.ts. A send cap must not roll over at an hour
  // that depends on the host's timezone.
  return utcDayStart();
}

/** Count drafts dispatched today by a single sending account. */
export async function getAccountSentToday(
  accountId: number,
  workspaceId: number,
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const [row] = await db
    .select({ cnt: sql<number>`COUNT(*)` })
    .from(emailDrafts)
    .where(
      and(
        eq(emailDrafts.workspaceId, workspaceId),
        eq(emailDrafts.sendingAccountId, accountId),
        eq(emailDrafts.status, "sent"),
        sql`${emailDrafts.sentAt} >= ${todayStart()}`,
      ),
    );
  return Number(row?.cnt ?? 0);
}

/**
 * Count drafts this account dispatched in the last rolling hour.
 *
 * A rolling window, not a clock hour: an account capped at 6/hour should not
 * be able to send 6 at 10:59 and 6 more at 11:01, which is a 12-in-two-minutes
 * burst — exactly the pattern the limit exists to prevent.
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
    .from(emailDrafts)
    .where(
      and(
        eq(emailDrafts.workspaceId, workspaceId),
        eq(emailDrafts.sendingAccountId, accountId),
        eq(emailDrafts.status, "sent"),
        sql`${emailDrafts.sentAt} >= ${since}`,
      ),
    );
  return Number(row?.cnt ?? 0);
}

/** Count drafts dispatched today across the entire workspace. */
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
