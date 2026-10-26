/**
 * Ending sessions before they expire, and spending a 2FA code once.
 *
 * 🔴 THE GAP (audit 2026-10-20, Phase 0): a session was a signed JWT and
 * nothing more. Logout cleared the browser's cookie and left the token itself
 * valid for up to a year; a password reset or a 2FA change did not touch it
 * at all. Whoever had copied a token kept the account — through the very
 * steps a person takes when they suspect exactly that.
 *
 * Two levers, both checked on every authenticated request (sdk.ts):
 *   · users.session_version — every token carries the version it was minted
 *     at. Bumping it ends ALL of an account's sessions: password reset or
 *     change, a 2FA change, an admin resetting either.
 *   · revoked_sessions — ONE token, by its jti. That is logout: signing out on
 *     one device does not sign you out of the others.
 * A token minted before this shipped has no jti; logging out with one ends
 * every session of that account, once.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { revokedSessions, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { COOKIE_NAME } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Logout: end the token this request carries. A token with a jti is ended
 * alone; one minted before jtis existed can only be ended with all of its
 * account's sessions.
 */
export async function endCurrentSession(req: { headers?: { cookie?: string | string[] } } | null | undefined): Promise<void> {
  const raw = req?.headers?.cookie;
  const header = Array.isArray(raw) ? raw.join("; ") : raw;
  if (!header) return;
  const token = parseCookieHeader(header)[COOKIE_NAME];
  if (!token) return;
  const { sdk } = await import("./sdk");
  const session = await sdk.verifySession(token);
  if (!session) return;
  const db = await getDb();
  if (!db) return;
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.openId, session.openId)).limit(1);
  if (!user) return;
  if (session.jti) {
    await revokeSessionJti(db, session.jti, user.id, session.expiresAt ?? new Date(Date.now() + 366 * 86_400_000));
  } else {
    await revokeAllSessions(db, user.id);
  }
}

/** End every session of this account. An SQL increment, never read-then-write. */
export async function revokeAllSessions(db: Db, userId: number): Promise<void> {
  await db
    .update(users)
    .set({ sessionVersion: sql`${users.sessionVersion} + 1` } as never)
    .where(eq(users.id, userId));
}

/** End one session by its token id, and sweep the rows whose tokens have expired anyway. */
export async function revokeSessionJti(db: Db, jti: string, userId: number, expiresAt: Date): Promise<void> {
  await db.delete(revokedSessions).where(lt(revokedSessions.expiresAt, new Date()));
  await db.insert(revokedSessions).values({ jti: jti.slice(0, 32), userId, expiresAt });
}

export async function isSessionRevoked(db: Db, jti: string): Promise<boolean> {
  const [row] = await db
    .select({ jti: revokedSessions.jti })
    .from(revokedSessions)
    .where(eq(revokedSessions.jti, jti))
    .limit(1);
  return !!row;
}

/**
 * Spend a TOTP time-step: true only for the first sign-in with a code from a
 * step later than the last one used. Conditional UPDATE, so two requests
 * racing with the same code cannot both win.
 */
export async function useTotpStep(db: Db, userId: number, step: number): Promise<boolean> {
  const res = await db
    .update(users)
    .set({ mfaLastStep: step } as never)
    .where(and(eq(users.id, userId), or(isNull(users.mfaLastStep), lt(users.mfaLastStep, step))));
  const affected = Number((res as any)?.[0]?.affectedRows ?? (res as any)?.affectedRows ?? 0);
  return affected > 0;
}
