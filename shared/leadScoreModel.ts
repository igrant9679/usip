/**
 * The lead score's shape, one rule for the server and the Lead Scoring page
 * (audit 2026-10-20, P22, P116).
 *
 * The page said "Default 40 + 30 + 30 = 100" and drew the behavioural bar out
 * of 30, while the scorer let behaviour reach 75 (opens 15 + clicks 20 + a
 * reply 25 + five steps at 3). Rescaling behaviour down to 30 would have moved
 * every stored score, so the copy and the bars follow the math instead: each
 * component's maximum is what the scorer can really give, and the total is
 * capped at 100.
 */

export type ScoreWeights = {
  firmoOrgTypeWeight: number;
  firmoTitleWeight: number;
  firmoCompletenessWeight: number;
  behavOpenMax: number;
  behavClickMax: number;
  behavReplyPoints: number;
  behavStepPoints: number;
  aiFitMax: number;
};

/** Sequence steps that count toward the behavioural maximum. */
export const BEHAV_STEPS_IN_MAX = 5;

export function behavioralMax(cfg: Pick<ScoreWeights, "behavOpenMax" | "behavClickMax" | "behavReplyPoints" | "behavStepPoints">): number {
  return cfg.behavOpenMax + cfg.behavClickMax + cfg.behavReplyPoints + cfg.behavStepPoints * BEHAV_STEPS_IN_MAX;
}

/** Each component's ceiling, and their sum before the total's cap of 100. */
export function componentMaxes(cfg: ScoreWeights): { firmographic: number; behavioral: number; aiFit: number; sum: number } {
  const firmographic = cfg.firmoOrgTypeWeight + cfg.firmoTitleWeight + cfg.firmoCompletenessWeight;
  const behavioral = behavioralMax(cfg);
  return { firmographic, behavioral, aiFit: cfg.aiFitMax, sum: firmographic + behavioral + cfg.aiFitMax };
}

export type TierThresholds = { tierWarmMin: number; tierHotMin: number; tierSalesReadyMin: number };

/**
 * Why a set of tier thresholds can't be saved, or null. Warm, Hot and Sales
 * Ready must climb, and Warm must leave Cold some room: out of order, a lead
 * lands in a tier its score is below (P116).
 */
export function tierThresholdProblem(t: TierThresholds): string | null {
  if (t.tierWarmMin < 1) return "The Warm threshold must be at least 1, so Cold has a range.";
  if (t.tierHotMin <= t.tierWarmMin) return "The Hot threshold must be above the Warm threshold.";
  if (t.tierSalesReadyMin <= t.tierHotMin) return "The Sales-Ready threshold must be above the Hot threshold.";
  if (t.tierSalesReadyMin > 100) return "The Sales-Ready threshold can be at most 100.";
  return null;
}

/**
 * The four tier bands across scores 0-100. Each width is the band's share of
 * the 101 possible scores, so the bands fill the bar exactly; a band's last
 * score plus one, taken as a percentage, gave 101%.
 */
export function tierBands(t: TierThresholds): Array<{ name: string; min: number; max: number; widthPct: number }> {
  const bands = [
    { name: "Cold", min: 0, max: t.tierWarmMin - 1 },
    { name: "Warm", min: t.tierWarmMin, max: t.tierHotMin - 1 },
    { name: "Hot", min: t.tierHotMin, max: t.tierSalesReadyMin - 1 },
    { name: "Sales Ready", min: t.tierSalesReadyMin, max: 100 },
  ];
  return bands.map((b) => ({ ...b, widthPct: (Math.max(0, b.max - b.min + 1) / 101) * 100 }));
}
