/**
 * The caller's address, as the app's own proxy saw it.
 *
 * 🔴 WHY THIS EXISTS (audit 2026-10-20, "Also urgent"). Every rate limit in the
 * app — password login, 2FA, register, forgot/reset password, the public chat
 * and form ceilings, the per-IP LLM funnel — keyed on the FIRST entry of
 * `X-Forwarded-For`. Nothing called `app.set("trust proxy", …)`, so that entry
 * was whatever the CALLER wrote: rotate the header on each request and every
 * request lands in a fresh bucket. Ten guesses per fifteen minutes became
 * unlimited guesses.
 *
 * The fix is Express's own: tell it how many proxies stand in front of the
 * app, and read `req.ip`, which walks `X-Forwarded-For` from the RIGHT and
 * stops at the first address no trusted proxy vouched for. Railway's edge is
 * one hop (`Server: railway-hikari`, `x-railway-edge` on every response), so
 * the default is 1. Whether the edge appends to a client-sent header or
 * replaces it, the rightmost entry is the one the edge wrote.
 *
 * ⚠️ TOO FEW TRUSTED HOPS IS SAFE, TOO MANY IS NOT. One hop too few keys every
 * visitor on the edge's own address — one shared bucket, a lockout, but not a
 * bypass. One hop too many trusts a caller-written entry again. If a CDN is
 * ever put in front of Railway, set TRUST_PROXY to the new hop count (or to
 * the proxies' subnets, which Express also accepts) rather than raising the
 * default here.
 */
import type { Express } from "express";
import { ipKeyGenerator } from "express-rate-limit";

/** The value handed to `app.set("trust proxy", …)`. */
export function trustProxySetting(raw: string | undefined = process.env.TRUST_PROXY): number | string | false {
  const v = (raw ?? "").trim();
  if (!v) return 1;
  if (v === "false") return false;
  // `true` trusts EVERY hop, which is the first-entry bug again under a new
  // name. Refused rather than honoured.
  if (v === "true") return 1;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0) return n;
  // Express also takes a comma-separated list of addresses / subnets.
  return v;
}

export function configureTrustProxy(app: Express): void {
  app.set("trust proxy", trustProxySetting());
}

/**
 * `req.ip` when Express computed one, else the socket peer. Never empty: an
 * empty key would put every visitor in one bucket.
 */
export function clientIpOf(req: { ip?: unknown; socket?: { remoteAddress?: string } | null } | null | undefined): string {
  const fromExpress = typeof req?.ip === "string" ? req.ip.trim() : "";
  const fromSocket = (req?.socket?.remoteAddress ?? "").trim();
  return fromExpress || fromSocket || "unknown";
}

/**
 * The key every express-rate-limit instance uses. `ipKeyGenerator` folds an
 * IPv6 address to its /56, the library's own default: one subscriber holds a
 * whole block, and keying on the full address would hand them 2^72 buckets.
 */
export function rateLimitKey(req: Parameters<typeof clientIpOf>[0]): string {
  return ipKeyGenerator(clientIpOf(req));
}
