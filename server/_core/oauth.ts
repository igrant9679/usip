/**
 * Auth helper routes (post-Manus). The OAuth callback has been removed —
 * authentication is now native email + password via passwordAuth.ts.
 *
 * What remains:
 *   GET /api/oauth/callback   — returns 410 Gone, in case any external link
 *     still points at the old Manus OAuth callback. Kept on purpose: an old
 *     link answered with a reason beats a bare 404.
 *
 * GET /api/auth/set-return is gone (audit G67, 2026-11-07). It stashed the
 * invite return path in a cookie that nothing read, and nothing called it:
 * InviteAccept sends its return path with the sign-in request itself
 * (password-login's returnPath) and follows the redirect it gets back.
 */
import type { Express, Request, Response } from "express";

export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", (_req: Request, res: Response) => {
    res
      .status(410)
      .json({ error: "OAuth login is no longer supported. Use /api/auth/password-login." });
  });
}
