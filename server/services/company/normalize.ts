/**
 * Company identity normalization (pure). Canonicalizes names, domains, websites
 * and LinkedIn company URLs so matching/dedupe compares like-with-like, and
 * distinguishes business email domains from consumer ones.
 */

/** Consumer/free email domains that must never be treated as a company domain. */
export const CONSUMER_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "icloud.com",
  "live.com", "msn.com", "me.com", "mac.com", "protonmail.com", "proton.me",
  "gmx.com", "yandex.com", "zoho.com", "mail.com", "ymail.com", "comcast.net",
  "verizon.net", "att.net", "sbcglobal.net", "cox.net", "hey.com", "pm.me",
]);

const COMPANY_SUFFIXES = [
  "inc", "incorporated", "llc", "l.l.c", "ltd", "limited", "corp", "corporation",
  "co", "company", "plc", "gmbh", "srl", "sa", "sas", "bv", "ag", "pty", "llp",
  "group", "holdings", "holding", "international", "intl", "worldwide",
];

/** Lowercase, strip punctuation/suffixes, collapse whitespace. */
export function normalizeCompanyName(name?: string | null): string {
  if (!name) return "";
  let s = name.toLowerCase().trim();
  s = s.replace(/[.,]/g, " ").replace(/[^a-z0-9&\s-]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  // Strip trailing legal suffixes (repeatedly, e.g. "acme inc llc").
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of COMPANY_SUFFIXES) {
      const re = new RegExp(`\\s${suf}$`);
      if (re.test(s)) { s = s.replace(re, "").trim(); changed = true; }
    }
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Lowercase host, strip protocol/www/path/port. Returns "" if not a domain. */
export function normalizeDomain(input?: string | null): string {
  if (!input) return "";
  let s = input.toLowerCase().trim();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].split("#")[0].split(":")[0].trim();
  // A bare domain must have a dot and no spaces.
  if (!s.includes(".") || /\s/.test(s)) return "";
  return s;
}

/** Canonical website URL (https + host, no trailing slash) or "". */
export function normalizeWebsite(url?: string | null): string {
  const d = normalizeDomain(url);
  return d ? `https://${d}` : "";
}

/** Canonical LinkedIn company URL slug form, or "". */
export function normalizeLinkedInCompanyUrl(url?: string | null): string {
  if (!url) return "";
  const m = url.toLowerCase().match(/linkedin\.com\/company\/([^/?#]+)/);
  if (!m) return "";
  return `linkedin.com/company/${m[1].replace(/\/+$/, "")}`;
}

/** Domain from an email, only if it's a real business (non-consumer) domain. */
export function businessDomainFromEmail(email?: string | null): string {
  if (!email || !email.includes("@")) return "";
  const domain = normalizeDomain(email.split("@")[1]);
  if (!domain || CONSUMER_DOMAINS.has(domain)) return "";
  return domain;
}

export function isConsumerDomain(domain?: string | null): boolean {
  const d = normalizeDomain(domain) || (domain ?? "").toLowerCase().trim();
  return CONSUMER_DOMAINS.has(d);
}

/** The two identity-index columns every accounts INSERT must carry
 *  (roadmap P1.4): rows without them are invisible to the matcher
 *  (`findWorkspaceAccountMatch`) and the duplicate report
 *  (`findDuplicateAccounts`) — the defect that made CSV-imported accounts
 *  unmatchable. Spread the result into any accounts insert/update. */
export function normalizedAccountFields(name?: string | null, domain?: string | null): {
  normalizedName: string | null;
  normalizedDomain: string | null;
} {
  const n = normalizeCompanyName(name);
  const d = normalizeDomain(domain);
  return { normalizedName: n || null, normalizedDomain: d || null };
}

/** Jaccard token overlap 0..1 for fuzzy name similarity. */
export function nameSimilarity(a?: string | null, b?: string | null): number {
  const tok = (x: string) => new Set(normalizeCompanyName(x).split(" ").filter(Boolean));
  const ta = tok(a ?? ""), tb = tok(b ?? "");
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Words that say what KIND of organisation something is, not WHICH one. They
 * never vouch for a domain on their own ("Community Free Library" ↔ nioga.org
 * shares nothing that identifies it).
 */
const CONNECTIVES = ["the", "of", "and", "for", "at", "in", "on", "a", "an", "&"];
const GENERIC_ORG_WORDS = new Set([
  ...CONNECTIVES,
  "university", "college", "school", "schools", "academy", "institute", "institution",
  "foundation", "association", "society", "center", "centre", "council", "alliance",
  "company", "corporation", "corp", "inc", "llc", "ltd", "co", "group", "holdings",
  "international", "national", "american", "america", "united", "states", "us", "usa", "global",
  "public", "community", "free", "library", "libraries", "memorial",
  "services", "service", "solutions", "systems", "partners", "technologies", "technology",
  "health", "healthcare", "medical", "hospital", "clinic",
  "state", "county", "city", "area", "regional", "district", "department", "office",
  "board", "trust", "fund", "federal", "government", "authority", "agency", "bureau",
]);

/**
 * Does the company NAME vouch for this domain? True when a distinctive name
 * token (not a generic organisation word, ≥4 letters) sits inside a domain
 * label, or the name's initials ARE a label.
 *
 *   "Marquette University" ↔ marquette.edu       → true  (token)
 *   "Bowie State University" ↔ bowiestate.edu    → true  (token, substring)
 *   "Virginia Commonwealth University" ↔ vcu.edu → true  (initials)
 *   "Washington and Lee University" ↔ wlu.edu    → true  (initials w/o connectives)
 *   "The San Francisco Foundation" ↔ sff.org     → true  (initials w/o connectives)
 *   "Holy Cross Academy" ↔ bluefrog.com          → false
 *   "Oxford Memorial Library" ↔ stny.rr.com      → false
 *   "National Park Foundation" ↔ nps.gov         → false (npf ≠ nps)
 *
 * Why it exists: a prospect's stored companyDomain often equals their mailbox
 * domain, and that is either an employee at their org (right) or a trustee
 * carrying a day-job mailbox that got copied into the company field (wrong).
 * The two are indistinguishable from the fields alone; the name is the one
 * extra witness we hold. Weak by design — false positives exist ("Southern
 * University" ↔ southern.edu) — so callers use it to KEEP a domain that would
 * otherwise be set aside, never to invent one.
 */
export function nameVouchesForDomain(name?: string | null, domain?: string | null): boolean {
  const d = normalizeDomain(domain);
  if (!d) return false;
  const labels = d.split(".").slice(0, -1).filter(Boolean); // drop the TLD
  if (labels.length === 0) return false;
  const joined = labels.join("");
  const all = normalizeCompanyName(name).split(" ").filter(Boolean);
  if (all.length === 0) return false;
  const distinctive = all.filter((t) => !GENERIC_ORG_WORDS.has(t));
  for (const t of distinctive) {
    if (t.length >= 4 && joined.includes(t)) return true;
  }
  const initials = (ts: string[]) => ts.map((t) => t[0]).join("");
  const connective = new Set(CONNECTIVES);
  const variants = [all, all.filter((t) => !connective.has(t)), distinctive];
  for (const acr of Array.from(new Set(variants.map(initials)))) {
    if (acr.length >= 3 && labels.includes(acr)) return true;
  }
  return false;
}

/** A display name → initials (max 2) for the fallback avatar. */
export function companyInitials(name?: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
