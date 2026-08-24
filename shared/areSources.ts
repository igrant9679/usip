/**
 * areSources.ts — the ONE definition of ARE prospect sources.
 *
 * This file exists because there used to be three competing vocabularies:
 *   • the campaign wizard offered  internal, google_business, linkedin, web,
 *                                  news, ai_research
 *   • ARE Settings offered         google_business, linkedin_company,
 *                                  linkedin_people, web, news, events
 *   • the engine actually ran      linkedin, google_business, news, web
 *
 * So four checkboxes were silent no-ops (`internal` and `ai_research` were
 * never implemented, `events` was deliberately disabled for fabricating
 * attendees, and the linkedin_company/linkedin_people split didn't exist in
 * the engine), and the three default lists disagreed with each other. A user
 * could tick a box and get nothing, with no error to explain it.
 *
 * Rule going forward: a source may appear here ONLY if the engine actually
 * runs it. If you add an entry, add its branch in areEngine.runDiscovery in
 * the same commit — an option that does nothing is worse than no option.
 */

export const ARE_SOURCES = [
  {
    id: "internal",
    label: "Internal CRM",
    description: "Re-engage contacts and leads already in your CRM that match this campaign's targeting.",
  },
  {
    id: "google_business",
    label: "Google Business",
    description: "Discover local and regional businesses from Google Business listings.",
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    description: "Find decision-makers matching your title filters via your connected LinkedIn account.",
  },
  {
    id: "web",
    label: "Web scraping",
    description: "Extract prospects from company sites, team pages, and directory listings.",
  },
  {
    id: "news",
    label: "News & trigger events",
    description: "Track funding rounds, launches, and leadership changes that signal buying intent.",
  },
  {
    id: "apollo",
    label: "Apollo.io",
    description: "Search your Apollo account for matching people. Costs no Apollo credits.",
  },
  {
    id: "quickenrich",
    label: "QuickEnrich",
    description: "Discover people matching your titles and industries from the QuickEnrich database. Discovery is free; emails are found during enrichment, one credit per hit.",
  },
] as const;

export type AreSourceId = (typeof ARE_SOURCES)[number]["id"];

export const ARE_SOURCE_IDS: AreSourceId[] = ARE_SOURCES.map((s) => s.id) as AreSourceId[];

/**
 * The default for a NEW campaign: everything on. A campaign that sources from
 * every channel and dedupes across them finds strictly more than one that
 * doesn't, and each source is individually uncheckable for anyone who wants
 * to narrow it.
 *
 * Used by the wizard, the server's create-input default, AND the engine's
 * fallback for campaigns whose prospectSources is null — those three used to
 * be three different lists.
 */
export const ARE_DEFAULT_SOURCES: AreSourceId[] = [...ARE_SOURCE_IDS];

/** Drop anything not in the live vocabulary (e.g. 'ai_research' persisted on
 *  older campaigns) so removed options can't resurrect as silent no-ops. */
export function normalizeSources(raw: unknown): AreSourceId[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set<string>(ARE_SOURCE_IDS);
  return raw.filter((s): s is AreSourceId => typeof s === "string" && valid.has(s));
}

/**
 * The default CHECKING order (owner decision 2026-08-24): QuickEnrich first.
 *
 * Order is not cosmetics — runDiscovery builds its source tasks in this
 * order and identity claims are first-wins across the settled results, so
 * the earlier source's row is the one that enters the queue when two
 * sources find the same person. QuickEnrich rows arrive LinkedIn-keyed
 * with has_email flags and enrich at ~85%; scraper rows are what built
 * the email-less sediment.
 */
export const ARE_DEFAULT_SOURCE_ORDER: AreSourceId[] = [
  "quickenrich",
  "internal",
  "linkedin",
  "apollo",
  "google_business",
  "news",
  "web",
];

/**
 * The ONE resolver from (workspace order, workspace enable mask, campaign
 * selection) to the ordered list of sources a discovery run actually
 * executes. Every consumer — the engine, the settings surface, the
 * Find-prospects mask — reads through this, so the UI can never show an
 * order the engine doesn't run.
 *
 * `orderRaw` is workspace_settings.areSourceOrder (migration 0172): unknown
 * ids are dropped (normalizeSources), and sources it does not mention are
 * appended in the DEFAULT order — a new vocabulary entry must not vanish
 * behind a stale stored order.
 *
 * `maskRaw` is workspace_settings.areScraperSources — the EXISTING
 * per-workspace source toggles (Record<sourceId, boolean>). It used to seed
 * only the campaign wizard's defaults; since 2026-08-24 (owner ask) it is
 * the runtime enable mask too: `false` disables the source workspace-wide,
 * absent/other means enabled. One vocabulary, not a second parallel one.
 */
export function resolveSourceOrder(
  orderRaw: unknown,
  maskRaw: unknown,
  selected: AreSourceId[],
): AreSourceId[] {
  const order = normalizeSources(orderRaw);
  const mask = (maskRaw && typeof maskRaw === "object" ? maskRaw : {}) as Record<string, unknown>;
  const mentioned = new Set<AreSourceId>(order);
  const full = [...order, ...ARE_DEFAULT_SOURCE_ORDER.filter((s) => !mentioned.has(s))];
  const sel = new Set<AreSourceId>(selected);
  return full.filter((s) => sel.has(s) && mask[s] !== false);
}
