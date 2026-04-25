/**
 * Password-based authentication route.
 *
 * POST /api/auth/password-login
 *   Body: { email: string; password: string; returnPath?: string }
 *
 * Verifies the bcrypt hash stored in users.passwordHash, issues the same
 * JWT session cookie as the OAuth flow, and redirects (or returns JSON for
 * fetch-based callers).
 */
import type { Express, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { users, loginHistory, workspaceMembers } from "../drizzle/schema";
import { sdk } from "./_core/sdk";
import { getSessionCookieOptions } from "./_core/cookies";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

const MAX_ATTEMPTS = 10; // per process restart — simple in-memory rate limit
const attemptMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(email: string): boolean {
  const now = Date.now();
  const entry = attemptMap.get(email);
  if (!entry || entry.resetAt < now) {
    attemptMap.set(email, { count: 1, resetAt: now + 15 * 60_000 });
    return true;
  }
  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) return false;
  return true;
}

function clearRateLimit(email: string) {
  attemptMap.delete(email);
}

export function registerPasswordAuthRoutes(app: Express) {
  app.post("/api/auth/password-login", async (req: Request, res: Response) => {
    const { email, password, returnPath } = req.body ?? {};

    if (typeof email !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "email and password are required" });
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Simple in-memory rate limit
    if (!checkRateLimit(normalizedEmail)) {
      res.status(429).json({ error: "Too many login attempts. Please wait 15 minutes and try again." });
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

    // Successful login — clear rate limit, update lastSignedIn, issue session
    clearRateLimit(normalizedEmail);

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
  });
}
