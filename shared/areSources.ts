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
 *
 * "web" was removed 2026-10-27 (audit A25/P62): it reads a page at a URL, and
 * discovery hands it search text, so it found nobody, every tick, on every
 * campaign. normalizeSources drops it from stored campaigns and settings.
 * Scraping a page a person names stays on the campaign's Scraper tab.
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
    // Campaigns and Find prospects search through every LinkedIn account
    // connected in the workspace, least-used first, not the viewer's own
    // (audit 2026-10-20, P76: this said "your connected LinkedIn account").
    description: "Find decision-makers matching your title filters through the LinkedIn accounts connected in this workspace.",
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
  {
    id: "warmysender",
    label: "WarmySender leads",
    description: "Search WarmySender's B2B lead database (US/Canada deepest). Searching is free and masked; one lead unit is spent per net-new person acquired.",
  },
  {
    id: "leadocean",
    label: "LeadOcean",
    description: "Search your LeadOcean account for people with an address you accept. Every search row and every lookup counts as a record, so a person costs two. Only runs on a campaign that ticks it, with this workspace's own key.",
  },
] as const;

export type AreSourceId = (typeof ARE_SOURCES)[number]["id"];

export const ARE_SOURCE_IDS: AreSourceId[] = ARE_SOURCES.map((s) => s.id) as AreSourceId[];

/**
 * Sources a person has to tick. LeadOcean bills every preview row, so the rule
 * below ("a campaign that sources from everything finds more") stops being
 * free: left in the defaults, saving a key would have started spending that
 * customer's records on every campaign with a null source list, on the next
 * tick, with nobody having asked for it.
 */
export const ARE_OPT_IN_SOURCES: readonly AreSourceId[] = ["leadocean"];

/**
 * The default for a NEW campaign: everything that costs nothing to look at. A
 * campaign that sources from every channel and dedupes across them finds
 * strictly more than one that doesn't, and each source is individually
 * uncheckable for anyone who wants to narrow it.
 *
 * Used by the wizard, the server's create-input default, AND the engine's
 * fallback for campaigns whose prospectSources is null — those three used to
 * be three different lists.
 */
export const ARE_DEFAULT_SOURCES: AreSourceId[] = ARE_SOURCE_IDS.filter((id) => ARE_OPT_IN_SOURCES.indexOf(id) === -1);

/** Drop anything not in the live vocabulary (e.g. 'ai_research' persisted on
 *  older campaigns) so removed options can't resurrect as silent no-ops. */
export function normalizeSources(raw: unknown): AreSourceId[] {
  if (!Array.isArray(raw)) return [];
  const valid = new Set<string>(ARE_SOURCE_IDS);
  return raw.filter((s): s is AreSourceId => typeof s === "string" && valid.has(s));
}

/**
 * An EXPLICIT empty list means "no discovery". A campaign the engine proposed
 * (campaignProposals) exists to absorb the people it was proposed for and stores
 * [] on purpose; on 2026-09-04 a fallback read that as "every source" and pulled
 * 68 strangers into a 32-person campaign within one tick.
 */
export function discoveryIsOff(raw: unknown): boolean {
  return Array.isArray(raw) && raw.length === 0;
}

/**
 * The sources a campaign has selected: the ONE reading of its stored list. The
 * engine runs what this returns; Source Health and the Sources tab show it. Null
 * and dead-ids-only lists, the legacy shapes, get the defaults.
 *
 * It used to be three copies, and the tab's had lost the explicit-empty rule. A
 * campaign with discovery off showed every box ticked, so unticking one to narrow
 * it saved the rest and switched discovery on, which is the same strangers by
 * another door.
 */
export function campaignSources(raw: unknown): AreSourceId[] {
  const configured = normalizeSources(raw);
  if (configured.length > 0) return configured;
  return discoveryIsOff(raw) ? [] : [...ARE_DEFAULT_SOURCES];
}

/** A box ticked or unticked, for the two screens that pick a campaign's sources. */
export function toggledSources(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((s) => s !== id) : [...list, id];
}

/** What a campaign with no source ticked does, wherever someone can tick them. */
export const DISCOVERY_OFF_NOTE =
  "Discovery is off for this campaign: with no source ticked, it won't look for anyone new. People already in it, and anyone you add, still go through it. Tick a source to turn discovery on.";

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
  "warmysender",
  "internal",
  "linkedin",
  "apollo",
  "google_business",
  "news",
  // Last: the waterfall stops at the target, so the one source that bills its
  // previews is only reached for slots the others could not fill.
  "leadocean",
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

/**
 * The sources one MANUAL run will use (Find Prospects; owner ask
 * 2026-09-22): the surface's candidate list for the mode, narrowed by the
 * workspace mask and then by the user's per-run selection.
 *
 * The mask wins: a selection can never re-enable a source Settings
 * disabled, nor add one the mode does not offer. An absent selection means
 * every enabled candidate, which is what the page ran before it had a
 * picker. An explicit selection that names nothing the mode offers runs
 * nothing — the run log says so rather than quietly running everything.
 * Returns what runs and, for the log, why the rest did not.
 */
export function selectRunSources(
  candidates: readonly AreSourceId[],
  enabled: ReadonlySet<string>,
  selected?: readonly string[] | null,
): { run: AreSourceId[]; masked: AreSourceId[]; unselected: AreSourceId[] } {
  const chosen = selected == null ? null : new Set<string>(selected);
  const run: AreSourceId[] = [];
  const masked: AreSourceId[] = [];
  const unselected: AreSourceId[] = [];
  for (const id of candidates) {
    if (!enabled.has(id)) masked.push(id);
    else if (chosen && !chosen.has(id)) unselected.push(id);
    else run.push(id);
  }
  return { run, masked, unselected };
}
