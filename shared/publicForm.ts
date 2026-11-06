/**
 * The public capture forms' shared rules (audit 2026-10-20, G41), read by the
 * pages that render them and the procedures that take their submissions.
 */

/**
 * A field people never see and bots fill in: rendered off-screen, out of the
 * tab order and hidden from screen readers. A submission with anything in it
 * is answered as a success and kept nowhere. Named so it can't collide with a
 * field an admin defines (field keys are plain words like "email").
 */
export const HONEYPOT_FIELD = "hp_website";

/** Longest value kept for one field. A message field is the longest legitimate one. */
export const MAX_FIELD_VALUE = 5000;
/** Most keys a submission may carry; a form has at most a dozen fields. */
export const MAX_SUBMISSION_KEYS = 40;
