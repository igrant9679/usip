/**
 * Which sessions an account has open (audit 2026-10-20, F3).
 *
 * A session is a signed token and the server keeps no list of them, so the
 * list is built from what IS recorded: each successful sign-in's login_history
 * row now carries the session it started (its jti, expiry and the account's
 * session version when minted). A row's session is alive while it has not
 * expired, the account's session version has not moved past it (a password or
 * 2FA change, or "Sign out everywhere"), and its jti is not in
 * revoked_sessions (logout, or "Sign out" on that row). Sessions from before
 * this shipped have no jti and are not listed; "Sign out everywhere" still
 * ends them, because it bumps the version every token carries.
 */
import type { Request } from "express";
import { and, desc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import { decodeJwt } from "jose";
import { parse as parseCookieHeader } from "cookie";
import { loginHistory, revokedSessions, users } from "../../drizzle/schema";
import { COOKIE_NAME } from "@shared/const";
import { describeUserAgent } from "@shared/userAgent";
import { clientIpOf } from "./clientIp";
import type { getDb } from "../db";
import { affectedRowsOf } from "./claim";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * A token's id and expiry, read without verifying it: only ever called on a
 * token this server just minted, or one the request was already
 * authenticated with.
 */
export function sessionMetaOf(token: string | null | undefined): { jti: string | null; expiresAt: Date | null } {
  if (!token) return { jti: null, expiresAt: null };
  try {
    const p = decodeJwt(token);
    return {
      jti: typeof p.jti === "string" && p.jti ? p.jti.slice(0, 32) : null,
      expiresAt: typeof p.exp === "number" ? new Date(p.exp * 1000) : null,
    };
  } catch {
    return { jti: null, expiresAt: null };
  }
}

/** The session cookie on this request, if any. */
export function sessionTokenOf(req: { headers?: { cookie?: string | string[] } } | null | undefined): string | null {
  const raw = req?.headers?.cookie;
  const header = Array.isArray(raw) ? raw.join("; ") : raw;
  if (!header) return null;
  return parseCookieHeader(header)[COOKIE_NAME] ?? null;
}

/**
 * A successful sign-in, and the session it started. Best effort, as the
 * history insert always was: a failed write must not fail the sign-in.
 */
export async function recordSignIn(
  db: Db,
  req: Request,
  opts: { userId: number; workspaceId: number | null; token: string; sessionVersion: number },
): Promise<void> {
  const meta = sessionMetaOf(opts.token);
  try {
    await db.insert(loginHistory).values({
      userId: opts.userId,
      workspaceId: opts.workspaceId,
      ipAddress: clientIpOf(req).slice(0, 64),
      userAgent: (req.headers?.["user-agent"] ?? "").slice(0, 500),
      outcome: "success",
      sessionJti: meta.jti,
      sessionExpiresAt: meta.expiresAt,
      sessionVersion: opts.sessionVersion,
    });
  } catch (_) { /* non-fatal */ }
}

/**
 * This device was given a fresh token (its own password or 2FA change, or
 * "Sign out everywhere", ended every session and re-issued this one): its
 * row now names the new session, so it stays in the list as the same device.
 * A device whose session started before rows carried one gets a row now.
 */
export async function recordReissuedSession(
  db: Db,
  req: Request,
  opts: { userId: number; oldToken: string | null; newToken: string; sessionVersion: number },
): Promise<void> {
  const oldJti = sessionMetaOf(opts.oldToken).jti;
  const meta = sessionMetaOf(opts.newToken);
  try {
    if (oldJti) {
      const res = await db
        .update(loginHistory)
        .set({ sessionJti: meta.jti, sessionExpiresAt: meta.expiresAt, sessionVersion: opts.sessionVersion })
        .where(and(eq(loginHistory.userId, opts.userId), eq(loginHistory.sessionJti, oldJti)));
      const affected = affectedRowsOf(res);
      if (affected > 0) return;
    }
    await recordSignIn(db, req, { userId: opts.userId, workspaceId: null, token: opts.newToken, sessionVersion: opts.sessionVersion });
  } catch (_) { /* non-fatal */ }
}

export type LiveSession = {
  id: number;
  device: string;
  ipAddress: string | null;
  signedInAt: Date;
  expiresAt: Date | null;
  current: boolean;
};

/** The account's sessions that are still alive, newest first. */
export async function listLiveSessions(db: Db, userId: number, currentToken: string | null, nowMs = Date.now()): Promise<LiveSession[]> {
  const [u] = await db.select({ sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return [];
  const rows = await db
    .select({
      id: loginHistory.id,
      ipAddress: loginHistory.ipAddress,
      userAgent: loginHistory.userAgent,
      createdAt: loginHistory.createdAt,
      sessionJti: loginHistory.sessionJti,
      sessionExpiresAt: loginHistory.sessionExpiresAt,
    })
    .from(loginHistory)
    .where(and(
      eq(loginHistory.userId, userId),
      eq(loginHistory.outcome, "success"),
      isNotNull(loginHistory.sessionJti),
      eq(loginHistory.sessionVersion, u.sessionVersion ?? 0),
      gt(loginHistory.sessionExpiresAt, new Date(nowMs)),
    ))
    .orderBy(desc(loginHistory.createdAt))
    .limit(50);
  const jtis = rows.map((r) => r.sessionJti!).filter((j, i, all) => all.indexOf(j) === i);
  const revoked = jtis.length
    ? new Set((await db.select({ jti: revokedSessions.jti }).from(revokedSessions).where(inArray(revokedSessions.jti, jtis))).map((r) => r.jti))
    : new Set<string>();
  const currentJti = sessionMetaOf(currentToken).jti;
  return rows
    .filter((r) => !revoked.has(r.sessionJti!))
    .map((r) => ({
      id: r.id,
      device: describeUserAgent(r.userAgent),
      ipAddress: r.ipAddress ?? null,
      signedInAt: r.createdAt,
      expiresAt: r.sessionExpiresAt ?? null,
      current: !!currentJti && r.sessionJti === currentJti,
    }));
}
