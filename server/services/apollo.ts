/**
 * apollo.ts — Apollo.io as a prospect SOURCE (search-only, zero credits).
 *
 * WHY SEARCH-ONLY
 * ---------------
 * Apollo splits its API in two:
 *   • People Search  (/mixed_people/api_search) — returns name, title, seniority,
 *     company, **company domain**, LinkedIn URL, location. Consumes ZERO
 *     Apollo credits. Never returns a real email.
 *   • People Enrichment (/people/match)     — reveals the email. Costs 1
 *     credit per person when it finds one, +8 more if a mobile is returned.
 *
 * This module deliberately calls ONLY the search endpoint. There is no code
 * path here that hits /people/match, and no parameter that asks for a phone
 * number — credit spend is structurally impossible, not merely toggled off.
 *
 * A paid enrichment module (services/apolloEnrich.ts) existed briefly and was
 * REMOVED with the dataCleanup router on 2026-08-12 — the owner ruled paid
 * Apollo enrichment out permanently. If you are about to add a paid call
 * below — don't; that decision needs the owner, and apolloSearchOnly.test.ts
 * fails on any /people/match code line in this file.
 *
 * The company DOMAIN was the whole point: the old /mixed_people/search rows
 * carried it, and it is the input the Reoon-backed `resolveVerifiedEmail()`
 * needs. api_search, the path Apollo moved API callers to, MASKS its rows
 * (docs.apollo.io/reference/people-api-search, read 2026-10-19): first name,
 * `last_name_obfuscated` ("Hu***n"), title, has_* flags, and an organization
 * with its name and has_* flags only. No last name, domain, LinkedIn URL or
 * location, and the total is a top-level `total_entries`, not `pagination`.
 * Such a row gives the email lookup nothing to work from, so the engine does
 * not queue it (`apolloEmailReady`). The full record comes only from People
 * Enrichment, which costs credits and is ruled out (above).
 *
 * THE PLACEHOLDER-EMAIL TRAP
 * --------------------------
 * Search responses put `email_not_unlocked@domain.com` in the email field for
 * locked contacts. If that string were stored it would look like a valid
 * address to ARE dispatch, which would then mail into the void (and burn
 * sender reputation doing it). `cleanEmail()` below drops it. Do not remove
 * that guard.
 */
import { createHash } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { areScrapeJobs, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "../_core/crypto";
import { normalizeDomain } from "./scraper/domain";
import { utcDayStart } from "@shared/timeWindows";

const APOLLO_BASE = "https://api.apollo.io/api/v1";
const DEFAULT_DAILY_PULL_CAP = 50;

/* ─── Key access ─────────────────────────────────────────────────────────── */

/** Decrypted Apollo key for a workspace, or "" when not configured. */
export async function getApolloKey(workspaceId: number): Promise<string> {
  const db = await getDb();
  if (!db) return "";
  const [row] = await db
    .select({ enc: workspaceSettings.apolloApiKeyEnc })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return tryDecryptSecret(row?.enc);
}

export async function getApolloDailyCap(workspaceId: number): Promise<number> {
  const db = await getDb();
  if (!db) return DEFAULT_DAILY_PULL_CAP;
  const [row] = await db
    .select({ cap: workspaceSettings.apolloDailyPullCap })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return row?.cap ?? DEFAULT_DAILY_PULL_CAP;
}

/**
 * Records already pulled from Apollo today, derived from the scrape-job log
 * rather than a new counter table — every Apollo pull writes an are_scrape_jobs
 * row with its resultCount, so summing today's rows IS the usage number.
 */
export async function apolloPulledToday(workspaceId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  // UTC: this gates a paid daily credit cap.
  const midnight = utcDayStart();
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(${areScrapeJobs.resultCount}), 0)` })
    .from(areScrapeJobs)
    .where(
      and(
        eq(areScrapeJobs.workspaceId, workspaceId),
        eq(areScrapeJobs.sourceType, "apollo"),
        gte(areScrapeJobs.scrapedAt, midnight),
      ),
    );
  return Number(row?.total ?? 0);
}

/* ─── Field mapping ──────────────────────────────────────────────────────── */

/**
 * Apollo's public docs don't publish the person response field names, so read
 * several plausible keys rather than betting on one shape. Anything missing
 * simply comes back undefined and the prospect is still usable.
 */
function pick(obj: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (!obj) return "";
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

/** Apollo's locked-email sentinel. Never store this as an address. */
const LOCKED_EMAIL = /email_not_unlocked|^\s*$|not_unlocked@/i;

function cleanEmail(raw: string): string {
  if (!raw || LOCKED_EMAIL.test(raw)) return "";
  // A real address Apollo volunteered for free (rare, but it happens on
  // contacts already in your Apollo CRM). Keep it only if it looks real.
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(raw) ? raw : "";
}

export interface ApolloProspect {
  firstName: string;
  lastName: string;
  /** Apollo hid the last name (api_search's `last_name_obfuscated`, or a
   *  starred `last_name`). lastName is then "", never the masked string:
   *  "Hu***n" would build wrong email patterns and wrong dedup keys. */
  lastNameMasked: boolean;
  /** Apollo's person id, the only handle a masked row carries. */
  apolloId: string;
  /** api_search's has_email flag; null when the row does not say. */
  hasEmail: boolean | null;
  title: string;
  email: string;
  linkedinUrl: string;
  companyName: string;
  companyDomain: string;
  companySize: string;
  industry: string;
  geography: string;
  sourceUrl: string;
  emailStatus: string;
  confidence: number;
}

/** A masked last name: api_search stars out the middle ("Hu***n"); lower
 *  tiers of the old search sent an initial ("S."). Neither builds a pattern. */
const MASKED_NAME = /\*|^[^\s.]\.?$/;

export function mapPerson(p: Record<string, unknown>): ApolloProspect {
  const org = (p.organization ?? p.account ?? {}) as Record<string, unknown>;
  const location = [pick(p, "city"), pick(p, "state"), pick(p, "country")]
    .filter(Boolean)
    .join(", ");
  const domain = pick(org, "primary_domain", "domain", "website_url")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "");
  const lastName = pick(p, "last_name", "lastName");
  const lastNameMasked = MASKED_NAME.test(lastName) || (!lastName && pick(p, "last_name_obfuscated") !== "");
  const hasEmail = typeof p.has_email === "boolean" ? p.has_email : null;

  return {
    firstName: pick(p, "first_name", "firstName"),
    lastName: lastNameMasked ? "" : lastName,
    lastNameMasked,
    apolloId: pick(p, "id"),
    hasEmail,
    title: pick(p, "title", "headline"),
    email: cleanEmail(pick(p, "email")),
    linkedinUrl: pick(p, "linkedin_url", "linkedinUrl"),
    companyName: pick(org, "name") || pick(p, "organization_name"),
    companyDomain: domain,
    companySize: pick(org, "estimated_num_employees", "employee_count"),
    industry: pick(org, "industry"),
    geography: location || pick(org, "city"),
    sourceUrl: pick(p, "linkedin_url") || pick(org, "website_url"),
    emailStatus: pick(p, "email_status"),
    confidence: 0,
  };
}

/**
 * Whether the email lookup can work from this row. The enrichment pass finds
 * an address from a LinkedIn URL (QuickEnrich) or from first + last name +
 * company domain (patterns verified by Reoon); a row with neither, which is
 * every api_search row, is rejected after enrichment with "No verifiable
 * email address found". Campaign 38 queued 19 such rows on 2026-10-19.
 */
export function apolloEmailReady(p: ApolloProspect): boolean {
  if (p.email || p.linkedinUrl) return true;
  return !!p.firstName && !!p.lastName && !p.lastNameMasked && !!p.companyDomain;
}

/* ─── Employee-band mapping ──────────────────────────────────────────────── */

/**
 * Apollo takes employee counts as discrete band strings ("21,50"), not a
 * min/max pair, so translate the campaign's numeric range into every band it
 * overlaps. Campaign 14's "20+ staff" becomes every band from 11,20 upward.
 */
const APOLLO_BANDS: Array<[number, number]> = [
  [1, 10], [11, 20], [21, 50], [51, 100], [101, 200],
  [201, 500], [501, 1000], [1001, 2000], [2001, 5000],
  [5001, 10000], [10001, 1000000],
];

export function toEmployeeBands(min?: number, max?: number): string[] {
  if (!min && !max) return [];
  const lo = min ?? 1;
  const hi = max ?? 1000000;
  return APOLLO_BANDS.filter(([a, b]) => b >= lo && a <= hi).map(([a, b]) => `${a},${b}`);
}

/* ─── Search ─────────────────────────────────────────────────────────────── */

export interface ApolloSearchInput {
  titles?: string[];
  seniorities?: string[];
  industries?: string[];
  locations?: string[];
  keywords?: string[];
  employeeMin?: number;
  employeeMax?: number;
  page?: number;
  perPage?: number;
}

export interface ApolloSearchResult {
  ok: boolean;
  prospects: ApolloProspect[];
  totalAvailable: number;
  /** People on the page Apollo sent, before our usability filter: the page
   *  cursor advances on this, not on what survived. */
  pageCount?: number;
  /** The keyword search matched nobody, so this page is the relaxed search
   *  without keywords. */
  keywordsDropped?: boolean;
  error?: string;
  /** Rate-limit headers echoed back so callers can log/surface them. */
  rateLimit?: Record<string, string>;
}

/**
 * Run one page of Apollo People Search. Returns ok:false with a human-readable
 * error rather than throwing, so one bad source never aborts a discovery tick
 * (the engine fans out with Promise.allSettled and logs per-source outcomes).
 */
export async function apolloSearchPeople(
  workspaceId: number,
  input: ApolloSearchInput,
  /** What searched, for the spend report (services/spend). */
  feature: string,
): Promise<ApolloSearchResult> {
  const key = await getApolloKey(workspaceId);
  if (!key) {
    return { ok: false, prospects: [], totalAvailable: 0, error: "No Apollo API key configured for this workspace." };
  }

  const perPage = Math.min(Math.max(input.perPage ?? 25, 1), 100);
  const baseBody: Record<string, unknown> = {
    page: Math.max(input.page ?? 1, 1),
    per_page: perPage,
  };
  if (input.titles?.length) baseBody.person_titles = input.titles;
  if (input.seniorities?.length) baseBody.person_seniorities = input.seniorities;
  if (input.locations?.length) baseBody.organization_locations = input.locations;
  const bands = toEmployeeBands(input.employeeMin, input.employeeMax);
  if (bands.length) baseBody.organization_num_employees_ranges = bands;
  // NOTE: no reveal_personal_emails / reveal_phone_number here, ever. Those
  // flags are what turn a free search into a billed enrichment.

  // q_keywords is a narrow AND-ish text match. Stuffing every AI-generated
  // industry label + keyword into it ("Nonprofit - Human Services Nonprofit -
  // Community Development … organizational management") reliably matched ZERO
  // people. Use at most the first two campaign keywords — titles, locations,
  // and size carry the real targeting — and if that still matches nothing,
  // retry once with no keywords at all. Only on page 1: an empty later page
  // is the end of the keyword search, not a sign that it matched nobody.
  const kw = (input.keywords ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 2).join(" ");
  const attempts: Array<Record<string, unknown>> = !kw
    ? [{ ...baseBody }]
    : baseBody.page === 1
      ? [{ ...baseBody, q_keywords: kw }, { ...baseBody }]
      : [{ ...baseBody, q_keywords: kw }];

  let last: ApolloSearchResult = { ok: false, prospects: [], totalAvailable: 0, error: "No search attempted" };
  const { recordSpend } = await import("./spend");
  for (const body of attempts) {
    last = { ...(await runApolloSearch(key, body)), keywordsDropped: !!kw && !("q_keywords" in body) };
    // No credits on this path, but each request counts against Apollo's
    // per-day API limits, which is what their usage page shows.
    await recordSpend({ workspaceId, vendor: "apollo", meter: "searches", quantity: 1, keySource: "workspace", feature });
    // Stop on hard failure (auth/rate-limit/network) or on anyone on the
    // page; only an ok-but-empty page falls through to the relaxed retry.
    if (!last.ok || (last.pageCount ?? last.prospects.length) > 0) return last;
  }
  return last;
}

/** One POST to /mixed_people/api_search, parsed into ApolloSearchResult. */
async function runApolloSearch(
  key: string,
  body: Record<string, unknown>,
): Promise<ApolloSearchResult> {
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      // Apollo deprecated /mixed_people/search for API callers (422) in favour
      // of /mixed_people/api_search — same params/response, different path.
      res = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "x-api-key": key,
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { ok: false, prospects: [], totalAvailable: 0, error: `Apollo request failed: ${(e as Error)?.message ?? e}` };
  }

  const rateLimit: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (/^x-(rate-limit|minute|hourly|daily)/i.test(k)) rateLimit[k] = v;
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint =
      res.status === 401 || res.status === 403
        ? " — check the key is valid and your Apollo plan includes API search access."
        : res.status === 429
          ? " — Apollo rate limit reached; the next tick will retry."
          : "";
    return {
      ok: false,
      prospects: [],
      totalAvailable: 0,
      error: `Apollo returned ${res.status}${hint} ${text.slice(0, 300)}`.trim(),
      rateLimit,
    };
  }

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const rawPeople = [
    ...((json.people as Array<Record<string, unknown>>) ?? []),
    ...((json.contacts as Array<Record<string, unknown>>) ?? []),
  ];
  const pagination = (json.pagination ?? {}) as Record<string, unknown>;

  const prospects = rawPeople
    .map(mapPerson)
    // A record with neither a name nor a company is unusable downstream.
    .filter((p) => (p.firstName || p.lastName) && (p.companyName || p.companyDomain));

  // api_search reports the total at the top level; the old search path put it
  // under pagination. Reading only pagination made every log say "from 25
  // matches" (the page size) whatever Apollo matched.
  const total = Number(json.total_entries ?? pagination.total_entries);
  return {
    ok: true,
    prospects,
    totalAvailable: Number.isFinite(total) && total > 0 ? total : rawPeople.length,
    pageCount: rawPeople.length,
    rateLimit,
  };
}

/* ─── Search page rotation ──────────────────────────────────────────────── */

/** Where an engine campaign's Apollo search is: the query it was walking
 *  (key), the next page, and whether that query had to drop its keywords. */
export type ApolloPageState = { key: string; page: number; relaxed?: boolean };

/** The engine always asks for this many people a page, so the page numbers
 *  of one query mean the same people tick after tick. */
export const APOLLO_PAGE_SIZE = 25;

/** Apollo shows at most 50,000 people of a search (500 pages of 100). */
export const APOLLO_MAX_RECORDS = 50_000;

/** Stable key of the filters the engine sends; a retargeted campaign gets a
 *  new key and starts again at page 1. */
export function apolloQueryKey(input: ApolloSearchInput): string {
  const parts = [
    input.titles ?? [], input.locations ?? [], input.keywords ?? [],
    toEmployeeBands(input.employeeMin, input.employeeMax), input.perPage ?? null,
  ];
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** The page to request now and whether to leave the keywords out. */
export function currentApolloPage(
  prev: ApolloPageState | null | undefined,
  key: string,
): { page: number; relaxed: boolean } {
  if (!prev || prev.key !== key || !Number.isInteger(prev.page) || prev.page < 1) return { page: 1, relaxed: false };
  return { page: prev.page, relaxed: prev.relaxed === true };
}

/**
 * The cursor after a search. discoverViaApollo sent no page, so every tick
 * asked for page 1 of the same filters and got the same 25 people, who were
 * all already queued: "→ 0 new" every tick. One page forward per full page;
 * a short or empty page is the end of the results, and so is Apollo's
 * 50,000-record display limit. The walk then wraps to page 1, with the
 * keywords tried again.
 */
export function nextApolloPage(
  prev: ApolloPageState | null | undefined,
  key: string,
  res: { pageCount: number; perPage: number; totalAvailable: number; keywordsDropped: boolean },
): ApolloPageState {
  const cur = currentApolloPage(prev, key);
  const relaxed = cur.relaxed || res.keywordsDropped;
  const seen = cur.page * res.perPage;
  const end = Math.min(res.totalAvailable > 0 ? res.totalAvailable : Infinity, APOLLO_MAX_RECORDS);
  if (res.pageCount < res.perPage || seen >= end) return { key, page: 1 };
  return relaxed ? { key, page: cur.page + 1, relaxed } : { key, page: cur.page + 1 };
}

/* ─── Company name → domain resolution ───────────────────────────────────── */

/** Process-lifetime cache — the same org names recur across prospects and
 *  campaigns; no point re-asking Apollo. Capped to bound memory. */
const domainCache = new Map<string, string | null>();
const DOMAIN_CACHE_MAX = 500;

/**
 * Resolve a company/organization NAME to its website domain via Apollo's
 * organization search. NOT free: Organization Search costs 1 Apollo credit
 * per page (docs.apollo.io/reference/organization-search, read 2026-10-19);
 * nothing calls this today, and wiring it in needs the owner's OK. This was
 * meant as the missing link for LinkedIn-sourced prospects, which
 * carry an org name in the headline but no domain — and without a domain the
 * enrichment email-finder can't generate/verify addresses.
 *
 * Never throws; returns { domain: null } when unresolvable. Tries the
 * legacy search path first and falls back to the api_search variant if
 * Apollo has deprecated it for API callers (as happened with mixed_people).
 */
export async function apolloResolveDomain(
  workspaceId: number,
  companyName: string,
): Promise<{ domain: string | null; error?: string }> {
  const name = (companyName ?? "").trim();
  if (name.length < 2) return { domain: null, error: "no_name" };

  const cacheKey = name.toLowerCase();
  if (domainCache.has(cacheKey)) return { domain: domainCache.get(cacheKey) ?? null };

  const key = await getApolloKey(workspaceId);
  if (!key) return { domain: null, error: "No Apollo API key configured" };

  const body = { q_organization_name: name, page: 1, per_page: 3 };
  let lastError: string | undefined;

  for (const path of ["mixed_companies/search", "mixed_companies/api_search"]) {
    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        res = await fetch(`${APOLLO_BASE}/${path}`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache",
            "x-api-key": key,
          },
          body: JSON.stringify(body),
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastError = `Apollo org request failed: ${(e as Error)?.message ?? e}`;
      break; // network problem — the other path won't fare better
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      lastError = `Apollo org search returned ${res.status} ${text.slice(0, 200)}`.trim();
      // Deprecated-path 422 → try the api_search variant; anything else stop.
      if (res.status === 422 && /deprecat/i.test(text)) continue;
      break;
    }

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const orgs = [
      ...((json.organizations as Array<Record<string, unknown>>) ?? []),
      ...((json.accounts as Array<Record<string, unknown>>) ?? []),
    ];
    for (const org of orgs) {
      const domain =
        normalizeDomain(String(org.primary_domain ?? "")) ??
        normalizeDomain(String(org.website_url ?? "")) ??
        normalizeDomain(String(org.domain ?? ""));
      if (domain) {
        if (domainCache.size >= DOMAIN_CACHE_MAX) domainCache.clear();
        domainCache.set(cacheKey, domain);
        return { domain };
      }
    }
    // ok response but no domain-bearing org — cache the miss.
    if (domainCache.size >= DOMAIN_CACHE_MAX) domainCache.clear();
    domainCache.set(cacheKey, null);
    return { domain: null, error: "no_match" };
  }

  return { domain: null, error: lastError ?? "unresolved" };
}

/* ─── Key test / usage ───────────────────────────────────────────────────── */

export interface ApolloTestResult {
  ok: boolean;
  message: string;
  sampleCount: number;
  totalAvailable: number;
  rateLimit?: Record<string, string>;
  /** Present only when the key is a master key (usage endpoint 403s otherwise). */
  usage?: Record<string, unknown>;
}

/**
 * Validate a key by running the smallest possible real search — the same
 * endpoint the sourcing actually uses, so a pass here means sourcing will
 * work rather than merely that the key string is well-formed.
 */
export async function apolloTestKey(workspaceId: number): Promise<ApolloTestResult> {
  const probe = await apolloSearchPeople(workspaceId, {
    titles: ["Executive Director"],
    perPage: 1,
  }, "apollo.test");
  if (!probe.ok) {
    return { ok: false, message: probe.error ?? "Apollo search failed.", sampleCount: 0, totalAvailable: 0, rateLimit: probe.rateLimit };
  }

  // Usage stats need a MASTER key; a normal key gets 403. Report honestly
  // rather than inventing a credit balance.
  let usage: Record<string, unknown> | undefined;
  const key = await getApolloKey(workspaceId);
  try {
    const r = await fetch(`${APOLLO_BASE}/usage_stats/api_usage_stats`, {
      headers: { "Cache-Control": "no-cache", "x-api-key": key },
    });
    if (r.ok) usage = (await r.json()) as Record<string, unknown>;
  } catch {
    // Non-fatal — the search probe already proved the key works.
  }

  return {
    ok: true,
    message: `Key works. Apollo matched ${probe.totalAvailable.toLocaleString()} people for the test query.`,
    sampleCount: probe.prospects.length,
    totalAvailable: probe.totalAvailable,
    rateLimit: probe.rateLimit,
    usage,
  };
}
