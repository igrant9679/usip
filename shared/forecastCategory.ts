/**
 * Forecast categories (audit 2026-10-20, R41).
 *
 * Commit was "open deals at 90% or more", and no stage defaults that high
 * (negotiation is 75%), so Commit was nearly always $0 and no rep could say
 * "I'm committing this one". A rep can now put a deal in a category on its
 * page. A deal with none keeps the old rule, so nothing moves until someone
 * chooses: Commit at 90% or more, Best case at 50% or more.
 *
 *   commit     counted in Commit and in Best case
 *   best_case  counted in Best case
 *   pipeline   counted in neither
 *   omitted    counted in neither (still open pipeline; a rep's "not this period")
 */
export const FORECAST_CATEGORIES = ["pipeline", "best_case", "commit", "omitted"] as const;
export type ForecastCategory = (typeof FORECAST_CATEGORIES)[number];

export const FORECAST_CATEGORY_LABEL: Record<ForecastCategory, string> = {
  pipeline: "Pipeline",
  best_case: "Best case",
  commit: "Commit",
  omitted: "Omitted",
};

/** Whether an open deal counts in Commit and in Best case. */
export function forecastBuckets(category: string | null | undefined, winProb: number): { commit: boolean; bestCase: boolean } {
  switch (category) {
    case "commit": return { commit: true, bestCase: true };
    case "best_case": return { commit: false, bestCase: true };
    case "pipeline":
    case "omitted": return { commit: false, bestCase: false };
    default: return { commit: winProb >= 90, bestCase: winProb >= 50 };
  }
}
