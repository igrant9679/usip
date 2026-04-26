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
          expiresAt: proposals.expiresAt,
          skipAutoExtend: proposals.skipAutoExtend,
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
      // ── Auto-extend expiresAt if workspace setting is enabled ──────────────
      try {
        const { workspaceSettings } = await import("../drizzle/schema");
        const [ws] = await db
          .select({ autoExtendOnOpen: workspaceSettings.autoExtendOnOpen, autoExtendDays: workspaceSettings.autoExtendDays })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, proposal.workspaceId))
          .limit(1);
        if (ws?.autoExtendOnOpen && proposal.expiresAt && !proposal.skipAutoExtend) {
          const msLeft = new Date(proposal.expiresAt).getTime() - Date.now();
          const sevenDays = 7 * 24 * 60 * 60 * 1000;
          // Only auto-extend if expiry is within 7 days (and not already expired)
          if (msLeft > 0 && msLeft <= sevenDays) {
            const extendDays = ws.autoExtendDays ?? 7;
            const newExpiry = new Date(new Date(proposal.expiresAt).getTime() + extendDays * 24 * 60 * 60 * 1000);
            await db
              .update(proposals)
              .set({ expiresAt: newExpiry, updatedAt: new Date() })
              .where(eq(proposals.id, proposal.id));
            // Log the auto-extension as an activity
            await db.insert(activities).values({
              workspaceId: proposal.workspaceId,
              relatedType: "proposal",
              relatedId: proposal.id,
              type: "system",
              subject: `Expiry auto-extended by ${extendDays} days (client opened email)`,
              body: `The client opened the proposal email. The expiry date was automatically extended by ${extendDays} days to ${newExpiry.toLocaleDateString()}.`,
              actorUserId: null,
              occurredAt: new Date(),
            });
          }
        }
      } catch (_extErr) {
        // Non-fatal — auto-extend failure should not break the open tracking
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

      // ── Expiry reminder: email client when expiresAt is within 48h ──────────────
      const { isNotNull: isNotNullR, gt: gtR, lte: lteR, inArray: inArrayR } = await import("drizzle-orm");
      const reminderCutoff = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h from now
      const reminderFloor = new Date(); // not yet expired
      const expiringProposals = await db
        .select()
        .from(proposals)
        .where(
          and(
            isNotNullR(proposals.expiresAt),
            gtR(proposals.expiresAt, reminderFloor),
            lteR(proposals.expiresAt, reminderCutoff),
            inArrayR(proposals.status, ["sent", "under_review"]),
          ),
        );
      let remindersSent = 0;
      for (const rp of expiringProposals) {
        try {
          if (!rp.clientEmail || !rp.shareToken) continue;
          // Deduplicate: check if we already logged a reminder activity today
          const { gte: gteR2 } = await import("drizzle-orm");
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const alreadySent = await db
            .select({ id: activities.id })
            .from(activities)
            .where(
              and(
                eq(activities.workspaceId, rp.workspaceId),
                eq(activities.relatedType, "proposal"),
                eq(activities.relatedId, rp.id),
                eq(activities.subject, "Expiry reminder email sent"),
                gteR2(activities.occurredAt, todayStart),
              ),
            )
            .limit(1);
          if (alreadySent.length > 0) continue;
          // Build reminder email
          const expDate = new Date(rp.expiresAt!);
          const daysLeft = Math.ceil((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          const countdownText = daysLeft <= 1 ? "today" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
          const shareUrl = `${process.env.MANUS_APP_URL ?? ""}/p/${rp.shareToken}`;
          const emailHtml = `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">
  <div style="margin-bottom:24px">
    <span style="font-size:13px;font-weight:600;letter-spacing:0.05em;color:#14b8a6;text-transform:uppercase">LSI Media · USIP</span>
  </div>
  <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:16px;margin-bottom:20px">
    <p style="margin:0;font-weight:700;color:#c2410c;font-size:15px">⏰ Proposal Expiring ${countdownText}</p>
    <p style="margin:6px 0 0;color:#9a3412;font-size:13px">This proposal will expire on ${expDate.toLocaleDateString()}.</p>
  </div>
  <h2 style="margin:0 0 8px;font-size:18px;font-weight:700">Action required: ${rp.title}</h2>
  <p style="margin:0 0 16px;color:#6b7280">Hi ${rp.clientName},</p>
  <p style="margin:0 0 16px;color:#374151">
    The proposal <strong>${rp.title}</strong> is expiring ${countdownText}.
    Please review and accept it before it closes.
  </p>
  <p style="margin:24px 0">
    <a href="${shareUrl}" style="display:inline-block;background:#0f766e;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
      Review Proposal →
    </a>
  </p>
  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
  <p style="color:#9ca3af;font-size:12px">
    You are receiving this because a proposal was shared with you. If you have questions, please reply to this email.
  </p>
</div>`;
          // Send via workspace sending account
          try {
            const { createEmailAdapter } = await import("./emailAdapter");
            const { sendingAccounts } = await import("../drizzle/schema");
            const [sendingAcc] = await db
              .select()
              .from(sendingAccounts)
              .where(and(eq(sendingAccounts.workspaceId, rp.workspaceId), eq(sendingAccounts.enabled, true)))
              .limit(1);
            if (sendingAcc) {
              const adapter = createEmailAdapter(sendingAcc);
              await adapter.sendEmail({
                fromEmail: sendingAcc.fromEmail,
                fromName: sendingAcc.fromName ?? "LSI Media",
                to: rp.clientEmail,
                subject: `Reminder: "${rp.title}" proposal expires ${countdownText}`,
                bodyHtml: emailHtml,
              });
            } else {
              const { sendWorkspaceEmail } = await import("./emailDelivery");
              await sendWorkspaceEmail(rp.workspaceId, {
                to: rp.clientEmail,
                subject: `Reminder: "${rp.title}" proposal expires ${countdownText}`,
                html: emailHtml,
              });
            }
          } catch (_emailErr) {
            // Non-fatal — still log activity and notify owner
          }
          // Log activity so we don't re-send today
          await db.insert(activities).values({
            workspaceId: rp.workspaceId,
            type: "system",
            relatedType: "proposal",
            relatedId: rp.id,
            subject: "Expiry reminder email sent",
            body: `Reminder email sent to ${rp.clientEmail} — proposal expires ${countdownText} (${expDate.toLocaleDateString()}).`,
            actorUserId: null,
            occurredAt: new Date(),
          });
          // In-app notification to workspace owner
          const wsOwnerRows = await db
            .select({ ownerUserId: workspaces.ownerUserId })
            .from(workspaces)
            .where(eq(workspaces.id, rp.workspaceId))
            .limit(1);
          if (wsOwnerRows[0]) {
            await db.insert(notifications).values({
              workspaceId: rp.workspaceId,
              userId: wsOwnerRows[0].ownerUserId,
              kind: "system",
              title: `Proposal expiring ${countdownText}: "${rp.title}"`,
              body: `A reminder email was sent to ${rp.clientEmail}. The proposal expires on ${expDate.toLocaleDateString()}.`,
              isRead: false,
            });
          }
          remindersSent++;
        } catch (e3) {
          console.error(`[ProposalFollowup] Expiry reminder failed for proposal ${rp.id}:`, e3);
        }
      }

      // ── Auto-expire: set status=not_accepted for proposals past their expiresAt ──
      const { isNotNull, lte, inArray: inArrayOp } = await import("drizzle-orm");
      const now = new Date();
      const expiredProposals = await db
        .select({ id: proposals.id, workspaceId: proposals.workspaceId, title: proposals.title, clientName: proposals.clientName, clientEmail: proposals.clientEmail })
        .from(proposals)
        .where(
          and(
            isNotNull(proposals.expiresAt),
            lte(proposals.expiresAt, now),
            inArrayOp(proposals.status, ["sent", "under_review"]),
          ),
        );
      let autoExpired = 0;
      for (const ep of expiredProposals) {
        try {
          await db
            .update(proposals)
            .set({ status: "not_accepted", updatedAt: new Date() })
            .where(eq(proposals.id, ep.id));
          // Log activity
          await db.insert(activities).values({
            workspaceId: ep.workspaceId,
            type: "system",
            relatedType: "proposal",
            relatedId: ep.id,
            subject: "Proposal auto-expired",
            body: `Proposal "${ep.title}" has passed its expiry date and was automatically marked as Not Accepted.`,
            actorUserId: null,
            occurredAt: new Date(),
          });
          autoExpired++;
        } catch (e2) {
          console.error(`[ProposalFollowup] Auto-expire failed for proposal ${ep.id}:`, e2);
        }
      }
      // ── SLA overdue: notify owner when extension request has been pending >48h without resolution ──
      const slaOverdueCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
      // Find all extension_requested activities older than 48h
      const { gt: gtOp, like: likeOp } = await import("drizzle-orm");
      const pendingExtActivities = await db
        .select({
          id: activities.id,
          workspaceId: activities.workspaceId,
          relatedId: activities.relatedId,
          subject: activities.subject,
          occurredAt: activities.occurredAt,
        })
        .from(activities)
        .where(
          and(
            likeOp(activities.subject, "%Extension requested%"),
            lt(activities.occurredAt, slaOverdueCutoff),
          ),
        );
      let slaNotifsent = 0;
      for (const pendingAct of pendingExtActivities) {
        try {
          // Check if there's already a resolution (approved/declined) for this proposal
          const resolutionActs = await db
            .select({ id: activities.id })
            .from(activities)
            .where(
              and(
                eq(activities.relatedId, pendingAct.relatedId!),
                eq(activities.relatedType, "proposal"),
              ),
            );
          const hasResolution = resolutionActs.some(
            (a) =>
              (a as any).subject?.toLowerCase().includes("extension approved") ||
              (a as any).subject?.toLowerCase().includes("extension declined"),
          );
          if (hasResolution) continue;
          // Check if we already sent an SLA overdue notification for this activity
          const alreadyNotified = await db
            .select({ id: activities.id })
            .from(activities)
            .where(
              and(
                eq(activities.relatedId, pendingAct.relatedId!),
                eq(activities.relatedType, "proposal"),
                likeOp(activities.subject, "%Extension SLA overdue%"),
              ),
            );
          if (alreadyNotified.length > 0) continue;
          // Get workspace owner
          const wsRow = await db
            .select({ ownerUserId: workspaces.ownerUserId })
            .from(workspaces)
            .where(eq(workspaces.id, pendingAct.workspaceId))
            .limit(1);
          if (!wsRow[0]) continue;
          const ownerUserId = wsRow[0].ownerUserId;
          // Get proposal title
          const propRow = await db
            .select({ title: proposals.title })
            .from(proposals)
            .where(eq(proposals.id, pendingAct.relatedId!))
            .limit(1);
          const propTitle = propRow[0]?.title ?? "Unknown Proposal";
          // Send in-app notification to owner
          await db.insert(notifications).values({
            workspaceId: pendingAct.workspaceId,
            userId: ownerUserId,
            kind: "system",
            title: "Extension request overdue",
            body: `The extension request for "${propTitle}" has been pending for over 48 hours without a response.`,
            read: false,
            createdAt: new Date(),
          });
          // Log a dedup marker activity
          await db.insert(activities).values({
            workspaceId: pendingAct.workspaceId,
            type: "system",
            relatedType: "proposal",
            relatedId: pendingAct.relatedId!,
            subject: "Extension SLA overdue — owner notified",
            body: `Extension request pending for over 48h. Owner notified via in-app notification.`,
            actorUserId: null,
            occurredAt: new Date(),
          });
          slaNotifsent++;
        } catch (e4) {
          console.error(`[ProposalFollowup] SLA overdue notification failed for activity ${pendingAct.id}:`, e4);
        }
      }
      // ── 72h SLA escalation: create a task for the rep if extension request still unresolved after 72h ──
      const sla72Cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);
      const { gt: gt72Op } = await import("drizzle-orm");
      const overdue72Acts = await db
        .select({
          id: activities.id,
          workspaceId: activities.workspaceId,
          relatedId: activities.relatedId,
          occurredAt: activities.occurredAt,
        })
        .from(activities)
        .where(
          and(
            likeOp(activities.subject, "%Extension requested%"),
            lt(activities.occurredAt, sla72Cutoff),
          ),
        );
      let slaTasksCreated = 0;
      for (const act72 of overdue72Acts) {
        try {
          // Skip if already resolved
          const resActs = await db
            .select({ id: activities.id, subject: activities.subject })
            .from(activities)
            .where(
              and(
                eq(activities.relatedId, act72.relatedId!),
                eq(activities.relatedType, "proposal"),
              ),
            );
          const resolved = resActs.some(
            (a) =>
              (a as any).subject?.toLowerCase().includes("extension approved") ||
              (a as any).subject?.toLowerCase().includes("extension declined"),
          );
          if (resolved) continue;
          // Check if a 72h escalation task already exists for this proposal
          const existingEscalation = await db
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(
                eq(tasks.workspaceId, act72.workspaceId),
                eq(tasks.relatedType, "proposal"),
                eq(tasks.relatedId, act72.relatedId!),
                likeOp(tasks.title, "%Extension request overdue%"),
              ),
            );
          if (existingEscalation.length > 0) continue;
          // Get workspace owner
          const ws72Row = await db
            .select({ ownerUserId: workspaces.ownerUserId })
            .from(workspaces)
            .where(eq(workspaces.id, act72.workspaceId))
            .limit(1);
          if (!ws72Row[0]) continue;
          const ownerUserId72 = ws72Row[0].ownerUserId;
          // Get proposal title
          const prop72Row = await db
            .select({ title: proposals.title })
            .from(proposals)
            .where(eq(proposals.id, act72.relatedId!))
            .limit(1);
          const propTitle72 = prop72Row[0]?.title ?? "Unknown Proposal";
          // Create escalation task
          await db.insert(tasks).values({
            workspaceId: act72.workspaceId,
            ownerUserId: ownerUserId72,
            relatedType: "proposal",
            relatedId: act72.relatedId!,
            title: `Extension request overdue — action required: "${propTitle72}"`,
            description: `A client extension request for proposal "${propTitle72}" has been pending for over 72 hours without a response. Please approve or decline the request.`,
            status: "open",
            priority: "high",
            dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          });
          slaTasksCreated++;
        } catch (e5) {
          console.error(`[ProposalFollowup] 72h escalation task failed for activity ${act72.id}:`, e5);
        }
      }
      return res.json({ ok: true, processed, total: staleProposals.length, autoExpired, remindersSent, slaNotifsent, slaTasksCreated });
    } catch (e) {
      console.error("[ProposalFollowup] Endpoint error:", e);
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  /* -- Scheduled: ARE ICP re-inference --
     POST /api/scheduled/icp-regen
     Called by the Manus scheduled task agent nightly.
     Runs the ICP inference agent for every workspace that has at least one
     won or lost opportunity, updating the active ICP profile.
  ----------------------------------------------------------------- */
  app.post("/api/scheduled/icp-regen", async (req: any, res: any) => {
    try {
      const db = await getDb();
      if (!db) return res.status(503).json({ ok: false, error: "DB unavailable" });
      const { workspaces } = await import("../drizzle/schema");
      const { runIcpInference } = await import("./routers/are/icp");
      const allWorkspaces = await db.select({ id: workspaces.id }).from(workspaces);
      let succeeded = 0;
      let failed = 0;
      const errors: string[] = [];
      for (const ws of allWorkspaces) {
        try {
          await runIcpInference(ws.id);
          succeeded++;
        } catch (e) {
          failed++;
          errors.push("ws " + ws.id + ": " + String(e).slice(0, 120));
          console.error("[IcpRegen] Failed for workspace " + ws.id + ":", e);
        }
      }
      console.log("[IcpRegen] Completed: " + succeeded + " succeeded, " + failed + " failed");
      return res.json({ ok: true, succeeded, failed, errors });
    } catch (e) {
      console.error("[IcpRegen] Endpoint error:", e);
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
