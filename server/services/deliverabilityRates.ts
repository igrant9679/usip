/**
 * deliverabilityRates.ts — per-mailbox bounce and spam rates, DERIVED at read time.
 *
 * `sending_accounts.bounceRate` / `.spamRate` (varchar(10) NOT NULL DEFAULT '0')
 * have no writer anywhere in the product, and `reputationTier` had exactly one:
 * a testConnection line that fed it that same hardcoded '0'. So every mailbox
 * has reported "0% bounce · Excellent" since Feature 64 shipped, on the three
 * surfaces an operator checks BEFORE scaling volume (audit 2026-09-20).
 *
 * Derived, not stored. drizzle/schema.ts:851-857 already names the stored-copy
 * pattern as what produced are_ab_variants' dead columns, and a cron writing
 * these would need archived-workspace gating and a backfill to say nothing a
 * live query cannot.
 *
 * DENOMINATOR PROVENANCE. `email_log`, because it is the only table every
 * account-attributed transmission writes (migration 0163) — the same reason
 * sendLimits.accountsSentToday counts it. Deliberately NOT
 * `sending_account_daily_stats`, whose sentCount only emailDelivery's pool path
 * increments, and NOT `email_drafts`, which an ARE campaign send never writes.
 * Dividing by drafts understates a campaign-heavy workspace by most of its
 * volume — the same shape as the denominator bug noted at smtpConfig.ts:750-754.
 *
 * KNOWN LIMITS, stated here rather than discovered later:
 *   • email_suppressions carries no sendingAccountId, so an address two
 *     mailboxes both wrote to before it bounced is charged to BOTH. Per-mailbox
 *     rates therefore do not sum to a workspace figure.
 *   • smtpConfig.sendApproved sends through the workspace transporter, writes no
 *     email_log row and stamps no sending account, so these rates also will not
 *     reconcile with EmailAnalytics' workspace bounce figure.
 *   • ARE-ingested bounce signals land in are_suppression_list, not
 *     email_suppressions; the provider webhook (emailTracking.ts) is the path
 *     that shows up here.
 *   • Warmup mail is correctly outside both sides: warmupEngine sends through
 *     its own transporter and writes no email_log row at all.
 *
 * No module-scope side effects on purpose — server/sendingInfrastructure.test.ts
 * imports the router that imports this, so `db` arrives as a parameter and
 * getDb is never called here.
 */
import { sql } from "drizzle-orm";
import type { getDb } from "../db";
import { confidenceFromSample, type Confidence } from "./optimization/types";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Recipients a mailbox must have reached in the window before a rate is shown.
 * Shaped like the hard floors this codebase already draws — MIN_STEP_SAMPLE = 30
 * and MIN_SOURCE_SAMPLE = 25 in services/optimization/types.ts. Below it the
 * answer is null, never 0: "no evidence" and "no bounces" are different claims,
 * and printing the second for the first is the bug this module exists to end.
 */
export const MIN_DELIVERABILITY_RECIPIENTS = 50;
export const DELIVERABILITY_WINDOW_DAYS = 30;

export type ReputationTier = "excellent" | "good" | "fair" | "poor";

/**
 * Derive reputation tier from bounce rate (0–1 FRACTION, not a percent).
 * < 2%  → excellent
 * < 5%  → good
 * < 10% → fair
 * ≥ 10% → poor
 *
 * Lives here rather than in routers/sendingAccounts.ts (where it shipped)
 * because the router imports this module; the router re-exports it so its
 * original import path still resolves.
 */
export function reputationTierFromRate(bounceRate: number): ReputationTier {
  if (bounceRate < 0.02) return "excellent";
  if (bounceRate < 0.05) return "good";
  if (bounceRate < 0.10) return "fair";
  return "poor";
}

export type AccountRates = {
  accountId: number;
  /** FRACTION 0–1. Null means "not enough recipients to say", never "zero". */
  bounceRate: number | null;
  spamRate: number | null;
  tier: ReputationTier | null;
  recipients: number;
  bouncedRecipients: number;
  spamRecipients: number;
  confidence: Confidence;
  windowDays: number;
};

/**
 * Pure so the two ways this lies are testable without a database: a sample
 * under the floor must come back null rather than 0, and zero recipients must
 * not divide by zero.
 */
export function ratesFromCounts(
  accountId: number,
  recipients: number,
  bounced: number,
  spam: number,
): AccountRates {
  const enough = recipients >= MIN_DELIVERABILITY_RECIPIENTS;
  const bounceRate = enough ? bounced / recipients : null;
  return {
    accountId,
    bounceRate,
    spamRate: enough ? spam / recipients : null,
    tier: bounceRate === null ? null : reputationTierFromRate(bounceRate),
    recipients,
    bouncedRecipients: bounced,
    spamRecipients: spam,
    // The same ladder every optimisation analyzer draws its line on, so the
    // two cannot drift into disagreeing about what "high confidence" means.
    confidence: confidenceFromSample(recipients),
    windowDays: DELIVERABILITY_WINDOW_DAYS,
  };
}

/**
 * Bounce/spam counts per mailbox over the rolling window.
 *
 * Written out as one statement rather than assembled from builder fragments for
 * the reason areEngine gives for its own raw statements: a join whose tenancy
 * predicate cannot be read AT the statement is one edit away from losing it.
 *
 * Accounts with no rows in the window are ABSENT from the result — a caller
 * must treat a miss as ratesFromCounts(id, 0, 0, 0), not as an error.
 */
export async function deliverabilityRatesByAccount(
  db: Db,
  workspaceId: number,
  accountIds: number[],
): Promise<Map<number, AccountRates>> {
  const out = new Map<number, AccountRates>();
  // Drizzle emits invalid SQL for an empty IN list, and there is nothing to ask.
  if (accountIds.length === 0) return out;

  const since = new Date(Date.now() - DELIVERABILITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const ids = sql.join(accountIds.map((id) => sql`${id}`), sql`, `);

  const [rows] = await db.execute(sql`
    SELECT el.sendingAccountId                                                       AS accountId,
           COUNT(DISTINCT el.toEmail)                                                AS recipients,
           COUNT(DISTINCT CASE WHEN s.reason = 'bounce'         THEN el.toEmail END) AS bouncedRecipients,
           COUNT(DISTINCT CASE WHEN s.reason = 'spam_complaint' THEN el.toEmail END) AS spamRecipients
      FROM \`email_log\` el
      LEFT JOIN \`email_suppressions\` s
             ON s.workspaceId = el.workspaceId
            AND s.email       = LOWER(TRIM(el.toEmail))
            AND s.reason      IN ('bounce', 'spam_complaint')
            AND s.createdAt  >= el.sentAt
     WHERE el.workspaceId       = ${workspaceId}
       AND el.sendingAccountId IN (${ids})
       AND el.status            = 'sent'
       AND el.toEmail IS NOT NULL
       AND el.sentAt           >= ${since}
     GROUP BY el.sendingAccountId`);

  /* Four lines above are load-bearing:
   *
   * COUNT(DISTINCT el.toEmail) — RECIPIENTS, on BOTH sides. Never el.id, never
   *   COUNT(*). ix_sup_uniq is a PLAIN index (drizzle/0017_brief_ultragirl.sql),
   *   so one address can hold several 'bounce' rows, and a sequence writes to
   *   the same address four to six times before it dies. Counting messages
   *   charges that one bounce event to every earlier send and reports up to the
   *   sequence length times the real rate.
   *
   * s.workspaceId = el.workspaceId — in the ON clause, not just the WHERE.
   *   Without it the join reads every other tenant's suppression list; it is
   *   the only way this read becomes a security bug.
   *
   * LOWER(TRIM(el.toEmail)) — on the LOG side only, so `ix_sup_email` stays
   *   usable. Suppressions are stored already normalised
   *   (unsubscribe.normalizeSuppressionEmail); utf8mb4's default collation is
   *   case-insensitive but NO PAD, so TRIM is the half that matters and LOWER is
   *   belt-and-braces. The cost is that the optimiser can no longer drive from
   *   the (much smaller) suppression side through ix_elog_to.
   *
   * el.status = 'sent' — logSend writes failed rows too, and a message that
   *   never left must not be in the denominator.
   *
   * The scan is served by ix_elog_acct_sent (migration 0182), which batch 2 added
   * for the send budget over exactly this predicate. */

  const counted = rows as unknown as Array<{
    accountId: number | string | null;
    recipients: number | string | null;
    bouncedRecipients: number | string | null;
    spamRecipients: number | string | null;
  }>;
  // .forEach, not for-of: tsconfig declares no `target`, so this is ES5.
  counted.forEach((r) => {
    if (r.accountId == null) return;
    const id = Number(r.accountId);
    out.set(
      id,
      ratesFromCounts(
        id,
        Number(r.recipients) || 0,
        Number(r.bouncedRecipients) || 0,
        Number(r.spamRecipients) || 0,
      ),
    );
  });
  return out;
}
