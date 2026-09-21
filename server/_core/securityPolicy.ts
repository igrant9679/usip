/**
 * Settings → Security, for the two controls that now actually bite.
 *
 * Until 2026-09-20 `sessionTimeoutMin`, `enforce2fa` and `ipAllowlist` were
 * stored and read by nothing at all — the tab carried an honest "Not enforced
 * yet" banner saying so. Two of the three are enforced from here:
 *
 *   · `enforce2fa` — one gate in `workspaceProcedure`, which is the single
 *     choke point every authenticated request already crosses.
 *   · `sessionTimeoutMin` — NOT enforced per request. jose already refuses an
 *     expired token inside `jwtVerify`, so the lifetime is simply set on the
 *     token and the cookie at the two mint sites in `passwordAuth.ts`. That
 *     keeps the whole feature out of `sdk.ts` and `context.ts`.
 *
 * `ipAllowlist` is deliberately still inert: nothing in `server/` calls
 * `app.set('trust proxy', …)`, so `x-forwarded-for` is caller-controlled at
 * whichever hop we picked. First hop waves anyone through who sets a header
 * while the UI claims protection; last hop, behind two edge hops, compares
 * against an internal address and locks out every member including the admin
 * who would turn it off. Both are worse than the honest label, which is why
 * the banner on that one field stays.
 *
 * Deliberately FAIL-OPEN, mirroring `_core/workspaceArchive`: a database fault
 * must not lock a workspace out of its own product. That is also why a policy
 * read that throws leaves the cache empty rather than caching a null.
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";

/**
 * Only `enforce2fa` — deliberately. `sessionTimeoutMin` is not in here because
 * nothing reads it per request: it is resolved once at sign-in, from the
 * member's own workspaces, by `sessionLifetimeForUser` in passwordAuth. A
 * field on this object that no caller consults would be exactly the inert
 * setting this change exists to remove.
 */
export type WsSecurityPolicy = { enforce2fa: boolean };

const cache = new Map<number, { at: number; policy: WsSecurityPolicy }>();
const TTL_MS = 60_000;

/**
 * This workspace's security policy, cached ~60s. `null` means "no answer" —
 * either the settings row was never seeded or the read failed — and every
 * caller must treat that as "no restriction".
 */
export async function securityPolicyFor(workspaceId: number): Promise<WsSecurityPolicy | null> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.policy;
  try {
    // getDb(), the chain construction AND the await all sit inside the try:
    // the fake databases in the middleware suites throw SYNCHRONOUSLY from
    // `.then`, so a try that only wraps the await would not catch them and
    // six existing suites would go red instead of failing open.
    const db = await getDb();
    if (!db) return null;
    const rows = await db
      .select({ enforce2fa: workspaceSettings.enforce2fa })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const policy: WsSecurityPolicy = { enforce2fa: !!row.enforce2fa };
    cache.set(workspaceId, { at: Date.now(), policy });
    return policy;
  } catch (e) {
    // Named, because a sustained db fault silently SUSPENDS both controls and
    // the only evidence would otherwise be that nobody is being challenged.
    console.error("[securityPolicy] policy read failed:", (e as Error).message);
    return null;
  }
}

/** settings.save just wrote — without this the Security tab tells a 60s lie. */
export function invalidateSecurityPolicyCache(workspaceId?: number): void {
  if (workspaceId === undefined) cache.clear();
  else cache.delete(workspaceId);
}

/** The shortest session we will ever mint. A corrupt or absurd stored value
 *  must not be able to lock a tenant into a re-login loop. */
export const MIN_SESSION_LIFETIME_MS = 15 * 60_000;

/**
 * Absolute token lifetime for a stored `sessionTimeoutMin`. PURE.
 *
 * Clamped at both ends: below `MIN_SESSION_LIFETIME_MS` a bad row would sign
 * people out faster than they can work, and above `fallbackMs` it would hand
 * out a token longer-lived than the cookie the caller is about to set.
 */
export function sessionLifetimeMs(
  timeoutMin: number | null | undefined,
  fallbackMs: number,
): number {
  const n = Number(timeoutMin);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  const ms = n * 60_000;
  if (ms < MIN_SESSION_LIFETIME_MS) return MIN_SESSION_LIFETIME_MS;
  if (ms > fallbackMs) return fallbackMs;
  return ms;
}

/**
 * The four procedures a member blocked by `enforce2fa` must still reach, or
 * the gate is a guaranteed lockout: they are themselves `workspaceProcedure`,
 * so without this exemption the enrolment screen cannot load the state it
 * needs to enrol. Deliberately minimal — everything else a blocked user would
 * have seen is replaced by a full-screen interstitial, so there is no second
 * list of "keep the app half-alive" paths to maintain.
 */
export const MFA_EXEMPT_PATHS: string[] = [
  "profile.getMfaStatus",
  "profile.startTotpEnrollment",
  "profile.confirmTotpEnrollment",
  "profile.disableTotp",
];

/** PURE. `indexOf` rather than a Set: the build targets ES5 and iterating a
 *  Set literal is a compile error here (TS2802). */
export function mfaGateExemptPath(path: string): boolean {
  return MFA_EXEMPT_PATHS.indexOf(path) !== -1;
}
