/**
 * Email Tracking Routes (Feature 47)
 *
 * GET /api/track/open/:token
 *   - Returns a 1×1 transparent GIF
 *   - Inserts an "open" event into email_tracking_events
 *   - Increments emailDrafts.openCount, sets lastOpenedAt
 *
 * GET /api/track/click/:token?url=...
 *   - Inserts a "click" event into email_tracking_events
 *   - Increments emailDrafts.clickCount, sets lastClickedAt
 *   - Redirects the browser to the original URL
 */

import type { Express, Request, Response } from "express";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { emailDrafts, emailTrackingEvents } from "../drizzle/schema";

// 1×1 transparent GIF (43 bytes)
const TRACKING_PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

export function registerEmailTrackingRoutes(app: Express) {
  /**
   * Open pixel — called when the email client loads images
   */
  app.get("/api/track/open/:token", async (req: Request, res: Response) => {
    // Always return the pixel immediately so the email client doesn't hang
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Content-Length", TRACKING_PIXEL.length);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.end(TRACKING_PIXEL);

    // Record the event asynchronously (don't block the response)
    const { token } = req.params;
    if (!token) return;

    try {
      const db = await getDb();
      if (!db) return;

      // Look up the draft by tracking token
      const [draft] = await db
        .select({ id: emailDrafts.id, workspaceId: emailDrafts.workspaceId })
        .from(emailDrafts)
        .where(eq(emailDrafts.trackingToken, token))
        .limit(1);

      if (!draft) return;

      // Insert tracking event
      await db.insert(emailTrackingEvents).values({
        workspaceId: draft.workspaceId,
        draftId: draft.id,
        type: "open",
        userAgent: req.headers["user-agent"]?.slice(0, 512) ?? null,
        ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null,
      });

      // Increment counter + set lastOpenedAt
      await db
        .update(emailDrafts)
        .set({
          openCount: sql`${emailDrafts.openCount} + 1`,
          lastOpenedAt: new Date(),
        })
        .where(eq(emailDrafts.id, draft.id));
    } catch (e) {
      console.error("[EmailTracking] open event failed:", e);
    }
  });

  /**
   * Click redirect — wraps outbound links in tracked emails
   */
  app.get("/api/track/click/:token", async (req: Request, res: Response) => {
    const { token } = req.params;
    const targetUrl = req.query.url as string | undefined;

    // Validate target URL before redirecting
    if (!targetUrl) {
      res.status(400).send("Missing url parameter");
      return;
    }

    let safeUrl: string;
    try {
      const parsed = new URL(targetUrl);
      // Only allow http/https redirects
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        res.status(400).send("Invalid URL");
        return;
      }
      safeUrl = parsed.toString();
    } catch {
      res.status(400).send("Invalid URL");
      return;
    }

    // Redirect immediately
    res.redirect(302, safeUrl);

    // Record the event asynchronously
    if (!token) return;

    try {
      const db = await getDb();
      if (!db) return;

      const [draft] = await db
        .select({ id: emailDrafts.id, workspaceId: emailDrafts.workspaceId })
        .from(emailDrafts)
        .where(eq(emailDrafts.trackingToken, token))
        .limit(1);

      if (!draft) return;

      await db.insert(emailTrackingEvents).values({
        workspaceId: draft.workspaceId,
        draftId: draft.id,
        type: "click",
        url: safeUrl.slice(0, 2048),
        userAgent: req.headers["user-agent"]?.slice(0, 512) ?? null,
        ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null,
      });

      await db
        .update(emailDrafts)
        .set({
          clickCount: sql`${emailDrafts.clickCount} + 1`,
          lastClickedAt: new Date(),
        })
        .where(eq(emailDrafts.id, draft.id));
    } catch (e) {
      console.error("[EmailTracking] click event failed:", e);
    }
  });

  /**
   * Unsubscribe — one-click opt-out via tracking token
   * GET /api/track/unsubscribe/:token
   */
  app.get("/api/track/unsubscribe/:token", async (req: Request, res: Response) => {
    const { token } = req.params;
    if (!token) {
      return res.status(400).send("<h2>Invalid unsubscribe link.</h2>");
    }
    try {
      const { recordUnsubscribeByToken } = await import("./routers/emailSuppressions");
      const result = await recordUnsubscribeByToken(token, req.headers["user-agent"]);
      if (result.ok) {
        return res.status(200).send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed</title>
          <style>body{font-family:sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#333}
          h1{color:#111}p{color:#666}</style></head>
          <body><h1>You have been unsubscribed</h1>
          <p>The address <strong>${result.email ?? ""}</strong> has been removed from our mailing list.</p>
          <p>You will no longer receive emails from this sender.</p>
          <p style="margin-top:40px;font-size:12px;color:#999">If this was a mistake, please contact the sender directly.</p>
          </body></html>`
        );
      } else {
        return res.status(400).send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title></head>
          <body><h2>This unsubscribe link is invalid or has already been used.</h2></body></html>`
        );
      }
    } catch (e) {
      console.error("[EmailTracking] unsubscribe failed:", e);
      return res.status(500).send("<h2>An error occurred. Please try again later.</h2>");
    }
  });
}
