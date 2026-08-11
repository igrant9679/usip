/**
 * Brandfetch Logo Link URL builder — PURE, shared by server and client so
 * there is exactly one definition of how a logo URL is constructed.
 *
 * No code anywhere fetches these URLs server-side: Brandfetch's terms
 * require hotlinking (the user's browser loads them at render time) and
 * treat programmatic access as scraping. `fallback/404` makes unknown
 * brands fail fast so the client-side cascade (stored site icon → monogram)
 * takes over.
 */

export interface BrandLogoOptions {
  /** Match the UI background: "dark" serves the variant made for dark UIs. */
  theme?: "light" | "dark";
  /** icon/symbol = square mark (rows, avatars); logo = full wordmark. */
  type?: "icon" | "symbol" | "logo";
  /** Square pixel budget; request 2× for high-DPI and render at half. */
  size?: number;
  /** What the CDN serves for unknown brands. 404 lets our cascade act. */
  fallback?: "404" | "lettermark" | "transparent";
}

export function brandfetchLogoUrl(
  domain: string | null | undefined,
  clientId: string | null | undefined,
  opts: BrandLogoOptions = {},
): string | null {
  const d = (domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!clientId || !d || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return null;
  const segments: string[] = [encodeURIComponent(d)];
  if (opts.theme) segments.push("theme", opts.theme);
  if (opts.size) {
    const s = Math.max(16, Math.min(512, Math.round(opts.size)));
    segments.push("w", String(s), "h", String(s));
  }
  segments.push("fallback", opts.fallback ?? "404");
  if (opts.type) segments.push(opts.type);
  return `https://cdn.brandfetch.io/${segments.join("/")}?c=${encodeURIComponent(clientId)}`;
}
