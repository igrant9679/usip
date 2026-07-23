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
 * The company DOMAIN is the whole point. LinkedIn people-search gave us names
 * with no domain, so the existing Reoon-backed `resolveVerifiedEmail()` had
 * nothing to work with. Apollo hands us the domain for free, which is exactly
 * that finder's required input — so the free half of Apollo unblocks the
 * pipeline on its own.
 *
 * THE PLACEHOLDER-EMAIL TRAP
 * --------------------------
 * Search responses put `email_not_unlocked@domain.com` in the email field for
 * locked contacts. If that string were stored it would look like a valid
 * address to ARE dispatch, which would then mail into the void (and burn
 * sender reputation doing it). `cleanEmail()` below drops it. Do not remove
 * that guard.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { areScrapeJobs, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "../_core/crypto";
import { normalizeDomain } from "./scraper/domain";

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
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
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

function mapPerson(p: Record<string, unknown>): ApolloProspect {
  const org = (p.organization ?? p.account ?? {}) as Record<string, unknown>;
  const location = [pick(p, "city"), pick(p, "state"), pick(p, "country")]
    .filter(Boolean)
    .join(", ");
  const domain = pick(org, "primary_domain", "domain", "website_url")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "");

  return {
    // Last names come back partially masked on lower Apollo tiers ("S.").
    // Store what was actually returned rather than discarding the record —
    // a real first name + real company domain is still enough for the
    // email finder to work with.
    firstName: pick(p, "first_name", "firstName"),
    lastName: pick(p, "last_name", "lastName"),
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
  // retry once with no keywords at all.
  const kw = (input.keywords ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 2).join(" ");
  const attempts: Array<Record<string, unknown>> = kw
    ? [{ ...baseBody, q_keywords: kw }, { ...baseBody }]
    : [{ ...baseBody }];

  let last: ApolloSearchResult = { ok: false, prospects: [], totalAvailable: 0, error: "No search attempted" };
  for (const body of attempts) {
    last = await runApolloSearch(key, body);
    // Stop on hard failure (auth/rate-limit/network) or on any results;
    // only an ok-but-empty result falls through to the relaxed retry.
    if (!last.ok || last.prospects.length > 0) return last;
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

  return {
    ok: true,
    prospects,
    totalAvailable: Number(pagination.total_entries ?? prospects.length) || prospects.length,
    rateLimit,
  };
}

/* ─── Company name → domain resolution ───────────────────────────────────── */

/** Process-lifetime cache — the same org names recur across prospects and
 *  campaigns; no point re-asking Apollo. Capped to bound memory. */
const domainCache = new Map<string, string | null>();
const DOMAIN_CACHE_MAX = 500;

/**
 * Resolve a company/organization NAME to its website domain via Apollo's
 * organization search (zero Apollo credits — same free tier as people
 * search). This is the missing link for LinkedIn-sourced prospects, which
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
  });
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
