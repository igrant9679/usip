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
 *   /quotes          → /proposals   Quotes folded INTO proposals first
 *                                   (audit 2026-10-20, F34, 2026-11-07): a
 *                                   quote is a proposal's pricing section,
 *                                   versioned, with its PDF and the AI
 *                                   pricing advice; existing quotes were
 *                                   attached to their deal's proposal (or a
 *                                   new draft one) by services/quoteFold, so
 *                                   every one stays readable there. The page
 *                                   file is kept, unrouted: put its <Route>
 *                                   line back in App.tsx to undo.
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
 *  - The Settings hub had seven rows that navigated to standalone pages.
 *    Since 2026-11-08 (audit U9, batch CONB) the four that are settings —
 *    Users and teams (`/team`), Audit log (`/audit`), Custom fields
 *    (`/custom-fields`) and Notifications (`/notification-prefs`) — render
 *    inside the hub (Shell's ShellEmbedContext drops the page's own frame),
 *    and their routes stay for links and bookmarks; "Phone numbers", which
 *    opened the call queue (`/v2/calls`), is the hub's Voice agents section,
 *    where numbers are set. Three still link out on purpose: Tour builder (a
 *    full-screen authoring tool for super admins, not a setting) and Imports
 *    and Data enrichment (`/v2/data-enrichment`, places to work on records).
 */

/*
 * The 2026-11-07 final pass (audit 2026-10-20, U14 and F25) retired two more
 * sets of duplicates, folding first and redirecting second:
 *
 *   /sequences            → /v2/sequences        U14: one sequence editor. The
 *   /sequences/:id/canvas → /v2/sequences/:id    v2 editor took over what only
 *                                   the legacy list and the canvas had: A/B
 *                                   variants, the bulk enrol picker, the daily
 *                                   cap, reply detection, archive and delete,
 *                                   "Mark replied", the prospect preview, the
 *                                   per-step breakdown, AI-written email steps
 *                                   and waits in hours. The canvas drew
 *                                   branches the engine never ran (O21); the
 *                                   editor says what such a drawing held. A
 *                                   canvas deep link keeps its sequence id.
 *   /inbox                → /v2/inbox?tab=notifications   F25: one reply
 *   /mailbox              → /v2/inbox?tab=mailbox         workspace. Each old
 *   /unified-inbox        → /v2/inbox?tab=social&view=chats  page is a tab or
 *   /v2/conversations     → /v2/inbox                      filter there, built
 *                                   from the old page's own component, so no
 *                                   read or send path was written twice. The
 *                                   old query strings still work: ?reply= opens
 *                                   that reply (an old Mailbox link opens its
 *                                   thread in the Mailbox tab) and
 *                                   ?channel=social|calls picks that tab
 *                                   (lib/inboxTabs.ts).
 *
 * The old page files are kept, unrouted, so each redirect can be undone by
 * putting its one <Route> line back in App.tsx.
 */

/*
 * Batch CONB (2026-11-08, audit 2026-10-20 R72, U33, U13 and X6.3) retired
 * the last pairs, folding first again:
 *
 *   /tasks     → /v2/tasks   R72: one task page. /v2/tasks took /tasks' Today
 *                            / Upcoming / Overdue / Done / All tabs (as views,
 *                            `?view=`), its related-record filter, Reopen and
 *                            Cancel; it already had the assignee picker and
 *                            filter (ported 2026-10-29). Tasks.tsx is kept,
 *                            unrouted, and still exports RelatedTasks, which
 *                            the record pages embed.
 *   /dashboard → /v2/home?view=pipeline   U33: one home. The Dashboard and
 *                            Home were two homes that disagreed (G56); Home
 *                            has a Today view (its own) and a Pipeline view
 *                            (the Dashboard's whole body, DashboardOverview,
 *                            so no read was written twice), and "/" renders
 *                            it. "Set as home" picks the view and is stored on
 *                            the person (users.home_view, migration 0430); a
 *                            browser's old choice is carried over once.
 *                            Dashboard.tsx's page wrapper is kept, unrouted.
 *   /v2/deals  → /pipeline   U13: one deal board. /pipeline took what only
 *                            /v2/deals had: the Deal Autopilot dial and strip,
 *                            Analyze with AI, the header numbers, the AI
 *                            commentary, the at-risk alerts strip, a Move menu
 *                            on every card and the won confetti; and gained
 *                            owner and close-date filter controls, folding
 *                            closed columns and "Show more" on them. It kept
 *                            its own forecast, create, export, drag, AI card
 *                            analysis and pipeline switcher. The hash rides
 *                            along, so /v2/deals#alerts still opens the alerts.
 *                            DealsV2.tsx is kept, unrouted.
 */

/**
 * Retired path → its v2 equivalent. Both are real routes in App.tsx. A `:name`
 * segment in a key is filled into the same `:name` in its target, and a target
 * may carry a query string (the tab or filter it lands on).
 */
export const RETIRED_ROUTES = {
  "/prospects": "/v2/people",
  "/dashboard-home2": "/v2/home",
  "/campaigns": "/are/campaigns",
  "/sequences": "/v2/sequences",
  "/sequences/:id/canvas": "/v2/sequences/:id",
  "/inbox": "/v2/inbox?tab=notifications",
  "/mailbox": "/v2/inbox?tab=mailbox",
  "/unified-inbox": "/v2/inbox?tab=social&view=chats",
  "/v2/conversations": "/v2/inbox",
  "/quotes": "/proposals",
  "/tasks": "/v2/tasks",
  "/dashboard": "/v2/home?view=pipeline",
  "/v2/deals": "/pipeline",
} as const;

export type RetiredRoute = keyof typeof RETIRED_ROUTES;

/**
 * Where a retired path lands. `params` fills the target's `:name` segments
 * (a deep link keeps its id); `search` is the query string the old URL
 * arrived with, carried over so a bookmark like /mailbox?reply=12 still opens
 * that reply. The target's own keys win over the old ones.
 */
export function retiredRedirectUrl(
  from: RetiredRoute,
  opts: { params?: Record<string, string | undefined>; search?: string } = {},
): string {
  const target: string = RETIRED_ROUTES[from];
  const [rawPath, rawQuery = ""] = target.split("?");
  const path = rawPath.replace(/:([A-Za-z_]\w*)/g, (_m, name: string) => encodeURIComponent(opts.params?.[name] ?? ""));
  const query = new URLSearchParams(rawQuery);
  const carried = new URLSearchParams((opts.search ?? "").replace(/^\?/, ""));
  carried.forEach((value, key) => { if (!query.has(key)) query.append(key, value); });
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}
