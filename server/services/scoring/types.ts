/**
 * Scoring system — shared types + constants (Velocity Priority Score).
 *
 * Apollo-style, explainable, configurable scoring. All numeric points are
 * integers in [-20, +20] per criterion; scores normalize to 0..100.
 */

export type ObjectType = "person" | "company";
export type Rating = "excellent" | "good" | "fair" | "not_a_fit";
export type CriterionType = "stackable" | "mutually_exclusive" | "negative" | "disqualifier";
export type ImpactMode = "label" | "numeric";
export type ModelStatus = "draft" | "active" | "archived";
export type ModelType = "auto" | "custom";

export type Operator =
  | "equals" | "not_equals"
  | "contains" | "not_contains"
  | "starts_with" | "ends_with"
  | "in" | "not_in"
  | "range"
  | "greater_than" | "greater_than_or_equal"
  | "less_than" | "less_than_or_equal"
  | "exists" | "not_exists"
  | "fuzzy_match" | "regex_match"
  | "date_within_last" | "date_older_than"
  | "score_above" | "score_below";

export const OPERATORS: Operator[] = [
  "equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with",
  "in", "not_in", "range", "greater_than", "greater_than_or_equal", "less_than",
  "less_than_or_equal", "exists", "not_exists", "fuzzy_match", "regex_match",
  "date_within_last", "date_older_than", "score_above", "score_below",
];

/** Label impact mode → points. */
export const IMPACT_LABEL_POINTS: Record<string, number> = {
  very_important: 20,
  important: 15,
  moderately_important: 10,
  lightly_important: 5,
  not_important: 0,
  negative_signal: -10,
  strong_negative: -20,
  disqualifier: 0, // hard-fail; points irrelevant
};

/** Priority Score component weights (must sum to 1.0). */
export const PRIORITY_WEIGHTS = {
  person_fit: 0.35,
  company_fit: 0.30,
  intent: 0.15,
  engagement: 0.10,
  data_quality: 0.05,
  sequence_readiness: 0.05,
} as const;

/** Default fit-model rating thresholds. */
export interface RatingThresholds {
  excellent_min: number;
  good_min: number;
  fair_min: number;
  not_fit_max: number;
}
export const DEFAULT_THRESHOLDS: RatingThresholds = {
  excellent_min: 80, good_min: 60, fair_min: 35, not_fit_max: 34,
};
/** Velocity Priority Score uses its own thresholds. */
export const PRIORITY_THRESHOLDS: RatingThresholds = {
  excellent_min: 85, good_min: 70, fair_min: 50, not_fit_max: 49,
};

export function ratingFor(normalized: number, t: RatingThresholds): Rating {
  if (normalized >= t.excellent_min) return "excellent";
  if (normalized >= t.good_min) return "good";
  if (normalized >= t.fair_min) return "fair";
  return "not_a_fit";
}

/** One evaluated criterion line for the explainable breakdown. */
export interface BreakdownLine {
  criterionId: number | null;
  groupName: string;
  fieldName: string;
  matched: boolean;
  pointsAwarded: number;
  /** matched (positive applied) · missed (positive not matched) · negative · disqualifier */
  kind: "matched" | "missed" | "negative" | "disqualifier";
  explanation: string;
  oldValue?: string | null;
  currentValue?: string | null;
}

/** Pure result of scoring an object against one model. */
export interface ScoreComputation {
  rawScore: number;
  maxPossibleScore: number;
  normalizedScore: number;
  rating: Rating;
  isDisqualified: boolean;
  disqualificationReasons: string[];
  breakdown: BreakdownLine[];
}

/** Component + blended Velocity Priority Score for an object. */
export interface PriorityComputation {
  personFitScore: number | null;
  companyFitScore: number | null;
  intentScore: number | null;
  engagementScore: number | null;
  dataQualityScore: number | null;
  sequenceReadinessScore: number | null;
  priorityScore: number;
  priorityRating: Rating;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
