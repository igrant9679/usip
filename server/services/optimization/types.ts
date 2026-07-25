/**
 * The analyzer contract for the continuous-optimisation layer.
 *
 * Every module (sequences, messaging, sourcing, voice, CRM, ICP, SDR coaching)
 * plugs in through this ONE interface, so adding a module later means writing an
 * analyzer — not another bespoke pipeline, another store, and another UI.
 *
 * Non-negotiable rules for any analyzer:
 *
 *   • Return NOTHING when the data is too thin. "Insufficient data" is not a
 *     recommendation — an empty result is the correct, honest output. This is
 *     the guard against the system confidently optimising on noise, which is
 *     the primary failure mode of a self-tuning product.
 *   • `proposedValue` must be a patch code can APPLY. Prose advice can never be
 *     auto-applied and must not pretend it can.
 *   • Always populate `evidence` + `sampleSize`. A proposal without them is an
 *     opinion wearing a number's clothes.
 *   • Analyzers only PROPOSE. They never mutate the thing they're analysing —
 *     applying is a separate, explicitly-gated step.
 */

export type OptimizationModule =
  | "sequences" | "messaging" | "sourcing" | "voice" | "crm" | "icp" | "sdr_coaching";

export type ScopeType = "global" | "campaign" | "sequence" | "source" | "step";

export type Confidence = "low" | "medium" | "high";

export interface Proposal {
  module: OptimizationModule;
  scopeType: ScopeType;
  scopeId: number | null;
  scopeLabel: string | null;
  /** Stable machine key for the proposal type, e.g. `retire_dead_step`. */
  kind: string;
  title: string;
  rationale: string;
  /** What the claim rests on: the metric, its value, and what it's compared to. */
  evidence: Record<string, unknown>;
  sampleSize: number;
  confidence: Confidence;
  /** The value being replaced — needed for a real diff and for revert. */
  currentValue: Record<string, unknown> | null;
  /** Machine-applicable patch. Null ONLY for advisory-by-nature proposals. */
  proposedValue: Record<string, unknown> | null;
  generatedBy?: "rules" | "llm";
}

export interface Analyzer {
  module: OptimizationModule;
  /** Human name, used in logs and the "last analysed" UI. */
  name: string;
  /** Produce proposals for a workspace. Must return [] rather than guess. */
  run(workspaceId: number): Promise<Proposal[]>;
}

/* ─── Shared statistical gates ──────────────────────────────────────────────
 * Centralised so every analyzer draws its lines in the same place, and so
 * tightening the rules later is a one-line change rather than an audit.
 * ────────────────────────────────────────────────────────────────────────── */

/** Minimum sends before a step's performance is worth acting on. */
export const MIN_STEP_SAMPLE = 30;
/** Minimum contacted prospects before judging a source. */
export const MIN_SOURCE_SAMPLE = 25;

/**
 * Confidence from sample size alone — deliberately conservative.
 *
 * Nothing reaches `high` below 200 observations. An analyzer may lower a
 * proposal's confidence beyond this, but should not raise it: a small sample is
 * a small sample no matter how large the effect looks.
 */
export function confidenceFromSample(n: number): Confidence {
  if (n >= 200) return "high";
  if (n >= 75) return "medium";
  return "low";
}
