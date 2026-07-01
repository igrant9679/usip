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

/** Jaccard token overlap 0..1 for fuzzy name similarity. */
export function nameSimilarity(a?: string | null, b?: string | null): number {
  const tok = (x: string) => new Set(normalizeCompanyName(x).split(" ").filter(Boolean));
  const ta = tok(a ?? ""), tb = tok(b ?? "");
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** A display name → initials (max 2) for the fallback avatar. */
export function companyInitials(name?: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
