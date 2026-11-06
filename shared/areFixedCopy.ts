/**
 * Fixed-copy steps on a Revenue Engine campaign (audit 2026-10-20, A47).
 *
 * The engine spaces every step by the campaign's step gap (first send + k ×
 * stepGapDays), and the sequence writer drops a step with no subject and no
 * body. So a per-step "day" typed into Settings did nothing, and a campaign
 * saved with no usable step failed every prospect's sequence. Settings shows
 * the day the engine will use, and an empty fixed campaign cannot be saved.
 */

/** Steps the sequence writer would keep: a subject or a body. */
export function usableFixedSteps(steps: unknown): number {
  if (!Array.isArray(steps)) return 0;
  return steps.filter((s) => {
    const x = (s ?? {}) as Record<string, unknown>;
    return String(x.subject ?? "").trim() !== "" || String(x.body ?? "").trim() !== "";
  }).length;
}

/** The day step `index` goes out, counted from the first send, as the engine spaces it. */
export function fixedStepDay(index: number, gapDays: number): number {
  return index * gapDays;
}

export const EMPTY_FIXED_COPY = "A fixed-copy campaign needs at least one step with a subject or a body.";
