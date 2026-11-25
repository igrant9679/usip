/**
 * sourceNames.ts — what members call a prospect-data source (owner
 * 2026-11-25): "Name the sources Source 1, 2, 3 etc. and give a brief
 * description of source but don't give the actual true name of the source."
 *
 * The ONE place a vendor slug becomes what a person reads. Only the platform
 * owner (users.role 'admin') sees a vendor's true name; everyone else sees
 * "Source N" and its description. Numbers are set by the platform owner
 * (prospect_pool_sources.sourceNumber), seeded once in descending platform
 * ceiling order so Source 1 is the default (services/prospectPool).
 *
 * Server text that reaches members (engine and run logs, notes, reasons,
 * notification bodies) passes through anonymizeVendorText at its sink, so a
 * vendor name an adapter writes into an error is replaced too. A source
 * added later needs no entry here: its pattern is derived from its slug and
 * its adapter's displayName, so adding one stays a registry entry plus an
 * adapter.
 *
 * Pure, so a test reads every sentence.
 */

/** The placeholder a pool source shows until the platform owner writes one. */
export const DEFAULT_SOURCE_DESCRIPTION = "B2B contact database";

export function anonSourceLabel(n: number): string {
  return `Source ${n}`;
}

/** What one source is called for one viewer. */
export type SourceName = {
  slug: string;
  number: number;
  /** "Source N" for members; the vendor's name for the platform owner. */
  label: string;
  description: string;
};

/**
 * Spellings our own text and the adapters' messages use for the four vendors
 * that predate this file. Hunter and Lemlist are stubs, never pooled, whose
 * names are ordinary words ("Hunter Smith"): they are never rewritten.
 */
const KNOWN_SPELLINGS: Record<string, string> = {
  warmysender: String.raw`\bwarmy[\s-]?sender(?:\s+leads)?(?:'s)?\b`,
  quickenrich: String.raw`\bquick[\s-]?enrich(?:'s)?\b`,
  apollo: String.raw`\bapollo(?:\.io)?(?:'s)?\b`,
  leadocean: String.raw`\blead[\s-]?ocean(?:'s)?\b`,
};
const NEVER_REWRITTEN = new Set(["hunter", "lemlist"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);

/** The pattern that finds a vendor's name in a sentence, or null when it is never rewritten. */
export function vendorPattern(slug: string, displayName?: string | null): RegExp | null {
  if (NEVER_REWRITTEN.has(slug)) return null;
  if (KNOWN_SPELLINGS[slug]) return new RegExp(KNOWN_SPELLINGS[slug], "gi");
  // "CluGTM" → clu[\s-]?gtm, "A-Leads" → a[\s-]?leads; and the slug itself.
  const words = String(displayName ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s\-_.]+/)
    .filter(Boolean)
    .map(escapeRe);
  const alts = [words.length ? words.join(String.raw`[\s-]?`) : "", escapeRe(slug)].filter(Boolean);
  return new RegExp(String.raw`\b(?:` + alts.join("|") + String.raw`)(?:'s)?\b`, "gi");
}

/**
 * Stable numbers for every slug: the stored ones first; a slug without one
 * gets the next free number, in descending platform ceiling order (a
 * ceiling-less source after), then the order `slugs` lists them in.
 */
export function numberSources(
  slugs: readonly string[],
  stored: Record<string, { number?: number | null; ceiling?: number | null } | undefined>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const taken = new Set<number>();
  for (const slug of slugs) {
    const n = stored[slug]?.number;
    if (typeof n === "number" && Number.isInteger(n) && n > 0 && !taken.has(n)) {
      out[slug] = n;
      taken.add(n);
    }
  }
  const rest = slugs
    .filter((s) => out[s] === undefined)
    .map((s, i) => ({ s, i, c: stored[s]?.ceiling ?? -1 }))
    .sort((a, b) => (b.c - a.c) || (a.i - b.i));
  let next = 1;
  for (const r of rest) {
    while (taken.has(next)) next++;
    out[r.s] = next;
    taken.add(next);
  }
  return out;
}

/** One vendor as text sanitizing needs it: how its name is spelled, and what replaces it. */
export type VendorLabel = { slug: string; displayName?: string | null; label: string };

/** Replace every vendor name in a sentence with what the viewer may read ("Source N"). */
export function anonymizeVendorText(text: string, vendors: readonly VendorLabel[]): string {
  let out = String(text ?? "");
  for (const v of vendors) {
    const re = vendorPattern(v.slug, v.displayName);
    if (!re) continue;
    out = out.replace(re, (m) => (/'s$/i.test(m) ? `${v.label}'s` : v.label));
  }
  return out;
}

/** True when a sentence still names one of these vendors (for the guard tests). */
export function namesAVendor(text: string, vendors: ReadonlyArray<{ slug: string; displayName?: string | null }>): boolean {
  return vendors.some((v) => {
    const re = vendorPattern(v.slug, v.displayName);
    return !!re && re.test(text);
  });
}

/** What a member sees when a pool source's monthly platform ceiling is used up. */
export function sourceUsedUpMessage(label: string): string {
  return `${label} is used up for this month. Choose another source in Settings → Data sources.`;
}
