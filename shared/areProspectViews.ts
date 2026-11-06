/**
 * What a campaign's Prospects tab can be narrowed to — one vocabulary for the
 * server (are.prospects.list and statusCounts filter by it) and the tab (its
 * chips name it), so a chip's count and the rows under it are the same set.
 *
 * WHY VIEWS (tracker item 12, 2026-11-06): the tab listed every row that was
 * not rejected, so a prospect approved yesterday sat in the same list as
 * today's new batch, and "select all" picked it up again. The default view is
 * now the review queue — the rows that still need a decision — and approving
 * a row moves it out. "All" is still one click away for anyone who wants the
 * old list.
 *
 * No imports: reached from the client bundle and the server.
 */

/** Sequence statuses each view lists. Rejected (`skipped`) and email-less
 *  staged (`sourcing`) rows are in none of them: they have their own places. */
export const PROSPECT_VIEWS = {
  /** Needs a decision: new rows, and ones whose sequence was canceled (the row offers Approve for both). */
  review: ["pending", "canceled"],
  /** Decided, not yet sending: the engine writes and enrols these. */
  approved: ["approved"],
  /** Enrolled, or paused part-way. */
  in_sequence: ["enrolled", "paused"],
  /** Ran to the end, or the prospect replied. */
  finished: ["completed", "replied"],
  /** Everything above — the list as it was before views. */
  all: ["pending", "canceled", "approved", "enrolled", "paused", "completed", "replied"],
} as const;

export type ProspectView = keyof typeof PROSPECT_VIEWS;
export const PROSPECT_VIEW_KEYS = Object.keys(PROSPECT_VIEWS) as ProspectView[];

export const PROSPECT_VIEW_LABEL: Record<ProspectView, string> = {
  review: "To review",
  approved: "Approved",
  in_sequence: "In sequence",
  finished: "Finished",
  all: "All",
};

/** Enrichment states, in the order the tab shows them (tracker item 13). */
export const ENRICHMENT_STATES = ["complete", "enriching", "pending", "failed"] as const;
export type EnrichmentState = (typeof ENRICHMENT_STATES)[number];

/** Search terms, split on spaces: every word must match one column. Capped so a pasted paragraph is not 50 LIKEs. */
export function searchWords(term: string | null | undefined): string[] {
  return String(term ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 4);
}

/**
 * Who may run which mass action on a campaign's prospects (tracker item 9).
 * A rep can approve, reject or skip one row at a time, and can "Approve all";
 * the bulk bar offered them the same three for a selection and the server
 * refused every one, so both buttons failed for them. These three are now a
 * rep's in bulk too. Everything else — actions that spend credits, enrol,
 * suppress site-wide or touch People — stays with managers.
 */
export const REP_BULK_ACTIONS = ["approve", "reject", "skip"] as const;

export function bulkActionNeedsManager(action: string): boolean {
  return !(REP_BULK_ACTIONS as readonly string[]).includes(action);
}
