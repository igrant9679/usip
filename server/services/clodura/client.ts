/**
 * Clodura.ai API Client
 * Pluggable — swap provider by replacing this module.
 * All methods throw typed CloduraError so callers can map to HTTP status codes.
 */
import { TRPCError } from "@trpc/server";

// Base URL is overridable via env so the hostname can be corrected without a
// redeploy. Default matches the official docs (Clodura API Reference Guide v1).
// Strip any trailing slash so concatenation with `/path` always yields a
// single-slash URL.
const CLODURA_BASE = (process.env.CLODURA_BASE_URL || "https://app.clodura.ai/api/v1").replace(/\/+$/, "");
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

/** Pull the most useful detail out of a thrown error for diagnostics. */
function describeError(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string; errno?: string; hostname?: string } };
  const parts: string[] = [];
  if (err.message) parts.push(err.message);
  const cause = err.cause;
  if (cause) {
    const causeBits: string[] = [];
    if (cause.code) causeBits.push(cause.code);
    if (cause.errno) causeBits.push(`errno=${cause.errno}`);
    if (cause.hostname) causeBits.push(`host=${cause.hostname}`);
    if (cause.message && cause.message !== err.message) causeBits.push(cause.message);
    if (causeBits.length > 0) parts.push(`(${causeBits.join(", ")})`);
  }
  return parts.join(" ");
}

export class CloduraError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "CloduraError";
  }
}

function getApiKey(workspaceApiKey?: string): string {
  const key = workspaceApiKey ?? process.env.CLODURA_API_KEY;
  if (!key) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Clodura API key not configured. Add it under Settings → Integrations.",
    });
  }
  return key;
}

async function cloduraFetch<T>(
  path: string,
  options: RequestInit & { apiKey?: string; retries?: number } = {},
): Promise<T> {
  const { apiKey, retries = MAX_RETRIES, ...fetchOptions } = options;
  const key = getApiKey(apiKey);
  const url = path.startsWith("http") ? path : `${CLODURA_BASE}${path}`;

  let lastError: CloduraError | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...fetchOptions,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-api-key": key,
          // Cloudflare-fronted APIs often reject Node's default User-Agent as
          // bot traffic. Send something explicit so 403s reflect real
          // app-level decisions, not WAF false positives.
          "User-Agent": "USIP-Clodura-Client/1.0 (+https://github.com/igrant9679/usip)",
          ...(fetchOptions.headers ?? {}),
        },
        signal: AbortSignal.timeout(30_000),
      });

      // Retry on 5xx and 429
      if (res.status >= 500 || res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        const delay = retryAfter
          ? parseInt(retryAfter) * 1000
          : RETRY_DELAY_MS * Math.pow(2, attempt);
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, delay));
          lastError = new CloduraError(res.status, `HTTP ${res.status}`, await res.text().catch(() => null));
          continue;
        }
      }

      // Never retry on 4xx
      if (!res.ok) {
        const rawText = await res.text().catch(() => "");
        let parsed: unknown = null;
        try { parsed = JSON.parse(rawText); } catch { /* leave as null */ }
        const message =
          (parsed as { message?: string })?.message ??
          (rawText && rawText.length < 300 ? rawText : `HTTP ${res.status}`);
        // Surface enough context to debug 404s with empty bodies:
        //   - which URL we actually sent to (env var is invisible otherwise)
        //   - the final URL after any redirects
        //   - the `server` / `cf-ray` headers — reveals if it's Clodura vs Cloudflare
        const server = res.headers.get("server") ?? "";
        const cfRay = res.headers.get("cf-ray") ?? "";
        const final = res.url && res.url !== url ? ` final=${res.url}` : "";
        const tag = [server && `server=${server}`, cfRay && `cf-ray=${cfRay}`].filter(Boolean).join(" ");
        const ctx = ` [sent=${url}${final}${tag ? ` ${tag}` : ""}]`;
        throw new CloduraError(res.status, `${message}${ctx}`, parsed ?? rawText);
      }

      return res.json() as Promise<T>;
    } catch (e) {
      if (e instanceof CloduraError) throw e;
      const detail = describeError(e);
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt)));
        lastError = new CloduraError(0, detail);
        continue;
      }
      throw new CloduraError(0, `${detail} — url=${url}`);
    }
  }
  throw lastError ?? new CloduraError(0, "Unknown error");
}

/* ─── Search ──────────────────────────────────────────────────────────────── */
export interface CloduraSearchFilters {
  firstName?: string;
  lastName?: string;
  personTitle?: string[];
  seniority?: string[];
  functional?: string[];
  company?: string[];
  companyDomain?: string[];  // max 10
  industry?: string[];
  technology?: string[];
  city?: string[];
  state?: string[];
  country?: string[];
  employeeSize?: string[];
  revenue?: string[];
  linkedinUrl?: string;
  excludeLinkedinSalesNav?: boolean;
}

export interface CloduraSearchParams extends CloduraSearchFilters {
  page?: number;
  perPage?: number; // 25 | 50 | 100
}

export interface CloduraPersonResult {
  personId: string;
  firstName: string;
  lastName: string;
  personTitle?: string;
  seniority?: string[];
  functional?: string[];
  linkedinUrl?: string;
  personCity?: string;
  personState?: string;
  personCountry?: string;
  organizationName?: string;
  organizationId?: string;
  companyDomain?: string[];
  industry?: string[];
  contactEmailStatus?: string;
}

export interface CloduraSearchResponse {
  data: CloduraPersonResult[];
  total: number;
  page: number;
  perPage: number;
}

export async function searchPeople(
  params: CloduraSearchParams,
  apiKey?: string,
): Promise<CloduraSearchResponse> {
  // Validate LinkedIn Sales Navigator URLs are rejected
  if (params.linkedinUrl?.includes("linkedin.com/sales/")) {
    throw new CloduraError(
      400,
      "LinkedIn Sales Navigator URLs are not supported. Please use a standard linkedin.com/in/ profile URL.",
    );
  }
  // Validate domain list max 10
  if (params.companyDomain && params.companyDomain.length > 10) {
    throw new CloduraError(400, "You may specify at most 10 company domains per search.");
  }

  // Translate our friendly filter shape to Clodura's exact wire field
  // names. Earlier the request was sent through as-is, which meant
  // Clodura silently ignored every renamed filter (city, state, country,
  // company, employeeSize, technology, etc.) and returned zero matches.
  // Reference: Clodura API Reference Guide §2.1, Request Body Parameters.
  const body: Record<string, unknown> = {
    page: params.page ?? 1,
    perPage: params.perPage ?? 25,
  };
  if (params.firstName) body.firstName = params.firstName;
  if (params.lastName) body.lastName = params.lastName;
  if (params.linkedinUrl) body.linkedinUrl = params.linkedinUrl;
  if (params.personTitle?.length) {
    // Clodura wants a single string + an includeSimilarTitles flag.
    // Pass the first entry; downstream callers that want strict
    // multi-title should fan out and merge.
    body.personTitle = params.personTitle[0];
  }
  if (params.seniority?.length) body.seniority = params.seniority;
  if (params.functional?.length) body.functional = params.functional;
  if (params.industry?.length) body.industry = params.industry;
  if (params.revenue?.length) body.revenue = params.revenue;
  if (params.companyDomain?.length) body.companyDomain = params.companyDomain;
  // Renamed fields → also expand US state and country abbreviations to
  // their full names because Clodura's reference data stores full names
  // (per their API guide example: "personCountry": ["United States"]).
  // Sending "VA" alone never matches; we send both "VA" and "Virginia".
  if (params.company?.length) body.organizationName = params.company[0];
  if (params.city?.length) body.personCity = params.city;
  if (params.state?.length) body.personState = expandStates(params.state);
  if (params.country?.length) body.personCountry = expandCountries(params.country);
  if (params.employeeSize?.length) body.companyEmployeeSize = params.employeeSize;
  if (params.technology?.length) body.technologyParameters = params.technology;

  // Per Clodura's API reference (HTTP Status Code table): 404 from
  // /search/people means "No Results found, may be you can tweak the
  // filters" — their semantic "empty result" code, NOT "endpoint
  // missing". Catch it and return an empty page instead of bubbling
  // the error up to the UI as a generic 404 toast.
  // Diagnostic — surface exactly what we sent + what came back so we
  // can verify field-name translation and response shape end-to-end.
  // Strip the apiKey from logging by virtue of never including it in `body`.
  console.log(
    `[Clodura.search] request body=${JSON.stringify(body).slice(0, 400)}`,
  );
  try {
    const raw = await cloduraFetch<unknown>("/search/people", {
      method: "POST",
      body: JSON.stringify(body),
      apiKey,
    });
    // First 600 chars of the raw response — enough to see the envelope
    // shape and the first row or two without flooding logs on big pages.
    console.log(
      `[Clodura.search] response keys=${Object.keys((raw ?? {}) as Record<string, unknown>).join(",")} sample=${JSON.stringify(raw).slice(0, 600)}`,
    );
    const normalized = normalizeSearchResponse(raw, params.page ?? 1, params.perPage ?? 25);
    console.log(
      `[Clodura.search] normalized total=${normalized.total} data.length=${normalized.data.length}`,
    );
    return normalized;
  } catch (e) {
    if (e instanceof CloduraError && e.statusCode === 404) {
      // Surface the 404 + probe /credits with the SAME api key so we
      // can tell two failure modes apart:
      //  - credits 200 + search 404 → auth works, Clodura genuinely
      //    has no matching rows (or our payload doesn't hit any).
      //  - credits 4xx/5xx → auth or entitlement issue masquerading
      //    as a search 404.
      let creditDiag = "(probe skipped)";
      try {
        const c = await cloduraFetch<unknown>("/credits", { method: "GET", apiKey });
        creditDiag = `OK ${JSON.stringify(c).slice(0, 150)}`;
      } catch (probeErr) {
        const pe = probeErr as CloduraError;
        creditDiag = `${pe.statusCode ?? "?"} ${pe.message ?? String(probeErr)}`.slice(0, 200);
      }
      console.log(
        `[Clodura.search] 404 (no results) for body=${JSON.stringify(body).slice(0, 200)} — /credits probe: ${creditDiag}`,
      );
      return {
        data: [],
        page: params.page ?? 1,
        perPage: params.perPage ?? 25,
        total: 0,
      };
    }
    throw e;
  }
}

// Normalize common state / country shorthand to full names that Clodura's
// reference data actually contains. We keep the caller's original values
// AND add the expanded form so a search for ["VA"] becomes
// ["VA", "Virginia"] — Clodura ORs across array values, so the chance of
// matching their stored format goes up without dropping the caller's intent.
const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
  SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};
const COUNTRY_NAMES: Record<string, string> = {
  US: "United States", USA: "United States",
  UK: "United Kingdom", GB: "United Kingdom",
  CA_COUNTRY: "Canada", // (CA collides with California; users normally type "Canada" in country)
};

function expandStates(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return values;
  const out = new Set<string>();
  for (const v of values) {
    const trimmed = v.trim();
    if (!trimmed) continue;
    out.add(trimmed);
    const upper = trimmed.toUpperCase();
    if (US_STATE_NAMES[upper]) out.add(US_STATE_NAMES[upper]);
    // Also normalize Title Case if the user typed all lowercase.
    if (trimmed !== trimmed[0].toUpperCase() + trimmed.slice(1).toLowerCase()) {
      out.add(trimmed[0].toUpperCase() + trimmed.slice(1).toLowerCase());
    }
  }
  return Array.from(out);
}

function expandCountries(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return values;
  const out = new Set<string>();
  for (const v of values) {
    const trimmed = v.trim();
    if (!trimmed) continue;
    out.add(trimmed);
    const upper = trimmed.toUpperCase();
    if (COUNTRY_NAMES[upper]) out.add(COUNTRY_NAMES[upper]);
  }
  return Array.from(out);
}

/**
 * Translate Clodura's wire response shape into our local CloduraSearchResponse.
 * Their docs aren't explicit about the /search/people response envelope but
 * peer endpoints (orgs search §3.1, webhook tracking §2.5) use
 * `{ pagination: {...}, people: [...] }`. Be lenient and accept variants
 * (people/data/results, pagination/total_entries/total) so we don't break
 * silently if they reshape the response again.
 */
function normalizeSearchResponse(
  raw: unknown,
  fallbackPage: number,
  fallbackPerPage: number,
): CloduraSearchResponse {
  const r = (raw ?? {}) as Record<string, unknown>;
  const data = (r.people ?? r.data ?? r.results ?? []) as CloduraPersonResult[];
  const pag = (r.pagination ?? {}) as Record<string, unknown>;
  const total = Number(pag.total_entries ?? pag.total ?? r.total ?? data.length ?? 0);
  const page = Number(pag.page ?? r.page ?? fallbackPage);
  const perPageRaw = pag.per_page ?? pag.perPage ?? r.perPage ?? fallbackPerPage;
  const perPage = Number(perPageRaw);
  return { data, total, page, perPage };
}

/* ─── Reveal email ────────────────────────────────────────────────────────── */
export interface CloduraRevealEmailParams {
  personId: string;
  webhookUrl: string;
}

export interface CloduraRevealResponse {
  trackingId: string;
  status: "queued" | "completed";
  email?: string;
  phone?: string;
}

export async function revealEmail(
  params: CloduraRevealEmailParams,
  apiKey?: string,
): Promise<CloduraRevealResponse> {
  return cloduraFetch<CloduraRevealResponse>("/search/people/email/match", {
    method: "POST",
    body: JSON.stringify(params),
    apiKey,
  });
}

/* ─── Reveal phone ────────────────────────────────────────────────────────── */
export async function revealPhone(
  params: CloduraRevealEmailParams,
  apiKey?: string,
): Promise<CloduraRevealResponse> {
  return cloduraFetch<CloduraRevealResponse>("/search/people/phone/match", {
    method: "POST",
    body: JSON.stringify(params),
    apiKey,
  });
}

/* ─── Credits ─────────────────────────────────────────────────────────────── */
// Per Clodura API Reference v1, the response shape varies by plan:
//   Free Forever / Max / PAYG: { remainingCredits: number }
//   Prospect / Prospect Pro:    { contactsView, maxContacts, directDials, maxDirectDials }
export interface CloduraCreditsResponse {
  remainingCredits?: number;
  contactsView?: number;
  maxContacts?: number | string;
  directDials?: number;
  maxDirectDials?: number;
}

export async function getCredits(apiKey?: string): Promise<CloduraCreditsResponse> {
  return cloduraFetch<CloduraCreditsResponse>("/credits", { method: "GET", apiKey });
}

/* ─── Taxonomies ──────────────────────────────────────────────────────────── */
// Path is /api/v1/search/taxonomy. The exact way to pass `type` (query string,
// path segment, or POST body) isn't yet confirmed against a curl example —
// going with `?type=...` query string as the most common REST convention.
// If a curl example shows otherwise, swap accordingly.
export type TaxonomyType = "seniority" | "functional" | "industry" | "technology" | "country" | "employeeSize" | "revenue";

export async function getTaxonomy(
  type: TaxonomyType,
  apiKey?: string,
): Promise<string[]> {
  const res = await cloduraFetch<{ data: string[] }>(
    `/search/taxonomy?type=${encodeURIComponent(type)}`,
    { apiKey },
  );
  return res.data;
}

/* ─── Enrich (Cleanup & Enrich endpoint) ─────────────────────────────────── */
export interface CloduraEnrichParams {
  // Identifier set — send whichever is available (priority order)
  linkedinUrl?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  orgLinkedinUrl?: string;
  company?: string;
}

export interface CloduraEnrichResponse {
  personId?: string;
  personTitle?: string;
  seniority?: string[];
  functional?: string[];
  personCity?: string;
  personState?: string;
  personCountry?: string;
  linkedinUrl?: string;
  organisation?: {
    organisationId?: string;
    organisationName?: string;
    domain?: string;
    industry?: string;
    organisationEmployeeSize?: string;
    revenue?: string;
    foundedYear?: number;
    boardlineNumbers?: string;
    organisationCity?: string;
    organisationState?: string;
    organisationCountry?: string;
  };
}

export async function enrichContact(
  params: CloduraEnrichParams,
  apiKey?: string,
): Promise<CloduraEnrichResponse | null> {
  try {
    const res = await cloduraFetch<{ data: CloduraEnrichResponse[] }>("/cleanup/enrich", {
      method: "POST",
      body: JSON.stringify(params),
      apiKey,
    });
    return res.data?.[0] ?? null;
  } catch (e) {
    if (e instanceof CloduraError && e.statusCode === 404) return null;
    throw e;
  }
}
