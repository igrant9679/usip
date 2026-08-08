/**
 * When is a sequence actually FINISHED?
 *
 * Deliberately a pure module with zero imports, so the decision is testable
 * without loading the engine (the shouldContinue pattern).
 *
 * WHY IT EXISTS: "completed" used to mean only "no steps still scheduled".
 * On 2026-08-08 a campaign was reactivated after three weeks paused, its
 * every overdue email step failed "Prospect has no email address" within the
 * hour, and the completion sweep marked all 17 prospects completed — which
 * permanently disarmed the self-heal, because healing requires
 * `sequenceStatus = "enrolled"`. The heal was BUILT for exactly those steps
 * (no email at send time, email found later), and lost the race to the
 * completion marker. Verified emails arrived the next day and nothing would
 * ever use them.
 *
 * The rule now: a sequence that sent NOTHING and still holds revivable steps
 * is not finished — it never started. It stays enrolled so the heal keeps
 * watching. A zero-send sequence with nothing revivable (e.g. every step was
 * a LinkedIn step the v1 engine cannot send) completes as before: leaving it
 * open would watch for a recovery that cannot happen.
 */

/**
 * The two auto-healable failure classes — ONE definition, consumed by the
 * dispatch heal, the completion verdict's counting query, and the fail-site
 * writes' guards. The heal and the completion sweep disagreeing about what
 * "revivable" means is precisely how the lockout happened.
 */
export const HEALABLE_NO_EMAIL = "Prospect has no email address";
export const HEALABLE_POOL_PREFIX = "Pool send failed:";

export function sequenceCompletionVerdict(counts: {
  /** All execution rows for the prospect. */
  total: number;
  /** Rows still status "scheduled". */
  stillScheduled: number;
  /** Rows sent. */
  sent: number;
  /** Rows failed with one of the two healable reasons. */
  healableFailed: number;
}): boolean {
  if (counts.total === 0) return false;          // nothing ever enqueued
  if (counts.stillScheduled > 0) return false;   // still work to do
  // Zero sends + revivable steps = a sequence that never started, not one
  // that finished. Completing it here is what disarmed the heal.
  if (counts.sent === 0 && counts.healableFailed > 0) return false;
  return true;
}
