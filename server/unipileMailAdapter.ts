/**
 * UnipileMailAdapter — implements EmailAdapter against Unipile's email API.
 *
 * Phase 2 (this file) implements every method on top of the helpers in
 * server/lib/unipile.ts. Phase 1 stubs that threw "not yet implemented"
 * are now gone.
 *
 * Surface coverage:
 *   listFolders   → GET  /folders
 *   listThreads   → GET  /emails?folder=X&meta_only=true (groups by thread_id)
 *   searchThreads → GET  /emails with any_email/to/from filters
 *   getThread     → GET  /emails?thread_id=Y  (Unipile handles threading)
 *   sendEmail     → POST /emails (multipart)
 *   markRead      → PUT  /emails/{id}  { unread: !read }
 *   moveToTrash   → DELETE /emails/{id}
 *   moveToFolder  → PUT  /emails/{id}  { folders: [destFolder] }
 *   getAttachment → GET  /emails/{messageId}/attachments/{attachmentId}
 *
 * The bridged sending_accounts row's `unipileAccountId` column points at the
 * underlying Unipile account UUID. All API calls scope to that account.
 */
import type { SendingAccount } from "../drizzle/schema";
import type {
  EmailAdapter,
  EmailFolder,
  EmailMessage,
  EmailThread,
  SendEmailInput,
} from "./emailAdapter";
import {
  deleteEmail,
  getEmail,
  getEmailAttachment,
  listEmails,
  listFolders,
  sendEmail,
  updateEmail,
  type UnipileAttendee,
  type UnipileEmail,
  type UnipileFolder,
} from "./lib/unipile";

/** Strip HTML tags for a quick snippet without pulling in a sanitizer. */
function htmlToSnippet(html: string | undefined, maxLen = 140): string {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function parseEmailList(addrs: UnipileAttendee[] | undefined): string {
  if (!addrs || addrs.length === 0) return "";
  return addrs.map((a) => a.identifier).join(", ");
}

function attendeesFromCsv(csv: string | undefined): UnipileAttendee[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((email) => ({ identifier: email }));
}

function unipileEmailToMessage(email: UnipileEmail): EmailMessage {
  return {
    messageId: email.id,
    threadId: email.thread_id ?? email.id,
    subject: email.subject ?? "",
    fromEmail: email.from_attendee?.identifier ?? "",
    fromName: email.from_attendee?.display_name ?? "",
    toEmail: parseEmailList(email.to_attendees),
    ccEmail: parseEmailList(email.cc_attendees) || undefined,
    date: new Date(email.date),
    bodyText: email.body_plain ?? "",
    bodyHtml: email.body ?? "",
    attachments: (email.attachments ?? []).map((a) => ({
      filename: a.name,
      contentType: a.mime ?? "application/octet-stream",
      size: a.size ?? 0,
    })),
    inReplyTo: undefined,
    references: undefined,
    unread: email.read_date === null,
  };
}

export class UnipileMailAdapter implements EmailAdapter {
  private account: SendingAccount;
  protected readonly unipileAccountId: string;

  constructor(account: SendingAccount) {
    this.account = account;
    if (!account.unipileAccountId) {
      throw new Error(
        "UnipileMailAdapter requires sending_accounts.unipileAccountId to be set",
      );
    }
    this.unipileAccountId = account.unipileAccountId;
  }

  /** GET /folders — list inbox / sent / archive / drafts / trash / spam / labels. */
  async listFolders(): Promise<EmailFolder[]> {
    const res = await listFolders(this.unipileAccountId);
    return res.items.map((f: UnipileFolder) => ({
      name: f.name,
      path: f.id,
      unreadCount: f.status?.unread ?? 0,
      totalCount: f.status?.total ?? 0,
    }));
  }

  /**
   * GET /emails — list emails in a folder, grouped into "threads" on our side.
   *
   * Unipile returns individual emails; we collapse them by `thread_id`
   * (falling back to the email id when the provider doesn't expose threads).
   * `pageToken` maps to Unipile's cursor.
   */
  async listThreads(
    folder = "INBOX",
    pageToken?: string,
    maxResults = 50,
  ): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
    console.log(
      `[UnipileMailAdapter] listThreads account=${this.unipileAccountId} folder=${folder} pageToken=${pageToken ?? "(none)"} max=${maxResults}`,
    );
    const res = await listEmails({
      accountId: this.unipileAccountId,
      folder,
      cursor: pageToken,
      limit: maxResults,
      metaOnly: true,
    });
    console.log(
      `[UnipileMailAdapter] listThreads received ${res.items.length} emails, cursor=${res.cursor ?? "(none)"}`,
    );

    // Group by thread_id; keep the newest email per thread.
    const byThread = new Map<string, { newest: UnipileEmail; count: number }>();
    for (const email of res.items) {
      const tid = email.thread_id ?? email.id;
      const cur = byThread.get(tid);
      if (!cur) {
        byThread.set(tid, { newest: email, count: 1 });
      } else {
        cur.count += 1;
        if (new Date(email.date) > new Date(cur.newest.date)) {
          cur.newest = email;
        }
      }
    }

    const threads: EmailThread[] = Array.from(byThread.values())
      .map(({ newest, count }) => ({
        threadId: newest.thread_id ?? newest.id,
        subject: newest.subject ?? "",
        snippet: htmlToSnippet(newest.body ?? newest.body_plain),
        fromEmail: newest.from_attendee?.identifier ?? "",
        fromName: newest.from_attendee?.display_name ?? "",
        date: new Date(newest.date),
        unread: newest.read_date === null,
        messageCount: count,
        labels: newest.folders ?? [],
      }))
      .sort((a, b) => b.date.getTime() - a.date.getTime());

    return {
      threads,
      nextPageToken: res.cursor ?? undefined,
    };
  }

  /**
   * Search via Unipile's `any_email` / `to` / `from` filters.
   * Free-text body search isn't an API filter, so we match the query
   * against from/to/subject server-side then return what Unipile gives us.
   */
  async searchThreads(
    query: string,
    folder?: string,
    maxResults = 50,
  ): Promise<{ threads: EmailThread[] }> {
    const lower = query.toLowerCase();
    const looksLikeEmail = /@/.test(query);
    const res = await listEmails({
      accountId: this.unipileAccountId,
      folder,
      limit: maxResults,
      metaOnly: true,
      ...(looksLikeEmail ? { any_email: query } : {}),
    });
    const threads: EmailThread[] = res.items
      .filter((e) =>
        looksLikeEmail
          ? true
          : (e.subject ?? "").toLowerCase().includes(lower) ||
            (e.from_attendee?.display_name ?? "").toLowerCase().includes(lower) ||
            (e.from_attendee?.identifier ?? "").toLowerCase().includes(lower),
      )
      .map((e) => ({
        threadId: e.thread_id ?? e.id,
        subject: e.subject ?? "",
        snippet: htmlToSnippet(e.body ?? e.body_plain),
        fromEmail: e.from_attendee?.identifier ?? "",
        fromName: e.from_attendee?.display_name ?? "",
        date: new Date(e.date),
        unread: e.read_date === null,
        messageCount: 1,
        labels: e.folders ?? [],
      }));
    return { threads };
  }

  /**
   * GET /emails?thread_id=... — full messages in a thread.
   * Falls back to a single-email fetch if Unipile didn't return matches
   * (some providers don't expose thread_id for older messages).
   */
  async getThread(threadId: string, folder?: string): Promise<EmailMessage[]> {
    const res = await listEmails({
      accountId: this.unipileAccountId,
      threadId,
      folder,
      limit: 100,
      metaOnly: false,
    });
    if (res.items.length > 0) {
      return res.items
        .map(unipileEmailToMessage)
        .sort((a, b) => a.date.getTime() - b.date.getTime());
    }
    // Fallback: maybe the caller passed an email id rather than a thread id.
    const single = await getEmail(threadId, this.unipileAccountId).catch(() => null);
    return single ? [unipileEmailToMessage(single)] : [];
  }

  /** Binary attachment download. */
  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: Buffer; contentType: string; filename: string }> {
    return getEmailAttachment(messageId, attachmentId);
  }

  /** POST /emails — send a new email (handles new + reply via reply_to). */
  async sendEmail(input: SendEmailInput): Promise<{ messageId: string; threadId?: string }> {
    const res = await sendEmail({
      accountId: this.unipileAccountId,
      to: attendeesFromCsv(input.to),
      subject: input.subject,
      body: input.bodyHtml || input.bodyText || "",
      cc: input.cc ? attendeesFromCsv(input.cc) : undefined,
      bcc: input.bcc ? attendeesFromCsv(input.bcc) : undefined,
      from: input.fromEmail
        ? { identifier: input.fromEmail, display_name: input.fromName }
        : undefined,
      // replyToThreadId is the Unipile thread id; replyTo accepts either
      // a Unipile email id or provider id of the email being replied to.
      // Velocity's adapter interface uses inReplyTo for the Message-ID
      // header, not the email id — most callers pass replyToThreadId.
      replyTo: input.replyToThreadId,
      // Personal-mailbox path: do not track. Outreach SMTP uses Velocity's
      // own pixel-and-redirect tracking via emailTracking.ts.
      trackingOptions: { opens: false, links: false },
      attachments: input.attachments,
    });
    return { messageId: res.tracking_id, threadId: undefined };
  }

  /** PUT /emails/{id} { unread } — mark a message read or unread. */
  async markRead(messageId: string, read: boolean): Promise<void> {
    await updateEmail(messageId, { unread: !read }, this.unipileAccountId);
  }

  /** DELETE /emails/{id} — move to Trash. */
  async moveToTrash(messageId: string): Promise<void> {
    await deleteEmail(messageId, this.unipileAccountId);
  }

  /**
   * PUT /emails/{id} { folders: [destFolder] } — Outlook/IMAP accept exactly
   * one destination folder. Gmail-style multi-label moves would need
   * provider-specific handling; for the M365 path this is sufficient.
   */
  async moveToFolder(messageId: string, destFolder: string): Promise<void> {
    await updateEmail(messageId, { folders: [destFolder] }, this.unipileAccountId);
  }

  protected getAccount(): SendingAccount {
    return this.account;
  }
}
