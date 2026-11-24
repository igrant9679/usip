/**
 * recordLookup — looking a name up OUTSIDE the workspace when the Search box
 * finds nobody (owner, 2026-11-23: "if the search doesn't find the person or
 * company then the app should go out to the prospect sources to get the info,
 * and offer to create a record in the system").
 *
 * Shared so the box (CommandPalette), the server (services/recordLookup.ts)
 * and Elsie agree on what can be looked up and what a found row carries.
 *
 * What the sources can and cannot do, which is why the plan below looks the
 * way it does:
 *   · a person's name: LinkedIn (through a connected account) and the
 *     databases' keyword search;
 *   · a company's name: the databases' company-name filter, which returns the
 *     people there, and the company is read off them;
 *   · a domain: the databases' company-domain filter;
 *   · an email address: NO source finds a person from an address, so the
 *     company on its domain is looked up instead, and the box says so.
 */
import type { RecordSearchQuery } from "./recordSearch";

export type LookupKind = "person" | "company";

/** Rows asked of the databases, and of LinkedIn, per lookup from the Search box. */
export const LOOKUP_TARGET = 6;
/**
 * The most one lookup may ask for. The name lookup on Find prospects and
 * People asks for this many (owner, 2026-11-24: "search for a company
 * (retrieving employees)"): six rows is a glance, not a company's people.
 */
export const LOOKUP_MAX = 25;
/** The limit a lookup runs with: what was asked, within 1 and LOOKUP_MAX; LOOKUP_TARGET when nothing was. */
export function lookupLimit(asked: number | null | undefined): number {
  if (asked == null || !Number.isFinite(asked)) return LOOKUP_TARGET;
  return Math.max(1, Math.min(LOOKUP_MAX, Math.floor(asked)));
}
/** How long one call waits for the databases before it answers "still searching". */
export const LOOKUP_WAIT_MS = 25_000;

export type LookupPlan = {
  kind: LookupKind;
  /** What is asked for, as the box words it. */
  subject: string;
  /** LinkedIn is asked only for a person's name. */
  linkedin: boolean;
  keywords: string[];
  companyNames: string[];
  companyDomains: string[];
  /** Said beside the results when what was typed could not be looked up as typed. */
  note: string | null;
};

/** The kinds the box offers for what was typed: an address or a domain is only ever a company. */
export function lookupKindsFor(q: RecordSearchQuery): LookupKind[] {
  return q.domain ? ["company"] : ["person", "company"];
}

export const NO_EMAIL_LOOKUP_NOTE = "No source finds a person from an email address, so the company on its domain was looked up instead.";

export function planLookup(q: RecordSearchQuery, kind: LookupKind): LookupPlan {
  if (q.domain) {
    return {
      kind: "company", subject: q.domain, linkedin: false,
      keywords: [], companyNames: [], companyDomains: [q.domain],
      note: q.email ? NO_EMAIL_LOOKUP_NOTE : null,
    };
  }
  if (kind === "company") {
    return { kind, subject: q.text, linkedin: false, keywords: [], companyNames: [q.text], companyDomains: [], note: null };
  }
  return { kind: "person", subject: q.text, linkedin: true, keywords: [q.text], companyNames: [], companyDomains: [], note: null };
}

/** What search.createFromLookup takes: the row to save, as the lookup handed it out. */
export type LookupSave =
  | { type: "linkedin_person"; firstName: string; lastName: string; title?: string | null; company?: string | null; linkedinUrl: string; location?: string | null }
  | { type: "source_person"; runId: number; resultId: number }
  | { type: "company"; name: string; domain?: string | null };

export type OutsidePerson = {
  /** Stable within one lookup: "li:3", "src:812". */
  ref: string;
  /** "LinkedIn", "Apollo", "WarmySender"… */
  via: string;
  name: string;
  title: string | null;
  company: string | null;
  domain: string | null;
  location: string | null;
  linkedinUrl: string | null;
  /** Null when the source holds the address back until the row is saved. */
  email: string | null;
  emailHidden: boolean;
  /** Set when this person is in People already: the row opens them instead. */
  already: { href: string } | null;
  /** Units of the source's allowance that saving this row spends. 0 = free. */
  saveCost: number;
  save: LookupSave;
};

export type OutsideCompany = {
  ref: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  /** People the lookup found there. */
  peopleFound: number;
  /** True when no source returned it: the row is only what was typed, with no details yet. */
  typed: boolean;
  already: { href: string } | null;
  save: LookupSave;
};

export type OutsideLookupResult = {
  query: string;
  kind: LookupKind;
  subject: string;
  people: OutsidePerson[];
  companies: OutsideCompany[];
  /** Where it looked, by name ("LinkedIn", "Apollo"). */
  searched: string[];
  /** Plain sentences: a source that was held, nothing connected, the email caveat. */
  notes: string[];
  /** The databases had not finished: ask again with this run id for the rest. */
  pending: { runId: number } | null;
};

export type LookupSaveResult = {
  kind: "person" | "company";
  id: number;
  href: string;
  /** False when the record was there already and is only being opened. */
  created: boolean;
  unitsSpent: number;
  message: string;
};

/** The line under a found person: the facts, then where they came from. */
export function outsidePersonDetail(p: OutsidePerson): string {
  const email = p.email ? p.email : p.emailHidden ? "email shown once saved" : null;
  return [p.title, p.company, email, p.location, `via ${p.via}`].filter((x): x is string => !!x && !!String(x).trim()).join(" · ");
}

export function outsideCompanyDetail(c: OutsideCompany): string {
  return [c.domain, c.industry, c.size, c.peopleFound ? `${c.peopleFound} ${c.peopleFound === 1 ? "person" : "people"} found there` : null]
    .filter((x): x is string => !!x && !!String(x).trim()).join(" · ");
}

/**
 * A lookup whose databases were still searching is asked again for the rest
 * (pending.runId). That second answer has no LinkedIn rows, since LinkedIn is
 * not searched twice: the first answer's are kept.
 */
export function mergeLookup(first: OutsideLookupResult, rest: OutsideLookupResult): OutsideLookupResult {
  const uniq = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) === i);
  return {
    ...rest,
    people: first.people.filter((p) => p.ref.startsWith("li:")).concat(rest.people.filter((p) => !p.ref.startsWith("li:"))),
    searched: uniq(first.searched.concat(rest.searched)),
    notes: uniq(first.notes.concat(rest.notes)),
  };
}

/** How many times the box asks again for a database search that is still going. */
export const LOOKUP_RESUMES = 3;

/** What pressing a found person's row will do, said before it is pressed. */
export function saveLabel(p: Pick<OutsidePerson, "already" | "saveCost" | "via">): string {
  if (p.already) return "In People · open";
  if (p.saveCost > 0) return `Create · ${p.saveCost} ${p.via} ${p.saveCost === 1 ? "credit" : "credits"}`;
  return "Create record";
}

/** What saving these rows would spend, in all and by source ("2 WarmySender credits, 1 LeadOcean credit"). */
export function lookupSaveCost(rows: Array<Pick<OutsidePerson, "saveCost" | "via">>): { total: number; text: string } {
  const by = new Map<string, number>();
  for (const r of rows) if (r.saveCost > 0) by.set(r.via, (by.get(r.via) ?? 0) + r.saveCost);
  const parts: string[] = [];
  let total = 0;
  by.forEach((n, via) => { total += n; parts.push(`${n} ${via} ${n === 1 ? "credit" : "credits"}`); });
  return { total, text: parts.join(", ") };
}
