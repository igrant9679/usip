/**
 * QuickEnrich client — key resolution and the one call the app makes today.
 *
 * QuickEnrich (quickenrich.io) is a B2B contact database keyed on LinkedIn
 * URLs, being evaluated as a prospect SOURCE for ARE campaigns: their
 * contact-finder discovery endpoint is free and returns has_email/has_phone
 * flags without the values, so a sourcing funnel can know its hit rate before
 * spending. Email delivery is 1 credit only on success ($0.004/record).
 *
 * CONSUMERS (each function here exists because one of these calls it):
 *   - quickenrich.test (router) → quickenrichTestKey
 *   - the enrichment sweep's QuickEnrich pass → quickenrichFindEmailByLinkedIn,
 *     for queue rows a pattern can never reach (LinkedIn URL, no domain).
 *
 * Two invariants the sweep pass holds, recorded where the client lives:
 *   - a QuickEnrich-supplied address is NEVER send-safe on their word — their
 *     "email_verification_date" is a freshness claim about their database, not
 *     an independent check. Reoon power verification before
 *     promoteVerifiedProspect stays the gate, exactly as for pattern-derived
 *     addresses. QuickEnrich replaces the GUESSING step, not the verifying one.
 *   - spend rides the sweep's existing daily cap (one attempt = at most one
 *     credit, charged only on delivery). There is no balance check because
 *     their API publishes no balance endpoint — the cap is the only brake, and
 *     saying so here beats implying a safety net that does not exist.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { areScrapeJobs, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { tryDecryptSecret } from "../_core/crypto";
import { normalizeDomain } from "./scraper/domain";
import { stripNameCredentials } from "./enrichment/personName";
import { utcDayStart } from "@shared/timeWindows";
import { canonicalText } from "@shared/canonicalText";

export const QUICKENRICH_BASE = "https://app.quickenrich.io";

/**
 * Workspace key first, env fallback, "" when neither — the exact contract of
 * getReoonKey/getApolloKey, so every integration answers "which key am I on?"
 * the same way and the settings card can honestly report the source.
 */
export async function getQuickEnrichKey(workspaceId?: number | null): Promise<string> {
  if (workspaceId) {
    try {
      const db = await getDb();
      if (db) {
        const [row] = await db
          .select({ enc: workspaceSettings.quickenrichApiKeyEnc })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, workspaceId))
          .limit(1);
        const key = tryDecryptSecret(row?.enc);
        if (key) return key;
      }
    } catch (e) {
      console.error("[quickenrich] key lookup failed, falling back to env:", (e as Error).message);
    }
  }
  return process.env.QUICKENRICH_API_KEY ?? "";
}

/* ─── Sourcing (migration 0148) ──────────────────────────────────────────── */

/** Daily pull cap — queue hygiene, since discovery itself is their free endpoint. */
export async function getQuickenrichDailyPullCap(workspaceId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 50;
  const [row] = await db
    .select({ cap: workspaceSettings.quickenrichDailyPullCap })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return row?.cap ?? 50;
}

/** Records pulled today, via are_scrape_jobs — the same ledger Apollo uses. */
export async function quickenrichPulledToday(workspaceId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const midnight = utcDayStart();
  const [row] = await db
    .select({ total: sql<number>`COALESCE(SUM(${areScrapeJobs.resultCount}), 0)` })
    .from(areScrapeJobs)
    .where(
      and(
        eq(areScrapeJobs.workspaceId, workspaceId),
        eq(areScrapeJobs.sourceType, "quickenrich"),
        gte(areScrapeJobs.scrapedAt, midnight),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * Country names→ISO codes for the geos a campaign is likely to carry. Their
 * contact-finder filters on country_code; a geo that doesn't map cleanly is
 * OMITTED and reported back, never guessed — sending "California" as a country
 * would silently empty the search. Deliberately small: cover what campaigns
 * actually write, and the caller logs whatever was dropped.
 */
const COUNTRY_CODES: Record<string, string> = {
  "united states": "US", usa: "US", us: "US", america: "US", "united states of america": "US",
  "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB",
  canada: "CA", australia: "AU", ireland: "IE", "new zealand": "NZ",
  germany: "DE", france: "FR", netherlands: "NL", spain: "ES", italy: "IT",
  sweden: "SE", norway: "NO", denmark: "DK", switzerland: "CH", belgium: "BE",
  india: "IN", singapore: "SG",
};

/**
 * In-process cache of their industries vocabulary (GET /api/lookups/industries).
 * Their contact-finder 422s the WHOLE request when any `industry_linkedin`
 * value is not an exact member of this list (observed live 2026-08-24:
 * "The value \"Colleges & Universities\" is not allowed. Use an exact value
 * from GET /api/lookups/industries"), so every industry we send must be
 * validated against it first. 12h TTL — a controlled vocabulary changes on
 * their release cadence, not per request.
 */
let industriesCache: { key: string; at: number; values: string[] } | null = null;
const INDUSTRIES_TTL_MS = 12 * 60 * 60 * 1000;

/** Their allowed industry values, or null when the lookup can't be fetched —
 *  callers must then OMIT the industry dimension rather than guess (an
 *  unvalidated value 422s the whole search). Never throws. */
export async function getQuickenrichIndustries(apiKey: string): Promise<string[] | null> {
  if (industriesCache && industriesCache.key === apiKey && Date.now() - industriesCache.at < INDUSTRIES_TTL_MS) {
    return industriesCache.values;
  }
  try {
    const res = await fetch(`${QUICKENRICH_BASE}/api/lookups/industries`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return null;
    }
    // Envelope tolerance, same posture as quickenrichContactFinder: bare
    // array, or the list under a common wrapper key. Entries may be bare
    // strings or objects naming the value.
    const j = json as Record<string, unknown>;
    const rows = [Array.isArray(json) ? json : undefined, j.data, j.results, j.items, j.industries]
      .find(Array.isArray) as unknown[] | undefined;
    if (!rows) return null;
    const values = rows
      .map((r) => {
        if (typeof r === "string") return r.trim();
        if (r && typeof r === "object") {
          const o = r as Record<string, unknown>;
          const v = [o.value, o.name, o.label, o.industry].find((x) => typeof x === "string" && x.trim());
          return typeof v === "string" ? v.trim() : "";
        }
        return "";
      })
      .filter(Boolean);
    if (values.length === 0) return null;
    industriesCache = { key: apiKey, at: Date.now(), values };
    return values;
  } catch {
    return null;
  }
}

/** Compact form for vocabulary matching: "&"→"and", then the ONE canonical
 *  collapse (@shared/canonicalText) with its spaces removed — so
 *  "Non-profit Organizations" meets "nonprofit organizations" without a fuzzy
 *  library. Spaces are dropped because this matches vocabulary IDENTIFIERS,
 *  not tokenised names (the mergeKeys-vs-canonicalText distinction). */
function compactIndustry(s: string): string {
  return canonicalText(s.replace(/&/g, " and ")).replace(/ /g, "");
}

/**
 * Map OUR industry strings onto THEIR controlled vocabulary. A value maps by
 * compact-form equality, or by unambiguous containment (exactly ONE candidate
 * whose compact form contains ours or vice versa). Anything else is dropped
 * and reported — "similarity is not meaning" is what got the whole request
 * 422'd, so an ambiguous near-match is a miss, not a pick.
 */
export function mapIndustriesToVocabulary(
  ours: string[],
  allowed: string[],
): { mapped: string[]; unmapped: string[] } {
  const byCompact = new Map<string, string>();
  for (const a of allowed) {
    const c = compactIndustry(a);
    if (c && !byCompact.has(c)) byCompact.set(c, a);
  }
  const mapped: string[] = [];
  const unmapped: string[] = [];
  const taken = new Set<string>();
  for (const raw of ours) {
    const c = compactIndustry(raw);
    if (!c) continue;
    let hit = byCompact.get(c) ?? null;
    if (!hit) {
      const containing = Array.from(byCompact.entries())
        .filter(([ac]) => ac.includes(c) || c.includes(ac));
      if (containing.length === 1) hit = containing[0][1];
    }
    if (hit) {
      if (!taken.has(hit)) {
        taken.add(hit);
        mapped.push(hit);
      }
    } else {
      unmapped.push(raw);
    }
  }
  return { mapped, unmapped };
}

export type QuickEnrichFilterBuild = {
  /** Body for POST /api/employees/contact-finder, or null when nothing mapped. */
  body: Record<string, unknown> | null;
  /** Geos that could not be mapped to a country code — for the discovery log. */
  unmappedGeos: string[];
  /** Industries dropped: not in their vocabulary, or the vocabulary was unavailable. */
  unmappedIndustries: string[];
  /** True when industries were requested but GET /api/lookups/industries failed —
   *  they were ALL dropped for that reason, not because they don't exist there. */
  industryLookupUnavailable: boolean;
};

/**
 * Campaign targeting → contact-finder filters. Titles map directly (their
 * filter field is `title`); industries are validated against their controlled
 * vocabulary (`allowedIndustries` from getQuickenrichIndustries — one
 * unrecognised value 422s the whole request, so pass null to omit the
 * dimension when the lookup is unavailable); geos map only through the
 * country table above. Employee-count bands are deliberately NOT sent: their
 * band format is undocumented, and a mis-formatted filter silently empties
 * results — the Email Status lesson says similarity is not meaning, and that
 * applies to filter vocabularies too.
 */
export function buildQuickenrichFilters(targeting: {
  titles: string[];
  industries: string[];
  geos: string[];
}, allowedIndustries: string[] | null): QuickEnrichFilterBuild {
  const clean = (xs: string[], max: number) =>
    xs.map((s) => s.trim()).filter(Boolean).slice(0, max);

  const filters: Record<string, unknown> = {};
  const titles = clean(targeting.titles, 12);
  const requestedIndustries = clean(targeting.industries, 12);
  const industryLookupUnavailable = requestedIndustries.length > 0 && allowedIndustries === null;
  const { mapped: industries, unmapped: unmappedIndustries } = industryLookupUnavailable
    ? { mapped: [] as string[], unmapped: requestedIndustries }
    : mapIndustriesToVocabulary(requestedIndustries, allowedIndustries ?? []);
  if (titles.length > 0) filters.title = { include: titles };
  if (industries.length > 0) filters.industry_linkedin = { include: industries };

  const codes = new Set<string>();
  const unmappedGeos: string[] = [];
  for (const g of clean(targeting.geos, 12)) {
    const code = COUNTRY_CODES[g.toLowerCase()];
    if (code) codes.add(code);
    else unmappedGeos.push(g);
  }
  // Array.from, not a spread: this project's tsc target rejects iterating a
  // Set without --downlevelIteration.
  if (codes.size > 0) filters.country_code = { include: Array.from(codes) };

  // Their API requires at least one active filter — and a filter-less search
  // would be "every contact they have", which is never a campaign audience
  // (the internal-CRM source refuses for the same reason).
  if (!filters.title && !filters.industry_linkedin) {
    return { body: null, unmappedGeos, unmappedIndustries, industryLookupUnavailable };
  }
  // Dimensions at the BODY ROOT — proven by probe on 2026-08-21. Their API
  // changed schema at some point after key setup: any body containing a
  // `filters` wrapper now 422s ("at least one filter is required", because
  // the wrapper reads as no filter at all), while the same per-dimension
  // include objects at the top level answer 200. `logic` was dropped with
  // the wrapper: the accepted probe carried no such key, and an unproven key
  // is how the last 422 started.
  return { body: { ...filters, page: 1 }, unmappedGeos, unmappedIndustries, industryLookupUnavailable };
}

/* ─── Contact-finder page rotation ──────────────────────────────────────── */

export type QuickenrichPageState = { key: string; page: number };

/** Highest page the rotation will request before wrapping — their pagination
 *  depth is undocumented, and the wrap guarantees we can never walk off into
 *  requesting page 900 of a three-page result set forever. */
export const QUICKENRICH_MAX_PAGE = 50;

/** The page a pull should request NOW: the stored cursor when the query is
 *  unchanged (key match), else 1 — a retargeted campaign starts over. */
export function currentQuickenrichPage(
  prev: QuickenrichPageState | null | undefined,
  key: string,
): number {
  return prev && prev.key === key && Number.isInteger(prev.page) && prev.page >= 1 ? prev.page : 1;
}

/**
 * Advance the cursor after a pull. The body used to carry a hardcoded
 * `page: 1`, so every pull of an unchanged query re-fetched the same people
 * and deduped to zero new — "fresh prospects from QuickEnrich" was one page
 * deep. One page forward per non-empty pull; wrap to 1 when a page comes
 * back empty (past the end of their result set) or at the cap.
 */
export function nextQuickenrichPage(
  prev: QuickenrichPageState | null | undefined,
  key: string,
  peopleReturned: number,
): QuickenrichPageState {
  const cur = currentQuickenrichPage(prev, key);
  if (peopleReturned <= 0 || cur >= QUICKENRICH_MAX_PAGE) return { key, page: 1 };
  return { key, page: cur + 1 };
}

export type QuickEnrichDiscoveredPerson = {
  firstName: string;
  lastName: string;
  title: string | null;
  linkedinUrl: string | null;
  companyName: string | null;
  companyDomain: string | null;
  /** Their DB claims an email exists — the enrichment lookup will likely pay off. */
  hasEmail: boolean;
};

/**
 * Free discovery search. Returns people WITHOUT addresses — that is the
 * endpoint's design (has_email flags only), and the reason sourcing costs
 * nothing: the sweep's lookup pass spends the credit later, per hit, on rows
 * the flag says are worth it. Never throws.
 */
export async function quickenrichContactFinder(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; people: QuickEnrichDiscoveredPerson[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${QUICKENRICH_BASE}/api/employees/contact-finder`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      // A 422 carries THEIR validation message — discarding it made the
      // 2026-08-21 API-schema change undiagnosable ("HTTP 422", nothing else).
      const detail = await res.text().then((t) => t.slice(0, 300)).catch(() => "");
      return { ok: false, error: `HTTP ${res.status}${detail ? ` — ${detail}` : ""}` };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: "unparseable response body" };
    }
    const j = json as Record<string, unknown>;
    const rows = [j.data, j.results, j.items, j.employees, Array.isArray(j) ? j : undefined]
      .find(Array.isArray) as Array<Record<string, unknown>> | undefined;
    if (!rows) return { ok: false, error: `unrecognised envelope (keys: ${Object.keys(j).slice(0, 10).join(",")})` };

    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
    const people: QuickEnrichDiscoveredPerson[] = [];
    for (const r of rows) {
      // `employee_linkedin` is the 2026-08-21 schema's name (probe-verified
      // row keys); the older candidates stay for tolerance. The value may be
      // a bare profile slug rather than a URL — normalise, because this field
      // is the enrichment lookup's KEY and a slug that isn't a URL would make
      // every discovered person unenrichable.
      const linkedinRaw = str(r.linkedin_url) ?? str(r.linkedin) ?? str(r.li_url) ?? str(r.employee_linkedin);
      const linkedinUrl = linkedinRaw
        ? (/^https?:\/\//i.test(linkedinRaw) ? linkedinRaw : `https://www.linkedin.com/in/${linkedinRaw.replace(/^\/+/, "")}`)
        : null;
      // QuickEnrich's DB is LinkedIn-keyed, so its names carry the same
      // credential suffixes ("…, PMP") — owner rule: they never enter a name.
      const firstName = stripNameCredentials(str(r.first_name)) ?? "";
      const lastName = stripNameCredentials(str(r.last_name)) ?? "";
      // No LinkedIn URL means the enrichment lookup has no key to work with —
      // and no name means nothing to address. Either way the row is inert in
      // OUR pipeline, whatever their DB knows about it.
      if (!linkedinUrl || (!firstName && !lastName)) continue;
      people.push({
        firstName,
        lastName,
        title: str(r.title) ?? str(r.job_title),
        linkedinUrl,
        companyName: str(r.company_name) ?? str(r.company),
        companyDomain: normalizeDomain(str(r.company_url) ?? str(r.company_domain) ?? str(r.company_website) ?? str(r.email_domain)),
        hasEmail: r.has_email === true,
      });
    }
    return { ok: true, people };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type QuickEnrichTestResult = {
  ok: boolean;
  /** HTTP status from their API — surfaced so "invalid key" (401) reads differently from "their API is down" (5xx). */
  status: number;
  /** Rows on page 1 of the probe search, when the response shape was recognisable. */
  sampleRows: number | null;
  message: string;
};

/**
 * Prove the key works, without spending anything.
 *
 * Their docs publish no balance endpoint (unlike Reoon), so the cheapest
 * honest test is a real call to the one endpoint documented as costing 0
 * credits: contact-finder. A minimal single-filter query establishes that the
 * key authenticates and the account is live. A 401/403 is a bad key; anything
 * 2xx proves the connection regardless of how many rows match.
 */
export type QuickEnrichLookup = {
  /** The address their database returned, or null on any kind of miss. */
  email: string | null;
  /** Why null, when it is: distinguishes "not in their DB" from "call failed". */
  reason: "found" | "no_match" | "http_error" | "network_error" | "unrecognised_shape";
  /**
   * Company identity harvested from the same employee record, when their DB
   * carries it — INCLUDING on a no-email miss. Owner decision 2026-08-24 (CF
   * runs without Apollo): QuickEnrich and LinkedIn are the name→domain path,
   * so a lookup that finds the person but no address must still hand back
   * the domain — that is what lets the pattern+Reoon pass work the row next.
   */
  companyName: string | null;
  companyDomain: string | null;
};

/** Track whether we've already dumped one unrecognised body this process — one
 *  sample is diagnosis, one per row is log spam across a 25-row sweep. */
let loggedUnrecognisedShape = false;

/**
 * Look up an email by LinkedIn URL — the one query their database is keyed on,
 * and the reason this vendor fits this backlog: the stuck rows have a LinkedIn
 * URL and nothing else usable. 1 credit, charged by them only when an email is
 * returned. Never throws: a sweep must not abort on row 7 of 25.
 *
 * ⚠️ ENVELOPE IS INFERRED. Their docs name the fields (email, first/last,
 * title…) but not the wrapper, so this recognises the common shapes and treats
 * an unrecognised 200 as a MISS after logging one raw sample — the
 * producer/consumer field-drift class, handled by admitting uncertainty at the
 * read instead of trusting a guessed schema.
 */
export async function quickenrichFindEmailByLinkedIn(
  apiKey: string,
  linkedinUrl: string,
): Promise<QuickEnrichLookup> {
  // Their 2026-08-21 schema drift renamed the employee-LinkedIn field
  // (`employee_linkedin` replaced `linkedin_url` in contact-finder responses);
  // whether this GET endpoint's search param followed is unprobed — and a
  // DEAD param can answer 200 with no rows, which reads exactly like "not in
  // their DB" (the failure-masking class), so a single-param miss is not
  // trustworthy. Try the historical param, then the renamed one. Verdict
  // merge: any found wins; else a definitive no_match beats a transport
  // failure; else the first failure stands.
  const results: QuickEnrichLookup[] = [];
  for (const param of ["linkedin_url", "employee_linkedin"] as const) {
    const r = await quickenrichLookupOnce(apiKey, param, linkedinUrl);
    if (r.reason === "found") return r;
    results.push(r);
  }
  // No address anywhere — but company identity harvested by EITHER attempt
  // still rides the verdict (a no-email record's domain is the whole point
  // of the harvest).
  const verdict = results.find((r) => r.reason === "no_match") ?? results[0];
  const withCompany = results.find((r) => r.companyDomain || r.companyName);
  return withCompany
    ? { ...verdict, companyName: verdict.companyName ?? withCompany.companyName, companyDomain: verdict.companyDomain ?? withCompany.companyDomain }
    : verdict;
}

async function quickenrichLookupOnce(
  apiKey: string,
  param: "linkedin_url" | "employee_linkedin",
  linkedinUrl: string,
): Promise<QuickEnrichLookup> {
  try {
    const res = await fetch(
      `${QUICKENRICH_BASE}/api/employees/search?${param}=${encodeURIComponent(linkedinUrl)}`,
      {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const miss = (reason: QuickEnrichLookup["reason"]): QuickEnrichLookup =>
      ({ email: null, reason, companyName: null, companyDomain: null });
    if (res.status === 404) return miss("no_match");
    if (!res.ok) return miss("http_error");

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return miss("unrecognised_shape");
    }

    // Common envelopes: bare object, {data: {...}}, {data: [...]}, {results: [...]}.
    const j = json as Record<string, unknown>;
    const candidates: unknown[] = [
      j,
      j.data,
      Array.isArray(j.data) ? j.data[0] : undefined,
      Array.isArray(j.results) ? j.results[0] : undefined,
      Array.isArray(j.employees) ? j.employees[0] : undefined,
    ];
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
    // Company identity from the first record-shaped candidate that carries
    // it — harvested whether or not an address turns up, because a no-email
    // record's domain is what lets the pattern pass work the row next.
    let companyName: string | null = null;
    let companyDomain: string | null = null;
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const rec = c as Record<string, unknown>;
      if (!companyName) companyName = str(rec.company_name) ?? str(rec.company);
      if (!companyDomain) companyDomain = normalizeDomain(str(rec.company_url) ?? str(rec.company_domain) ?? str(rec.company_website) ?? str(rec.email_domain));
    }
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const rec = c as Record<string, unknown>;
      const email = [rec.email, rec.work_email, rec.professional_email]
        .find((v): v is string => typeof v === "string" && v.includes("@"));
      if (email) return { email: email.trim().toLowerCase(), reason: "found", companyName, companyDomain };
    }
    // A 200 with no recognisable address is a miss ("has no email for this
    // person") unless the shape is entirely alien — then say so, once.
    const keys = Object.keys(j);
    if (keys.length > 0 && !("data" in j) && !("results" in j) && !("employees" in j) && !("email" in j)) {
      if (!loggedUnrecognisedShape) {
        loggedUnrecognisedShape = true;
        console.warn("[quickenrich] unrecognised response shape, keys:", keys.slice(0, 12).join(","));
      }
      return miss("unrecognised_shape");
    }
    return { email: null, reason: "no_match", companyName, companyDomain };
  } catch {
    return { email: null, reason: "network_error", companyName: null, companyDomain: null };
  }
}

/**
 * The filter-shape candidates the key test probes, exported so the unit test
 * derives its call count instead of pinning a number that changes per round.
 *
 * Round 1 (2026-08-21) sent per-dimension include objects
 * ({title:{include:[…]}}), has_email inside filters, and a dimension array —
 * all four answered the same 422 "At least one filter is required: a
 * non-empty include/exclude dimension, has_email, or has_phone", INCLUDING
 * the has_email one their own message names as sufficient. Conclusion: the
 * parser does not recognise our nesting at all. Round 2 reads their message
 * literally — include/exclude as the keys INSIDE filters — plus the other
 * plausible nestings.
 */
export const QUICKENRICH_PROBE_CANDIDATES: Array<{ label: string; body: Record<string, unknown> }> = [
  // Round 2 verdict: `{ has_email: true, page: 1 }` — top level, NO `filters`
  // key — answered 200 with rows; every body containing `filters` 422s. Their
  // schema moved constraints to the body root. Round 3 pins the dimension
  // syntax at the root, has_email kept as the known-good control.
  { label: "top-level-dimension-object", body: { title: { include: ["CEO"] }, page: 1 } },
  { label: "top-level-include-map", body: { include: { title: ["CEO"] }, page: 1 } },
  { label: "top-level-bare-array", body: { title: ["CEO"], page: 1 } },
  { label: "top-level-has_email", body: { has_email: true, page: 1 } },
];

export async function quickenrichTestKey(apiKey: string): Promise<QuickEnrichTestResult> {
  /**
   * A battery, not one probe (2026-08-21): their contact-finder started
   * answering 422 "at least one filter is required" to the very body that
   * proved the key at setup — i.e. their filter schema changed and an
   * unknown dimension parses as "no filter at all". Trying the candidate
   * shapes in one pass both proves the key AND names the vocabulary their
   * API currently accepts, which is the fact buildQuickenrichFilters needs.
   */
  const candidates = QUICKENRICH_PROBE_CANDIDATES;
  const accepted: string[] = [];
  const rejected: string[] = [];
  let lastStatus = 0;
  let sampleRows: number | null = null;
  try {
    for (const c of candidates) {
      const res = await fetch(`${QUICKENRICH_BASE}/api/employees/contact-finder`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(c.body),
        signal: AbortSignal.timeout(15_000),
      });
      lastStatus = res.status;
      if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, sampleRows: null, message: "QuickEnrich rejected that key." };
      }
      if (res.ok) {
        accepted.push(c.label);
        if (sampleRows === null) {
          try {
            const json = (await res.json()) as Record<string, unknown>;
            const rows = [json.data, json.results, json.items, json].find(Array.isArray) as Array<Record<string, unknown>> | undefined;
            if (rows) {
              sampleRows = rows.length;
              // KEYS ONLY, never values — enough to diagnose a response-field
              // rename (2026-08-21: rows arrived but the mapper dropped all of
              // them, so the linkedin/name fields must have moved) without
              // putting anyone's data in a log line.
              if (rows[0] && typeof rows[0] === "object") {
                accepted.push(`row-keys: ${Object.keys(rows[0]).slice(0, 25).join(",")}`);
              }
            }
          } catch { /* a 2xx with an unparseable body still proves the key */ }
        }
      } else {
        const detail = await res.text().then((t) => t.slice(0, 160)).catch(() => "");
        rejected.push(`${c.label} (HTTP ${res.status}${detail ? `: ${detail}` : ""})`);
      }
    }
    if (accepted.length > 0) {
      return {
        ok: true, status: 200, sampleRows,
        message: `Connected. Filter shapes accepted: ${accepted.join(", ")}${rejected.length ? ` · rejected: ${rejected.join(" | ")}` : ""}`,
      };
    }
    return { ok: false, status: lastStatus, sampleRows: null, message: `No candidate filter shape accepted — ${rejected.join(" | ")}` };
  } catch (e) {
    return { ok: false, status: 0, sampleRows: null, message: `Could not reach QuickEnrich: ${(e as Error).message}` };
  }
}
