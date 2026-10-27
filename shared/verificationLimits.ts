/**
 * How much Reoon verification one action may start (audit 2026-10-20, P10).
 *
 * "Verify" with nothing selected used to send every contact in the workspace
 * to Reoon in one task, open to any member, as often as they clicked. One job
 * now carries at most this many addresses, and a workspace runs one job at a
 * time. The Contacts dialog reads the same number to say so before the click.
 */
export const BULK_VERIFY_MAX = 5000;

/** A job still "running" after this long is presumed lost and no longer blocks a new one. */
export const VERIFY_JOB_STALE_MS = 24 * 60 * 60 * 1000;
