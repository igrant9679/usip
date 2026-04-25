import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { parse as parseCookieHeader } from "cookie";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getDb } from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

const INVITE_RETURN_COOKIE = "usip_invite_return";

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

export function registerOAuthRoutes(app: Express) {
  // Pre-auth endpoint: stores the returnPath in a short-lived HttpOnly cookie
  // before the OAuth redirect so the callback can redirect back to the invite page.
  // Called by InviteAccept.tsx before window.location.href = loginUrl.
  app.get("/api/auth/set-return", (req: Request, res: Response) => {
    const path = typeof req.query.path === "string" ? req.query.path : null;
    if (path && path.startsWith("/invite/accept")) {
      res.cookie(INVITE_RETURN_COOKIE, path, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 10 * 60 * 1000, // 10 minutes
        path: "/",
      });
    }
    res.json({ ok: true });
  });

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

      // ── Invite-placeholder merge ──────────────────────────────────────────
      // When an admin invites a user by email, we create a placeholder user row
      // with openId = "invite:<email>" and loginMethod = "invite".
      // On the user's first real OAuth sign-in we must merge that placeholder
      // into the real user row so workspace_members points to the right user.
      //
      // Strategy:
      //   1. Find the real user row (just upserted above) by openId.
      //   2. Look for a placeholder row with openId = "invite:<email>" for the
      //      same email that still has loginMethod = "invite" or "expired_invite".
      //   3. If found, re-point all workspace_members.userId references from the
      //      placeholder to the real user, then delete the placeholder.
      if (userInfo.email) {
        try {
          const dbConn = await getDb();
          if (dbConn) {
            const { users: usersTable, workspaceMembers } = await import("../../drizzle/schema");
            const { eq, and, or } = await import("drizzle-orm");

            // Find the real user row
            const [realUser] = await dbConn
              .select({ id: usersTable.id })
              .from(usersTable)
              .where(eq(usersTable.openId, userInfo.openId));

            if (realUser) {
              // Find any placeholder rows with the same email
              const placeholders = await dbConn
                .select({ id: usersTable.id, openId: usersTable.openId })
                .from(usersTable)
                .where(
                  and(
                    eq(usersTable.email, userInfo.email),
                    or(
                      eq(usersTable.loginMethod, "invite"),
                      eq(usersTable.loginMethod, "expired_invite"),
                    ),
                  ),
                );

              for (const placeholder of placeholders) {
                if (placeholder.id === realUser.id) continue; // same row, skip
                // Re-point workspace_members from placeholder → real user
                await dbConn
                  .update(workspaceMembers)
                  .set({ userId: realUser.id })
                  .where(eq(workspaceMembers.userId, placeholder.id));
                // Delete the now-orphaned placeholder user row
                await dbConn
                  .delete(usersTable)
                  .where(eq(usersTable.id, placeholder.id));
                console.log(
                  `[OAuth] Merged invite placeholder user ${placeholder.id} (${placeholder.openId}) → real user ${realUser.id} (${userInfo.openId})`,
                );
              }
            }
          }
        } catch (mergeErr) {
          // Non-fatal: log but don't block the login
          console.error("[OAuth] Invite-placeholder merge failed", mergeErr);
        }
      }

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

      // Check for a pre-auth invite return cookie set by /api/auth/set-return.
      // Express does not have cookie-parser registered, so we parse the raw
      // Cookie header manually (same approach as sdk.ts parseCookies).
      const rawCookies = parseCookieHeader(req.headers.cookie ?? "");
      const inviteReturn = rawCookies[INVITE_RETURN_COOKIE];
      let redirectTo = "/";
      if (
        inviteReturn &&
        typeof inviteReturn === "string" &&
        inviteReturn.startsWith("/invite/accept")
      ) {
        redirectTo = inviteReturn;
        res.clearCookie(INVITE_RETURN_COOKIE, { path: "/" });
      }
      res.redirect(302, redirectTo);
    } catch (error) {
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}
