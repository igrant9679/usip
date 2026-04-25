/**
 * Password-based authentication route.
 *
 * POST /api/auth/password-login
 *   Body: { email: string; password: string; returnPath?: string }
 *
 * Verifies the bcrypt hash stored in users.passwordHash, issues the same
 * JWT session cookie as the OAuth flow, and redirects (or returns JSON for
 * fetch-based callers).
 *
 * Rate-limiting: express-rate-limit — 10 attempts per IP per 15 minutes.
 * The in-memory store resets on restart, which is acceptable for a single-
 * instance deployment; swap to a Redis store if horizontal scaling is needed.
 */
import type { Express, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import rateLimit from "express-rate-limit";
import { getDb } from "./db";
import { users, loginHistory, workspaceMembers } from "../drizzle/schema";
import { sdk } from "./_core/sdk";
import { getSessionCookieOptions } from "./_core/cookies";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/** 10 attempts per IP per 15 minutes */
const passwordLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1_000,
  max: 10,
  standardHeaders: true,   // Return `RateLimit-*` headers
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    ((req.headers["x-forwarded-for"] as string) ?? req.socket?.remoteAddress ?? "unknown")
      .split(",")[0]
      .trim(),
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: "Too many login attempts from this IP address. Please wait 15 minutes and try again.",
    });
  },
  skip: () => process.env.NODE_ENV === "test",
});

export function registerPasswordAuthRoutes(app: Express) {
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
        // Record failed login
        try {
          const [member] = await db
            .select({ workspaceId: workspaceMembers.workspaceId })
            .from(workspaceMembers)
            .where(eq(workspaceMembers.userId, user.id))
            .limit(1);
          await db.insert(loginHistory).values({
            userId: user.id,
            workspaceId: member?.workspaceId ?? null,
            ipAddress: ((req.headers["x-forwarded-for"] as string) ?? req.socket?.remoteAddress ?? "").slice(0, 64),
            userAgent: (req.headers["user-agent"] ?? "").slice(0, 500),
            outcome: "failed",
          });
        } catch (_) { /* non-fatal */ }
        res.status(401).json({ error: GENERIC_ERROR });
        return;
      }

      // Successful login — update lastSignedIn, issue session
      try {
        await db.update(users).set({ lastSignedIn: new Date() }).where(eq(users.id, user.id));
      } catch (_) { /* non-fatal */ }

      // Record successful login
      try {
        const [member] = await db
          .select({ workspaceId: workspaceMembers.workspaceId })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, user.id))
          .limit(1);
        await db.insert(loginHistory).values({
          userId: user.id,
          workspaceId: member?.workspaceId ?? null,
          ipAddress: ((req.headers["x-forwarded-for"] as string) ?? req.socket?.remoteAddress ?? "").slice(0, 64),
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

      // Support both JSON fetch callers and redirect-based callers
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
