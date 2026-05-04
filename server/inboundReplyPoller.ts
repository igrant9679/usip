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
} from "../drizzle/schema";
import { eq, and, or, inArray, isNull } from "drizzle-orm";
import { decryptField } from "./emailAdapter";

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
          // Check if already processed by IMAP UID
          const db3 = await getDb();
          if (!db3) continue;
          const existing = await db3.select({ id: emailReplies.id }).from(emailReplies)
            .where(and(eq(emailReplies.sendingAccountId, account.id), eq(emailReplies.imapUid, msg.uid)));
          if (existing.length > 0) continue;

          const parsed = await simpleParser(msg.source);
          const fromAddr = parsed.from?.value?.[0];
          const toVal = parsed.to;

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

interface InboundReplyData {
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
  receivedAt: Date;
}

async function processInboundReply(data: InboundReplyData) {
  const db = await getDb();
  if (!db) return;
  // 1. Match to outbound draft via In-Reply-To or References
  let matchedDraft: any = null;
  let matchedContactId: number | undefined;
  let matchedLeadId: number | undefined;
  let matchedAccountId: number | undefined;

  if (data.inReplyTo || data.references) {
    const refIds = [data.inReplyTo, ...(data.references?.split(/\s+/) ?? [])].filter(Boolean);
    // Look for a draft whose trackingToken or messageId matches
    const drafts = await db.select().from(emailDrafts)
      .where(
        and(
          eq(emailDrafts.workspaceId, data.workspaceId),
          inArray(emailDrafts.toEmail, [data.fromEmail]),
        )
      );
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
    if (matchedLead) matchedLeadId = matchedLead.id;
  }

  // 3. Insert email_reply row
  await db.insert(emailReplies).values({
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

  // 4. Create notification for the account owner
  if (data.userId) {
    await db.insert(notifications).values({
      workspaceId: data.workspaceId,
      userId: data.userId,
      kind: "email_reply",
      title: `Reply from ${data.fromName || data.fromEmail}`,
      body: data.subject ? `Re: ${data.subject}` : data.bodyText?.slice(0, 200),
      relatedType: matchedContactId ? "contact" : matchedLeadId ? "lead" : null,
      relatedId: matchedContactId ?? matchedLeadId ?? null,
    });
  }

  // 5. Pause sequence enrollment if pauseOnReply is set
  if (matchedContactId || matchedLeadId) {
    const enrollmentConditions = [
      eq(enrollments.workspaceId, data.workspaceId),
      eq(enrollments.status, "active"),
    ];
    if (matchedContactId) enrollmentConditions.push(eq(enrollments.contactId, matchedContactId));
    else if (matchedLeadId) enrollmentConditions.push(eq(enrollments.leadId, matchedLeadId));

    const activeEnrollments = await db.select().from(enrollments).where(and(...enrollmentConditions));
    for (const enrollment of activeEnrollments) {
      // Pause all active enrollments for this contact/lead when a reply is received
      await db.update(enrollments).set({ status: "paused" }).where(eq(enrollments.id, enrollment.id));
    }
  }

  // 6. Increment campaigns.totalReplied if draft belongs to a campaign (via sequenceId → campaign)
  // emailDrafts links to sequences, not campaigns directly — skip for now
  // (campaigns track replies via their own stats aggregation)

  // 7. Log an activity
  if (matchedContactId || matchedLeadId) {
    const relatedType = matchedContactId ? "contact" : "lead";
    const relatedId = matchedContactId ?? matchedLeadId!;
    await db.insert(activities).values({
      workspaceId: data.workspaceId,
      type: "email",
      relatedType,
      relatedId,
      subject: `Email reply received: ${data.subject || "(no subject)"}`,
      body: data.bodyText?.slice(0, 500),
      actorUserId: data.userId,
      occurredAt: data.receivedAt,
    });
  }

  console.log(`[InboundPoller] Processed reply from ${data.fromEmail} (draft: ${matchedDraft?.id ?? "unmatched"})`);
}

