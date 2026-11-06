/**
 * The one reading of a customer's health score (audit 2026-10-20, R58).
 *
 * The server tiered a score at 75 / 55 / 35 (healthy · watch · at_risk ·
 * critical) while the Customers page drew its churn-risk banner from its own
 * 45 / 65 cut-offs and coloured a tier list ("thriving", "neutral") the enum
 * never holds, so a "watch" customer showed an uncoloured pill and the same
 * score could be "watch" in the table and "high churn risk" beside it. Every
 * reader now takes the tier, the churn risk and the colour from here.
 */

export type HealthTier = "healthy" | "watch" | "at_risk" | "critical";
export type ChurnRisk = "low" | "medium" | "high";

/** Lowest score in each tier, highest tier first. */
export const HEALTH_TIER_FLOORS: ReadonlyArray<readonly [HealthTier, number]> = [
  ["healthy", 75],
  ["watch", 55],
  ["at_risk", 35],
  ["critical", 0],
];

export function healthTierFor(score: number): HealthTier {
  for (const [tier, floor] of HEALTH_TIER_FLOORS) if (score >= floor) return tier;
  return "critical";
}

/** Usage 35%, engagement 25%, support 20%, NPS (−100…100 scaled to 0…100) 20%. */
export function healthScoreOf(c: { usageScore: number; engagementScore: number; supportScore: number; npsScore: number }): number {
  const npsNorm = (c.npsScore + 100) / 2;
  return Math.round(c.usageScore * 0.35 + c.engagementScore * 0.25 + c.supportScore * 0.2 + npsNorm * 0.2);
}

export function calcHealth(c: { usageScore: number; engagementScore: number; supportScore: number; npsScore: number }): { score: number; tier: HealthTier } {
  const score = healthScoreOf(c);
  return { score, tier: healthTierFor(score) };
}

/** Churn risk is the tier, read as a risk: never a second set of cut-offs. */
export function churnRiskFor(tier: string): ChurnRisk {
  if (tier === "healthy") return "low";
  if (tier === "watch") return "medium";
  return "high";
}

/**
 * How a churn-risk rationale starts when the score came from the health score
 * because the AI call failed (R74). The Renewals board labelled that estimate
 * "AI churn risk"; it reads this prefix to say "estimate" instead.
 */
export const CHURN_ESTIMATE_PREFIX = "Heuristic:";

export function isChurnEstimate(rationale: string | null | undefined): boolean {
  return typeof rationale === "string" && rationale.startsWith(CHURN_ESTIMATE_PREFIX);
}

export const HEALTH_TIER_TONE: Record<HealthTier, "success" | "info" | "warning" | "danger"> = {
  healthy: "success",
  watch: "info",
  at_risk: "warning",
  critical: "danger",
};

export const HEALTH_TIER_LABEL: Record<HealthTier, string> = {
  healthy: "Healthy",
  watch: "Watch",
  at_risk: "At risk",
  critical: "Critical",
};
