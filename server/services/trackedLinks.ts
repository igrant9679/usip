/**
 * Signed click-tracking links (audit 2026-10-20, G43).
 *
 * `/api/track/click/:token?url=…` redirected to any http(s) URL in its query
 * string, so a link on our own domain could be made to land anywhere: an open
 * redirect, the thing phishing mail is built from. The links we write now
 * carry `sig`, an HMAC over the tracking token and the destination, and only a
 * signed pair is redirected straight away. Mail sent before this has no `sig`;
 * its links still work, through a page that shows where they go and asks.
 */
import { createHmac, timingSafeEqual } from "crypto";

function secret(): string {
  const k = process.env.JWT_SECRET || process.env.ENCRYPTION_KEY || "";
  if (!k && process.env.NODE_ENV === "production") throw new Error("No server secret for tracked links");
  return `track-click:${k || "dev-only"}`;
}

/** 128 bits of HMAC, base64url: short enough for a query string, long enough to never be guessed. */
export function clickSignature(token: string, url: string): string {
  return createHmac("sha256", secret()).update(`${token}\n${url}`).digest("base64url").slice(0, 22);
}

export function isSignedClick(token: string, url: string, sig: unknown): boolean {
  if (typeof sig !== "string" || !sig) return false;
  const want = Buffer.from(clickSignature(token, url));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
