/**
 * Auth helper routes (post-Manus). The OAuth callback has been removed —
 * authentication is now native email + password via passwordAuth.ts.
 *
 * What remains:
 *   GET /api/auth/set-return  — used by InviteAccept.tsx to stash the invite
 *     return URL in a short-lived HttpOnly cookie before redirecting to login.
 *     The login flow reads this cookie post-login to redirect users back to
 *     the original invite acceptance page.
 *   GET /api/oauth/callback   — returns 410 Gone, in case any external link
 *     still points at the old Manus OAuth callback.
 */
import type { Express, Request, Response } from "express";

const INVITE_RETURN_COOKIE = "usip_invite_return";

export function registerOAuthRoutes(app: Express) {
  app.get("/api/auth/set-return", (req: Request, res: Response) => {
    const path = typeof req.query.path === "string" ? req.query.path : null;
    if (path && path.startsWith("/invite/accept")) {
      res.cookie(INVITE_RETURN_COOKIE, path, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 10 * 60 * 1000,
        path: "/",
      });
    }
    res.json({ ok: true });
  });

  app.get("/api/oauth/callback", (_req: Request, res: Response) => {
    res
      .status(410)
      .json({ error: "OAuth login is no longer supported. Use /api/auth/password-login." });
  });
}
