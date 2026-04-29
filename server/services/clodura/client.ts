/**
 * Clodura.ai API Client
 * Pluggable — swap provider by replacing this module.
 * All methods throw typed CloduraError so callers can map to HTTP status codes.
 */
import { TRPCError } from "@trpc/server";

const CLODURA_BASE = "https://api.clodura.ai/api/v1";
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

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
          "x-api-key": key,
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
        let body: unknown;
        try { body = await res.json(); } catch { body = await res.text().catch(() => null); }
        throw new CloduraError(res.status, (body as any)?.message ?? `HTTP ${res.status}`, body);
      }

      return res.json() as Promise<T>;
    } catch (e) {
      if (e instanceof CloduraError) throw e;
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * Math.pow(2, attempt)));
        lastError = new CloduraError(0, (e as Error).message);
        continue;
      }
      throw new CloduraError(0, (e as Error).message);
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

  return cloduraFetch<CloduraSearchResponse>("/people/search", {
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
  return cloduraFetch<CloduraRevealResponse>("/people/reveal/email", {
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
  return cloduraFetch<CloduraRevealResponse>("/people/reveal/phone", {
    method: "POST",
    body: JSON.stringify(params),
    apiKey,
  });
}

/* ─── Credits ─────────────────────────────────────────────────────────────── */
export interface CloduraCreditsResponse {
  remaining: number;
  used: number;
  total: number;
  resetAt?: string;
}

export async function getCredits(apiKey?: string): Promise<CloduraCreditsResponse> {
  return cloduraFetch<CloduraCreditsResponse>("/account/credits", { apiKey });
}

/* ─── Taxonomies ──────────────────────────────────────────────────────────── */
export type TaxonomyType = "seniority" | "functional" | "industry" | "technology" | "country" | "employeeSize" | "revenue";

export async function getTaxonomy(
  type: TaxonomyType,
  apiKey?: string,
): Promise<string[]> {
  const res = await cloduraFetch<{ data: string[] }>(`/taxonomies/${type}`, { apiKey });
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
    const res = await cloduraFetch<{ data: CloduraEnrichResponse[] }>("/people/enrich", {
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
