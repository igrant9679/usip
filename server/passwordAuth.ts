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
import { eq } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { nanoid } from "nanoid";
import { getDb } from "./db";
import { users, loginHistory, workspaceMembers } from "../drizzle/schema";
import { sdk } from "./_core/sdk";
import { getSessionCookieOptions } from "./_core/cookies";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

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

export function registerPasswordAuthRoutes(app: Express) {
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

      try {
        await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));
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

      const redirect = typeof returnPath === "string" && returnPath.startsWith("/") ? returnPath : "/";
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
      const { email, password, name, returnPath } = req.body ?? {};

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

      const redirect = typeof returnPath === "string" && returnPath.startsWith("/") ? returnPath : "/";
      const acceptsJson = (req.headers.accept ?? "").includes("application/json");
      if (acceptsJson) {
        res.json({ ok: true, redirect });
      } else {
        res.redirect(302, redirect);
      }
    },
  );
}
