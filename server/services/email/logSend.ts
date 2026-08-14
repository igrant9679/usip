/**
 * logSend.ts — write one `email_log` row per email this workspace transmits.
 *
 * Owner ask 2026-08-14: every email sitewide must appear on the Emails page.
 * Before migration 0163 an email's record depended on which code path sent it,
 * and three paths kept none at all (Inbox composes and replies, proposal mail,
 * every transactional message). The Emails page read `email_drafts` alone, so
 * it showed a minority of what actually went out.
 *
 * ⚠️ Called from the SAME three transmission points `usage_counters` uses, and
 * for the same reason recorded there: a per-call-site record misses the twelfth
 * call site.
 *   1. `createEmailAdapter`'s wrapper — every adapter instance, so every
 *      account-attributed send (CRM, sequences, ARE pool, mailbox, proposals,
 *      the system sender) passes through it whether or not its caller knows
 *      this file exists.
 *   2. `sendWorkspaceEmail`'s raw-SMTP branch — transactional mail, which
 *      builds its own transporter and never touches an adapter.
 *   3. `operations.sendScheduleNow` — same, for scheduled reports.
 *
 * Callers may attach an `EmailLogMeta` describing where the send came from.
 * An UNTAGGED send is still logged (as `other`) — the point of the table is
 * that nothing goes out unrecorded, so silence has to be the loud case, not
 * the quiet one.
 *
 * Best-effort by construction: this never throws and never blocks delivery. A
 * logging failure must not turn a delivered email into an error, so failures
 * are consoled and swallowed.
 */
import { emailLog } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { htmlBodyToText, isHtmlBody } from "@shared/emailBody";

/** Where a send came from. Free-form so a new path can log the day it ships. */
export type EmailLogSource =
  | "campaign"       // ARE Hub campaign step (are_execution_queue)
  | "sequence"       // classic sequence step
  | "crm"            // ad-hoc send from a contact / lead / prospect record
  | "ai_draft"       // an AI-generated draft that was approved and sent
  | "mailbox"        // human compose or reply in the Inbox
  | "proposal"       // proposal / quote delivery
  | "transactional"  // invites, notifications, alerts, scheduled reports
  | "test"           // "send me a test" from a settings screen
  | "other";

export interface EmailLogMeta {
  source?: EmailLogSource | string;
  /** Campaign name, sequence name, "Proposal #12" — whatever names the source. */
  sourceLabel?: string | null;
  draftId?: number | null;
  executionQueueId?: number | null;
  campaignId?: number | null;
  prospectQueueId?: number | null;
  contactId?: number | null;
  leadId?: number | null;
  sequenceId?: number | null;
  /** Who triggered it. Omit for autonomous sends — NULL means "the engine". */
  userId?: number | null;
}

export interface LogEmailSendInput {
  workspaceId: number;
  meta?: EmailLogMeta;
  sendingAccountId?: number | null;
  fromEmail?: string | null;
  fromName?: string | null;
  to?: string | string[] | null;
  cc?: string | null;
  bcc?: string | null;
  subject?: string | null;
  bodyHtml?: string | null;
  bodyText?: string | null;
  status: "sent" | "failed";
  failureReason?: string | null;
  messageId?: string | null;
  sentAt?: Date;
}

/** varchar(320)/(500) columns: an oversized value fails the insert at runtime. */
function clamp(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/** Recipients arrive as a string or an array depending on the caller. */
function firstRecipient(to: string | string[] | null | undefined): string | null {
  if (!to) return null;
  if (Array.isArray(to)) return to.length ? String(to[0]) : null;
  // A comma-joined list keeps its first address; the rest stay in the string
  // for cc/bcc-style sends, which are rare on this path.
  return String(to).split(",")[0]?.trim() || null;
}

/**
 * A readable preview, not the message. Stored as plain text so the Emails page
 * can show a snippet without sanitising HTML on every row.
 */
export function previewOf(bodyHtml?: string | null, bodyText?: string | null, max = 2000): string | null {
  const raw = (bodyText ?? "").trim() || (bodyHtml ?? "").trim();
  if (!raw) return null;
  const flat = (isHtmlBody(raw) ? htmlBodyToText(raw) : raw).replace(/\s+\n/g, "\n").trim();
  if (!flat) return null;
  return flat.length > max ? flat.slice(0, max) : flat;
}

/**
 * Point an already-written log row at the draft its caller created afterwards.
 *
 * `crm.sendAdHocEmail` deliberately writes its `email_drafts` row only AFTER a
 * successful delivery, so at send time there is no draft id to tag the log row
 * with — and without the link the Emails page cannot show that send's opens and
 * clicks, which live on the draft. Matched on the provider's message id, which
 * is the same value the draft stores as its `trackingToken`.
 *
 * No-op when the adapter returned no message id: an unlinked row still appears
 * on the page, just without engagement counters.
 */
export async function linkEmailLogToDraft(
  workspaceId: number,
  messageId: string | null | undefined,
  draftId: number,
): Promise<void> {
  try {
    const id = clamp(messageId, 500);
    if (!id || !draftId) return;
    const db = await getDb();
    if (!db) return;
    const { and, eq, isNull } = await import("drizzle-orm");
    await db
      .update(emailLog)
      .set({ draftId })
      .where(and(
        eq(emailLog.workspaceId, workspaceId),
        eq(emailLog.messageId, id),
        isNull(emailLog.draftId),
      ));
  } catch (e) {
    console.error("[emailLog] failed to link draft:", (e as Error)?.message ?? e);
  }
}

export async function logEmailSend(input: LogEmailSendInput): Promise<void> {
  try {
    if (!input.workspaceId) return;
    const db = await getDb();
    if (!db) return;
    const meta = input.meta ?? {};
    await db.insert(emailLog).values({
      workspaceId: input.workspaceId,
      source: clamp(meta.source ?? "other", 32) ?? "other",
      sourceLabel: clamp(meta.sourceLabel, 200),
      draftId: meta.draftId ?? null,
      executionQueueId: meta.executionQueueId ?? null,
      campaignId: meta.campaignId ?? null,
      prospectQueueId: meta.prospectQueueId ?? null,
      contactId: meta.contactId ?? null,
      leadId: meta.leadId ?? null,
      sequenceId: meta.sequenceId ?? null,
      sendingAccountId: input.sendingAccountId ?? null,
      userId: meta.userId ?? null,
      fromEmail: clamp(input.fromEmail, 320),
      fromName: clamp(input.fromName, 200),
      toEmail: clamp(firstRecipient(input.to), 320),
      cc: clamp(input.cc, 500),
      bcc: clamp(input.bcc, 500),
      subject: clamp(input.subject, 500),
      bodyPreview: previewOf(input.bodyHtml, input.bodyText),
      status: input.status,
      failureReason: input.failureReason ? String(input.failureReason).slice(0, 2000) : null,
      messageId: clamp(input.messageId, 500),
      sentAt: input.sentAt ?? new Date(),
    });
  } catch (e) {
    // Never turn a delivered email into a failed request.
    console.error("[emailLog] failed to record send:", (e as Error)?.message ?? e);
  }
}
