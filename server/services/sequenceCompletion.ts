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

/**
 * What the sweep should do with a prospect whose steps are all settled.
 *
 * "completed" and "not completed" were the only two answers, and that is
 * how the second failure happened (2026-08-16): a sequence whose steps were
 * ALL skipped — canceled for regeneration, never re-enrolled — has zero
 * scheduled rows, so the old rule called it finished. 112 prospects were
 * marked `completed` with one step sent and six that never existed. That is
 * not a finished sequence; it is an abandoned one, and calling it complete
 * hides the abandonment behind the label for the best possible outcome.
 */
export type CompletionVerdict = "completed" | "abandoned" | null;
// NOTE: `abandoned` maps to prospect_queue.sequenceStatus = "canceled" at the
// write site — that enum value already exists and is the honest word for
// "the steps were canceled". No new enum value, no migration.

export function sequenceCompletionVerdict(counts: {
  /** All execution rows for the prospect. */
  total: number;
  /** Rows still status "scheduled". */
  stillScheduled: number;
  /** Rows sent. */
  sent: number;
  /** Rows failed with one of the two healable reasons. */
  healableFailed: number;
  /** Rows skipped (canceled, suppressed, throttled-and-abandoned). Optional
   *  only so older callers keep compiling; the engine always passes it. */
  skipped?: number;
}): CompletionVerdict {
  if (counts.total === 0) return null;            // nothing ever enqueued
  if (counts.stillScheduled > 0) return null;     // still work to do
  // Zero sends + revivable steps = a sequence that never started, not one
  // that finished. Completing it here is what disarmed the heal.
  if (counts.sent === 0 && counts.healableFailed > 0) return null;
  // Every step settled, but the SKIPPED steps outnumber the sent ones: the
  // sequence was cut short, not carried through. "completed" is the word for
  // a prospect who received the cadence; this one did not. Reporting it
  // honestly is what lets a person see that 112 prospects need re-enrolling
  // instead of reading a healthy-looking funnel.
  const skipped = counts.skipped ?? 0;
  if (skipped > 0 && skipped > counts.sent) return "abandoned";
  return "completed";
}
