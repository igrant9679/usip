/**
 * Native email + password authentication routes.
 *
 *   POST /api/auth/password-login
 *     Body: { email, password, returnPath? }
 *     Verifies bcrypt hash in users.passwordHash, issues JWT session cookie.
 *
 *   POST /api/auth/register
 *     Body: { email, password, name?, returnPath? }
 *     Creates a new user (or upgrades a pending invite placeholder), hashes
 *     the password, issues a JWT session cookie, and returns the redirect URL.
 *
 * Both routes are rate-limited per IP. The in-memory rate-limit store resets
 * on restart — acceptable for a single-instance deployment, swap to a Redis
 * store for horizontal scaling.
 */
import type { Express, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { nanoid } from "nanoid";
import { getDb } from "./db";
import { users, loginHistory, workspaceMembers, workspaceInviteLinks } from "../drizzle/schema";
import { sdk } from "./_core/sdk";
import { getSessionCookieOptions } from "./_core/cookies";
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

const ipKey = (req: Request) =>
  ((req.headers["x-forwarded-for"] as string) ?? req.socket?.remoteAddress ?? "unknown")
    .split(",")[0]
    .trim();

const passwordLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipKey,
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
  keyGenerator: ipKey,
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
  keyGenerator: ipKey,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: "Too many reset requests from this IP address. Please wait 15 minutes and try again.",
    });
  },
  skip: () => process.env.NODE_ENV === "test",
});

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
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.email, normalizedEmail));
      if (!user?.email) return ok();

      // sendSystemEmail needs a workspace to pick the system sender from. A
      // user with no membership has nothing to send through — still `ok`.
      const [member] = await db
        .select({ workspaceId: workspaceMembers.workspaceId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, user.id))
        .limit(1);
      if (!member) return ok();

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
      await sendSystemEmail(member.workspaceId, {
        to: user.email,
        subject: "Reset your Velocity password",
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
      return ok();
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
        // Single use — clearing these is what spends the token.
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
      })
      .where(eq(users.id, user.id));

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
        })
        .from(users)
        .where(eq(users.email, normalizedEmail));

      const GENERIC_ERROR = "Invalid email or password.";

      if (!user || !user.passwordHash) {
        // Constant-time dummy compare to prevent timing attacks
        await bcrypt.compare(password, "$2b$12$invalidhashpadding000000000000000000000000000000000000000");
        res.status(401).json({ error: GENERIC_ERROR });
        return;
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
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
      if (user.mfaTotpEnabledAt && user.mfaTotpSecret) {
        const totpCode = typeof (req.body ?? {}).totpCode === "string" ? (req.body.totpCode as string) : "";
        if (!totpCode) {
          res.status(401).json({ error: "Enter the 6-digit code from your authenticator app.", mfaRequired: true });
          return;
        }
        const { verifyTotp } = await import("./services/totp");
        if (!verifyTotp(user.mfaTotpSecret, totpCode)) {
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
          res.status(401).json({ error: "That authentication code didn't match — try again.", mfaRequired: true });
          return;
        }
      }

      try {
        await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));
      } catch (_) { /* non-fatal */ }

      // A successful password login proves the account is accepted — clear any
      // stale invite tokens (heals members who registered or set a password
      // without completing finaliseAcceptance) and normalise a leftover
      // "invite"/"expired_invite" loginMethod.
      try {
        await db
          .update(workspaceMembers)
          .set({ inviteToken: null, inviteExpiresAt: null })
          .where(eq(workspaceMembers.userId, user.id));
        if (user.loginMethod === "invite" || user.loginMethod === "expired_invite") {
          await db.update(users).set({ loginMethod: "password" }).where(eq(users.id, user.id));
        }
      } catch (_) { /* non-fatal */ }

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
          outcome: "success",
        });
      } catch (_) { /* non-fatal */ }

      const sessionToken = await sdk.createSessionToken(user.openId, {
        name: user.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      const redirect = safeReturnPath(returnPath);
      const acceptsJson = (req.headers.accept ?? "").includes("application/json");
      if (acceptsJson) {
        res.json({ ok: true, redirect });
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
      const { email, password, name, returnPath, inviteLinkToken } = req.body ?? {};

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
        })
        .from(users)
        .where(eq(users.email, normalizedEmail));

      // Existing real account → conflict.
      if (existing && existing.passwordHash) {
        res.status(409).json({
          error: "An account with that email already exists. Try signing in instead.",
        });
        return;
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const now = new Date();

      let userId: number;
      let openId: string;

      if (existing) {
        // Upgrade an invite placeholder (or any password-less row) in place,
        // preserving its workspaceMembers links.
        userId = existing.id;
        openId = existing.openId;
        await db
          .update(users)
          .set({
            passwordHash,
            name: cleanName ?? undefined,
            loginMethod: "password",
            lastSignedIn: now,
          })
          .where(eq(users.id, existing.id));
        // Registering fulfils any outstanding email invite: clear the member
        // rows' invite tokens, or the Team tab keeps showing "Pending" for an
        // account that is fully active (register bypasses finaliseAcceptance).
        await db
          .update(workspaceMembers)
          .set({ inviteToken: null, inviteExpiresAt: null })
          .where(eq(workspaceMembers.userId, existing.id));
      } else {
        openId = `local:${nanoid(24)}`;
        const [insertResult] = await db.insert(users).values({
          openId,
          email: normalizedEmail,
          name: cleanName,
          passwordHash,
          loginMethod: "password",
          lastSignedIn: now,
        });
        userId = (insertResult as unknown as { insertId: number }).insertId;
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

      try {
        await db.insert(loginHistory).values({
          userId,
          workspaceId: null,
          ipAddress: ipKey(req).slice(0, 64),
          userAgent: (req.headers["user-agent"] ?? "").slice(0, 500),
          outcome: "success",
        });
      } catch (_) { /* non-fatal */ }

      const sessionToken = await sdk.createSessionToken(openId, {
        name: cleanName ?? "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      const redirect = safeReturnPath(returnPath);
      const acceptsJson = (req.headers.accept ?? "").includes("application/json");
      if (acceptsJson) {
        res.json({ ok: true, redirect });
      } else {
        res.redirect(302, redirect);
      }
    },
  );
}
