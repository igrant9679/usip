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

  /**
   * Bounce webhook — accepts bounce notifications from Mailgun, SendGrid, Postmark, or generic
   * POST /api/track/bounce
   *
   * Providers configure this URL in their dashboard:
   *   Mailgun:  Webhooks → Permanent Failure + Temporary Failure + Spam Complaints
   *   SendGrid: Mail Settings → Event Webhook (bounce, spamreport)
   *   Postmark: Servers → Webhooks → Bounce + SpamComplaint
   *
   * Signature verification:
   *   Mailgun:  MAILGUN_WEBHOOK_KEY env var (HMAC-SHA256 of timestamp+token)
   *   Postmark: POSTMARK_WEBHOOK_KEY env var (HMAC-SHA256 of body)
   *   SendGrid: ECDSA verification skipped (use IP allowlist in production)
   *
   * Set BOUNCE_WEBHOOK_SKIP_VERIFY=true to bypass signature checks in development.
   */
  app.post("/api/track/bounce", async (req: Request, res: Response) => {
    // Respond immediately to prevent provider retries
    res.status(200).json({ ok: true });

    try {
      const provider = detectBounceProvider(req);
      const events = parseBouncePayload(provider, req.body);
      if (events.length === 0) return;

      const skipVerify = process.env.BOUNCE_WEBHOOK_SKIP_VERIFY === "true";
      if (!skipVerify) {
        const valid = verifyBounceSignature(provider, req);
        if (!valid) {
          console.warn("[BounceWebhook] Invalid signature from provider:", provider);
          return;
        }
      }

      const db = await getDb();
      if (!db) return;

      for (const event of events) {
        try {
          await processBounceEvent(db, event);
        } catch (e) {
          console.error("[BounceWebhook] Failed to process event:", event.email, e);
        }
      }
    } catch (e) {
      console.error("[BounceWebhook] Unhandled error:", e);
    }
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   Bounce webhook helpers
   ───────────────────────────────────────────────────────────────────────── */

type BounceProvider = "mailgun" | "sendgrid" | "postmark" | "generic";

interface BounceEvent {
  email: string;
  bounceType: "hard" | "soft" | "spam";
  message?: string;
  timestamp?: Date;
}

export function detectBounceProvider(req: Request): BounceProvider {
  if (req.headers["x-mailgun-signature-v2"]) return "mailgun";
  if (req.headers["x-twilio-email-event-webhook-signature"]) return "sendgrid";
  if (req.headers["x-postmark-signature"]) return "postmark";
  return "generic";
}

export function parseBouncePayload(provider: BounceProvider, body: unknown): BounceEvent[] {
  if (!body || typeof body !== "object") return [];
  const events: BounceEvent[] = [];

  if (provider === "mailgun") {
    const data = (body as Record<string, unknown>)["event-data"] as Record<string, unknown> | undefined;
    if (!data) return [];
    const eventType = data["event"] as string;
    const recipient = data["recipient"] as string;
    if (!recipient) return [];
    if (eventType === "failed") {
      const severity = (data["severity"] as string) ?? "permanent";
      events.push({
        email: recipient.toLowerCase(),
        bounceType: severity === "permanent" ? "hard" : "soft",
        message: (data["delivery-status"] as Record<string, string>)?.["message"] ?? undefined,
        timestamp: data["timestamp"] ? new Date((data["timestamp"] as number) * 1000) : new Date(),
      });
    } else if (eventType === "complained") {
      events.push({ email: recipient.toLowerCase(), bounceType: "spam", timestamp: new Date() });
    }
  } else if (provider === "sendgrid") {
    const arr = Array.isArray(body) ? body : [body];
    for (const item of arr) {
      const ev = item as Record<string, unknown>;
      const email = (ev["email"] as string)?.toLowerCase();
      if (!email) continue;
      const eventType = ev["event"] as string;
      if (eventType === "bounce" || eventType === "blocked") {
        const bounceType = (ev["type"] as string) === "bounce" ? "hard" : "soft";
        events.push({
          email,
          bounceType,
          message: (ev["reason"] as string) ?? undefined,
          timestamp: ev["timestamp"] ? new Date((ev["timestamp"] as number) * 1000) : new Date(),
        });
      } else if (eventType === "spamreport") {
        events.push({ email, bounceType: "spam", timestamp: new Date() });
      }
    }
  } else if (provider === "postmark") {
    const ev = body as Record<string, unknown>;
    const email = (ev["Email"] as string)?.toLowerCase();
    if (!email) return [];
    const recordType = ev["RecordType"] as string;
    if (recordType === "Bounce") {
      const typeCode = ev["Type"] as string;
      const bounceType: BounceEvent["bounceType"] =
        typeCode === "HardBounce" ? "hard" :
        typeCode === "SpamComplaint" ? "spam" : "soft";
      events.push({
        email,
        bounceType,
        message: (ev["Description"] as string) ?? undefined,
        timestamp: ev["BouncedAt"] ? new Date(ev["BouncedAt"] as string) : new Date(),
      });
    } else if (recordType === "SpamComplaint") {
      events.push({ email, bounceType: "spam", timestamp: new Date() });
    }
  } else {
    // Generic: expect { email, type: 'hard'|'soft'|'spam', message? }
    const ev = body as Record<string, unknown>;
    const email = (ev["email"] as string)?.toLowerCase();
    const type = ev["type"] as string;
    if (email && ["hard", "soft", "spam"].includes(type)) {
      events.push({
        email,
        bounceType: type as BounceEvent["bounceType"],
        message: ev["message"] as string | undefined,
      });
    }
  }

  return events;
}

export function verifyBounceSignature(provider: BounceProvider, req: Request): boolean {
  try {
    if (provider === "mailgun") {
      const key = process.env.MAILGUN_WEBHOOK_KEY;
      if (!key) return true; // key not configured, skip
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const crypto = require("crypto");
      const sig = (req.body as Record<string, Record<string, string>>)?.["signature"];
      if (!sig) return false;
      const { timestamp, token, signature } = sig;
      if (!timestamp || !token || !signature) return false;
      const expected = crypto.createHmac("sha256", key).update(timestamp + token).digest("hex");
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    }
    if (provider === "postmark") {
      const key = process.env.POSTMARK_WEBHOOK_KEY;
      if (!key) return true;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const crypto = require("crypto");
      const signature = req.headers["x-postmark-signature"] as string;
      if (!signature) return false;
      const rawBody = JSON.stringify(req.body);
      const expected = crypto.createHmac("sha256", key).update(rawBody).digest("base64");
      return signature === expected;
    }
    // SendGrid ECDSA — complex; use IP allowlist in production
    return true;
  } catch {
    return false;
  }
}

export async function processBounceEvent(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  event: BounceEvent
): Promise<void> {
  const { emailDrafts: draftsTable, emailSuppressions } = await import("../drizzle/schema");
  const { eq, and } = await import("drizzle-orm");

  // 1. Find the most recent sent draft for this email
  const [draft] = await db
    .select({ id: draftsTable.id, workspaceId: draftsTable.workspaceId })
    .from(draftsTable)
    .where(eq(draftsTable.toEmail, event.email))
    .orderBy(draftsTable.sentAt)
    .limit(1);

  const workspaceId = draft?.workspaceId ?? 0;

  // 2. Update the draft's bounce fields
  if (draft) {
    await db
      .update(draftsTable)
      .set({
        bouncedAt: event.timestamp ?? new Date(),
        bounceType: event.bounceType,
        bounceMessage: event.message?.slice(0, 512) ?? null,
      })
      .where(eq(draftsTable.id, draft.id));
  }

  // 3. Insert suppression row if not already present
  //    emailSuppressions uses hard-delete (no removedAt column), so just check for existing row
  if (workspaceId > 0) {
    const suppressionReason = event.bounceType === "spam" ? "spam_complaint" : "bounce";
    const existing = await db
      .select({ id: emailSuppressions.id })
      .from(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.workspaceId, workspaceId),
          eq(emailSuppressions.email, event.email),
          eq(emailSuppressions.reason, suppressionReason)
        )
      )
      .limit(1);

    if (existing.length === 0) {
      await db.insert(emailSuppressions).values({
        workspaceId,
        email: event.email,
        reason: suppressionReason,
        draftId: draft?.id ?? null,
        notes: event.message?.slice(0, 512) ?? null,
      });
    }
  }

  console.log(`[BounceWebhook] Processed ${event.bounceType} bounce for ${event.email}`);
}
