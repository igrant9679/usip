/**
 * Native email + password authentication routes.
 *
 *   POST /api/auth/password-login
 *     Body: { email, password, returnPath? }
 *     Verifies bcrypt hash in users.passwordHash, issues JWT session cookie.
 *
 *   POST /api/auth/register
 *     Body: { email, password, name?, returnPath?, inviteLinkToken?, inviteToken? }
 *     Creates a NEW user, hashes the password, issues a JWT session cookie,
 *     and returns the redirect URL. The one existing row it may touch is an
 *     untouched invite placeholder presenting its own invite token.
 *
 * Both routes are rate-limited per IP. The in-memory rate-limit store resets
 * on restart — acceptable for a single-instance deployment, swap to a Redis
 * store for horizontal scaling.
 */
import type { Express, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { and, eq, isNull, sql } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { nanoid } from "nanoid";
import { getDb } from "./db";
import { users, loginHistory, workspaceMembers, workspaceInviteLinks, workspaceSettings, workspaces } from "../drizzle/schema";
import { rankOf } from "@shared/roleRank";
import { sdk } from "./_core/sdk";
import { sessionLifetimeMs } from "./_core/securityPolicy";
import { getSessionCookieOptions } from "./_core/cookies";
import { clientIpOf, rateLimitKey } from "./_core/clientIp";
import { useTotpStep } from "./_core/sessionRevocation";
import { recordReissuedSession, recordSignIn, sessionTokenOf } from "./_core/sessionRecords";
import { clearFailures, isLockedOut, noteFailure, SIGN_IN_LOCKED, signInKey } from "./services/accountLockout";
import { backupCodesLeft, looksLikeBackupCode, useBackupCode } from "./services/mfaBackupCodes";
import { markEmailVerified, mintEmailVerification, sendVerificationEmail } from "./services/accountEmailVerification";
import { insertIdOf } from "./_core/insertId";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { escapeHtml } from "@shared/escapeHtml";
import { safeReturnPath } from "@shared/returnPath";
import {
  hashResetToken,
  isResetTokenLive,
  isStrongEnoughPassword,
  newResetToken,
  resetTokenExpiry,
} from "./services/passwordReset";

/**
 * What an unknown email is compared against, so its answer takes as long as a
 * wrong password does (audit 2026-10-20, G31). A real cost-12 bcrypt hash, the
 * cost every stored hash here is made with, of random bytes nobody kept: it
 * matches no password. The string it replaced was 64 characters with no valid
 * salt, which bcrypt rejects without doing the work, so "no such account"
 * answered in a fraction of the time a wrong password took.
 */
export const DUMMY_PASSWORD_HASH = "$2b$12$Fe74OEbZCKeL4mea8lXK6ODOx.pZt/OtfzE62kxYceNAcguf.ccZW";

/**
 * The caller's address, from `req.ip` and the trusted hop count — NOT the
 * first entry of X-Forwarded-For, which the caller writes (audit 2026-10-20:
 * rotating that header gave every guess a fresh bucket). See _core/clientIp.ts.
 */
const ipKey = (req: Request) => clientIpOf(req);

/**
 * How long this user's session may live, from Settings → Security.
 *
 * Enforced HERE rather than in a per-request middleware: jose already refuses
 * an expired token inside `jwtVerify`, and the whole refusal path downstream
 * of that (verifySession → authenticateRequest → createContext → requireUser →
 * the client's redirect to the sign-in form) was already built and already
 * tested. Setting `exp` and the cookie's `maxAge` from the policy is the
 * entire feature; the alternative was surgery across sdk, context, the SSE
 * stream helpers and the storage proxy for the same behaviour.
 *
 * The MINIMUM across the user's ACTIVE memberships, not the first workspace's:
 * a member of a strict workspace must not buy a lax session by holding a
 * second membership somewhere else. `isNull(deactivatedAt)` is load-bearing —
 * a workspace someone has left must not set their session lifetime.
 *
 * Fails open to ONE_YEAR_MS: a database hiccup at sign-in must not turn into
 * a 15-minute session for everyone.
 */
type LiveDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function sessionLifetimeForUser(db: LiveDb, userId: number): Promise<number> {
  try {
    const rows = await db
      .select({ t: workspaceSettings.sessionTimeoutMin })
      .from(workspaceMembers)
      .innerJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deactivatedAt)));
    let min: number | null = null;
    // Indexed loop, not for-of: the build targets ES5.
    for (let i = 0; i < rows.length; i++) {
      const v = Number(rows[i]?.t);
      if (!Number.isFinite(v) || v <= 0) continue;
      if (min === null || v < min) min = v;
    }
    return sessionLifetimeMs(min, ONE_YEAR_MS);
  } catch (e) {
    console.warn("[passwordAuth] session lifetime lookup failed:", (e as Error).message);
    return ONE_YEAR_MS;
  }
}

/** A failed second factor in the account's sign-in history. Best effort. */
async function recordFailedSignIn(db: LiveDb, req: Request, userId: number): Promise<void> {
  try {
    const [member] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .limit(1);
    await db.insert(loginHistory).values({
      userId,
      workspaceId: member?.workspaceId ?? null,
      ipAddress: ipKey(req).slice(0, 64),
      userAgent: (req.headers["user-agent"] ?? "").slice(0, 500),
      outcome: "failed",
    });
  } catch (_) { /* non-fatal */ }
}

const passwordLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  /**
   * Only failures count (tracker 2026-11-06, item 16). Every request counted,
   * so a 2FA sign-in spent two of the ten (the password step that asks for
   * the code, then the code) and successful sign-ins spent them too; a few
   * people behind one office address were locked out for 15 minutes having
   * done nothing wrong. A wrong password and a wrong or spent code still
   * count, which is what the limit is for.
   */
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req: Request, res: Response) => res.statusCode < 400 || res.locals.mfaCodePrompt === true,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: "Too many login attempts from this IP address. Please wait 15 minutes and try again.",
    });
  },
  skip: () => process.env.NODE_ENV === "test",
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: "Too many registration attempts from this IP address. Please wait 15 minutes and try again.",
    });
  },
  skip: () => process.env.NODE_ENV === "test",
});

function isValidEmail(s: string): boolean {
  // Minimal RFC-ish check; bcrypt + lowercase normalisation handles the rest.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function isStrongEnough(password: string): boolean {
  return typeof password === "string" && password.length >= 8;
}

/**
 * Reset requests send EMAIL, so the ceiling is tighter than login's. Ten
 * password guesses a quarter-hour is a person who forgot; ten reset mails is a
 * person being used as a mail relay against someone else's inbox.
 */
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKey,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: "Too many reset requests from this IP address. Please wait 15 minutes and try again.",
    });
  },
  skip: () => process.env.NODE_ENV === "test",
});

/**
 * Mint a single-use reset token for this account and email the link to the
 * account's OWN address. Returns false when there is nothing to send to — no
 * email on the row, or no workspace to pick a system sender from.
 *
 * Shared by the forgot-password form and `team.sendPasswordReset`: it is the
 * one way to put a new password on an account that lives in more than one
 * workspace (audit 2026-10-20, C1), because the link goes to the person, not
 * to whoever asked for it.
 */
type ResetSenderCandidate = {
  workspaceId: number;
  role: string;
  inviteToken: string | null;
  deactivatedAt: Date | null;
  createdAt: Date | null;
  ownerUserId: number | null;
};

/** Exported for the test; see the comment in emailPasswordReset. */
export function pickResetSenderWorkspace(userId: number, rows: ResetSenderCandidate[]): ResetSenderCandidate | null {
  const time = (d: Date | null) => (d ? new Date(d).getTime() : 0);
  const accepted = rows.filter((r) => r.inviteToken == null && r.deactivatedAt == null);
  if (accepted.length) {
    return accepted.slice().sort((a, b) =>
      Number(b.ownerUserId === userId) - Number(a.ownerUserId === userId)
      || rankOf(b.role) - rankOf(a.role)
      || time(a.createdAt) - time(b.createdAt))[0];
  }
  // Nothing accepted, and something accepted-then-deactivated: no channel.
  if (rows.some((r) => r.inviteToken == null)) return null;
  const pending = rows.filter((r) => r.deactivatedAt == null);
  return pending.slice().sort((a, b) => time(a.createdAt) - time(b.createdAt))[0] ?? null;
}

export async function emailPasswordReset(db: LiveDb, userId: number): Promise<boolean> {
  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, userId));
  if (!user?.email) return false;

  /**
   * WHICH workspace's sender carries the link matters (audit 2026-10-20, C1).
   * The mail goes out through that workspace's own transport, which its
   * admins configure — so it must be a workspace the person actually belongs
   * to, not merely one that typed their email into an invite box. Accepted
   * memberships first: the workspace they own, then where their role is
   * highest, then the oldest. Only an account with no accepted membership at
   * all (an invite placeholder nobody has claimed) falls back to the
   * workspace that invited it — the one whose token can already claim it.
   */
  const memberships = await db
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
      inviteToken: workspaceMembers.inviteToken,
      deactivatedAt: workspaceMembers.deactivatedAt,
      createdAt: workspaceMembers.createdAt,
      ownerUserId: workspaces.ownerUserId,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, user.id));
  const member = pickResetSenderWorkspace(user.id, memberships);
  if (!member) return false;

  const token = newResetToken();
  await db
    .update(users)
    .set({
      passwordResetTokenHash: hashResetToken(token),
      passwordResetExpiresAt: resetTokenExpiry(Date.now()),
    })
    .where(eq(users.id, user.id));

  const { sendSystemEmail } = await import("./emailDelivery");
  const { appUrl } = await import("./appUrl");
  const link = appUrl(`/reset-password?token=${encodeURIComponent(token)}`);
  const who = user.name?.trim() || user.email.split("@")[0];
  const sent = await sendSystemEmail(member.workspaceId, {
    to: user.email,
    subject: "Reset your Velocity password",
    // The link is the credential: the sending workspace's Emails page shows
    // that a reset went out, never the link itself.
    logPreview: `Password reset link sent to ${user.email} (link withheld from the log).`,
    html: `
<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
  <h2 style="margin:0 0 8px;font-size:18px">Reset your password</h2>
  <p style="margin:0 0 16px;color:#475569;font-size:14px">Hi ${escapeHtml(who)}, we received a request to reset your password.</p>
  <p style="margin:24px 0">
<a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Choose a new password →</a>
  </p>
  <p style="margin:0 0 8px;color:#64748b;font-size:12px">This link works once and expires in 1 hour.</p>
  <p style="margin:0;color:#64748b;font-size:12px"><strong>If you didn't ask for this, ignore this email</strong> — your password has not changed.</p>
</div>`,
  });
  return sent.ok;
}

/**
 * Give THIS browser a fresh session after the person changed their own
 * password or 2FA — which bumped session_version and so ended every session,
 * this one included. Their other devices stay signed out; this one does not.
 * A no-op where there is no response to set a cookie on (tests, scripts).
 */
export async function reissueSessionCookie(db: LiveDb, req: Request, res: Response, userId: number): Promise<void> {
  if (typeof (res as { cookie?: unknown }).cookie !== "function") return;
  const [u] = await db
    .select({ openId: users.openId, name: users.name, sessionVersion: users.sessionVersion })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return;
  const lifetimeMs = await sessionLifetimeForUser(db, userId);
  const token = await sdk.createSessionToken(u.openId, { name: u.name || "", expiresInMs: lifetimeMs, sessionVersion: u.sessionVersion ?? 0 });
  res.cookie(COOKIE_NAME, token, { ...getSessionCookieOptions(req), maxAge: lifetimeMs });
  // The same device, now on a new session: its row in the sessions list
  // follows it (F3), instead of vanishing with the session that just ended.
  await recordReissuedSession(db, req, { userId, oldToken: sessionTokenOf(req), newToken: token, sessionVersion: u.sessionVersion ?? 0 });
}

/**
 * The ONE existing row register may touch: an invitation placeholder that has
 * never been an account, claimed with the token of the invite that created it.
 *
 * Each condition closes a door:
 *   · no password, an "invite:" openId, an invite loginMethod — the row was
 *     made by team.invite and nobody has ever signed in as it. A SCIM user or
 *     a former OAuth user fails here and must use forgot-password.
 *   · exactly ONE membership, and it is the one the token names. The admin who
 *     sent an invite can read its token (copyInviteLink, returnLink), so the
 *     token proves only "this admin invited this address". When a second
 *     workspace has also invited the same address, one admin's token must not
 *     choose the password the other workspace's invitee will sign in with.
 *   · live: not expired, not deactivated.
 */
async function claimableInvite(
  db: LiveDb,
  existing: { id: number; openId: string; passwordHash: string | null; loginMethod: string | null },
  token: unknown,
): Promise<{ memberId: number } | null> {
  if (typeof token !== "string" || token.length < 32) return null;
  if (existing.passwordHash) return null;
  if (!existing.openId.startsWith("invite:")) return null;
  if (existing.loginMethod !== "invite" && existing.loginMethod !== "expired_invite") return null;
  const memberships = await db
    .select({
      id: workspaceMembers.id,
      inviteToken: workspaceMembers.inviteToken,
      inviteExpiresAt: workspaceMembers.inviteExpiresAt,
      deactivatedAt: workspaceMembers.deactivatedAt,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, existing.id));
  if (memberships.length !== 1) return null;
  const [m] = memberships;
  if (m.inviteToken !== token || m.deactivatedAt) return null;
  if (m.inviteExpiresAt && new Date(m.inviteExpiresAt).getTime() <= Date.now()) return null;
  return { memberId: m.id };
}

export function registerPasswordAuthRoutes(app: Express) {
  /**
   * POST /api/auth/forgot-password  { email }
   *
   * ⚠️ ALWAYS answers `{ ok: true }` — for an unknown address, for an address
   * with no workspace, and when the send itself fails. Login already refuses to
   * reveal which emails have accounts (there is a constant-time dummy compare
   * guarding it); a reset form replying "no such account" would give the same
   * fact away through the back door.
   */
  app.post("/api/auth/forgot-password", forgotPasswordLimiter, async (req: Request, res: Response) => {
    const { email } = req.body ?? {};
    // The generic answer, returned on EVERY path below.
    const ok = () => res.json({ ok: true });

    if (typeof email !== "string" || !isValidEmail(email.trim())) {
      res.status(400).json({ error: "Please enter a valid email address." });
      return;
    }
    const normalizedEmail = email.trim().toLowerCase();

    try {
      const db = await getDb();
      if (!db) return ok();

      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, normalizedEmail));
      if (!user) return ok();
      // Answer first, send after (audit 2026-10-20, G31): awaiting the mail
      // made a real account's answer take a mail send longer than an unknown
      // one's, which told the caller which addresses have accounts.
      ok();
      void emailPasswordReset(db, user.id).catch((e) =>
        console.error("[ForgotPassword] send failed:", e instanceof Error ? e.message : e));
      return;
    } catch (e) {
      // A failure here must not become an oracle either.
      console.error("[ForgotPassword] failed:", e instanceof Error ? e.message : e);
      return ok();
    }
  });

  /**
   * POST /api/auth/reset-password  { token, password }
   *
   * Sets the password and CLEARS the token (single use). Deliberately does NOT
   * issue a session: the user signs in normally afterwards, which keeps the
   * MFA step in force. A reset that logged you straight in would be a way past
   * an authenticator app.
   */
  app.post("/api/auth/reset-password", forgotPasswordLimiter, async (req: Request, res: Response) => {
    const { token, password } = req.body ?? {};
    if (typeof token !== "string" || token.length < 32) {
      res.status(400).json({ error: "That reset link is invalid or has expired." });
      return;
    }
    if (!isStrongEnoughPassword(password)) {
      res.status(400).json({ error: "Password must be at least 8 characters." });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(500).json({ error: "Database unavailable" });
      return;
    }

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        passwordResetExpiresAt: users.passwordResetExpiresAt,
      })
      .from(users)
      .where(eq(users.passwordResetTokenHash, hashResetToken(token)));

    if (!user || !isResetTokenLive(user.passwordResetExpiresAt, Date.now())) {
      res.status(400).json({ error: "That reset link is invalid or has expired." });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await db
      .update(users)
      .set({
        passwordHash,
        loginMethod: "password",
        // Every session minted under the old password ends with it (audit
        // 2026-10-20): a reset is what someone does when they think another
        // person has their account, and that person's token must stop working.
        sessionVersion: sql`${users.sessionVersion} + 1`,
        // Single use — clearing these is what spends the token.
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      })
      .where(eq(users.id, user.id));
    // The way out of a sign-in lock (G9): the reset proved the mailbox.
    if (user.email) clearFailures(signInKey(user.email));
    // ...and so it confirms the address of an account still waiting on its
    // verification link (F1).
    await markEmailVerified(db, user.id).catch(() => {});

    res.json({ ok: true });
  });

  // ── POST /api/auth/password-login ────────────────────────────────────────
  app.post(
    "/api/auth/password-login",
    passwordLoginLimiter,
    async (req: Request, res: Response) => {
      const { email, password, returnPath } = req.body ?? {};

      if (typeof email !== "string" || typeof password !== "string") {
        res.status(400).json({ error: "email and password are required" });
        return;
      }

      const normalizedEmail = email.trim().toLowerCase();
      /**
       * Per-account lock (audit 2026-10-20, G9), ahead of any lookup or hash,
       * so a locked known account and a locked unknown address answer alike
       * and alike fast. Failed passwords and failed codes both count.
       */
      const lockKey = signInKey(normalizedEmail);
      if (isLockedOut(lockKey)) {
        res.status(429).json({ error: SIGN_IN_LOCKED });
        return;
      }
      const db = await getDb();
      if (!db) {
        res.status(500).json({ error: "Database unavailable" });
        return;
      }

      const [user] = await db
        .select({
          id: users.id,
          openId: users.openId,
          name: users.name,
          email: users.email,
          passwordHash: users.passwordHash,
          loginMethod: users.loginMethod,
          mfaTotpSecret: users.mfaTotpSecret,
          mfaTotpEnabledAt: users.mfaTotpEnabledAt,
          sessionVersion: users.sessionVersion,
        })
        .from(users)
        .where(eq(users.email, normalizedEmail));

      const GENERIC_ERROR = "Invalid email or password.";

      if (!user || !user.passwordHash) {
        // The same bcrypt work as a wrong password (G31), and the same count.
        await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
        noteFailure(lockKey);
        res.status(401).json({ error: GENERIC_ERROR });
        return;
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        noteFailure(lockKey);
        try {
          const [member] = await db
            .select({ workspaceId: workspaceMembers.workspaceId })
            .from(workspaceMembers)
            .where(eq(workspaceMembers.userId, user.id))
            .limit(1);
          await db.insert(loginHistory).values({
            userId: user.id,
            workspaceId: member?.workspaceId ?? null,
            ipAddress: ipKey(req).slice(0, 64),
            userAgent: (req.headers["user-agent"] ?? "").slice(0, 500),
            outcome: "failed",
          });
        } catch (_) { /* non-fatal */ }
        res.status(401).json({ error: GENERIC_ERROR });
        return;
      }

      // ── MFA enforcement: an enabled authenticator app makes the code a
      //    second factor for every password login. The password has already
      //    been verified above, so telling the client MFA is required leaks
      //    nothing an attacker could use without the password.
      let backupCodesRemaining: number | null = null;
      if (user.mfaTotpEnabledAt && user.mfaTotpSecret) {
        const totpCode = typeof (req.body ?? {}).totpCode === "string" ? (req.body.totpCode as string) : "";
        /**
         * A one-time backup code stands in for the authenticator code (audit
         * 2026-10-20, G15): sent as `backupCode`, or typed into the code box,
         * which six digits never look like.
         */
        const backupCode = typeof (req.body ?? {}).backupCode === "string" && (req.body.backupCode as string).trim()
          ? (req.body.backupCode as string)
          : looksLikeBackupCode(totpCode) ? totpCode : "";
        if (!totpCode && !backupCode) {
          // The right password, asking for the code: not a failed attempt, so
          // the limiter doesn't count it (see passwordLoginLimiter).
          res.locals.mfaCodePrompt = true;
          res.status(401).json({ error: "Enter the 6-digit code from your authenticator app.", mfaRequired: true });
          return;
        }
        if (backupCode) {
          if (!(await useBackupCode(db, user.id, backupCode))) {
            // Counted against the account like a wrong authenticator code
            // (G9), so backup codes are not a second, unlimited door.
            noteFailure(lockKey);
            await recordFailedSignIn(db, req, user.id);
            res.status(401).json({ error: "That backup code isn't right, or it has already been used. Each code works once.", mfaRequired: true });
            return;
          }
          backupCodesRemaining = await backupCodesLeft(db, user.id).catch(() => null);
        } else {
          // A code works ONCE (audit 2026-10-20): its time-step is spent on
          // success, so the same six digits cannot be replayed for the rest of
          // their ~90-second window.
          const { matchTotpStep, totpRefusal } = await import("./services/totp");
          // Stored encrypted (services/totpSecret.ts). One that won't decrypt
          // matches no code: the account still needs its second factor, and
          // a backup code or an admin's Reset 2FA is the way back in.
          const { openTotpSecret } = await import("./services/totpSecret");
          const key = openTotpSecret(user.mfaTotpSecret);
          const step = key ? matchTotpStep(key, totpCode) : null;
          if (step === null || !(await useTotpStep(db, user.id, step))) {
            // A wrong or spent code is a failure against the account too (G9):
            // whoever holds the password gets ten guesses at the code, not ten
            // per address.
            noteFailure(lockKey);
            await recordFailedSignIn(db, req, user.id);
            // A spent step and a wrong code are different answers (item 16).
            res.status(401).json({ error: totpRefusal(step), mfaRequired: true });
            return;
          }
        }
      }

      clearFailures(lockKey);
      try {
        await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));
      } catch (_) { /* non-fatal */ }

      // Normalise a leftover "invite"/"expired_invite" loginMethod on an
      // account that now signs in with a password.
      //
      // It used to clear EVERY invite token on the account as well, "healing"
      // memberships that had skipped finaliseAcceptance. That made signing in
      // anywhere an acceptance of every pending invitation, from any workspace
      // that had typed this person's email (audit 2026-10-20, C1). An
      // invitation is accepted with its own token, on the invite page, and
      // nowhere else.
      try {
        if (user.loginMethod === "invite" || user.loginMethod === "expired_invite") {
          await db.update(users).set({ loginMethod: "password" }).where(eq(users.id, user.id));
        }
      } catch (_) { /* non-fatal */ }

      // ABSOLUTE age from sign-in, not idle time. A member already signed in
      // keeps the session they hold until it expires, so lowering the setting
      // lands one person at a time as they next sign in.
      const lifetimeMs = await sessionLifetimeForUser(db, user.id);
      const sessionToken = await sdk.createSessionToken(user.openId, {
        name: user.name || "",
        expiresInMs: lifetimeMs,
        sessionVersion: user.sessionVersion ?? 0,
      });

      // The sign-in and the session it started (F3): written after the token
      // is minted, so the row can name it for the active-sessions list.
      let firstWorkspaceId: number | null = null;
      try {
        const [member] = await db
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, user.id))
          .limit(1);
        firstWorkspaceId = member?.workspaceId ?? null;
      } catch (_) { /* non-fatal */ }
      await recordSignIn(db, req, { userId: user.id, workspaceId: firstWorkspaceId, token: sessionToken, sessionVersion: user.sessionVersion ?? 0 });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: lifetimeMs });

      const redirect = safeReturnPath(returnPath);
      const acceptsJson = (req.headers.accept ?? "").includes("application/json");
      if (acceptsJson) {
        // After a backup code, how many are left, so the sign-in page can say
        // so while there is still time to make a new set (G15).
        res.json(backupCodesRemaining === null ? { ok: true, redirect } : { ok: true, redirect, backupCodesLeft: backupCodesRemaining });
      } else {
        res.redirect(302, redirect);
      }
    },
  );

  // ── POST /api/auth/register ──────────────────────────────────────────────
  app.post(
    "/api/auth/register",
    registerLimiter,
    async (req: Request, res: Response) => {
      const { email, password, name, returnPath, inviteLinkToken, inviteToken } = req.body ?? {};

      if (typeof email !== "string" || !isValidEmail(email.trim())) {
        res.status(400).json({ error: "Please enter a valid email address." });
        return;
      }
      if (!isStrongEnough(password)) {
        res.status(400).json({ error: "Password must be at least 8 characters." });
        return;
      }

      const normalizedEmail = email.trim().toLowerCase();
      const cleanName =
        typeof name === "string" && name.trim().length > 0
          ? name.trim().slice(0, 200)
          : null;

      const db = await getDb();
      if (!db) {
        res.status(500).json({ error: "Database unavailable" });
        return;
      }

      // Activation-link registration: validate the link up front so we never
      // create an account for a dead link. The membership is created (and the
      // link consumed) after the user is created, below.
      const linkToken =
        typeof inviteLinkToken === "string" && inviteLinkToken.length >= 10 ? inviteLinkToken : null;
      let inviteLink:
        | { id: number; workspaceId: number; role: "super_admin" | "admin" | "manager" | "rep"; title: string | null; quota: string | null }
        | null = null;
      if (linkToken) {
        const [row] = await db
          .select({
            id: workspaceInviteLinks.id,
            workspaceId: workspaceInviteLinks.workspaceId,
            role: workspaceInviteLinks.role,
            title: workspaceInviteLinks.title,
            quota: workspaceInviteLinks.quota,
            usedAt: workspaceInviteLinks.usedAt,
            expiresAt: workspaceInviteLinks.expiresAt,
          })
          .from(workspaceInviteLinks)
          .where(eq(workspaceInviteLinks.token, linkToken));
        if (!row || row.usedAt || (row.expiresAt && row.expiresAt <= new Date())) {
          res.status(400).json({ error: "This activation link is invalid or has expired. Ask for a new one." });
          return;
        }
        inviteLink = { id: row.id, workspaceId: row.workspaceId, role: row.role, title: row.title, quota: row.quota };
      }

      // Look for an existing row by email (real account or invite placeholder)
      const [existing] = await db
        .select({
          id: users.id,
          openId: users.openId,
          passwordHash: users.passwordHash,
          loginMethod: users.loginMethod,
          sessionVersion: users.sessionVersion,
        })
        .from(users)
        .where(eq(users.email, normalizedEmail));

      /**
       * 🔴 REGISTER CREATES NEW ACCOUNTS ONLY (audit 2026-10-20, C2).
       *
       * This used to "upgrade any password-less row in place": an invite
       * placeholder, but equally a SCIM-provisioned user or an account that had
       * only ever signed in through OAuth. Anyone who typed that person's email
       * here chose their password, got a session, and had every invite token on
       * the row cleared — a takeover of any account without a password.
       *
       * Every existing row now goes through a channel that proves something:
       * a password sign-in, the forgot-password email, or — for the invitee
       * who has never had an account at all — the invite link. That last door
       * is deliberately narrow (claimableInvite above), because the admin who
       * sent the invite can read its token too.
       */
      let claimedInvite: { memberId: number } | null = null;
      if (existing) {
        if (existing.passwordHash) {
          res.status(409).json({
            error: "An account with that email already exists. Try signing in instead.",
          });
          return;
        }
        claimedInvite = inviteLink ? null : await claimableInvite(db, existing, inviteToken);
        if (!claimedInvite) {
          const invited = existing.loginMethod === "invite" || existing.loginMethod === "expired_invite";
          res.status(409).json({
            error: invited
              ? "You've been invited to Velocity. Open the invitation link in your email to set your password, or ask your admin to resend it."
              : "An account with that email already exists. Sign in, or use Forgot password to get a reset link.",
          });
          return;
        }
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const now = new Date();

      let userId: number;
      let openId: string;
      let verification: ReturnType<typeof mintEmailVerification> | null = null;

      if (existing && claimedInvite) {
        // The invitee's own placeholder, claimed with its invite token. Setting
        // the password here IS accepting that one invitation, so its token is
        // spent — and only its token: the row has no other membership.
        userId = existing.id;
        openId = existing.openId;
        await db
          .update(users)
          .set({
            passwordHash,
            name: cleanName ?? undefined,
            loginMethod: "password",
            lastSignedIn: now,
            // The invitation's token came to this address, so it is proven (F1).
            emailVerifiedAt: now,
            emailVerifyTokenHash: null,
            emailVerifyExpiresAt: null,
          })
          .where(eq(users.id, existing.id));
        await db
          .update(workspaceMembers)
          .set({ inviteToken: null, inviteExpiresAt: null })
          .where(and(eq(workspaceMembers.id, claimedInvite.memberId), eq(workspaceMembers.userId, existing.id)));
      } else {
        openId = `local:${nanoid(24)}`;
        /**
         * A stranger's new account is unverified until its link is opened
         * (audit 2026-10-20, F1): the token's hash goes in with the row, so
         * the very first page already shows the banner, and the mail itself
         * is sent after the answer, below.
         */
        verification = mintEmailVerification(now.getTime());
        const [insertResult] = await db.insert(users).values({
          openId,
          email: normalizedEmail,
          name: cleanName,
          passwordHash,
          loginMethod: "password",
          lastSignedIn: now,
          ...verification.columns,
        });
        userId = insertIdOf(insertResult);
      }

      // Consume the activation link (single-use) and add the new user to its
      // workspace at the link's role. The conditional UPDATE (usedAt IS NULL)
      // makes consumption atomic so two concurrent registrations can't both win.
      if (inviteLink) {
        const consumed = await db
          .update(workspaceInviteLinks)
          .set({ usedAt: now, usedByUserId: userId })
          .where(and(eq(workspaceInviteLinks.id, inviteLink.id), isNull(workspaceInviteLinks.usedAt)));
        const ok = Number((consumed as any)?.[0]?.affectedRows ?? (consumed as any)?.affectedRows ?? 0) > 0;
        if (ok) {
          // Don't double-add if they somehow already belong to this workspace.
          const [member] = await db
            .select({ id: workspaceMembers.id })
            .from(workspaceMembers)
            .where(and(eq(workspaceMembers.workspaceId, inviteLink.workspaceId), eq(workspaceMembers.userId, userId)));
          if (!member) {
            await db.insert(workspaceMembers).values({
              workspaceId: inviteLink.workspaceId,
              userId,
              role: inviteLink.role,
              title: inviteLink.title,
              quota: inviteLink.quota,
            });
          }
        }
      }

      // Read AFTER the activation link was consumed above, so a brand-new
      // member picks up their new workspace's policy on their very first
      // session rather than a year-long one.
      const lifetimeMs = await sessionLifetimeForUser(db, userId);
      const sessionToken = await sdk.createSessionToken(openId, {
        name: cleanName ?? "",
        expiresInMs: lifetimeMs,
        sessionVersion: existing?.sessionVersion ?? 0,
      });
      // The sign-in and the session it started (F3).
      await recordSignIn(db, req, { userId, workspaceId: null, token: sessionToken, sessionVersion: existing?.sessionVersion ?? 0 });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: lifetimeMs });

      const redirect = safeReturnPath(returnPath);
      const acceptsJson = (req.headers.accept ?? "").includes("application/json");
      if (acceptsJson) {
        res.json({ ok: true, redirect, emailVerificationPending: !!verification });
      } else {
        res.redirect(302, redirect);
      }
      // Answer first, send after, as forgot-password does: the mail must not
      // hold up the sign-up, and a failed send leaves the banner's Resend.
      if (verification) {
        const token = verification.token;
        void sendVerificationEmail(db, userId, token).catch((e) =>
          console.error("[register] verification email failed:", e instanceof Error ? e.message : e));
      }
    },
  );
}
