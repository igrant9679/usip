/**
 * areSequenceSteps.ts — the ONE rule for turning a stored ARE
 * `generatedSequence` into schedulable steps.
 *
 * This lived inside areEngine.ts, private and untested, while a SECOND opinion
 * about the same numbers sat in routers/are/prospects.ts: the A/B metadata
 * upsert wrote the opener's row at a hardcoded `stepIndex: 1` while the
 * execution-queue rows for that same opener were keyed by whatever the engine
 * derived here (0 for a 0-based sequence, which is what the campaign-skeleton
 * prompt asks the model for and what seedAreDemo uses).
 *
 * `getAbVariantStats` joins the two by `${stepIndex}:${variantKey}`, so the
 * mismatch had two silent effects at once: the opener's real cell — the one
 * holding every send — found no metadata and rendered with no subject line or
 * body preview, and the stored row minted a PHANTOM cell one step along,
 * showing the copy at 0 sends. One variant, two cards, neither complete.
 *
 * Rule going forward: anything that needs a step's index or variant key reads
 * it from here. A step index that is derived in two places is a join key that
 * agrees only by luck.
 */
import { normalizeVariantKey } from "./variantKeys";

export const ARE_STEP_CHANNELS = ["email", "linkedin", "sms", "voice"] as const;
export type AreStepChannel = (typeof ARE_STEP_CHANNELS)[number];

/**
 * Default spacing between consecutive sequence steps, in days. ONE definition:
 * the template generator's cadence rules and normalizeSequence's fallback both
 * read this, so the prompt cannot ask for one rhythm while the fallback
 * schedules another.
 *
 * Owner directive 2026-08-17: one week per step. The previous rhythm was
 * ~2 days (a "14-day total window" for seven steps), which is aggressive for
 * grants, scholarship and program-office audiences whose inboxes run on
 * committee and cycle time. A 7-step sequence now spans six weeks (days 0,
 * 7, 14, 21, 28, 35, 42).
 */
export const DEFAULT_STEP_GAP_DAYS = 7;

/** Cumulative day offset for the i-th step under the default cadence. */
export function defaultDayForStep(i: number): number {
  return i * DEFAULT_STEP_GAP_DAYS;
}

export interface NormalizedStep {
  stepIndex: number;
  channel: AreStepChannel;
  subject: string;
  body: string;
  variantKey: string;
  /** Cumulative day offset from enrollment for scheduling. */
  dayOffset: number;
}

/**
 * The index a step is keyed by everywhere: its own `stepIndex` when it has a
 * numeric one, the legacy seed shape's `step`, else its position.
 *
 * Deliberately tolerant of the model's output rather than assuming 0-based —
 * the queue row and the A/B metadata row must agree with EACH OTHER, which a
 * shared rule guarantees and an assumption does not.
 */
export function stepIndexOf(raw: unknown, position: number): number {
  const step = (raw ?? {}) as Record<string, unknown>;
  if (typeof step.stepIndex === "number") return step.stepIndex;
  if (typeof step.step === "number") return step.step;
  return position;
}

/**
 * Normalise a stored generatedSequence into schedulable steps. Handles both
 * the engine/agent shape ({stepIndex, day, channel, subject, body, variantKey})
 * and the older seed shape ({step, waitDays, channel, subject}).
 */
export function normalizeSequence(raw: unknown): NormalizedStep[] {
  if (!Array.isArray(raw)) return [];
  let cumulativeDay = 0;
  return raw.map((s, i) => {
    const step = (s ?? {}) as Record<string, unknown>;
    const ch = String(step.channel ?? "email").toLowerCase();
    const channel = (ARE_STEP_CHANNELS as readonly string[]).includes(ch)
      ? (ch as AreStepChannel)
      : "email";
    // `day` is a cumulative offset; `waitDays` is a gap from the previous step.
    let dayOffset: number;
    if (typeof step.day === "number") {
      dayOffset = step.day;
    } else {
      cumulativeDay += typeof step.waitDays === "number" ? step.waitDays : i === 0 ? 0 : DEFAULT_STEP_GAP_DAYS;
      dayOffset = cumulativeDay;
    }
    return {
      stepIndex: stepIndexOf(step, i),
      channel,
      subject: String(step.subject ?? ""),
      body: String(step.body ?? ""),
      // Normalised, not merely defaulted: this becomes the A/B tab's group-by
      // key and it arrives from an LLM never told what a variantKey is.
      variantKey: normalizeVariantKey(step.variantKey),
      dayOffset: Math.max(0, dayOffset),
    };
  });
}
