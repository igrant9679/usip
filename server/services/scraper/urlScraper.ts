/**
 * Arbitrary-URL scraper — pulls person/company contact data from any web page.
 *
 * Pipeline (single URL → ExtractedData):
 *   1. Fetch HTML (5s timeout, polite UA, 2MB cap, redirects followed)
 *   2. Try STRUCTURED extraction first:
 *        - JSON-LD blocks (Schema.org Person, Organization, JobPosting)
 *        - OpenGraph metadata (og:title, og:site_name, og:image)
 *        - Twitter Card metadata (twitter:title, etc.)
 *   3. Fall back to HEURISTICS for whatever wasn't structured:
 *        - <h1> + nearby <p> for name + bio
 *        - mailto: / tel: links for email / phone
 *        - linkedin.com / twitter.com / x.com / facebook.com / github.com hrefs
 *        - <meta name="author"> for author name
 *        - Title-case phrase patterns for company names
 *
 * Each extracted field gets a confidence flag (high / medium / low / none)
 * so the UI can show users where each value came from before they save it.
 *
 * Designed to coexist with the companySite scraper — that one handles
 * domain-root scraping for KNOWN company domains (used by the email pattern
 * generator). This one handles arbitrary URLs (Crunchbase, TechCrunch, a
 * conference speaker page, etc.) where the URL is the input rather than
 * inferred from a company.
 */

import { safeFetch } from "./ssrfGuard";

const FETCH_TIMEOUT_MS = 5_000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; Velocity-CRM/1.0; +https://velocity.app)";

export type Confidence = "high" | "medium" | "low" | "none";

export type ExtractedField<T> = {
  value: T | null;
  confidence: Confidence;
  source: string;
};

export type ExtractedData = {
  url: string;
  pageTitle: string | null;
  /** When all extraction failed, this carries the network/parse error. */
  error?: string;
  // Person-ish fields
  firstName: ExtractedField<string>;
  lastName: ExtractedField<string>;
  fullName: ExtractedField<string>;
  jobTitle: ExtractedField<string>;
  email: ExtractedField<string>;
  phone: ExtractedField<string>;
  bio: ExtractedField<string>;
  // Company-ish fields
  companyName: ExtractedField<string>;
  companyDomain: ExtractedField<string>;
  // Aggregate sets — multiple candidates from the page
  allEmails: string[];
  allPhones: string[];
  socialUrls: string[];
};

/* ─── Public entrypoint ─────────────────────────────────────────────────── */

export async function scrapeUrl(rawUrl: string): Promise<ExtractedData> {
  const url = normalizeInputUrl(rawUrl);
  const empty: ExtractedData = {
    url,
    pageTitle: null,
    firstName: noneField(),
    lastName: noneField(),
    fullName: noneField(),
    jobTitle: noneField(),
    email: noneField(),
    phone: noneField(),
    bio: noneField(),
    companyName: noneField(),
    companyDomain: noneField(),
    allEmails: [],
    allPhones: [],
    socialUrls: [],
  };

  let html: string;
  try {
    // safeFetch validates the URL + every redirect hop against the SSRF
    // blocklist (private IPs, cloud metadata, localhost, *.internal).
    const res = await safeFetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*" },
    });
    if (!res.ok) {
      return { ...empty, error: `HTTP ${res.status}` };
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("html") && !ct.includes("xml") && !ct.includes("text")) {
      return { ...empty, error: `Non-HTML response (${ct})` };
    }
    const text = await res.text();
    html = text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
  } catch (e) {
    return { ...empty, error: (e as Error).message };
  }

  const pageTitle = extractTitle(html);
  const result: ExtractedData = { ...empty, pageTitle };

  // ── Structured extraction first (highest confidence) ──
  const ldData = extractJsonLd(html);
  applyJsonLd(result, ldData);

  const og = extractOpenGraph(html);
  applyOpenGraph(result, og);

  // ── Aggregate sets (always-extract): emails / phones / socials ──
  result.allEmails = extractAllEmails(html);
  result.allPhones = extractAllPhones(html);
  result.socialUrls = extractSocialUrls(html);

  // ── Heuristic fallbacks for any field that's still empty ──
  if (!result.email.value && result.allEmails.length > 0) {
    result.email = { value: result.allEmails[0], confidence: "low", source: "page email regex" };
  }
  if (!result.phone.value && result.allPhones.length > 0) {
    result.phone = { value: result.allPhones[0], confidence: "low", source: "page phone regex" };
  }
  if (!result.fullName.value) {
    const author = extractMetaAuthor(html);
    if (author) result.fullName = { value: author, confidence: "medium", source: "meta name=author" };
  }
  if (!result.fullName.value && pageTitle) {
    // Title patterns like "Jane Smith — VP of Sales | Acme Corp" suggest a name at the start
    const m = pageTitle.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*[-—|·•]/);
    if (m) result.fullName = { value: m[1], confidence: "low", source: "page title pattern" };
  }
  if (!result.fullName.value) {
    const h1 = extractH1(html);
    if (h1 && looksLikePersonName(h1)) {
      result.fullName = { value: h1, confidence: "low", source: "h1" };
    }
  }

  // Split full name → first/last if we got one but not the other
  if (result.fullName.value && (!result.firstName.value || !result.lastName.value)) {
    const { first, last } = splitName(result.fullName.value);
    if (!result.firstName.value && first) {
      result.firstName = { value: first, confidence: result.fullName.confidence, source: `split from ${result.fullName.source}` };
    }
    if (!result.lastName.value && last) {
      result.lastName = { value: last, confidence: result.fullName.confidence, source: `split from ${result.fullName.source}` };
    }
  }

  // Derive companyDomain from page URL if structured data didn't supply one
  if (!result.companyDomain.value) {
    const d = domainFromUrl(url);
    if (d) {
      result.companyDomain = { value: d, confidence: "low", source: "from page URL" };
    }
  }

  return result;
}

/* ─── URL helpers ───────────────────────────────────────────────────────── */

function normalizeInputUrl(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s;
}

function domainFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/* ─── Title extraction ─────────────────────────────────────────────────── */

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? decodeHtmlEntities(m[1].trim()) : null;
}

function extractH1(html: string): string | null {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) return null;
  // Strip nested tags
  const txt = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return txt || null;
}

function extractMetaAuthor(html: string): string | null {
  const m = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i);
  return m ? decodeHtmlEntities(m[1].trim()) : null;
}

/* ─── Schema.org JSON-LD ───────────────────────────────────────────────── */

type LdBlock = Record<string, unknown> & { "@type"?: string | string[] };

function extractJsonLd(html: string): LdBlock[] {
  const blocks: LdBlock[] = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      // JSON-LD can be a single object, an array, or a @graph container
      if (Array.isArray(parsed)) {
        for (const p of parsed) if (p && typeof p === "object") blocks.push(p);
      } else if (parsed && typeof parsed === "object") {
        if (Array.isArray((parsed as { "@graph"?: unknown })["@graph"])) {
          for (const p of (parsed as { "@graph": unknown[] })["@graph"]) {
            if (p && typeof p === "object") blocks.push(p as LdBlock);
          }
        } else {
          blocks.push(parsed);
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  }
  return blocks;
}

function applyJsonLd(out: ExtractedData, blocks: LdBlock[]): void {
  for (const block of blocks) {
    const types = Array.isArray(block["@type"]) ? block["@type"] : [block["@type"] as string];
    if (types.includes("Person")) {
      if (!out.fullName.value && typeof block.name === "string") {
        out.fullName = { value: block.name, confidence: "high", source: "JSON-LD Person.name" };
      }
      if (!out.firstName.value && typeof block.givenName === "string") {
        out.firstName = { value: block.givenName, confidence: "high", source: "JSON-LD Person.givenName" };
      }
      if (!out.lastName.value && typeof block.familyName === "string") {
        out.lastName = { value: block.familyName, confidence: "high", source: "JSON-LD Person.familyName" };
      }
      if (!out.jobTitle.value && typeof block.jobTitle === "string") {
        out.jobTitle = { value: block.jobTitle, confidence: "high", source: "JSON-LD Person.jobTitle" };
      }
      if (!out.email.value && typeof block.email === "string") {
        const e = block.email.replace(/^mailto:/, "");
        out.email = { value: e, confidence: "high", source: "JSON-LD Person.email" };
      }
      if (!out.phone.value && typeof block.telephone === "string") {
        out.phone = { value: String(block.telephone), confidence: "high", source: "JSON-LD Person.telephone" };
      }
      if (!out.bio.value && typeof block.description === "string") {
        out.bio = { value: block.description, confidence: "high", source: "JSON-LD Person.description" };
      }
      // Some Person blocks nest worksFor → Organization
      const worksFor = (block as { worksFor?: LdBlock }).worksFor;
      if (worksFor && typeof worksFor === "object" && typeof worksFor.name === "string") {
        if (!out.companyName.value) {
          out.companyName = { value: worksFor.name, confidence: "high", source: "JSON-LD Person.worksFor.name" };
        }
        if (!out.companyDomain.value && typeof worksFor.url === "string") {
          const d = domainFromUrl(worksFor.url);
          if (d) out.companyDomain = { value: d, confidence: "high", source: "JSON-LD Person.worksFor.url" };
        }
      }
    }
    if (types.includes("Organization") || types.includes("Corporation") || types.includes("LocalBusiness")) {
      if (!out.companyName.value && typeof block.name === "string") {
        out.companyName = { value: block.name, confidence: "high", source: "JSON-LD Organization.name" };
      }
      if (!out.companyDomain.value && typeof block.url === "string") {
        const d = domainFromUrl(block.url);
        if (d) out.companyDomain = { value: d, confidence: "high", source: "JSON-LD Organization.url" };
      }
      if (!out.phone.value && typeof block.telephone === "string") {
        out.phone = { value: String(block.telephone), confidence: "high", source: "JSON-LD Organization.telephone" };
      }
      if (!out.email.value && typeof block.email === "string") {
        const e = block.email.replace(/^mailto:/, "");
        out.email = { value: e, confidence: "high", source: "JSON-LD Organization.email" };
      }
    }
  }
}

/* ─── OpenGraph / Twitter Card ─────────────────────────────────────────── */

type OgData = { title?: string; siteName?: string; description?: string; image?: string };

function extractOpenGraph(html: string): OgData {
  const get = (prop: string) => {
    const m = html.match(
      new RegExp(
        `<meta[^>]+(?:property|name)=["'](?:og:${prop}|twitter:${prop})["'][^>]+content=["']([^"']+)["']`,
        "i",
      ),
    );
    return m ? decodeHtmlEntities(m[1]) : undefined;
  };
  return {
    title: get("title"),
    siteName: get("site_name"),
    description: get("description"),
    image: get("image"),
  };
}

function applyOpenGraph(out: ExtractedData, og: OgData): void {
  if (!out.companyName.value && og.siteName) {
    out.companyName = { value: og.siteName, confidence: "medium", source: "og:site_name" };
  }
  if (!out.bio.value && og.description) {
    out.bio = { value: og.description, confidence: "medium", source: "og:description" };
  }
  if (!out.fullName.value && og.title && looksLikePersonName(og.title)) {
    out.fullName = { value: og.title, confidence: "medium", source: "og:title" };
  }
}

/* ─── Aggregate sets (mailto / tel / social) ───────────────────────────── */

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
  "github.com/",
];

function extractAllEmails(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    const e = m[1].toLowerCase().trim();
    if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)) found.add(e);
  }
  for (const m of html.matchAll(EMAIL_REGEX)) {
    const e = m[0].toLowerCase();
    if (/\.(png|jpg|jpeg|gif|svg|webp)$/.test(e)) continue;
    if (/example\.(com|org|net)$/.test(e)) continue;
    if (/your-?(email|domain)/i.test(e)) continue;
    found.add(e);
  }
  return Array.from(found).slice(0, 20);
}

function extractAllPhones(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/tel:([^"'?>\s]+)/gi)) {
    const p = m[1].replace(/[^\d+]/g, "");
    if (p.length >= 7) found.add(p);
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  for (const m of text.matchAll(PHONE_REGEX)) {
    const p = m[0].replace(/[^\d+]/g, "");
    if (p.length >= 10) found.add(p);
  }
  return Array.from(found).slice(0, 10);
}

function extractSocialUrls(html: string): string[] {
  const found = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const href = m[1];
    const lower = href.toLowerCase();
    for (const host of SOCIAL_HOSTS) {
      if (lower.includes(host)) {
        found.add(href.split("?")[0].split("#")[0]);
        break;
      }
    }
  }
  return Array.from(found).slice(0, 15);
}

/* ─── Heuristic helpers ────────────────────────────────────────────────── */

function looksLikePersonName(s: string): boolean {
  // Heuristic: 2-4 words, mostly capitalized, no digits, no special punctuation
  const trimmed = s.trim();
  if (trimmed.length < 4 || trimmed.length > 60) return false;
  if (/\d/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  // Most words start with a capital letter (allow "de", "von", etc.)
  const capCount = words.filter((w) => /^[A-Z]/.test(w)).length;
  return capCount >= Math.max(2, words.length - 1);
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2019;/g, "'")
    .replace(/&#x201C;/g, '"')
    .replace(/&#x201D;/g, '"')
    .replace(/&#x2014;/g, "—");
}

function noneField<T>(): ExtractedField<T> {
  return { value: null, confidence: "none", source: "" };
}
