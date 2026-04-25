import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getDb } from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);

      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }

      await db.upsertUser({
        openId: userInfo.openId,
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: new Date(),
      });

      // Record login history (non-fatal)
      try {
        const dbConn = await getDb();
        if (dbConn) {
          const { loginHistory, users: usersTable, workspaceMembers } = await import("../../drizzle/schema");
          const { eq } = await import("drizzle-orm");
          const [user] = await dbConn.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.openId, userInfo.openId));
          if (user) {
            const [member] = await dbConn.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, user.id)).limit(1);
            await dbConn.insert(loginHistory).values({
              userId: user.id,
              workspaceId: member?.workspaceId ?? null,
              ipAddress: ((req.headers["x-forwarded-for"] as string) ?? req.socket?.remoteAddress ?? "").slice(0, 64),
              userAgent: (req.headers["user-agent"] ?? "").slice(0, 500),
              outcome: "success",
            });
          }
        }
      } catch (_e) { /* Non-fatal */ }

      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      // Always redirect to '/' after OAuth. The client-side InviteAccept page
      // stores its returnPath in sessionStorage before redirecting to the OAuth
      // portal and reads it back on mount to navigate back to the invite flow.
      res.redirect(302, "/");
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}
