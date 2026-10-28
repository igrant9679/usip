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
 *   /campaigns       → /are/campaigns  The legacy Broadcasts page. See below:
 *                                   this one was settled by retiring WITHOUT
 *                                   the fold its plan item assumed.
 *
 * About `/campaigns`, so nobody re-runs the investigation (2026-10-27):
 *
 * Phase 5 item 2 named it, and the plan paired it with enhancement F21 (Low),
 * "fold the old /campaigns broadcasts into fixed-copy ARE campaigns". F21 as
 * written could not be built, for two independent reasons:
 *
 *  1. There was no copy to fold. A fixed-copy ARE campaign's content IS its
 *     `fixedSteps`, and the one existing conversion path
 *     (`are.campaigns.fromSequence`) builds those from a sequence's email
 *     steps and refuses when there are none. A legacy campaign only gets a
 *     `sequenceId` through `updateOutreach`, and not one row in any of the
 *     three workspaces had one: every campaign read Audience 0, Sequence —,
 *     Sender —, the "live" ones included. `campaigns.launch` gates only on
 *     the checklist being complete, so "live" never meant "sending" — which
 *     is what the page's own help text said.
 *  2. The fields that DID hold content had nowhere to land. `are_campaigns`
 *     has no objective, budget, checklist or targetSegment column; its only
 *     free-text columns are `description` and the AI-prompt fields, which are
 *     woven into LLM prompts. A decimal budget and a [{id,label,done}]
 *     checklist cannot become prose without losing their meaning.
 *
 * So the owner settled it (2026-10-27) by retiring the route with no fold.
 * The legacy rows are NOT deleted and NOT migrated: `campaigns`,
 * `campaign_components` and `campaign_step_stats` keep every row, reachable
 * by direct query, and the sample-data remover still recognises the seeded
 * ones by name (`SEED_FINGERPRINT.campaignNames`). What went away is the UI:
 * the page, its "New Campaign" button (F21's actual payoff), its sidebar and
 * tool-registry entries, its page help and its guided tour. The demo seeder
 * no longer creates new ones.
 *
 * Why `/settings` is NOT in this map, so the gap reads as deliberate
 * (Phase 5 item 3, checked 2026-10-28):
 *
 * It needs no entry because it was already collapsed, a month before this
 * module existed — commit 1e9c333, 2026-09-15. `/settings` is not a page: it
 * is a three-line shim that reads `?tab=` and redirects into the matching
 * Settings-hub section, which is more than this map can express (eleven
 * targets keyed by a query parameter, where `retiredRedirectUrl` maps one
 * path to one target). So it keeps its own mechanism on purpose; converting
 * it to `RetiredRedirect` would throw the per-tab mapping away and land every
 * old deep link on the same section. `server/settingsHubCollapse.test.ts`
 * pins it, including that each target is an INTERNAL hub section — a target
 * that is merely one of the hub's link-out rows resolves to Profile instead,
 * with no error.
 *
 * Two related things are deliberately NOT retired:
 *
 *  - `/settings/pipelines` and `/settings/linkedin-limits` are separate pages
 *    that merely share the prefix. Same trap as `/prospects/:id`: the parent
 *    stopped being a page, the children did not.
 *  - The Settings hub still has seven rows that navigate to standalone pages
 *    rather than rendering inside it (`/team`, `/audit`, `/custom-fields`,
 *    `/notification-prefs`, `/tour-builder`, `/v2/calls`,
 *    `/v2/data-enrichment`). Those are link-outs BY DESIGN, not leftovers:
 *    each is a full page in its own right, so hosting it in the hub means
 *    re-rendering it, which is a different job from retiring a duplicate and
 *    was left out of Phase 5 item 3 on purpose.
 */

/** Retired path → its v2 equivalent. Both are real routes in App.tsx. */
export const RETIRED_ROUTES = {
  "/prospects": "/v2/people",
  "/dashboard-home2": "/v2/home",
  "/campaigns": "/are/campaigns",
} as const;

export type RetiredRoute = keyof typeof RETIRED_ROUTES;

export function retiredRedirectUrl(from: RetiredRoute): string {
  return RETIRED_ROUTES[from];
}
