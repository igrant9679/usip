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

  /**
   * Proposal email open pixel — called when the client loads the proposal email.
   * Logs a "Client opened the proposal email" activity and sets emailOpenedAt.
   * Uses the proposal shareToken as the tracking token.
   */
  app.get("/api/track/proposal-open/:token", async (req: Request, res: Response) => {
    // Return the pixel immediately
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Content-Length", TRACKING_PIXEL.length);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.end(TRACKING_PIXEL);
    const { token } = req.params;
    if (!token) return;
    try {
      const db = await getDb();
      if (!db) return;
      const { proposals, activities } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      // Look up the proposal by shareToken
      const [proposal] = await db
        .select({
          id: proposals.id,
          workspaceId: proposals.workspaceId,
          title: proposals.title,
          emailOpenedAt: proposals.emailOpenedAt,
        })
        .from(proposals)
        .where(eq(proposals.shareToken, token))
        .limit(1);
      if (!proposal) return;
      // Set emailOpenedAt only on first open
      if (!proposal.emailOpenedAt) {
        await db
          .update(proposals)
          .set({ emailOpenedAt: new Date() })
          .where(eq(proposals.id, proposal.id));
      }
      // Always log the open event as an activity
      await db.insert(activities).values({
        workspaceId: proposal.workspaceId,
        relatedType: "proposal",
        relatedId: proposal.id,
        type: "system",
        subject: "Client opened the proposal email",
        body: `The client opened the email for "${proposal.title}".`,
        actorUserId: null,
        occurredAt: new Date(),
      });
    } catch (e) {
      console.error("[ProposalTracking] open event failed:", e);
    }
  });

  /**
   * Proposal email click tracker — called when the client clicks the "View Proposal" CTA.
   * Logs a "Client clicked the proposal link" activity, sets emailClickedAt on first click,
   * then redirects to the actual portal URL.
   */
  app.get("/api/track/proposal-click/:token", async (req: Request, res: Response) => {
    const { token } = req.params;
    const { dest } = req.query as { dest?: string };
    // Redirect immediately — tracking is best-effort
    const fallback = dest || "/";
    res.redirect(302, fallback);
    if (!token) return;
    try {
      const db = await getDb();
      if (!db) return;
      const { proposals, activities } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");
      const [proposal] = await db
        .select({
          id: proposals.id,
          workspaceId: proposals.workspaceId,
          title: proposals.title,
          emailClickedAt: proposals.emailClickedAt,
        })
        .from(proposals)
        .where(eq(proposals.shareToken, token))
        .limit(1);
      if (!proposal) return;
      // Set emailClickedAt only on first click
      if (!proposal.emailClickedAt) {
        await db
          .update(proposals)
          .set({ emailClickedAt: new Date() })
          .where(eq(proposals.id, proposal.id));
      }
      // Log the click event as an activity
      await db.insert(activities).values({
        workspaceId: proposal.workspaceId,
        relatedType: "proposal",
        relatedId: proposal.id,
        type: "system",
        subject: "Client clicked the proposal link",
        body: `The client clicked the "View Proposal" button in the email for "${proposal.title}".`,
        actorUserId: null,
        occurredAt: new Date(),
      });
    } catch (e) {
      console.error("[ProposalTracking] click event failed:", e);
    }
  });

  /* ── Scheduled: proposal follow-up reminder ──────────────────────────────
     POST /api/scheduled/proposal-followup
     Called by the Manus scheduled task agent every 24h.
     Finds proposals sent 48+ hours ago with no emailOpenedAt, creates a
     follow_up task and in-app notification for the workspace owner.
  ─────────────────────────────────────────────────────────────────────────── */
  app.post("/api/scheduled/proposal-followup", async (req: any, res: any) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ ok: false, error: "DB unavailable" });

      const { proposals, tasks, notifications, activities, workspaces } = await import("../drizzle/schema");
      const { and, isNull, lt } = await import("drizzle-orm");

      const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago

      // Find sent proposals with no emailOpenedAt, sent before the cutoff
      const staleProposals = await db
        .select()
        .from(proposals)
        .where(
          and(
            eq(proposals.status, "sent"),
            isNull(proposals.emailOpenedAt),
            lt(proposals.sentAt, cutoff),
          ),
        );

      if (staleProposals.length === 0) {
        return res.json({ ok: true, processed: 0, message: "No stale proposals found" });
      }

      let processed = 0;
      for (const proposal of staleProposals) {
        try {
          // Get workspace owner
          const wsRows = await db
            .select({ ownerUserId: workspaces.ownerUserId })
            .from(workspaces)
            .where(eq(workspaces.id, proposal.workspaceId))
            .limit(1);
          if (!wsRows[0]) continue;
          const ownerUserId = wsRows[0].ownerUserId;

          // Check if a follow-up task already exists for this proposal
          const existingTask = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(
                eq(tasks.workspaceId, proposal.workspaceId),
                eq(tasks.relatedType, "proposal"),
                eq(tasks.relatedId, proposal.id),
                eq(tasks.type, "follow_up"),
                eq(tasks.status, "open"),
              ),
            )
            .limit(1);

          if (existingTask.length > 0) continue; // already has an open follow-up

          const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // due in 24h

          // Create follow-up task
          await db.insert(tasks).values({
            workspaceId: proposal.workspaceId,
            title: `Follow up: "${proposal.title}" — client hasn't opened the email`,
            description: `Proposal sent to ${proposal.clientEmail ?? proposal.clientName} on ${proposal.sentAt?.toLocaleDateString() ?? "unknown date"}. No email open detected after 48 hours. Consider reaching out directly.`,
            type: "follow_up",
            priority: "high",
            status: "open",
            dueAt,
            ownerUserId,
            relatedType: "proposal",
            relatedId: proposal.id,
          });

          // Create in-app notification
          await db.insert(notifications).values({
            workspaceId: proposal.workspaceId,
            userId: ownerUserId,
            kind: "system",
            title: `Follow-up needed: "${proposal.title}"`,
            body: `This proposal was sent 48+ hours ago but the client hasn't opened the email yet. A follow-up task has been created.`,
            isRead: false,
          });

          // Log activity
          await db.insert(activities).values({
            workspaceId: proposal.workspaceId,
            type: "system",
            relatedType: "proposal",
            relatedId: proposal.id,
            subject: "Automated follow-up task created (no email open after 48h)",
            body: "The system detected no email open after 48 hours and created a follow-up task.",
            actorUserId: null,
            occurredAt: new Date(),
          });

          processed++;
        } catch (e) {
          console.error(`[ProposalFollowup] Failed for proposal ${proposal.id}:`, e);
        }
      }

      return res.json({ ok: true, processed, total: staleProposals.length });
    } catch (e) {
      console.error("[ProposalFollowup] Endpoint error:", e);
      return res.status(500).json({ ok: false, error: String(e) });
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
