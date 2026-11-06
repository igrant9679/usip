/**
 * retryBackoff.ts — how long a prospect waits after a failed enrichment or
 * sequence generation (audit 2026-10-20, A7/A27/A28).
 *
 * Both used to be retried on every engine tick. A row that kept failing sat
 * at the head of its page — five global enrichment slots, three generation
 * slots per campaign — so the rows behind it never got a turn. Now each
 * failure counts (`enrichAttempts` / `sequenceAttempts`, migration 0245) and
 * the next try waits 10 minutes, doubling, at most six hours.
 */

/** Failed enrichments after which a still-pending prospect is rejected, with the reason. */
export const ENRICH_MAX_ATTEMPTS = 3;

/** How long after the `attempts`-th failure the next try may start. */
export function retryBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(10 * 60_000 * 2 ** (attempts - 1), 6 * 60 * 60_000);
}

/** When the next try may start, after the `attempts`-th failure. */
export function retryAt(attempts: number, nowMs = Date.now()): Date {
  return new Date(nowMs + retryBackoffMs(attempts));
}
