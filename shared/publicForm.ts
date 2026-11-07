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

/**
 * A capture page's conversion rate (audit 2026-10-20, F47: views and
 * submissions were shown side by side, and the rate was left to the reader).
 * Views count once per visitor per day and began on a known date (landing
 * pages under L12, forms under F47), while submissions were always counted,
 * so a page can have more submissions than counted views. That is shown as no
 * rate, with the reason, rather than as 140%.
 */
export function conversionRate(views: number | null | undefined, submits: number | null | undefined): { rate: number | null; label: string; title: string } {
  const v = Math.max(0, Number(views ?? 0) || 0);
  const s = Math.max(0, Number(submits ?? 0) || 0);
  if (v === 0) return { rate: null, label: "—", title: s ? `${s} submissions, no views counted yet` : "No views yet" };
  if (s > v) return { rate: null, label: "—", title: `${s} submissions from ${v} counted views: views were not counted for the whole period` };
  const rate = (s / v) * 100;
  const label = `${rate >= 10 || rate === 0 ? Math.round(rate) : Math.round(rate * 10) / 10}%`;
  return { rate, label, title: `${s} submissions from ${v} views` };
}
