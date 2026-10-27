/**
 * Retired v1 routes and where they now land (audit 2026-10-20, Phase 5 item 2).
 *
 * Phase 5 consolidates the app onto one surface per job. These paths were the
 * v1 half of a pair: the page they rendered has a v2 equivalent that reads the
 * same rows, so the old page is gone and the path redirects instead of 404ing.
 * Bookmarks, links in help content and links in already-sent email still land
 * somewhere right — that is the phase gate, and the reason this is a redirect
 * and not a deletion.
 *
 *   /prospects       → /v2/people   Prospects and People both listed
 *                                   `prospects.list`; People is the superset
 *                                   (saved searches, scores, enrichment) and
 *                                   is the "one location for every person
 *                                   record" the owner asked for on 2026-08-17.
 *                                   Only the LIST is retired — /prospects/:id
 *                                   is still the person detail page every
 *                                   deep link (and ContactRedirect) resolves
 *                                   to, so it stays routed.
 *   /dashboard-home2 → /v2/home     "Home 2" was a second home page over
 *                                   workspace.summary; /v2/home is the v2
 *                                   home with the widget layout editor.
 *
 * Not here, deliberately: legacy `/campaigns`. Phase 5 item 2 names it, but
 * its rows are NOT a duplicate of any v2 surface — it reads `campaigns` +
 * `campaignComponents` (budget, objective, checklist), where /are/campaigns
 * reads the ARE's own tables. Folding broadcasts into fixed-copy ARE
 * campaigns is enhancement F21 (Low) and has not been done, so a redirect
 * today would leave live rows with no surface at all. Retire it once F21
 * lands — the same order ContactRedirect and AccountRedirect shipped in
 * (fold first, then redirect).
 */

/** Retired path → its v2 equivalent. Both are real routes in App.tsx. */
export const RETIRED_ROUTES = {
  "/prospects": "/v2/people",
  "/dashboard-home2": "/v2/home",
} as const;

export type RetiredRoute = keyof typeof RETIRED_ROUTES;

export function retiredRedirectUrl(from: RetiredRoute): string {
  return RETIRED_ROUTES[from];
}
