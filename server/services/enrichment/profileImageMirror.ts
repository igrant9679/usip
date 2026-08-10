/**
 * Profile-photo mirroring — signed CDN URLs become self-contained data URIs.
 *
 * LinkedIn (via Unipile) hands back media.licdn.com image URLs that are
 * SIGNED with an expiry (`?e=<epoch>` — roughly two weeks out). Storing the
 * URL means every enriched avatar 403s in unison when the signatures lapse
 * and the whole People page silently reverts to initials. So the permitted
 * photo is downloaded ONCE at apply time and stored inline as a small JPEG
 * data URI — the same self-contained form the user-upload path already uses,
 * and one resolveProspectProfileImage already whitelists.
 *
 * Size discipline: licdn `_100_100` display-photo variants run a few KB, and
 * uploadProfileImage's existing inline budget is 60 000 chars. Base64 inflates
 * bytes 4/3, so the byte cap is set to keep the final URI under that budget —
 * anything larger keeps its https URL (better two weeks of avatar than none)
 * rather than bloating the row.
 *
 * Compliance unchanged: mirroring runs ONLY where the https URL was already
 * permitted to be stored/displayed. It changes where the pixels live, not who
 * may see them.
 */

/** Byte cap chosen so prefix + base64(bytes) stays under the 60k-char inline
 *  budget shared with uploadProfileImage (43 000 × 4⁄3 ≈ 57.3k chars). */
export const MAX_INLINE_IMAGE_BYTES = 43_000;

/** Expiry epoch (seconds) from a signed licdn URL's `e=` param, or null. */
export function licdnExpiryEpoch(url: string | null | undefined): number | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/(^|\.)licdn\.com$/i.test(u.hostname)) return null;
    const e = u.searchParams.get("e");
    if (!e || !/^\d{9,12}$/.test(e)) return null;
    return Number(e);
  } catch {
    return null;
  }
}

/** Is this a signed licdn URL whose signature has already lapsed? */
export function isExpiredLicdnUrl(url: string | null | undefined, nowMs = Date.now()): boolean {
  const epoch = licdnExpiryEpoch(url);
  return epoch != null && epoch * 1000 < nowMs;
}

/** Bytes → `data:<type>;base64,…`, or null when over the inline budget. */
export function bytesToDataUri(bytes: Uint8Array, contentType: string): string | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_IMAGE_BYTES) return null;
  const type = /^image\/[a-z0-9.+-]+$/i.test(contentType) ? contentType.toLowerCase() : "image/jpeg";
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

export type MirrorResult =
  | { ok: true; dataUri: string }
  | { ok: false; reason: "expired" | "not_image" | "too_large" | "network" | `http_${number}` };

/**
 * Download a permitted image and inline it. Never throws.
 * An HTTP failure on an already-expired signature reports "expired" so the
 * caller can mark the stored status honestly instead of retrying forever.
 */
export async function mirrorImageToDataUri(url: string): Promise<MirrorResult> {
  if (isExpiredLicdnUrl(url)) return { ok: false, reason: "expired" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // A 4xx on a signed-but-now-expired URL is the expiry, not a flake.
      if (isExpiredLicdnUrl(url)) return { ok: false, reason: "expired" };
      return { ok: false, reason: `http_${res.status}` as const };
    }
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!contentType.startsWith("image/")) return { ok: false, reason: "not_image" };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const dataUri = bytesToDataUri(bytes, contentType);
    if (!dataUri) return { ok: false, reason: "too_large" };
    return { ok: true, dataUri };
  } catch {
    return { ok: false, reason: "network" };
  }
}
