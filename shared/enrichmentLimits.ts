/**
 * Bounds on the backlog enrichment sweep, in ONE place.
 *
 * The ceiling used to be the literal `500`, written three times: the zod input
 * on `prospects.setSweepSettings`, the per-query row limit in the domain pass,
 * and the run cap in `sweepWorkspace`. Three copies of a limit is how the
 * setting accepts 1000 while the engine quietly clamps to 500 — a control that
 * reports success and does nothing, which is the defect class this repo keeps
 * finding. Raising the ceiling is now one edit.
 *
 * ⚠️ THE CEILING IS NOT A BUDGET. Every swept prospect that reaches the email
 * pass spends Reoon credits (workspace BYOK key), so 1000/day is ~20,000
 * verifications a month. The DOMAIN pass is free — Apollo organization search
 * costs nothing — but the email pass is real money. The sweep also stops early
 * when the Reoon daily balance runs out, so a high cap is a permission rather
 * than a promise.
 */
export const SWEEP_DAILY_CAP_MIN = 1;

/**
 * Raised from 500 on 2026-08-02 at the owner's request, to make a
 * ~1000-per-weekday cleaning run reachable.
 *
 * The LinkedIn company pass is NOT governed by this — it has its own,
 * much lower ceiling (`companyBackfillDailyCap`, max 100) because it spends
 * the connected LinkedIn account's own lookup allowance rather than credits
 * you can top up. One switch over two different budgets is how someone ends
 * up surprised, which is why they were separated in the first place.
 */
export const SWEEP_DAILY_CAP_MAX = 1000;

/** Unchanged: a workspace that never touches the setting sweeps modestly. */
export const SWEEP_DAILY_CAP_DEFAULT = 50;

/** Clamp any caller-supplied limit into the supported range. */
export function clampSweepCap(limit: number | null | undefined): number {
  const n = Number(limit);
  if (!Number.isFinite(n)) return SWEEP_DAILY_CAP_DEFAULT;
  return Math.max(SWEEP_DAILY_CAP_MIN, Math.min(SWEEP_DAILY_CAP_MAX, Math.floor(n)));
}
