/**
 * usage_counters — the per-workspace, per-month figures behind Settings → Billing.
 *
 * Both columns were READ by `usage.currentMonth` and rendered on that panel,
 * and NEITHER WAS EVER WRITTEN. There was no `insert(usageCounters)` anywhere
 * in the server, so both tiles reported 0 for every workspace forever:
 * measurements never taken, presented as ones that were (the 96b161d shape).
 *
 * `llmTokens` was wired first (a1c1f99). This module exists because the second
 * counter needed the identical upsert, and a second copy of it is how the two
 * drift — one gets a fix the other does not. One atomic increment, two callers.
 *
 * NOT to be confused with `sendingAccountDailyStats.sentCount`, which counts
 * sends PER ACCOUNT PER DAY to enforce `dailySendLimit`. Different grain,
 * different purpose, and it already exists.
 */
import { sql } from "drizzle-orm";
import { usageCounters } from "../drizzle/schema";
import { getDb } from "./db";

/** The month key. UTC, and identical to the one `usage.currentMonth` reads. */
export function usageMonthKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Add `n` to one counter for this workspace's current month.
 *
 * ATOMIC — `col = col + n` in SQL, never read-modify-write. Concurrent sends
 * and parallel LLM calls are both normal here, and a lost update on a usage
 * counter is a bill nobody can reconcile. (`sendingAccountDailyStats` learned
 * this already; its comment says so.)
 *
 * BEST EFFORT — a broken counter is a reporting problem, a thrown counter is
 * an outage on whatever it was measuring. Never rethrows.
 */
async function bump(
  workspaceId: number | undefined,
  column: "llmTokens" | "emailsSent",
  n: number,
): Promise<void> {
  if (!workspaceId || !Number.isFinite(n) || n <= 0) return;
  const amount = Math.round(n);
  try {
    const db = await getDb();
    if (!db) return;
    const month = usageMonthKey();
    const col = usageCounters[column];
    await db
      .insert(usageCounters)
      .values({ workspaceId, month, [column]: amount } as never)
      .onDuplicateKeyUpdate({ set: { [column]: sql`${col} + ${amount}` } as never });
  } catch (e) {
    console.error(
      `[usage] failed to record ${amount} ${column} for workspace ${workspaceId}:`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Tokens consumed by one LLM call. Called from the invokeLLM funnel. */
export async function recordLlmTokens(workspaceId: number | undefined, tokens: number): Promise<void> {
  return bump(workspaceId, "llmTokens", tokens);
}

/**
 * Messages that actually left. Called from the three transmission points and
 * NOWHERE ELSE — counting at an orchestration layer as well would double-count
 * every send that reaches transmission through it:
 *
 *   1. the adapter factory's `sendEmail` (covers all 3 adapters, 11 call sites)
 *   2. sendWorkspaceEmail's raw SMTP-config branch
 *   3. operations.sendScheduleNow's raw transporter
 *
 * `sendSystemEmail` and `sendCampaignEmailViaPool` are orchestrators: each
 * reaches transmission through exactly one of the above, so they count once
 * without knowing anything about counting.
 *
 * Only SUCCESSFUL sends. A throw means nothing was delivered, and the caller
 * never reaches the increment.
 */
export async function recordEmailsSent(workspaceId: number | undefined, count = 1): Promise<void> {
  return bump(workspaceId, "emailsSent", count);
}
