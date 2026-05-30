/**
 * Unipile Webhook Handlers
 *
 * POST /api/unipile/account-webhook?userId=<id>&workspaceId=<id>
 *   Called by Unipile's Hosted Auth Wizard notify_url after a user successfully
 *   connects or reconnects an account.
 *   Payload: { status: "CREATION_SUCCESS" | "RECONNECTED", account_id: string, name: string }
 *
 * POST /api/unipile/status-webhook
 *   Called by a registered Unipile account_status webhook for any account
 *   status change across all connected accounts.
 *   Payload: { AccountStatus: { account_id: string, account_type: string, message: string } }
 *   Relevant message values:
 *     "OK"          — account is healthy
 *     "CREDENTIALS" — token expired / needs re-authentication
 *     "ERROR"       — synchronisation error
 *     "STOPPED"     — account synchronisation stopped
 */
import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import {
  calendarAccounts,
  emailDrafts,
  emailReplies,
  sendingAccounts,
  unipileAccounts,
  unipileEmailsCache,
  users,
} from "../drizzle/schema";
import { processInboundReply } from "./inboundReplyPoller";
import { processBounceEvent } from "./emailTracking";
import { bumpCampaignCounter } from "./campaignCounters";

/**
 * Detect whether an inbound webhook payload looks like a bounce notification
 * (a Delivery Status Notification / mailer-daemon reply). When it does,
 * extract the original recipient and return it so we can route the event
 * to processBounceEvent.
 *
 * Heuristics — all conservative, false negatives strongly preferred over
 * false positives so we never suppress a real reply or a legitimate
 * automated email (login links, newsletters, notifications). A genuine
 * bounce is a DSN (RFC 3464), which ALWAYS carries a machine-readable
 * Final-Recipient:/Original-Recipient: header naming the failed address.
 * We require that header — the recipient is read straight from it, never
 * scraped out of free-text body, so a noreply@ newsletter that merely
 * mentions an address in its body can't get that address suppressed.
 */
function detectBounce(payload: {
  from_attendee?: { identifier?: string };
  subject?: string;
  body_plain?: string;
  body?: string;
}): { bouncedEmail: string; bounceType: "hard" | "soft" | "spam"; message: string } | null {
  const senderId = (payload.from_attendee?.identifier ?? "").toLowerCase();
  // Only true bounce-originating mailboxes count. noreply@/no-reply@/
  // delivery@ are excluded — they're overwhelmingly legitimate automated
  // senders (sign-in links, receipts, newsletters), not DSNs.
  const senderLooksBouncy =
    /^(mailer-daemon|postmaster|bounce[s]?)@/.test(senderId);

  const subj = (payload.subject ?? "").toLowerCase();
  const subjectLooksBouncy =
    /^(undeliverable|mail delivery (?:failure|failed)|delivery status notification|returned mail|failure notice|delivery failed|undelivered mail returned)/.test(
      subj,
    );

  if (!senderLooksBouncy && !subjectLooksBouncy) return null;

  // Pull bodyPlain (preferred) or strip tags from body for regex.
  const rawBody =
    (payload.body_plain && payload.body_plain.length > 0
      ? payload.body_plain
      : (payload.body ?? "").replace(/<[^>]+>/g, " "));

  // Require the RFC 3464 DSN structure. No header → not a confirmed bounce;
  // bail rather than guess at an address from arbitrary body text.
  const finalRcptMatch = rawBody.match(
    /(?:final-recipient|original-recipient)\s*:\s*[^;\n]*;\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i,
  );
  if (!finalRcptMatch) return null;
  const bouncedEmail = finalRcptMatch[1].toLowerCase();
  if (bouncedEmail.endsWith("@unipile.local")) return null;

  // Classify hard vs soft. Body usually contains an SMTP code like "5.1.1"
  // (permanent) or "4.x.x" (temporary). Spam complaints are rare via DSN
  // — usually arrive via the provider's spam-complaint webhook instead.
  const status = rawBody.match(/(?:status|smtp code)\s*:?\s*([45]\.\d+\.\d+)/i);
  const bounceType: "hard" | "soft" =
    status && status[1].startsWith("4") ? "soft" : "hard";

  // Short message for the bounceMessage column (subject + first 256 chars of body).
  const message = `${payload.subject ?? "(no subject)"} — ${rawBody.replace(/\s+/g, " ").slice(0, 256)}`;

  return { bouncedEmail, bounceType, message };
}
import {
  generateHostedAuthLink,
  getUnipileAccount,
  type CalendarWebhookPayload,
  type EmailTrackingWebhookPayload,
  type MailWebhookPayload,
} from "./lib/unipile";
import { sql } from "drizzle-orm";

// Statuses that mean the account needs re-authentication
const EXPIRED_STATUSES = new Set(["CREDENTIALS", "ERROR", "STOPPED"]);

export function registerUnipileWebhookRoutes(app: Express) {
  // ─── 1. Hosted Auth Wizard notify_url ─────────────────────────────────────
  /**
   * Called by Unipile after the user completes the Hosted Auth Wizard.
   * userId and workspaceId are embedded in the notify_url query params.
   */
  app.post(
    "/api/unipile/account-webhook",
    async (req: Request, res: Response) => {
      // Respond 200 immediately so Unipile doesn't retry
      res.status(200).json({ ok: true });

      try {
        const userId = parseInt(String(req.query.userId ?? ""), 10);
        const workspaceId = parseInt(String(req.query.workspaceId ?? ""), 10);

        if (!userId || !workspaceId) {
          console.warn("[UnipileWebhook] Missing userId or workspaceId in query params");
          return;
        }

        const body = req.body as {
          status?: string;
          account_id?: string;
          name?: string;
        };

        const { status, account_id } = body;

        if (!account_id) {
          console.warn("[UnipileWebhook] Missing account_id in webhook body:", body);
          return;
        }

        if (status !== "CREATION_SUCCESS" && status !== "RECONNECTED") {
          console.log(`[UnipileWebhook] Ignoring status=${status} for account ${account_id}`);
          return;
        }

        console.log(
          `[UnipileWebhook] ${status} for account ${account_id} (userId=${userId}, workspaceId=${workspaceId})`,
        );

        // Fetch full account details from Unipile
        const acct = await getUnipileAccount(account_id);

        // Extract display name and profile picture from connection_params
        let displayName: string | null = acct.name ?? null;
        let profilePicture: string | null = null;

        if (acct.connection_params) {
          const providerKey = Object.keys(acct.connection_params)[0];
          if (providerKey) {
            const params = acct.connection_params[providerKey] as Record<string, unknown>;
            if (typeof params.username === "string" && params.username) {
              displayName = params.username;
            }
            if (typeof params.profile_picture_url === "string" && params.profile_picture_url) {
              profilePicture = params.profile_picture_url;
            }
          }
        }

        const db = await getDb();

        const [existing] = await db
          .select({ id: unipileAccounts.id })
          .from(unipileAccounts)
          .where(
            and(
              eq(unipileAccounts.unipileAccountId, account_id),
              eq(unipileAccounts.userId, userId),
            ),
          )
          .limit(1);

        if (existing) {
          await db
            .update(unipileAccounts)
            .set({
              status: "OK",
              displayName: displayName ?? undefined,
              profilePicture: profilePicture ?? undefined,
              connectedAt: new Date(),
            })
            .where(eq(unipileAccounts.id, existing.id));

          console.log(`[UnipileWebhook] Updated existing account row id=${existing.id}`);
        } else {
          await db.insert(unipileAccounts).values({
            workspaceId,
            userId,
            unipileAccountId: account_id,
            provider: acct.type,
            displayName,
            profilePicture,
            status: "OK",
            connectedAt: new Date(),
          });

          console.log(
            `[UnipileWebhook] Inserted new account ${account_id} (${acct.type}) for userId=${userId}`,
          );
        }

        // ── Auto-bridge for Microsoft (mail + calendar) ─────────────────
        // Only Microsoft accounts get bridged into sending_accounts +
        // calendar_accounts so the standard /mailbox and /calendar UIs can
        // surface them. LinkedIn / WhatsApp / etc. are left alone.
        //
        // Unipile uses "OUTLOOK" as the type label for Microsoft 365
        // accounts (verified via webhook log). "MICROSOFT" is also
        // accepted to be safe against future renames.
        if (acct.type === "OUTLOOK" || acct.type === "MICROSOFT") {
          // displayName may be an email for Microsoft accounts (the
          // username field in connection_params.MICROSOFT.username is
          // typically the user's email). Use it as fromEmail; if it
          // doesn't look like an email, fall back to a placeholder so
          // the NOT NULL constraint is satisfied.
          const looksLikeEmail = displayName && /@/.test(displayName);
          const fromEmail = looksLikeEmail ? displayName! : `${account_id}@unipile.local`;
          const bridgeName = displayName ?? `Microsoft (${account_id.slice(0, 8)})`;

          // sending_accounts bridge — upsert by unipileAccountId.
          try {
            const [existingSend] = await db
              .select({ id: sendingAccounts.id })
              .from(sendingAccounts)
              .where(
                and(
                  eq(sendingAccounts.workspaceId, workspaceId),
                  eq(sendingAccounts.unipileAccountId, account_id),
                ),
              )
              .limit(1);
            if (existingSend) {
              await db
                .update(sendingAccounts)
                .set({ name: bridgeName, fromEmail })
                .where(eq(sendingAccounts.id, existingSend.id));
            } else {
              await db.insert(sendingAccounts).values({
                workspaceId,
                name: bridgeName,
                // Use the existing 'outlook_oauth' enum value rather than
                // adding a new one — avoids a MODIFY ENUM migration that
                // hits MySQL's strict-mode data-truncated check (errno
                // 1265). The unipileAccountId column is the actual
                // discriminator the adapter factory reads.
                provider: "outlook_oauth",
                fromEmail,
                unipileAccountId: account_id,
              });
              console.log(
                `[UnipileWebhook] Bridged sending_accounts row for Unipile ${account_id}`,
              );
            }
          } catch (bridgeErr) {
            console.error(
              "[UnipileWebhook] sending_accounts bridge failed:",
              bridgeErr,
            );
          }

          // calendar_accounts bridge — upsert by unipileAccountId.
          try {
            const [existingCal] = await db
              .select({ id: calendarAccounts.id })
              .from(calendarAccounts)
              .where(
                and(
                  eq(calendarAccounts.workspaceId, workspaceId),
                  eq(calendarAccounts.unipileAccountId, account_id),
                ),
              )
              .limit(1);
            if (existingCal) {
              await db
                .update(calendarAccounts)
                .set({ label: bridgeName, email: looksLikeEmail ? displayName! : null })
                .where(eq(calendarAccounts.id, existingCal.id));
            } else {
              await db.insert(calendarAccounts).values({
                workspaceId,
                userId,
                // Use the existing 'outlook_oauth' enum value rather than
                // adding a new one — avoids a MODIFY ENUM migration that
                // hits MySQL's strict-mode data-truncated check (errno
                // 1265). The unipileAccountId column is the actual
                // discriminator the adapter factory reads.
                provider: "outlook_oauth",
                label: bridgeName,
                email: looksLikeEmail ? displayName! : null,
                unipileAccountId: account_id,
              });
              console.log(
                `[UnipileWebhook] Bridged calendar_accounts row for Unipile ${account_id}`,
              );
            }
          } catch (bridgeErr) {
            console.error(
              "[UnipileWebhook] calendar_accounts bridge failed:",
              bridgeErr,
            );
          }
        }
      } catch (err) {
        console.error("[UnipileWebhook] Error processing account-webhook:", err);
      }
    },
  );

  // ─── 2. Account status webhook (CREDENTIALS / ERROR / STOPPED) ────────────
  /**
   * Registered as a Unipile account_status webhook.
   * Receives status change events for all accounts connected to this Unipile DSN.
   *
   * On CREDENTIALS / ERROR / STOPPED:
   *   1. Mark the local unipile_accounts row as disabled (status = message)
   *   2. Send a re-authentication email to the account owner with a fresh reconnect link
   */
  app.post(
    "/api/unipile/status-webhook",
    async (req: Request, res: Response) => {
      res.status(200).json({ ok: true });

      try {
        const body = req.body as {
          AccountStatus?: {
            account_id?: string;
            account_type?: string;
            message?: string;
          };
        };

        const event = body?.AccountStatus;
        if (!event?.account_id || !event?.message) {
          console.warn("[UnipileStatusWebhook] Unexpected payload shape:", body);
          return;
        }

        const { account_id, message: statusMsg } = event;

        console.log(`[UnipileStatusWebhook] account=${account_id} status=${statusMsg}`);

        const db = await getDb();

        // Find the local row for this Unipile account
        const [row] = await db
          .select()
          .from(unipileAccounts)
          .where(eq(unipileAccounts.unipileAccountId, account_id))
          .limit(1);

        if (!row) {
          console.warn(`[UnipileStatusWebhook] No local row for account_id=${account_id}`);
          return;
        }

        // Always update the status so the UI can reflect the current state
        await db
          .update(unipileAccounts)
          .set({ status: statusMsg })
          .where(eq(unipileAccounts.id, row.id));

        console.log(`[UnipileStatusWebhook] Updated account id=${row.id} status → ${statusMsg}`);

        // Only send re-auth email for expired/broken statuses
        if (!EXPIRED_STATUSES.has(statusMsg)) {
          return;
        }

        // Look up the user's email address
        const [user] = await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, row.userId))
          .limit(1);

        if (!user?.email) {
          console.warn(`[UnipileStatusWebhook] No email for userId=${row.userId}`);
          return;
        }

        // Generate a fresh reconnect link
        const appBase = (process.env.MANUS_APP_URL ?? "").replace(/\/$/, "");
        if (!appBase) {
          console.warn("[UnipileStatusWebhook] MANUS_APP_URL not set — skipping reconnect email");
          return;
        }

        const notifyUrl = `${appBase}/api/unipile/account-webhook?userId=${row.userId}&workspaceId=${row.workspaceId}`;
        const successRedirectUrl = `${appBase}/connected-accounts?connected=1`;
        const expiresOn = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24h

        let reconnectUrl: string;
        try {
          const result = await generateHostedAuthLink({
            type: "reconnect",
            providers: [row.provider],
            expiresOn,
            notifyUrl,
            successRedirectUrl,
            name: String(row.userId),
            reconnectAccount: account_id,
          });
          reconnectUrl = result.url;
        } catch (linkErr) {
          console.error("[UnipileStatusWebhook] Failed to generate reconnect link:", linkErr);
          return;
        }

        const providerLabel = row.provider ?? "social";
        const accountLabel = row.displayName ?? account_id;
        const statusLabel =
          statusMsg === "CREDENTIALS"
            ? "expired credentials"
            : statusMsg === "ERROR"
              ? "a synchronisation error"
              : "being stopped";

        const { sendWorkspaceEmail } = await import("./emailDelivery");
        await sendWorkspaceEmail(row.workspaceId, {
          to: user.email,
          subject: `Action required: Reconnect your ${providerLabel} account`,
          html: `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <h2 style="margin-bottom:8px">Your ${providerLabel} account needs attention</h2>
  <p>Hi ${user.name ?? user.email.split("@")[0]},</p>
  <p>Your <strong>${providerLabel}</strong> account <em>${accountLabel}</em> has been disconnected due to ${statusLabel}.</p>
  <p>To restore access and continue receiving messages and updates, please reconnect your account:</p>
  <p style="margin:24px 0">
    <a href="${reconnectUrl}"
       style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">
      Reconnect ${providerLabel} account
    </a>
  </p>
  <p style="color:#6b7280;font-size:13px">Or copy this link: <a href="${reconnectUrl}">${reconnectUrl}</a></p>
  <p style="color:#6b7280;font-size:13px">This link expires in 24 hours. If you need a new link, visit <a href="${appBase}/connected-accounts">Connected Accounts</a> and click Reconnect.</p>
  <p style="color:#9ca3af;font-size:12px">If you did not expect this email, you can safely ignore it.</p>
</div>`,
          text: `Your ${providerLabel} account (${accountLabel}) needs to be reconnected. Visit: ${reconnectUrl}`,
        });

        console.log(
          `[UnipileStatusWebhook] Sent re-auth email to ${user.email} for account ${account_id}`,
        );
      } catch (err) {
        console.error("[UnipileStatusWebhook] Error processing status-webhook:", err);
      }
    },
  );

  // ─── 3. Email events webhook (mail_received / mail_sent / mail_moved) ─────
  /**
   * POST /api/unipile/mail-webhook
   *
   * Registered against Unipile as a source=email webhook. Fires in real time
   * whenever a connected account receives, sends, or moves an email.
   *
   * On every event we upsert into `unipile_emails_cache` keyed on `email_id`.
   * UnipileMailAdapter reads from this cache as a fallback when /emails
   * returns 0 items (the "sync hasn't indexed history" failure mode).
   *
   * The webhook owner is identified by looking up `account_id` in our
   * `unipile_accounts` table — that gives us workspaceId for tenancy.
   */
  app.post(
    "/api/unipile/mail-webhook",
    async (req: Request, res: Response) => {
      // Ack immediately so Unipile doesn't retry.
      res.status(200).json({ ok: true });

      try {
        const payload = req.body as MailWebhookPayload;
        if (!payload?.email_id || !payload?.account_id || !payload?.event) {
          console.warn(
            "[UnipileMailWebhook] Missing required fields:",
            JSON.stringify(payload).slice(0, 300),
          );
          return;
        }

        const { email_id, account_id, event } = payload;

        const db = await getDb();

        // Resolve the local unipile_accounts row for tenancy.
        const [acct] = await db
          .select({
            id: unipileAccounts.id,
            workspaceId: unipileAccounts.workspaceId,
          })
          .from(unipileAccounts)
          .where(eq(unipileAccounts.unipileAccountId, account_id))
          .limit(1);

        if (!acct) {
          console.warn(
            `[UnipileMailWebhook] No local unipile_accounts row for account_id=${account_id} (email_id=${email_id} event=${event})`,
          );
          return;
        }

        const emailDate = payload.date ? new Date(payload.date) : null;
        const readDate = payload.read_date ? new Date(payload.read_date) : null;
        const fromName = payload.from_attendee?.display_name ?? null;
        const fromEmail = payload.from_attendee?.identifier ?? null;

        // Upsert by email_id. We can't use INSERT ... ON DUPLICATE here via
        // Drizzle's typed builder cleanly, so check-then-update is fine — the
        // unique constraint on emailId guards against races (the second
        // insert would fail and we'd just log it).
        const [existing] = await db
          .select({ id: unipileEmailsCache.id })
          .from(unipileEmailsCache)
          .where(eq(unipileEmailsCache.emailId, email_id))
          .limit(1);

        const baseFields = {
          workspaceId: acct.workspaceId,
          unipileAccountId: account_id,
          providerMessageId: payload.message_id ?? null,
          subject: payload.subject ?? null,
          fromName,
          fromEmail,
          toJson: payload.to_attendees ?? null,
          ccJson: payload.cc_attendees ?? null,
          bccJson: payload.bcc_attendees ?? null,
          replyToJson: payload.reply_to_attendees ?? null,
          bodyHtml: payload.body ?? null,
          bodyPlain: payload.body_plain ?? null,
          attachmentsJson: payload.attachments ?? null,
          foldersJson: payload.folders ?? null,
          role: payload.role ?? null,
          hasAttachments: Boolean(payload.has_attachments),
          readDate,
          inReplyToId: payload.in_reply_to?.id ?? null,
          emailDate,
          origin: payload.origin ?? null,
          trackingId: payload.tracking_id ?? null,
          lastEvent: event,
          rawJson: payload,
        };

        if (existing) {
          // On mail_moved we mostly care about folders/role; on mail_received
          // and mail_sent we still want body/subject etc. (in case the first
          // event was incomplete and a later one fills it in).
          await db
            .update(unipileEmailsCache)
            .set(baseFields)
            .where(eq(unipileEmailsCache.id, existing.id));
          console.log(
            `[UnipileMailWebhook] ${event} updated cache id=${existing.id} email_id=${email_id}`,
          );
        } else {
          try {
            await db.insert(unipileEmailsCache).values({
              emailId: email_id,
              ...baseFields,
            });
            console.log(
              `[UnipileMailWebhook] ${event} inserted cache email_id=${email_id} from=${fromEmail ?? "(none)"} subject="${(payload.subject ?? "").slice(0, 60)}"`,
            );
          } catch (insertErr) {
            // Likely a race on the unique key — second event for the same
            // email_id arriving while we were inserting. Safe to ignore;
            // the next event will update the row.
            console.warn(
              `[UnipileMailWebhook] Insert race for email_id=${email_id}:`,
              insertErr,
            );
          }
        }

        // ── Bounce detection (mail_received only) ─────────────────────
        // Run before reply attachment — a DSN looks like a reply at the
        // envelope level but should be processed as a bounce instead.
        if (event === "mail_received") {
          const bounce = detectBounce(payload);
          if (bounce) {
            try {
              await processBounceEvent(db, {
                email: bounce.bouncedEmail,
                bounceType: bounce.bounceType,
                message: bounce.message,
                timestamp: emailDate ?? new Date(),
                // Scope to this workspace — the Unipile path knows tenancy
                // from the account lookup so we shouldn't fall back to the
                // cross-workspace draft heuristic.
                workspaceId: acct.workspaceId,
              });
              console.log(
                `[UnipileMailWebhook] bounce ${bounce.bounceType} for ${bounce.bouncedEmail} (from=${fromEmail ?? "?"} subj="${(payload.subject ?? "").slice(0, 60)}")`,
              );
              // Also pause any active sequence enrollment for that recipient
              // and mark the contact's email verification status invalid on
              // hard bounces, so future enrollments skip them.
              if (bounce.bounceType === "hard") {
                const { contacts } = await import("../drizzle/schema");
                // Scope to the workspace whose account received the bounce
                // — a hard bounce in workspace A shouldn't flip the same
                // address in workspace B as invalid.
                await db
                  .update(contacts)
                  .set({
                    emailVerificationStatus: "invalid",
                    emailVerifiedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(contacts.email, bounce.bouncedEmail),
                      eq(contacts.workspaceId, acct.workspaceId),
                    ),
                  );
              }
            } catch (bounceErr) {
              console.error(
                `[UnipileMailWebhook] processBounceEvent failed for ${bounce.bouncedEmail}:`,
                bounceErr,
              );
            }
            // Bounce handled — skip the reply-attachment path below.
            return;
          }
        }

        // ── Inbound reply attachment (mail_received only) ─────────────
        // Hand off to the shared processInboundReply helper so the
        // Unipile-bridged path produces the same email_replies row +
        // Timeline activity + sequence-pause + notification as the IMAP
        // poller. Skip if:
        //   - not a received event (sent/moved don't represent replies)
        //   - the sender is one of our own sending accounts (own outbound
        //     showing up because the user sent from another device)
        //   - we already processed this email_id (re-fire / duplicate webhook)
        if (event === "mail_received" && fromEmail) {
          try {
            // Resolve the bridged sendingAccounts row — email_replies
            // requires sendingAccountId NOT NULL.
            const [sendAcct] = await db
              .select({ id: sendingAccounts.id, fromEmail: sendingAccounts.fromEmail })
              .from(sendingAccounts)
              .where(
                and(
                  eq(sendingAccounts.workspaceId, acct.workspaceId),
                  eq(sendingAccounts.unipileAccountId, account_id),
                ),
              )
              .limit(1);

            if (!sendAcct) {
              // No bridge row — likely a Unipile account that hasn't been
              // bridged into sending_accounts. Reply tracking would need
              // an account id; skip silently.
            } else if (
              fromEmail.toLowerCase() === (sendAcct.fromEmail ?? "").toLowerCase()
            ) {
              // Our own outbound flowing back in (e.g. user sent from
              // Outlook desktop). Don't process as a reply.
            } else {
              // Dedup on provider message_id within this workspace.
              const providerMsgId = payload.message_id ?? "";
              if (providerMsgId) {
                const [dup] = await db
                  .select({ id: emailReplies.id })
                  .from(emailReplies)
                  .where(
                    and(
                      eq(emailReplies.workspaceId, acct.workspaceId),
                      eq(emailReplies.messageId, providerMsgId),
                    ),
                  )
                  .limit(1);
                if (dup) {
                  // Already recorded this reply; skip.
                  return;
                }
              }

              // Find a workspace user to attribute the activity to —
              // prefer the user who owns the bridged Unipile account.
              const [acctRow] = await db
                .select({ userId: unipileAccounts.userId })
                .from(unipileAccounts)
                .where(eq(unipileAccounts.unipileAccountId, account_id))
                .limit(1);

              await processInboundReply({
                workspaceId: acct.workspaceId,
                sendingAccountId: sendAcct.id,
                userId: acctRow?.userId,
                fromEmail,
                fromName: fromName ?? "",
                subject: payload.subject ?? "",
                bodyText: payload.body_plain ?? "",
                bodyHtml: payload.body ?? "",
                messageId: providerMsgId,
                inReplyTo: payload.in_reply_to?.message_id ?? "",
                references: "",
                unipileEmailId: email_id,
                receivedAt: emailDate ?? new Date(),
              });
              console.log(
                `[UnipileMailWebhook] mail_received → processInboundReply email_id=${email_id} from=${fromEmail}`,
              );
            }
          } catch (replyErr) {
            console.error(
              `[UnipileMailWebhook] processInboundReply failed for email_id=${email_id}:`,
              replyErr,
            );
          }
        }
      } catch (err) {
        console.error("[UnipileMailWebhook] Error processing mail-webhook:", err);
      }
    },
  );

  // ─── 4. Calendar events webhook ───────────────────────────────────────────
  /**
   * POST /api/unipile/calendar-webhook
   *
   * Registered against Unipile as a source=calendar_event webhook. Fires
   * on calendar_event_created / calendar_event_updated / calendar_event_deleted.
   *
   * For now the handler just logs — calendar reads come live from
   * /api/v1/calendars/{id}/events via UnipileCalendarAdapter, so there's no
   * cache fallback to maintain. We resolve the account_id to a local
   * unipile_accounts row to confirm ownership before logging, then bail
   * if it's not ours.
   *
   * If we ever see the same indexing failure mode here that we saw on the
   * email API, we can layer a unipile_events_cache table on this handler
   * the same way Track 2 layered unipile_emails_cache on mail-webhook.
   */
  app.post(
    "/api/unipile/calendar-webhook",
    async (req: Request, res: Response) => {
      res.status(200).json({ ok: true });

      try {
        const payload = req.body as CalendarWebhookPayload;
        if (!payload?.event || !payload?.account_id) {
          console.warn(
            "[UnipileCalendarWebhook] Missing required fields:",
            JSON.stringify(payload).slice(0, 300),
          );
          return;
        }

        const db = await getDb();
        const [acct] = await db
          .select({
            id: unipileAccounts.id,
            workspaceId: unipileAccounts.workspaceId,
          })
          .from(unipileAccounts)
          .where(eq(unipileAccounts.unipileAccountId, payload.account_id))
          .limit(1);

        if (!acct) {
          console.warn(
            `[UnipileCalendarWebhook] No local unipile_accounts row for account_id=${payload.account_id} (event=${payload.event})`,
          );
          return;
        }

        if (payload.event === "calendar_event_deleted") {
          console.log(
            `[UnipileCalendarWebhook] ${payload.event} cal=${payload.calendar_id} event=${payload.id} (workspace=${acct.workspaceId})`,
          );
        } else {
          const titleSnippet = (payload.title ?? "").slice(0, 60);
          console.log(
            `[UnipileCalendarWebhook] ${payload.event} cal=${payload.calendar_id ?? "?"} event=${payload.id} title="${titleSnippet}" (workspace=${acct.workspaceId})`,
          );
        }
      } catch (err) {
        console.error("[UnipileCalendarWebhook] Error processing calendar-webhook:", err);
      }
    },
  );

  // ─── 5. Email tracking webhook (opens / clicks) ───────────────────────────
  /**
   * POST /api/unipile/email-tracking-webhook
   *
   * Registered against Unipile as a source=email_tracking webhook with
   * events=[mail_opened, mail_link_clicked]. Fires once per recipient
   * open and once per recipient click.
   *
   * Matching: at send time crm.sendAdHocEmail persists the Unipile
   * `tracking_id` returned by POST /emails into emailDrafts.trackingToken.
   * We look the row up by that token and bump openCount or clickCount
   * (plus the last-event timestamp) atomically via raw SQL so concurrent
   * webhooks don't clobber each other.
   *
   * Event-type matching is forgiving — Unipile has used "mail_opened" /
   * "mail_link_clicked" in the spec but we also accept shorter variants
   * just in case the runtime field differs.
   */
  app.post(
    "/api/unipile/email-tracking-webhook",
    async (req: Request, res: Response) => {
      res.status(200).json({ ok: true });

      try {
        const payload = req.body as EmailTrackingWebhookPayload;
        // Unipile's runtime payload uses `event` for the event type;
        // when we register via our tRPC helper we also map a `type`
        // alias. Accept either so dashboard-registered webhooks work.
        const rawType = payload?.type ?? payload?.event;
        if (!payload?.tracking_id || !rawType) {
          console.warn(
            "[UnipileTrackingWebhook] Missing tracking_id or event/type:",
            JSON.stringify(payload).slice(0, 300),
          );
          return;
        }

        const type = rawType.toLowerCase();
        const isOpen = /open/.test(type); // mail_opened / opened / open
        const isClick = /click/.test(type); // mail_link_clicked / link_clicked / click
        if (!isOpen && !isClick) {
          console.warn(
            `[UnipileTrackingWebhook] Unknown event type "${payload.type}" — ignoring`,
          );
          return;
        }

        const eventDate = payload.date ? new Date(payload.date) : new Date();
        const db = await getDb();

        // Look up the draft FIRST so we can also bump the parent
        // campaign's counter after the draft counter goes up.
        const [draft] = await db
          .select({
            id: emailDrafts.id,
            workspaceId: emailDrafts.workspaceId,
            sequenceId: emailDrafts.sequenceId,
          })
          .from(emailDrafts)
          .where(eq(emailDrafts.trackingToken, payload.tracking_id))
          .limit(1);

        // Atomic increment + last-event timestamp via raw SQL. Drizzle's
        // typed update builder doesn't accept column arithmetic cleanly,
        // and we want this to be race-safe against concurrent opens.
        if (isOpen) {
          const [result] = await db.execute(
            sql`UPDATE \`email_drafts\`
                SET \`openCount\` = \`openCount\` + 1,
                    \`lastOpenedAt\` = ${eventDate}
                WHERE \`trackingToken\` = ${payload.tracking_id}`,
          );
          const affected = (result as { affectedRows?: number })?.affectedRows ?? 0;
          console.log(
            `[UnipileTrackingWebhook] open tracking_id=${payload.tracking_id} → updated ${affected} draft(s)${payload.ip ? ` ip=${payload.ip}` : ""}`,
          );
          if (affected === 0) {
            console.warn(
              `[UnipileTrackingWebhook] open with no matching emailDrafts row (tracking_id=${payload.tracking_id})`,
            );
          } else if (draft?.sequenceId) {
            await bumpCampaignCounter(draft.workspaceId, draft.sequenceId, "totalOpened");
          }
        } else {
          const [result] = await db.execute(
            sql`UPDATE \`email_drafts\`
                SET \`clickCount\` = \`clickCount\` + 1,
                    \`lastClickedAt\` = ${eventDate}
                WHERE \`trackingToken\` = ${payload.tracking_id}`,
          );
          const affected = (result as { affectedRows?: number })?.affectedRows ?? 0;
          console.log(
            `[UnipileTrackingWebhook] click tracking_id=${payload.tracking_id} url=${payload.url ?? "?"} → updated ${affected} draft(s)`,
          );
          if (affected === 0) {
            console.warn(
              `[UnipileTrackingWebhook] click with no matching emailDrafts row (tracking_id=${payload.tracking_id})`,
            );
          } else if (draft?.sequenceId) {
            await bumpCampaignCounter(draft.workspaceId, draft.sequenceId, "totalClicked");
          }
        }
      } catch (err) {
        console.error(
          "[UnipileTrackingWebhook] Error processing email-tracking-webhook:",
          err,
        );
      }
    },
  );
}
