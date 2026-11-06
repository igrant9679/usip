/**
 * The headers a workflow webhook may carry (audit 2026-10-20, G19).
 *
 * A webhook action's `params.headers` came straight from the rule (typed by a
 * member, or written by the AI suggester) and was spread over the request's
 * own headers, after Content-Type, so it could replace Content-Type and set
 * Host, Cookie, X-Forwarded-For or hop-by-hop headers on a request the server
 * makes. The SSRF guard decides WHERE a webhook may go; this decides what it
 * may claim when it gets there.
 *
 * Kept: `Authorization` and custom `X-…` headers, which is what a receiving
 * endpoint's shared secret needs. Dropped: everything else, any header that
 * names the client, the host or the forwarding chain, and any value with a
 * line break in it. The rule editor offers no header field, so nothing built
 * in the app loses anything.
 */

const MAX_HEADERS = 10;
const MAX_VALUE = 1024;
const DROPPED_X = new Set([
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip",
  "x-original-url", "x-rewrite-url", "x-http-method-override", "x-csrf-token", "x-workspace-id",
]);

export function safeWebhookHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_HEADERS) break;
    const key = name.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(key)) continue;
    if (key !== "authorization" && !(key.startsWith("x-") && !DROPPED_X.has(key))) continue;
    if (typeof value !== "string" && typeof value !== "number") continue;
    const v = String(value);
    if (/[\r\n\0]/.test(v) || v.length > MAX_VALUE) continue;
    out[key] = v;
  }
  return out;
}
