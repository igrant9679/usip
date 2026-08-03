/**
 * A lead's tier and its letter grade are ONE FACT with two spellings.
 *
 * 🔴 THE DRIFT. The server computes `tier` from PER-WORKSPACE thresholds
 * (`lead_score_config.tierWarmMin / tierHotMin / tierSalesReadyMin`, defaults
 * 31/61/81) and stores the derived letter on `leads.grade`. The Leads table
 * then rendered BOTH badges on the same row — the stored grade, and a tier it
 * re-derived in the browser from `leads.score` against 81/61/31 HARDCODED.
 *
 * For a default workspace they agree, which is why it survived. Raise
 * `tierSalesReadyMin` to 90 and a lead scoring 85 shows grade **B** next to the
 * label **Sales Ready**, in the same cell, and the "A lead becomes Sales-Ready"
 * notification fires on the server's answer rather than the one on screen.
 *
 * The mapping is a bijection, so the client needs no thresholds at all: it has
 * the grade already. This module is that mapping, and the ONLY place either
 * direction is written.
 */

export const LEAD_TIERS = ["cold", "warm", "hot", "sales_ready"] as const;
export type LeadTier = (typeof LEAD_TIERS)[number];

export const LEAD_GRADES = ["A", "B", "C", "D"] as const;
export type LeadGrade = (typeof LEAD_GRADES)[number];

/** Highest tier first, so the pairing is readable as a ladder. */
const TIER_TO_GRADE: Record<LeadTier, LeadGrade> = {
  sales_ready: "A",
  hot: "B",
  warm: "C",
  cold: "D",
};

const GRADE_TO_TIER: Record<LeadGrade, LeadTier> = {
  A: "sales_ready",
  B: "hot",
  C: "warm",
  D: "cold",
};

/** What gets stored on `leads.grade` when the scorer picks a tier. */
export function gradeForTier(tier: LeadTier): LeadGrade {
  return TIER_TO_GRADE[tier];
}

/**
 * The tier a stored grade stands for.
 *
 * Returns **null** for an absent or unrecognised grade, and that is the point:
 * a lead nobody has scored has no tier, and calling it "Cold" asserts a
 * measurement never taken — the mistake `96b161d` corrected when an unmeasured
 * intent signal counted as a real zero. Callers render the absence.
 */
export function tierForGrade(grade: string | null | undefined): LeadTier | null {
  if (!grade) return null;
  return GRADE_TO_TIER[grade as LeadGrade] ?? null;
}

/** Human label for a tier. `null` is an unscored lead, not a cold one. */
export function leadTierLabel(tier: LeadTier | null): string {
  if (!tier) return "Unscored";
  switch (tier) {
    case "sales_ready": return "Sales Ready";
    case "hot": return "Hot";
    case "warm": return "Warm";
    case "cold": return "Cold";
  }
}
