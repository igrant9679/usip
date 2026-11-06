/**
 * What a Revenue Engine auto-approve threshold means, said one way on every
 * screen (audit 2026-10-20, A16).
 *
 * An unset threshold read "Disabled" on ARE Settings, "Off (manual review)" on
 * the campaign page and 60 in the New Campaign wizard, while Full Auto
 * approved at 70 and rejected below it. Now unset means off everywhere: the
 * engine (areEngine.approveLineFor) approves nobody without a threshold, and
 * only Full Auto has one. With a threshold, Full Auto approves at or above it
 * and rejects below it, and the copy says both halves.
 */

/** Where the Enable button starts a threshold. A choice, never a default. */
export const APPROVE_THRESHOLD_START = 70;

/** One line for a threshold's state, as the settings screens show it. */
export function approveThresholdSummary(threshold: number | null | undefined): string {
  return threshold == null
    ? "Off: nothing is approved automatically, so every prospect waits for you"
    : `Approve at or above ${threshold}, reject below`;
}

/** What the threshold does, for the card that sets it. */
export const APPROVE_THRESHOLD_EXPLAINER =
  "Used only by Fully autonomous campaigns. Prospects whose ICP match score is at or above it are approved, " +
  "sequenced and sent with no review; prospects below it are rejected (you can see and restore them on the " +
  "Rejections tab). Off means nothing is approved automatically.";
