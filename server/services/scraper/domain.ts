/**
 * Domain normalization + extraction.
 *
 * The LeadRocks CSV's "Company Website" column is messy:
 *   "https://www.acme.com/about"
 *   "acme.com"
 *   "http://acme.com/"
 *   ""        (often)
 * We need a canonical bare domain (lower-case, no scheme, no www, no path)
 * to key the scrape cache and to build email patterns.
 */

/** Parse a URL or domain-ish string into a bare domain ("acme.com"). Null on failure. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;

  // Strip scheme if present
  s = s.replace(/^https?:\/\//, "");
  // Strip leading www.
  s = s.replace(/^www\./, "");
  // Strip everything from first / ? # onward
  s = s.split(/[/?#]/)[0] ?? "";
  // Strip trailing dots / whitespace
  s = s.replace(/[\s.]+$/, "");

  // Basic validation: must contain a dot and only valid chars
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return null;
  // Reject IPs (we want domain names only)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return null;
  return s;
}

/** Build the canonical https URL for scraping a page on a domain. */
export function buildUrl(domain: string, path = "/"): string {
  return `https://${domain}${path.startsWith("/") ? path : `/${path}`}`;
}
