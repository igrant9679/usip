/**
 * publicCaptureGuard — is a public form or landing-page submission from a
 * person? (audit 2026-10-20, F47; the honeypot came first, under G41.)
 *
 * Three layers, cheapest first:
 *   1. the honeypot (services/publicSubmission.ts): a filled hidden field is
 *      answered as a success and nothing is kept;
 *   2. time to submit: the page carries a signed "rendered at" token from the
 *      read that served it, and a submission needs one that is genuine, under a
 *      day old and at least MIN_SUBMIT_MS old. A script posting straight to the
 *      endpoint has no token; one that fetches the page first has to wait.
 *      A person who is too quick is told so and can press Submit again: a
 *      real lead is never dropped silently by this check;
 *   3. Cloudflare Turnstile, ONLY when a site key and a secret are both set,
 *      in Settings → Integrations (the workspace's own pair) or in the
 *      TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY environment variables. With
 *      neither, nothing changes and no request leaves for Cloudflare. No key
 *      lives in the repo.
 *
 * The rate limits in publicRateLimit.ts sit in front of all of this.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { workspaceIntegrations } from "../../drizzle/schema";
import { getDb } from "../db";
import { ENV } from "../_core/env";
import { tryDecryptSecret } from "../_core/crypto";

/** Faster than a person can read a form and fill one field. */
export const MIN_SUBMIT_MS = 3_000;
/** A page left open longer than this is asked to reload: its token is stale. */
export const SUBMIT_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const TURNSTILE_PROVIDER = "turnstile" as const;
/** Config field holding the secret's ciphertext (redacted by integrations.list as hasSecretKey). */
export const TURNSTILE_SECRET_FIELD = "secretKeyEnc";
export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const CAPTURE_STALE = "This page is out of date. Please reload it and submit again.";
export const CAPTURE_TOO_FAST = "That was quicker than a person can fill this in. Please check your details and press Submit again.";
export const CAPTURE_CHALLENGE = "Please complete the verification check, then submit again.";

function signingKey(): string {
  return ENV.cookieSecret || ENV.encryptionKey || "velocity-capture";
}

function mac(scope: string, issuedMs: number): string {
  return createHmac("sha256", signingKey()).update(`capture|${scope}|${issuedMs}`).digest("base64url").slice(0, 32);
}

/**
 * The token a public page carries: when it was served, signed for this one
 * form or page (`scope`), so it cannot be minted by a caller or moved to
 * another form.
 */
export function issueSubmitToken(scope: string, nowMs = Date.now()): string {
  return `${nowMs.toString(36)}.${mac(scope, nowMs)}`;
}

export type SubmitTokenCheck = "ok" | "missing" | "invalid" | "stale" | "too_fast";

export function checkSubmitToken(scope: string, token: string | null | undefined, nowMs = Date.now()): SubmitTokenCheck {
  if (!token) return "missing";
  const dot = token.indexOf(".");
  if (dot <= 0) return "invalid";
  const issued = parseInt(token.slice(0, dot), 36);
  if (!Number.isFinite(issued)) return "invalid";
  const want = Buffer.from(mac(scope, issued));
  const got = Buffer.from(token.slice(dot + 1));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return "invalid";
  const age = nowMs - issued;
  if (age < 0 || age > SUBMIT_TOKEN_MAX_AGE_MS) return "stale";
  if (age < MIN_SUBMIT_MS) return "too_fast";
  return "ok";
}

export type TurnstileConfig = { siteKey: string; secret: string; source: "workspace" | "environment" };

/**
 * The Turnstile pair in force for a workspace: its own (Settings →
 * Integrations), else the environment's, else none. Both halves are needed:
 * a site key with no secret would show a widget nobody can verify.
 */
export async function turnstileConfig(workspaceId: number): Promise<TurnstileConfig | null> {
  try {
    const db = await getDb();
    if (db) {
      const [row] = await db.select({ config: workspaceIntegrations.config, status: workspaceIntegrations.status })
        .from(workspaceIntegrations)
        .where(and(eq(workspaceIntegrations.workspaceId, workspaceId), eq(workspaceIntegrations.provider, TURNSTILE_PROVIDER)))
        .limit(1);
      const cfg = (row?.config ?? {}) as Record<string, unknown>;
      const siteKey = typeof cfg.siteKey === "string" ? cfg.siteKey.trim() : "";
      const secret = typeof cfg[TURNSTILE_SECRET_FIELD] === "string" ? tryDecryptSecret(cfg[TURNSTILE_SECRET_FIELD] as string) : "";
      if (row && row.status !== "disconnected" && siteKey && secret) return { siteKey, secret, source: "workspace" };
    }
  } catch (e) {
    console.error("[publicCaptureGuard] turnstile config read failed:", e instanceof Error ? e.message : e);
  }
  const envSite = (process.env.TURNSTILE_SITE_KEY ?? "").trim();
  const envSecret = (process.env.TURNSTILE_SECRET_KEY ?? "").trim();
  return envSite && envSecret ? { siteKey: envSite, secret: envSecret, source: "environment" } : null;
}

/** Only the public half, for the page. */
export async function turnstileSiteKey(workspaceId: number): Promise<string | null> {
  return (await turnstileConfig(workspaceId))?.siteKey ?? null;
}

/**
 * Ask Cloudflare whether the widget's token is good. `unreachable` when
 * Cloudflare cannot be asked (network, timeout, a 5xx): the caller lets the
 * submission through on that, because the honeypot and the timing check have
 * already passed and a Cloudflare outage must not drop every lead.
 */
export async function verifyTurnstile(secret: string, token: string, ip?: string | null): Promise<"ok" | "failed" | "unreachable"> {
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status >= 500) return "unreachable";
    const out = (await res.json().catch(() => null)) as { success?: boolean } | null;
    return out?.success === true ? "ok" : "failed";
  } catch (e) {
    console.error("[publicCaptureGuard] Turnstile verify unreachable:", e instanceof Error ? e.message : e);
    return "unreachable";
  }
}

/**
 * Layers 2 and 3, for a submission the honeypot has already let through.
 * Throws BAD_REQUEST with words a person can act on.
 */
export async function assertHumanSubmission(opts: {
  workspaceId: number;
  scope: string;
  submitToken?: string | null;
  turnstileToken?: string | null;
  ip?: string | null;
  nowMs?: number;
}): Promise<void> {
  const t = checkSubmitToken(opts.scope, opts.submitToken, opts.nowMs);
  if (t === "too_fast") throw new TRPCError({ code: "BAD_REQUEST", message: CAPTURE_TOO_FAST });
  if (t !== "ok") throw new TRPCError({ code: "BAD_REQUEST", message: CAPTURE_STALE });
  const ts = await turnstileConfig(opts.workspaceId);
  if (!ts) return;
  if (!opts.turnstileToken) throw new TRPCError({ code: "BAD_REQUEST", message: CAPTURE_CHALLENGE });
  const v = await verifyTurnstile(ts.secret, opts.turnstileToken, opts.ip);
  if (v === "failed") throw new TRPCError({ code: "BAD_REQUEST", message: CAPTURE_CHALLENGE });
}

/** The scope a token is signed for. */
export const formScope = (publicId: string) => `form:${publicId}`;
export const landingScope = (slug: string) => `landing:${slug}`;
