/**
 * Data Enrichment tab vocabulary — pure and dependency-free so server-side
 * tests can import it by relative path (the jobFlow pattern).
 *
 * The tab now lives in the URL (?tab=…): the Find Prospects page folded into
 * this page (owner ask 2026-08-21), and its deep links — ProspectDetail's
 * "Run #N" (?runId=…), People's typed discovery query (?q=…) — only work if
 * the fold's redirect can name the tab AND carry the old params through.
 * A tab held only in component state made every one of those links land on
 * the default tab with the params ignored.
 */

export const DATA_ENRICHMENT_TABS = [
  "Data health center",
  "Find prospects",
  "Import contacts",
  "CRM",
  "Job change alerts",
  "Form enrichment",
] as const;
export type DataEnrichmentTab = (typeof DATA_ENRICHMENT_TABS)[number];

export const DEFAULT_TAB: DataEnrichmentTab = "Data health center";

/** URL slug for a tab — stable, human-readable, kebab-case. */
export function tabSlug(tab: DataEnrichmentTab): string {
  return tab.toLowerCase().replace(/\s+/g, "-");
}

/** Resolve a ?tab= slug back to a tab; unknown/absent → the default. */
export function tabFromSlug(slug: string | null | undefined): DataEnrichmentTab {
  if (!slug) return DEFAULT_TAB;
  const s = slug.toLowerCase();
  return DATA_ENRICHMENT_TABS.find((t) => tabSlug(t) === s) ?? DEFAULT_TAB;
}

/**
 * Where a folded page sends its visitors: this page, with the named tab and
 * every OLD query param carried through — a fold must not orphan the deep
 * links that already point at the retired route.
 */
export function tabRedirectUrl(tab: DataEnrichmentTab, search: string): string {
  const sp = new URLSearchParams(search || "");
  sp.set("tab", tabSlug(tab));
  return `/v2/data-enrichment?${sp.toString()}`;
}

/** The Find Prospects fold's redirect (kept by name — first of the folds). */
export function foldRedirectUrl(search: string): string {
  return tabRedirectUrl("Find prospects", search);
}
