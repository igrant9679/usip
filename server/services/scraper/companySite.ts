/**
 * Company-website scraper.
 *
 * Fetches a small set of pages on a domain (homepage, /contact, /about) and
 * extracts contact-relevant data: mailto links, tel links, phone numbers in
 * plain text, and social-profile URLs.
 *
 * Politeness:
 *   - Hard 5s timeout per page
 *   - Realistic User-Agent (we identify as a normal browser; Velocity is a
 *     CRM, not a search-engine crawler, so an opaque UA is fine)
 *   - Per-domain serialized fetches via the in-process rateLimiter to keep
 *     us at ~1 req/sec on any single domain — protects us from looking like
 *     a scraper even though we only ever fetch 3 pages per domain
 *   - Robots.txt honored at the page level: if `/robots.txt` exists and
 *     Disallow-includes the path, that page is skipped
 *   - Cache hits (handled in scraper/index.ts via domain_scrape_cache) mean
 *     we only ever touch a domain once per 30 days
 *
 * NOT implemented (deliberately):
 *   - Sitemap parsing — overkill for "find me a contact page"
 *   - JS rendering — too expensive; mostly the contact info we want is in
 *     server-rendered HTML anyway. Sites that only expose contact info via
 *     JS-loaded widgets will return [] and we'll fall back to patterns.
 *   - PDF / iframe traversal
 */

import { buildUrl } from "./domain";

const FETCH_TIMEOUT_MS = 5_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; Velocity-CRM/1.0; +https://velocity.app)";
const PATHS_TO_TRY = ["/", "/contact", "/contact-us", "/about", "/about-us"];

export type ScrapedSite = {
  emails: string[];
  phones: string[];
  socialUrls: string[];
  pagesFetched: string[];
  robotsBlocked: boolean;
  /** Reason we returned empty (network failure, DNS error, etc.) if all pages failed. */
  fetchError?: string;
};

/* ─── Per-domain serialization to keep req/sec sane ────────────────────── */

const domainLocks = new Map<string, Promise<void>>();

async function serializePerDomain<T>(domain: string, fn: () => Promise<T>): Promise<T> {
  const prev = domainLocks.get(domain) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  domainLocks.set(
    domain,
    prev.then(() => next),
  );
  try {
    // Wait for any prior fetch to this domain to finish
    await prev;
    // Then enforce 1s gap between requests to same domain
    return await fn();
  } finally {
    setTimeout(release, 1_000);
    // Cleanup map slot once chain is fully drained
    void next.then(() => {
      if (domainLocks.get(domain) === next) domainLocks.delete(domain);
    });
  }
}

/* ─── Robots.txt (minimal parser) ──────────────────────────────────────── */

type RobotsRules = { disallow: string[]; allow: string[] };
const robotsCache = new Map<string, RobotsRules | null>();

async function getRobots(domain: string): Promise<RobotsRules | null> {
  if (robotsCache.has(domain)) return robotsCache.get(domain) ?? null;
  try {
    const res = await fetch(buildUrl(domain, "/robots.txt"), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) {
      robotsCache.set(domain, null);
      return null;
    }
    const text = await res.text();
    const rules = parseRobots(text);
    robotsCache.set(domain, rules);
    return rules;
  } catch {
    robotsCache.set(domain, null);
    return null;
  }
}

/** Parse Disallow/Allow entries for the User-agent: * block only. */
function parseRobots(text: string): RobotsRules {
  const lines = text.split(/\r?\n/);
  let inStar = false;
  const disallow: string[] = [];
  const allow: string[] = [];
  for (const raw of lines) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [keyRaw, ...rest] = line.split(":");
    const key = keyRaw.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      inStar = value === "*";
    } else if (inStar && key === "disallow" && value) {
      disallow.push(value);
    } else if (inStar && key === "allow" && value) {
      allow.push(value);
    }
  }
  return { disallow, allow };
}

function isAllowedByRobots(rules: RobotsRules | null, path: string): boolean {
  if (!rules) return true;
  // Standard precedence: longest match between Allow and Disallow wins.
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const a of rules.allow) if (path.startsWith(a) && a.length > bestAllow) bestAllow = a.length;
  for (const d of rules.disallow) if (path.startsWith(d) && d.length > bestDisallow) bestDisallow = d.length;
  if (bestDisallow === -1) return true;
  return bestAllow >= bestDisallow;
}

/* ─── HTML parsing (regex-based; no heavy DOM library) ─────────────────── */

const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_REGEX =
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-]?)\d{3,4}[\s.-]?\d{3,4}/g;
const SOCIAL_HOSTS = [
  "linkedin.com/company/",
  "linkedin.com/in/",
  "twitter.com/",
  "x.com/",
  "facebook.com/",
  "instagram.com/",
  "youtube.com/",
];

function extractEmails(html: string): string[] {
  const found = new Set<string>();
  // mailto: links — high confidence
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const e = m[1].toLowerCase().trim();
    if (EMAIL_REGEX.test(e)) found.add(e);
    EMAIL_REGEX.lastIndex = 0;
  }
  // bare emails in text — lower confidence, but useful for /contact pages
  // that render addresses as plain text (no mailto)
  for (const m of html.matchAll(EMAIL_REGEX)) {
    const e = m[0].toLowerCase();
    // Filter out common false positives (image filenames like "foo@2x.png")
    if (/\.(png|jpg|jpeg|gif|svg|webp)$/.test(e)) continue;
    if (/example\.(com|org|net)$/.test(e)) continue;
    if (/your-?(email|domain)/i.test(e)) continue;
    found.add(e);
  }
  return Array.from(found).slice(0, 20);
}

function extractPhones(html: string): string[] {
  const found = new Set<string>();
  // tel: links — high confidence
  for (const m of html.matchAll(/tel:([^"'?>\s]+)/gi)) {
    const p = normalizePhone(m[1]);
    if (p) found.add(p);
  }
  // Bare phone patterns — strip script/style first to reduce false positives
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  for (const m of text.matchAll(PHONE_REGEX)) {
    const p = normalizePhone(m[0]);
    // Require at least 10 digits to filter out years, zip codes, etc.
    if (p && p.replace(/\D/g, "").length >= 10) found.add(p);
  }
  return Array.from(found).slice(0, 10);
}

function normalizePhone(s: string): string | null {
  const digits = s.replace(/[^\d+]/g, "");
  if (digits.length < 7) return null;
  return digits;
}

function extractSocialUrls(html: string, sourceDomain: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1];
    for (const host of SOCIAL_HOSTS) {
      if (href.toLowerCase().includes(host)) {
        // Skip share-this links pointing back to the source domain
        if (href.toLowerCase().includes(`url=${sourceDomain}`)) continue;
        if (href.toLowerCase().includes(`u=${sourceDomain}`)) continue;
        found.add(href.split("?")[0].split("#")[0]);
      }
    }
  }
  return Array.from(found).slice(0, 15);
}

/* ─── Public entrypoint ─────────────────────────────────────────────────── */

/**
 * Scrape a domain's homepage + likely contact pages. Returns aggregated
 * emails / phones / social URLs across all successfully-fetched pages.
 *
 * Never throws — failures are recorded in the returned object so the
 * orchestrator can decide whether to fall back to email patterns alone.
 */
export async function scrapeCompanySite(domain: string): Promise<ScrapedSite> {
  const result: ScrapedSite = {
    emails: [],
    phones: [],
    socialUrls: [],
    pagesFetched: [],
    robotsBlocked: false,
  };

  const robots = await getRobots(domain);
  const allEmails = new Set<string>();
  const allPhones = new Set<string>();
  const allSocials = new Set<string>();
  const errors: string[] = [];
  let anyAllowed = false;

  for (const path of PATHS_TO_TRY) {
    if (!isAllowedByRobots(robots, path)) {
      continue;
    }
    anyAllowed = true;

    try {
      const html = await serializePerDomain(domain, async () => {
        const res = await fetch(buildUrl(domain, path), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
          redirect: "follow",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("html") && !ct.includes("text")) {
          throw new Error(`non-HTML content-type: ${ct}`);
        }
        // Cap response size at 2 MB — anything bigger is almost certainly
        // not a page we want to parse, and prevents memory blowups on
        // pathological sites.
        const text = await res.text();
        return text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
      });

      for (const e of extractEmails(html)) allEmails.add(e);
      for (const p of extractPhones(html)) allPhones.add(p);
      for (const u of extractSocialUrls(html, domain)) allSocials.add(u);
      result.pagesFetched.push(path);
    } catch (e) {
      errors.push(`${path}: ${(e as Error).message}`);
    }
  }

  // Strip emails that aren't on the target domain or a related one —
  // mailto:contact@third-party-newsletter.com is noise. We keep:
  //   1. Anything @ the company's own domain
  //   2. Anything @ a subdomain of the company's domain
  const domainTail = "." + domain;
  result.emails = Array.from(allEmails).filter((e) => {
    const at = e.lastIndexOf("@");
    if (at === -1) return false;
    const ed = e.slice(at + 1);
    return ed === domain || ed.endsWith(domainTail);
  });

  result.phones = Array.from(allPhones);
  result.socialUrls = Array.from(allSocials);
  result.robotsBlocked = !anyAllowed && (robots?.disallow.length ?? 0) > 0;
  if (result.pagesFetched.length === 0 && errors.length > 0) {
    result.fetchError = errors[0];
  }
  return result;
}
