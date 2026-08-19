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

const DAY_MS = 86_400_000;

/** The campaign's cadence, clamped to the allowed range; null/undefined → default. */
export function effectiveStepGapDays(stepGapDays: number | null | undefined): number {
  const n = typeof stepGapDays === "number" && Number.isFinite(stepGapDays) ? Math.round(stepGapDays) : DEFAULT_STEP_GAP_DAYS;
  return Math.min(MAX_STEP_GAP_DAYS, Math.max(MIN_STEP_GAP_DAYS, n));
}

/** When the k-th step (0-based position in the prospect's ordered sequence) is due. */
export function dueAtForPosition(anchorMs: number, position: number, gapDays: number, nowMs: number): Date {
  return new Date(Math.max(anchorMs + position * gapDays * DAY_MS, nowMs));
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
 */
export function planRespaceForProspect(rows: CadenceRow[], gapDays: number, nowMs: number): RespaceChange[] {
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
    const to = dueAtForPosition(anchor, position, gapDays, nowMs);
    const from = new Date(r.scheduledAt);
    if (Math.abs(to.getTime() - from.getTime()) >= 60_000) changes.push({ id: r.id, stepIndex: r.stepIndex, from, to });
  });
  return changes;
}
