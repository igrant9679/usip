/**
 * One gate for the `/api/scheduled/*` cron entry points.
 *
 * These are not user surfaces. Each one iterates EVERY workspace, and between
 * them they create tasks, write activities, send mail to a client's real inbox,
 * flip proposals to `not_accepted`, and run an LLM call per workspace. None of
 * that should be reachable by anyone who can spell the URL.
 *
 * `icp-regen` learned this already — its own comment records that it "was
 * completely unauthenticated — anyone could run up the bill" — and grew a
 * SCHEDULED_TASK_SECRET check. Its two siblings, registered by the same
 * function in the same file, never got one. The same job three times with one
 * of them right is the shape this repo keeps producing, so this is a helper
 * rather than a third copy.
 *
 * ⚠️ FAIL-OPEN when SCHEDULED_TASK_SECRET is unset. That is deliberate and
 * carried over unchanged from the icp-regen original: the external scheduler is
 * the ONLY trigger for two of the three endpoints (only ICP regen also runs on
 * an internal timer), so demanding a secret nobody has configured yet would
 * silently stop the client follow-up mail rather than protect it. An unset
 * secret is reported at boot by `_core/secretHealth.ts`, which exists for
 * exactly this class of "degrades quietly instead of failing".
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

/** Header the external scheduler presents. */
export const SCHEDULED_SECRET_HEADER = "x-scheduled-secret";

/**
 * Constant-time compare. A length mismatch short-circuits — timingSafeEqual
 * throws on unequal lengths, and the length of a shared secret is not the part
 * worth hiding.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True when the deployment has configured a secret at all. */
export function scheduledSecretConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SCHEDULED_TASK_SECRET);
}

/**
 * Returns true when the caller may proceed.
 *
 * On refusal it has ALREADY written the 401, so every caller must `return`
 * immediately — and must call this BEFORE it touches the database. A check
 * that runs after the work is not a check.
 */
export function requireScheduledSecret(req: Request, res: Response, routeName: string): boolean {
  const expected = process.env.SCHEDULED_TASK_SECRET;
  if (!expected) return true; // see the fail-open note in the header

  const raw = req.headers[SCHEDULED_SECRET_HEADER];
  const provided = String((Array.isArray(raw) ? raw[0] : raw) ?? "");
  if (!secretMatches(provided, expected)) {
    console.warn(`[ScheduledTask] rejected a call to ${routeName} with a missing/incorrect secret`);
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return false;
  }
  return true;
}
