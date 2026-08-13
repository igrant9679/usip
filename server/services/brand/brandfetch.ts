/**
 * Brandfetch provider — the passive brand-identity layer.
 *
 * Two deliberately separated halves, matching Brandfetch's two client IDs:
 *
 *  - `brandfetchLogoUrl` is a PURE URL builder for their Logo Link CDN. No
 *    request is ever made server-side: their terms require logos to be
 *    hotlinked and treat programmatic fetching as scraping (blockable), so
 *    the ONLY thing that ever loads these URLs is the user's browser at
 *    render time — exactly the embedded usage the product is designed for.
 *    `fallback/404` makes unknown brands fail fast so the client-side
 *    cascade (stored site icon → monogram) takes over.
 *
 *  - `searchBrand` (Brand Search API) DOES call out, so it is dormant by
 *    design: nothing in any enrichment path invokes it. It exists behind
 *    the BrandIdentityProvider seam for the explicit admin action today and
 *    the future company-enrichment stack. Search responses must not be
 *    cached beyond 24h per their terms; we return them transiently and
 *    store only facts we derive ourselves.
 *
 * Config: BRANDFETCH_LOGO_CLIENT_ID (public by design — it rides in every
 * <img> URL) and BRANDFETCH_SEARCH_CLIENT_ID (server-side only). Absent
 * keys leave the layer dormant, never broken.
 */

import { brandfetchLogoUrl, type BrandLogoOptions } from "@shared/brandfetch";

export { brandfetchLogoUrl, type BrandLogoOptions };

export interface BrandSearchHit {
  name: string | null;
  domain: string | null;
  /** Their icon URLs expire within 24h — display transiently, never store. */
  icon: string | null;
  brandId: string | null;
  claimed: boolean;
}

export interface BrandIdentityProvider {
  readonly name: string;
  /** True when this provider can serve logo URLs (config present). */
  logoReady(): boolean;
  logoUrl(domain: string | null | undefined, opts?: BrandLogoOptions): string | null;
  /** True when brand search can be used (config present). */
  searchReady(): boolean;
  searchBrand(query: string): Promise<BrandSearchOutcome>;
}

/**
 * A search either answered or it didn't — and the difference matters.
 *
 * Collapsing both into `[]` (what this did until 2026-08-13) makes a dead key,
 * a 429, and a genuine "no such brand" identical to the caller. The reconciler
 * then stores a no_match observation and negative-caches it for a WEEK, so one
 * bad afternoon of 401s quietly blocks every affected account from being
 * retried. `ok: false` means "we learned nothing" and must never be recorded
 * as evidence about the brand.
 */
export type BrandSearchOutcome =
  | { ok: true; hits: BrandSearchHit[] }
  | { ok: false; reason: "not_configured" | "auth" | "rate_limit" | "http" | "malformed" | "network"; status?: number };

const SEARCH_TIMEOUT_MS = 8_000;

export function createBrandfetchProvider(env: {
  logoClientId?: string | null;
  searchClientId?: string | null;
} = {
  logoClientId: process.env.BRANDFETCH_LOGO_CLIENT_ID,
  searchClientId: process.env.BRANDFETCH_SEARCH_CLIENT_ID,
}): BrandIdentityProvider {
  return {
    name: "brandfetch",
    logoReady: () => !!env.logoClientId,
    logoUrl: (domain, opts) => brandfetchLogoUrl(domain, env.logoClientId, opts),
    searchReady: () => !!env.searchClientId,
    async searchBrand(query: string): Promise<BrandSearchOutcome> {
      if (!env.searchClientId) return { ok: false, reason: "not_configured" };
      if (!query.trim()) return { ok: true, hits: [] };
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(
            `https://api.brandfetch.io/v2/search/${encodeURIComponent(query.trim())}?c=${encodeURIComponent(env.searchClientId)}`,
            { signal: ctrl.signal },
          );
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) {
          const reason = res.status === 401 || res.status === 403 ? "auth" : res.status === 429 ? "rate_limit" : "http";
          return { ok: false, reason, status: res.status };
        }
        const json = (await res.json()) as unknown;
        if (!Array.isArray(json)) return { ok: false, reason: "malformed" };
        const hits = json.slice(0, 10).map((r) => {
          const hit = r as Record<string, unknown>;
          return {
            name: typeof hit.name === "string" ? hit.name : null,
            domain: typeof hit.domain === "string" ? hit.domain : null,
            icon: typeof hit.icon === "string" ? hit.icon : null,
            brandId: typeof hit.brandId === "string" ? hit.brandId : null,
            claimed: hit.claimed === true,
          };
        });
        return { ok: true, hits };
      } catch {
        return { ok: false, reason: "network" };
      }
    },
  };
}
