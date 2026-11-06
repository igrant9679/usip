/**
 * Every cached read whose numbers change when somebody is enrolled, paused,
 * resumed or taken out of a sequence — invalidated together, in one place.
 *
 * Why this exists (2026-11-06). Five writers each invalidated a different
 * subset, and the subsets stopped matching the readers:
 *
 *   - `AddToMenu` and the People `SelectionToolbar` invalidated
 *     `getEnrollmentStats` alone — the query the v2 editor STOPPED using in
 *     PR #24, when its Contacts tab moved to `listEnrollments`. So enrolling
 *     from the People page left an open Contacts tab showing the old counts
 *     and the old list. The numbers were honest about what they read; what
 *     they read was stale.
 *   - Nothing invalidated `sequences.list` or `sequences.get` after a bulk
 *     enrol, and both carry `enrolledCount` (live-computed by
 *     `liveEnrolledCounts`) — so "N enrolled" on the Sequences list and in
 *     every picker lagged a write that had already happened.
 *   - Nothing invalidated `getPerformanceAnalytics` after a bulk enrol, and
 *     its `totalEnrolled` / `active` / `paused` / `exited` are enrolment
 *     counts: the Report tab PR #29 shipped would have shown the old ones.
 *
 * A subset is the failure mode, so the fix is not "add the missing line" at
 * each site — it is one function that names every enrolment-derived read, and
 * a guard that fails if a writer invalidates anything by hand instead.
 *
 * This does NOT wrap `onError`. A shared handler hid the error declaration
 * from `clientMutationErrors.test.ts` once already (PR #29, `b51fb4ab`);
 * every site keeps its own `onError` in its options object.
 */
import { trpc } from "@/lib/trpc";

type SequenceUtils = ReturnType<typeof trpc.useUtils>;

/**
 * @param sequenceId the sequence that was written to, when it is known. Left
 * out, every sequence's cached enrolment reads are invalidated — correct for
 * a caller that wrote to more than one, and never wrong, only broader.
 */
export function invalidateEnrollmentReads(utils: SequenceUtils, sequenceId?: number): void {
  const s = utils.sequences;

  // `enrolledCount` — the Sequences list, SequencesV2, EntityPicker, the
  // add-to menus. Live-computed per read, so it only needs re-reading.
  s.list.invalidate();
  s.get.invalidate(sequenceId != null ? { id: sequenceId } : undefined);

  // The rows themselves: the v2 editor's Contacts tab, and the per-step
  // distribution it counts off those same rows.
  s.listEnrollments.invalidate(sequenceId != null ? { sequenceId } : undefined);

  // Legacy /sequences' state strip and step bars.
  s.getEnrollmentStats.invalidate(sequenceId != null ? { sequenceId } : undefined);
  s.getEnrollmentStepStats.invalidate(sequenceId != null ? { sequenceId } : undefined);

  // totalEnrolled / active / paused / finished / exited on the Report tab,
  // Analytics, and legacy's analytics block. Keyed by date range as well as
  // sequence, so this invalidates the procedure rather than one input.
  s.getPerformanceAnalytics.invalidate();
}
