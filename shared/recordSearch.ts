/**
 * recordSearch — how the one search box reads what was typed (owner,
 * 2026-11-23: "a simple way to type in a company name, person's name or
 * email address and see their enriched info").
 *
 * Shared so the box (CommandPalette) and the server agree on when a search
 * runs and what kind of thing was typed; the server alone decides what
 * matches (server/services/recordSearch.ts).
 */
export const RECORD_SEARCH_MIN = 2;
export const RECORD_SEARCH_MAX = 120;
/** Rows shown per kind. The server reads one more, to know whether to say "more". */
export const RECORD_SEARCH_PER_KIND = 6;

export type RecordSearchQuery = {
  /** Trimmed, spaces collapsed, cut to RECORD_SEARCH_MAX. */
  text: string;
  /** Up to six words; each must be found somewhere on a record. */
  words: string[];
  /** The whole text is one email address, lower-cased; else null. */
  email: string | null;
  /** The domain of that address, or a bare domain typed on its own ("acme.org"); else null. */
  domain: string | null;
};

/** null when there is too little to search for. */
export function parseRecordSearch(raw: string | null | undefined): RecordSearchQuery | null {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, RECORD_SEARCH_MAX);
  if (text.length < RECORD_SEARCH_MIN) return null;
  const words = text.split(" ").filter(Boolean).slice(0, 6);
  const lone = words.length === 1 ? words[0].toLowerCase() : "";
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lone) ? lone : null;
  const bare = lone.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  const domain = email ? email.slice(email.indexOf("@") + 1)
    : /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(bare) ? bare
    : null;
  return { text, words, email, domain };
}

export type PersonHit = {
  kind: "person"; id: number; href: string; name: string;
  title: string | null; company: string | null; email: string | null; emailStatus: string | null;
  phone: string | null; linkedinUrl: string | null; location: string | null;
  /** ISO time of the last enrichment, or null when never enriched. */
  enrichedAt: string | null;
};
export type CompanyHit = {
  kind: "company"; id: number; href: string; name: string;
  domain: string | null; industry: string | null; size: string | null; location: string | null;
  /** People in this workspace linked to the company. */
  people: number;
};
export type LeadHit = {
  kind: "lead"; id: number; href: string; name: string;
  title: string | null; company: string | null; email: string | null; phone: string | null;
  status: string | null; score: number | null;
};
export type RecordHit = PersonHit | CompanyHit | LeadHit;

export type RecordSearchResult = {
  query: string;
  people: PersonHit[]; companies: CompanyHit[]; leads: LeadHit[];
  /** True where a kind has more matches than the rows returned. */
  more: { people: boolean; companies: boolean; leads: boolean };
};

/** The second line under a hit: the enriched facts, most useful first, blanks left out. */
export function hitDetail(h: RecordHit): string {
  const parts: Array<string | null | undefined> =
    h.kind === "person" ? [h.title, h.company, h.email ? `${h.email}${h.emailStatus ? ` (${h.emailStatus})` : ""}` : null, h.phone, h.location]
    : h.kind === "company" ? [h.domain, h.industry, h.size, h.location, h.people ? `${h.people} ${h.people === 1 ? "person" : "people"}` : null]
    : [h.title, h.company, h.email, h.phone, h.status ? `lead: ${h.status}` : null];
  return parts.filter((p): p is string => !!p && !!String(p).trim()).join(" · ");
}
