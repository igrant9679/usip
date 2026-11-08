/**
 * Why a deal was lost, asked when it is moved to Lost (audit 2026-10-20, F28).
 *
 * The reason could only be typed afterwards on the deal page, so almost no
 * lost deal had one. Every path that moves a deal to a lost stage now asks.
 * The question never blocks the move: a reason that is skipped is recorded as
 * "Not given", so a lost deal with no reason says it was not given rather
 * than looking like one nobody was asked about.
 */
export const LOST_REASON_NOT_GIVEN = "Not given";

/** The common answers, offered as one-click picks beside a free-text box. */
export const LOST_REASON_OPTIONS = [
  "Price",
  "Lost to a competitor",
  "No budget",
  "No decision / went dark",
  "Timing",
  "Product fit",
  "Chose to build in-house",
] as const;

/** The column holds 120 characters. */
export const LOST_REASON_MAX = 120;

/** The reason stored for a loss: what was typed, trimmed and capped, or "Not given". */
export function normalizeLostReason(reason: string | null | undefined): string {
  const r = String(reason ?? "").replace(/\s+/g, " ").trim().slice(0, LOST_REASON_MAX);
  return r || LOST_REASON_NOT_GIVEN;
}
