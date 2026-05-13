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
// The "people search" endpoint path is overridable because Clodura has
// renamed it before (we've seen /search/people, /people/search, and
// /v2/people/search across SDK versions). Set CLODURA_SEARCH_PATH on
// Railway to whatever the current docs say if you hit a 404 here.
const CLODURA_SEARCH_PATH = process.env.CLODURA_SEARCH_PATH || "/search/people";
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

  return cloduraFetch<CloduraSearchResponse>(CLODURA_SEARCH_PATH, {
    method: "POST",
    body: JSON.stringify({
      ...params,
      page: params.page ?? 1,
      perPage: params.perPage ?? 25,
    }),
    apiKey,
  });
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
