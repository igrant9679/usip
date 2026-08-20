/**
 * areStepCadence.ts — the ONE rule for WHEN a campaign's steps go out.
 *
 * Owner directive 2026-08-19: "make all of the current sequence steps
 * automatically 1 week apart." Until now the gap between steps was whatever
 * `day` the Sequence Agent wrote into each prospect's generated sequence, with
 * DEFAULT_STEP_GAP_DAYS only a fallback for steps that carried no day. That
 * made the cadence a property of each generated JSON blob — 141 in-flight
 * CommunityForce prospects still carried the pre-08-17 rhythm (gaps of 1–4
 * days) while the default said 7.
 *
 * Now the CAMPAIGN owns the cadence (`are_campaigns.stepGapDays`, default 7,
 * migration 0169), and two callers apply this one function:
 *
 *  - enrolment (areEngine): the k-th step of a prospect's sequence is due at
 *    `anchor + k × gap`, where `anchor` is the prospect's FIRST send if any
 *    step has gone, else now;
 *  - re-spacing (are.campaigns.respaceSteps): pending rows of an in-flight
 *    prospect are moved onto the same grid, anchored the same way, sent rows
 *    untouched.
 *
 * Never in the past: a step whose slot has already gone is due now, not
 * overdue-and-dispatched-in-a-burst.
 */
import { DEFAULT_STEP_GAP_DAYS } from "./areSequenceSteps";

export const MIN_STEP_GAP_DAYS = 1;
export const MAX_STEP_GAP_DAYS = 30;

/** Ceiling for a per-prospect timeline offset (0170) — a year out is a typo. */
export const MAX_TIMELINE_DAY_OFFSET = 365;
/** More positions than any sequence the generator can produce. */
export const MAX_TIMELINE_STEPS = 20;

const DAY_MS = 86_400_000;

/** The campaign's cadence, clamped to the allowed range; null/undefined → default. */
export function effectiveStepGapDays(stepGapDays: number | null | undefined): number {
  const n = typeof stepGapDays === "number" && Number.isFinite(stepGapDays) ? Math.round(stepGapDays) : DEFAULT_STEP_GAP_DAYS;
  return Math.min(MAX_STEP_GAP_DAYS, Math.max(MIN_STEP_GAP_DAYS, n));
}

/** When a step `dayOffset` days after the anchor is due — floored at now. */
export function dueAtForDay(anchorMs: number, dayOffset: number, nowMs: number): Date {
  return new Date(Math.max(anchorMs + dayOffset * DAY_MS, nowMs));
}

/** When the k-th step (0-based position in the prospect's ordered sequence) is due. */
export function dueAtForPosition(anchorMs: number, position: number, gapDays: number, nowMs: number): Date {
  return dueAtForDay(anchorMs, position * gapDays, nowMs);
}

/**
 * Per-prospect timeline override (migration 0170,
 * `prospect_intelligence.cadenceDayOffsets`): cumulative day offsets for the
 * prospect's ordered steps, set by the mass timeline editor on the campaign's
 * Sequences tab. Position-aligned with the ordered sequence — NOT keyed by
 * stepIndex — because scheduling has always been positional (enrolment counts
 * sent steps into the position, respace orders live rows the same way).
 *
 * This is the ONE reader of the stored value. It normalises rather than
 * trusting (sequence-step lesson: a `??` default hides producer drift): every
 * entry must be a finite number; entries are rounded, clamped to
 * [0, MAX_TIMELINE_DAY_OFFSET], and forced non-decreasing (a timeline that
 * goes backwards is a typo, not a schedule). Anything else → null, meaning
 * "no override — campaign cadence".
 */
export function sanitizeDayOffsets(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TIMELINE_STEPS) return null;
  const out: number[] = [];
  let floor = 0;
  for (const v of raw) {
    const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;
    if (Number.isNaN(n)) return null;
    floor = Math.max(floor, Math.min(MAX_TIMELINE_DAY_OFFSET, Math.max(0, n)));
    out.push(floor);
  }
  return out;
}

/**
 * The day offset of the k-th step under an optional per-prospect timeline.
 * Positions past the end of the override continue at the campaign gap from
 * the last listed offset, so a 7-step sequence with a 3-entry override still
 * schedules steps 4–7 instead of stacking them on step 3's day.
 */
export function dayOffsetForPosition(offsets: number[] | null | undefined, position: number, gapDays: number): number {
  if (!offsets || offsets.length === 0) return position * gapDays;
  if (position < offsets.length) return offsets[position];
  return offsets[offsets.length - 1] + (position - (offsets.length - 1)) * gapDays;
}

export interface CadenceRow {
  id: number;
  stepIndex: number;
  status: string;
  scheduledAt: Date | string;
  executedAt?: Date | string | null;
}

export interface RespaceChange {
  id: number;
  stepIndex: number;
  from: Date;
  to: Date;
}

/**
 * Plan the re-spacing of ONE prospect's rows. Order = stepIndex ascending
 * over the live rows (sent + scheduled); skipped/failed rows are not part of
 * the conversation. Anchor = earliest sent executedAt, else the earliest
 * scheduled time (so a never-touched prospect keeps its first slot), else now.
 * Returns only the scheduled rows whose time changes.
 *
 * `dayOffsets` (0170): the prospect's timeline override, already sanitised.
 * A campaign-level respace passes it through so re-anchoring PRESERVES a
 * per-prospect rhythm the user set on purpose — override supremacy, same as
 * the brand reconciler. Clearing an override is the mass timeline editor's
 * explicit "campaign cadence" mode, never a side effect of a respace.
 */
export function planRespaceForProspect(rows: CadenceRow[], gapDays: number, nowMs: number, dayOffsets?: number[] | null): RespaceChange[] {
  const live = rows
    .filter((r) => r.status === "sent" || r.status === "scheduled")
    .sort((a, b) => a.stepIndex - b.stepIndex);
  if (live.length === 0) return [];
  const sentTimes = live
    .filter((r) => r.status === "sent" && r.executedAt)
    .map((r) => new Date(r.executedAt as Date | string).getTime())
    .filter((t) => Number.isFinite(t));
  const firstScheduled = live
    .filter((r) => r.status === "scheduled")
    .map((r) => new Date(r.scheduledAt).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0];
  const anchor = sentTimes.length ? Math.min(...sentTimes) : (firstScheduled ?? nowMs);
  const changes: RespaceChange[] = [];
  live.forEach((r, position) => {
    if (r.status !== "scheduled") return;
    const to = dueAtForDay(anchor, dayOffsetForPosition(dayOffsets ?? null, position, gapDays), nowMs);
    const from = new Date(r.scheduledAt);
    if (Math.abs(to.getTime() - from.getTime()) >= 60_000) changes.push({ id: r.id, stepIndex: r.stepIndex, from, to });
  });
  return changes;
}
