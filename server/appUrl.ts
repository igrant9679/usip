/**
 * The ONE public origin of this app.
 *
 * Every URL we hand to a stranger is built from this: booking links (/b/:slug),
 * landing pages, open-tracking pixels, one-click unsubscribe, invite links.
 * Get it wrong and none of them fail loudly — they just 404 for the recipient
 * while every screen in the app keeps showing green.
 *
 * That is exactly what happened. There were two helpers doing this job and they
 * disagreed:
 *
 *   getAppBaseUrl()  (crm.ts, sequences.ts)  → MANUS_APP_URL … → getvelocityai.app  ✅
 *   appBaseUrl()     (+ 4 inline copies)     → VITE_OAUTH_PORTAL_URL.origin        ❌
 *
 * `VITE_OAUTH_PORTAL_URL` is the IDENTITY PROVIDER's URL, not this app's. In
 * production it is a manus.im address, so the second chain emitted
 * https://manus.im/b/…, https://manus.im/api/track/open/… and
 * https://manus.im/api/track/unsubscribe/… — all verified 404. Booking CTAs went
 * nowhere, open tracking recorded nothing, and RFC 8058 one-click unsubscribe was
 * dead, which is a compliance problem rather than a cosmetic one.
 *
 * So: one helper, and `VITE_OAUTH_PORTAL_URL` is deliberately NOT in the chain.
 * Never reintroduce it here, and never build a public URL from anything else.
 */

/** Where this product is actually deployed. Override with PUBLIC_APP_URL. */
const PRODUCTION_ORIGIN = "https://getvelocityai.app";

function normalize(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

export function appBaseUrl(): string {
  // 1. Explicit, and the only thing a new deployment should need to set.
  const explicit = process.env.PUBLIC_APP_URL && normalize(process.env.PUBLIC_APP_URL);
  if (explicit) return explicit;

  // 2. Honoured by the half of the codebase that was already correct.
  const manusApp = process.env.MANUS_APP_URL && normalize(process.env.MANUS_APP_URL);
  if (manusApp) return manusApp;

  // 3. Railway hands the running service its own public domain.
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) {
    const fromRailway = normalize(railway.startsWith("http") ? railway : `https://${railway}`);
    if (fromRailway) return fromRailway;
  }

  // 4. Local work gets localhost; anything else is a real deployment of THIS
  //    product, and a wrong-but-live origin beats a link to localhost.
  return process.env.NODE_ENV === "development" ? "http://localhost:3000" : PRODUCTION_ORIGIN;
}

/** Join the app origin with a path, without doubling or dropping the slash. */
export function appUrl(path: string): string {
  return `${appBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
