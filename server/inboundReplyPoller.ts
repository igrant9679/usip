/**
 * inboundReplyPoller.ts — IMAP polling job for inbound reply detection (Feature 73)
 *
 * Runs every 60 seconds per connected IMAP account.
 * For each new message:
 *   1. Matches it to an outbound draft via In-Reply-To / References headers
 *   2. Inserts a row into email_replies
 *   3. Creates a notification (kind: email_reply) for the account owner
 *   4. Pauses any active sequence enrollment for the matched contact/lead
 *   5. Increments campaigns.totalReplied if the draft belongs to a campaign
 *   6. Logs an activity (type: email, subtype: reply_received)
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { getDb } from "./db";
import {
  sendingAccounts,
  emailReplies,
  emailDrafts,
  notifications,
  contacts,
  leads,
  campaigns,
  enrollments,
  activities,
  sequences,
} from "../drizzle/schema";
import { eq, and, or, desc, inArray, isNull } from "drizzle-orm";
import { decryptField } from "./emailAdapter";
import { bumpCampaignCounter } from "./campaignCounters";

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

export function startInboundReplyPoller() {
  if (pollerInterval) return;
  console.log("[InboundPoller] Starting IMAP/Gmail reply poller (60s interval)");
  pollerInterval = setInterval(() => {
    if (!isPolling) {
      isPolling = true;
      pollAllAccounts().finally(() => { isPolling = false; });
    }
  }, 60_000);
  // Run immediately on startup
  setTimeout(() => {
    isPolling = true;
    pollAllAccounts().finally(() => { isPolling = false; });
  }, 5_000);
}

export function stopInboundReplyPoller() {
  if (pollerInterval) { clearInterval(pollerInterval); pollerInterval = null; }
}

async function pollAllAccounts() {
  try {
    // Get all accounts that have IMAP or Gmail OAuth configured
    const db = await getDb();
    if (!db) return;
    const accounts = await db
      .select()
      .from(sendingAccounts);
    const imapAccounts = accounts.filter(
      (a) => !!(a.imapHost && a.imapUsername && a.imapPassword)
    );

    for (const account of imapAccounts) {
      try {
        await pollImapAccount(account);
      } catch (err: any) {
        console.error(`[InboundPoller] Error polling account ${account.id} (${account.fromEmail}):`, err.message);
      }
    }
  } catch (err: any) {
    console.error("[InboundPoller] Fatal error in pollAllAccounts:", err.message);
  }
}

async function pollImapAccount(account: any) {
  let password: string;
  try { password = decryptField(account.imapPassword); } catch { password = account.imapPassword; }

  const client = new ImapFlow({
    host: account.imapHost, port: account.imapPort ?? 993, secure: account.imapSecure ?? true,
    auth: { user: account.imapUsername, pass: password }, logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Search for unseen messages
      const uids = await client.search({ unseen: true }, { uid: true });
      if (uids.length === 0) return;

      const recentUids = uids.slice(-50); // Process up to 50 at a time
      for await (const msg of client.fetch(recentUids.join(","), { uid: true, flags: true, source: true }, { uid: true })) {
        try {
          // Dedup pass — two paths can record the same reply:
          //   (a) IMAP poller for SMTP-served accounts (this loop)
          //   (b) Unipile mail webhook for bridged M365 accounts
          // (a) keys on imapUid + sendingAccountId, (b) keys on
          // messageId + workspaceId. A single recipient mailbox served
          // by BOTH would create duplicate rows. Parse the source so
          // we can also check messageId before inserting.
          const db3 = await getDb();
          if (!db3) continue;
          const byImap = await db3.select({ id: emailReplies.id }).from(emailReplies)
            .where(and(eq(emailReplies.sendingAccountId, account.id), eq(emailReplies.imapUid, msg.uid)));
          if (byImap.length > 0) continue;

          const parsed = await simpleParser(msg.source);
          const fromAddr = parsed.from?.value?.[0];
          const toVal = parsed.to;

          // Warmup traffic between our own mailboxes must never become a
          // "reply": skip on the engine's marker header, and skip anything
          // sent FROM one of this workspace's own sending accounts.
          if (parsed.headers?.get?.("x-velocity-warmup")) continue;
          if (fromAddr?.address) {
            const own = await db3
              .select({ id: sendingAccounts.id })
              .from(sendingAccounts)
              .where(and(eq(sendingAccounts.workspaceId, account.workspaceId), eq(sendingAccounts.fromEmail, fromAddr.address.toLowerCase())))
              .limit(1);
            if (own.length > 0) continue;
          }

          // Cross-source dedup: same messageId already recorded for
          // this workspace (e.g. via the Unipile webhook earlier).
          const msgIdHeader = parsed.messageId ?? "";
          if (msgIdHeader) {
            const byMsg = await db3.select({ id: emailReplies.id }).from(emailReplies)
              .where(
                and(
                  eq(emailReplies.workspaceId, account.workspaceId),
                  eq(emailReplies.messageId, msgIdHeader),
                ),
              )
              .limit(1);
            if (byMsg.length > 0) continue;
          }

          await processInboundReply({
            workspaceId: account.workspaceId,
            sendingAccountId: account.id,
            userId: account.userId,
            fromEmail: fromAddr?.address ?? "",
            fromName: fromAddr?.name ?? "",
            subject: parsed.subject ?? "",
            bodyText: parsed.text ?? "",
            bodyHtml: parsed.html || parsed.textAsHtml || "",
            messageId: parsed.messageId ?? "",
            inReplyTo: parsed.inReplyTo ?? "",
            references: Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references ?? ""),
            imapUid: msg.uid,
            receivedAt: parsed.date ?? new Date(),
          });
        } catch (err: any) {
          console.error(`[InboundPoller] Error processing IMAP UID ${msg.uid}:`, err.message);
        }
      }
    } finally { lock.release(); }
  } finally {
    await client.logout().catch(() => {});
  }
}

export interface InboundReplyData {
  workspaceId: number;
  sendingAccountId: number;
  userId?: number;
  fromEmail: string;
  fromName: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  messageId: string;
  inReplyTo: string;
  references: string;
  imapUid?: number;
  /** Set when the reply arrived via the Unipile webhook so we have a stable de-dup key. */
  unipileEmailId?: string;
  receivedAt: Date;
}

export async function processInboundReply(data: InboundReplyData) {
  const db = await getDb();
  if (!db) return;
  // 1. Match to outbound draft via In-Reply-To or References.
  //
  // Previously this gathered refIds and then *ignored* them — query
  // matched on toEmail alone and picked drafts[0] (random old draft),
  // which is what made reply analytics attribute to the wrong message.
  //
  // Strategy now:
  //   a. If we have any In-Reply-To / References values, try matching
  //      them against emailDrafts.trackingToken. trackingToken on the
  //      Unipile path stores the provider tracking_id; matching on
  //      that gives us exact draft identification when the recipient's
  //      client preserved headers. We strip <> braces both ways.
  //   b. Failing that, fall back to "most recent sent draft to this
  //      sender" — at least temporally relevant, not the oldest.
  let matchedDraft: any = null;
  let matchedContactId: number | undefined;
  let matchedLeadId: number | undefined;
  let matchedProspectId: number | undefined;
  let matchedAccountId: number | undefined;

  const stripAngle = (s: string) => s.replace(/^<|>$/g, "").trim();
  const refIds = [data.inReplyTo, ...(data.references?.split(/\s+/) ?? [])]
    .map((s) => (s ? stripAngle(s) : ""))
    .filter((s) => s.length > 0);

  if (refIds.length > 0) {
    // Exact-match on trackingToken — the Unipile path persists each
    // outbound's tracking_id there. trackingToken is varchar(64) so
    // refIds longer than 64 chars (full RFC Message-ID) won't match,
    // but they don't share format anyway. We include both bare and
    // angled forms to be tolerant.
    const candidates = [...refIds, ...refIds.map((id) => `<${id}>`)];
    const byToken = await db
      .select()
      .from(emailDrafts)
      .where(
        and(
          eq(emailDrafts.workspaceId, data.workspaceId),
          inArray(emailDrafts.trackingToken, candidates),
        ),
      )
      .limit(1);
    matchedDraft = byToken[0] ?? null;
  }

  if (!matchedDraft) {
    // Fallback: most-recent sent draft to this sender (was previously
    // the only path and used drafts[0] = oldest). Use desc(sentAt) so
    // a reply to today's send attaches to today's draft, not 2024's.
    const drafts = await db
      .select()
      .from(emailDrafts)
      .where(
        and(
          eq(emailDrafts.workspaceId, data.workspaceId),
          eq(emailDrafts.toEmail, data.fromEmail),
          eq(emailDrafts.status, "sent"),
        ),
      )
      .orderBy(desc(emailDrafts.sentAt))
      .limit(1);
    matchedDraft = drafts[0] ?? null;
  }

  // 2. Match to CRM contact/lead by fromEmail
  const [matchedContact] = await db.select({ id: contacts.id, accountId: contacts.accountId })
    .from(contacts)
    .where(and(eq(contacts.workspaceId, data.workspaceId), eq(contacts.email, data.fromEmail)));
  if (matchedContact) {
    matchedContactId = matchedContact.id;
    matchedAccountId = matchedContact.accountId ?? undefined;
  } else {
    const [matchedLead] = await db.select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.workspaceId, data.workspaceId), eq(leads.email, data.fromEmail)));
    if (matchedLead) {
      matchedLeadId = matchedLead.id;
    } else {
      // Migration 0085: prospects can be the enrollment target. If no
      // contact or lead matched, try to attribute the reply to a
      // prospect so the engine pauses the right enrollment row and
      // the prospect's history surfaces the message.
      const { prospects } = await import("../drizzle/schema");
      const [matchedProspect] = await db.select({ id: prospects.id })
        .from(prospects)
        .where(and(eq(prospects.workspaceId, data.workspaceId), eq(prospects.email, data.fromEmail)));
      if (matchedProspect) matchedProspectId = matchedProspect.id;
    }
  }

  // 3. Insert email_reply row (capture the id so the notification can
  //    deep-link "Open in Mailbox" straight to this conversation)
  const [insertedReply] = await db.insert(emailReplies).values({
    workspaceId: data.workspaceId,
    draftId: matchedDraft?.id ?? null,
    sendingAccountId: data.sendingAccountId,
    userId: data.userId,
    fromEmail: data.fromEmail,
    fromName: data.fromName,
    subject: data.subject,
    bodyText: data.bodyText,
    bodyHtml: data.bodyHtml,
    messageId: data.messageId,
    inReplyTo: data.inReplyTo,
    contactId: matchedContactId,
    leadId: matchedLeadId,
    accountId: matchedAccountId,
    imapUid: data.imapUid,
    receivedAt: data.receivedAt,
  });
  const emailReplyId = Number(
    (insertedReply as unknown as { insertId?: number })?.insertId ?? 0,
  );

  // 4. Create notification for the account owner
  if (data.userId) {
    await db.insert(notifications).values({
      workspaceId: data.workspaceId,
      userId: data.userId,
      kind: "email_reply",
      title: `Reply from ${data.fromName || data.fromEmail}`,
      body: data.subject ? `Re: ${data.subject}` : data.bodyText?.slice(0, 200),
      // Point at the email_reply row itself so the Inbox "Open in Mailbox"
      // link can deep-link straight to this conversation. (The contact/
      // lead linkage lives on the emailReplies + activities rows; nothing
      // consumed it off the notification.)
      relatedType: emailReplyId ? "email_reply" : null,
      relatedId: emailReplyId || null,
    });
  }

  // 5. Pause sequence enrollment if pauseOnReply is set
  if (matchedContactId || matchedLeadId || matchedProspectId) {
    const enrollmentConditions = [
      eq(enrollments.workspaceId, data.workspaceId),
      eq(enrollments.status, "active"),
    ];
    if (matchedContactId) enrollmentConditions.push(eq(enrollments.contactId, matchedContactId));
    else if (matchedLeadId) enrollmentConditions.push(eq(enrollments.leadId, matchedLeadId));
    else if (matchedProspectId) enrollmentConditions.push(eq(enrollments.prospectId, matchedProspectId));

    const activeEnrollments = await db.select().from(enrollments).where(and(...enrollmentConditions));
    if (activeEnrollments.length > 0) {
      // Honor each sequence's "Pause enrollment on reply" toggle — it was a
      // no-op here (every active enrollment got paused unconditionally).
      // Default stays pause-on-reply; only sequences that explicitly set
      // settings.replyDetection === false keep running.
      const seqIds = [...new Set(activeEnrollments.map((e) => e.sequenceId))];
      const seqRows = await db
        .select({ id: sequences.id, settings: sequences.settings })
        .from(sequences)
        .where(and(eq(sequences.workspaceId, data.workspaceId), inArray(sequences.id, seqIds)));
      const pauseBySeq = new Map(
        seqRows.map((s) => [s.id, (s.settings as { replyDetection?: boolean } | null)?.replyDetection !== false]),
      );
      for (const enrollment of activeEnrollments) {
        if (pauseBySeq.get(enrollment.sequenceId) === false) continue;
        await db.update(enrollments).set({ status: "paused" }).where(eq(enrollments.id, enrollment.id));
      }
    }
  }

  // 6. Increment campaigns.totalReplied if the matched draft belongs to
  //    a campaign-driven sequence. Goes through bumpCampaignCounter which
  //    handles the sequenceId → campaign lookup + safe raw SQL increment.
  if (matchedDraft?.sequenceId) {
    await bumpCampaignCounter(
      data.workspaceId,
      matchedDraft.sequenceId,
      "totalReplied",
    );
  }

  // 7. Log an activity. Write to the contact/lead, AND mirror to every
  //    open opportunity the contact is on so the opportunity's timeline
  //    surfaces the reply. Also bumps opportunities.lastActivityAt to
  //    feed the pipelineAlerts stale-deal scanner.
  if (matchedContactId || matchedLeadId || matchedProspectId) {
    const relatedType = matchedContactId ? "contact" : matchedLeadId ? "lead" : "prospect";
    const relatedId = (matchedContactId ?? matchedLeadId ?? matchedProspectId)!;
    const activityRow = {
      workspaceId: data.workspaceId,
      type: "email" as const,
      subject: `Email reply received: ${data.subject || "(no subject)"}`,
      body: data.bodyText?.slice(0, 500),
      actorUserId: data.userId,
      occurredAt: data.receivedAt,
    };
    await db.insert(activities).values({ ...activityRow, relatedType, relatedId });

    if (matchedContactId) {
      const { opportunityContactRoles, opportunities } = await import("../drizzle/schema");
      const roles = await db.select({ opportunityId: opportunityContactRoles.opportunityId })
        .from(opportunityContactRoles)
        .where(and(
          eq(opportunityContactRoles.workspaceId, data.workspaceId),
          eq(opportunityContactRoles.contactId, matchedContactId),
        ));
      const oppIds = roles.map((r) => r.opportunityId);
      if (oppIds.length > 0) {
        const openOpps = await db.select({ id: opportunities.id, stage: opportunities.stage })
          .from(opportunities)
          .where(and(
            eq(opportunities.workspaceId, data.workspaceId),
            inArray(opportunities.id, oppIds),
          ));
        for (const o of openOpps) {
          if (o.stage === "won" || o.stage === "lost") continue;
          await db.insert(activities).values({ ...activityRow, relatedType: "opportunity", relatedId: o.id });
          await db.update(opportunities).set({ lastActivityAt: data.receivedAt })
            .where(eq(opportunities.id, o.id));
        }
      }
    }
  }

  console.log(`[InboundPoller] Processed reply from ${data.fromEmail} (draft: ${matchedDraft?.id ?? "unmatched"})`);
}

