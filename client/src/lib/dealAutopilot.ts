/**
 * The Deal Autopilot's words, for the one deal board (audit 2026-10-20, R43
 * and U13; batch CONB, 2026-11-08). They came across from /v2/deals when it
 * was folded into /pipeline; DealsV2.tsx keeps its own copy, unrouted.
 *
 * Approve never writes the deal: each recommendation is a DRAFT task in
 * Tasks → AI drafts to review, carrying the suggested next step and win %.
 * Autonomous writes both onto the deal and opens the follow-up task.
 */
export const DEAL_AUTOPILOT_MODES: Record<string, { label: string; blurb: string }> = {
  off: { label: "Autopilot off", blurb: "AI won't touch your deals." },
  approval: { label: "Autopilot: Approve", blurb: "AI drafts a next step and a win probability for each open deal as a task for you to review in Tasks. Your deals are not changed until you act." },
  auto: { label: "Autopilot: Autonomous", blurb: "AI writes the next step and win probability onto each open deal and opens the follow-up task, so nothing stalls." },
};

/** Deals one "Analyze with AI" looks at, at most: one AI call each. */
export const ANALYZE_LIMIT = 15;

/** What "Analyze with AI" did, and where its drafts went (R43). */
export function dealAnalyzeToast(r: { analyzed: number; tasksCreated: number }): string {
  if (r.analyzed === 0) return "No open deals needed analysis";
  const drafts = `${r.tasksCreated} draft task${r.tasksCreated === 1 ? "" : "s"}`;
  return `AI analyzed ${r.analyzed} deal${r.analyzed === 1 ? "" : "s"}: ${drafts} to review in Tasks. Your deals are unchanged.`;
}

/** The close-date filter's choices; the server turns each into days (dealMetrics.closeRangeBounds). */
export const CLOSE_RANGE_OPTIONS = [
  { value: "", label: "Any close date" },
  { value: "overdue", label: "Close date passed" },
  { value: "this_month", label: "Closing this month" },
  { value: "this_quarter", label: "Closing this quarter" },
  { value: "next_90", label: "Closing in the next 90 days" },
  { value: "none", label: "No close date" },
] as const;
export type CloseRangeValue = Exclude<(typeof CLOSE_RANGE_OPTIONS)[number]["value"], "">;

/** A ?close= value, if it is one of the choices. */
export function closeRangeFrom(v: string | null | undefined): CloseRangeValue | undefined {
  return CLOSE_RANGE_OPTIONS.find((o) => o.value !== "" && o.value === v)?.value as CloseRangeValue | undefined;
}
