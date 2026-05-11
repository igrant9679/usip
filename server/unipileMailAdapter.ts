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
import { and, desc, eq, like, or } from "drizzle-orm";
import { getDb } from "./db";
import { unipileEmailsCache, type SendingAccount } from "../drizzle/schema";
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

/* ─── Local cache fallback helpers ────────────────────────────────────────
 *
 * Unipile's /emails endpoint sometimes returns items=0 for accounts whose
 * historical sync hasn't completed (Unipile-side state). The mail webhook
 * (POST /api/unipile/mail-webhook) populates unipile_emails_cache in real
 * time, so we serve from that table when the API gives us nothing.
 *
 * The cache only contains emails received after webhook registration —
 * it's NOT a historical backfill. But for the "I just connected and want
 * to see new mail arrive" path, it works without needing Unipile's
 * server-side sync.
 */

type CacheRow = typeof unipileEmailsCache.$inferSelect;

/** Stringify a Unipile attendee JSON column into "email1, email2". */
function attendeesJsonToCsv(json: unknown): string {
  if (!Array.isArray(json)) return "";
  return (json as UnipileAttendee[])
    .map((a) => a.identifier)
    .filter((s) => typeof s === "string" && s.length > 0)
    .join(", ");
}

function cacheRowToThread(row: CacheRow): EmailThread {
  const folders = Array.isArray(row.foldersJson) ? (row.foldersJson as string[]) : [];
  return {
    threadId: row.threadId ?? row.emailId,
    subject: row.subject ?? "",
    snippet: htmlToSnippet(row.bodyHtml ?? row.bodyPlain ?? ""),
    fromEmail: row.fromEmail ?? "",
    fromName: row.fromName ?? "",
    date: row.emailDate ?? row.createdAt,
    unread: row.readDate === null,
    messageCount: 1,
    labels: folders,
  };
}

function cacheRowToMessage(row: CacheRow): EmailMessage {
  const attachments = Array.isArray(row.attachmentsJson)
    ? (row.attachmentsJson as Array<{ name?: string; mime?: string; size?: number }>)
    : [];
  return {
    messageId: row.emailId,
    threadId: row.threadId ?? row.emailId,
    subject: row.subject ?? "",
    fromEmail: row.fromEmail ?? "",
    fromName: row.fromName ?? "",
    toEmail: attendeesJsonToCsv(row.toJson),
    ccEmail: attendeesJsonToCsv(row.ccJson) || undefined,
    date: row.emailDate ?? row.createdAt,
    bodyText: row.bodyPlain ?? "",
    bodyHtml: row.bodyHtml ?? "",
    attachments: attachments.map((a) => ({
      filename: a.name ?? "attachment",
      contentType: a.mime ?? "application/octet-stream",
      size: a.size ?? 0,
    })),
    inReplyTo: undefined,
    references: undefined,
    unread: row.readDate === null,
  };
}

/**
 * Folder match heuristic for cache rows.
 *
 * Mailbox can call listThreads with three different folder shapes:
 *   1. "INBOX" — the canonical alias we use as the default
 *   2. "Inbox" / "Sent" / "Trash" — the human folder names that show up in
 *      the webhook payload's `folders` array
 *   3. Opaque Unipile folder IDs (e.g. "0SqztReUV5qRVAcZ2jR5WQ") — what
 *      /folders returns as folder.id, what the Mailbox UI passes after a
 *      user clicks a folder in the sidebar
 *
 * The webhook payload only gives us human names, never folder IDs. So
 * shape (3) can never exact-match — we treat it as "probably the inbox"
 * (the most common case) and fall back to role matching.
 *
 * To distinguish inbox-ish folder IDs from sent/trash IDs we'd need to
 * cache the /folders response and look up role per id. For now, looseness
 * here only matters until Unipile's historical sync recovers — once
 * /emails returns rows, this whole code path goes silent.
 */
function cacheRowMatchesFolder(row: CacheRow, folder: string | undefined): boolean {
  if (!folder) return true;
  const wanted = folder.toLowerCase();

  // Canonical inbox aliases (case-insensitive) match anything with role=inbox.
  if (wanted === "inbox" || wanted === "[gmail]/inbox") {
    return row.role === "inbox";
  }
  // Other well-known role aliases.
  if (wanted === "sent" || wanted === "[gmail]/sent mail") return row.role === "sent";
  if (wanted === "trash" || wanted === "[gmail]/trash") return row.role === "trash";
  if (wanted === "drafts" || wanted === "[gmail]/drafts") return row.role === "drafts";
  if (wanted === "spam" || wanted === "[gmail]/spam") return row.role === "spam";

  // Exact match against any folder name the webhook recorded.
  const folders = Array.isArray(row.foldersJson) ? (row.foldersJson as string[]) : [];
  if (folders.some((f) => typeof f === "string" && f.toLowerCase() === wanted)) {
    return true;
  }

  // Opaque Unipile folder ID (no '/', no space, looks like base64ish) —
  // we can't tell from the id alone which role it maps to. Treat as
  // inbox-equivalent so the cache fallback at least surfaces new mail
  // for the most common case. If you click "Sent" in the UI and see
  // received mail here, that's the loose-match cost.
  if (/^[A-Za-z0-9_\-]{16,}$/.test(folder)) {
    return row.role === "inbox";
  }

  return false;
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

    // ── Fallback: serve from the webhook-fed cache when Unipile gave us
    // nothing. Only triggers on a clean empty page with no cursor (i.e.
    // the user's *first* page of an unsynced mailbox). Once /emails
    // starts returning items, this path goes silent.
    if (threads.length === 0 && !res.cursor) {
      const cacheThreads = await this.cacheFallbackListThreads(folder, maxResults);
      if (cacheThreads.length > 0) {
        console.log(
          `[UnipileMailAdapter] listThreads serving ${cacheThreads.length} threads from webhook cache (Unipile /emails returned 0)`,
        );
        return { threads: cacheThreads, nextPageToken: undefined };
      }
    }

    return {
      threads,
      nextPageToken: res.cursor ?? undefined,
    };
  }

  /** Cache-only path: read recent emails from unipile_emails_cache. */
  private async cacheFallbackListThreads(
    folder: string,
    maxResults: number,
  ): Promise<EmailThread[]> {
    const db = await getDb();
    // Pull a generous window then filter by folder client-side — folders
    // is a JSON column so we can't WHERE on it portably. maxResults*4 is
    // enough headroom for typical folder distributions.
    const rows = await db
      .select()
      .from(unipileEmailsCache)
      .where(eq(unipileEmailsCache.unipileAccountId, this.unipileAccountId))
      .orderBy(desc(unipileEmailsCache.emailDate))
      .limit(maxResults * 4);

    // Group by thread id and pick the newest per thread.
    const byThread = new Map<string, { newest: CacheRow; count: number }>();
    for (const row of rows) {
      if (!cacheRowMatchesFolder(row, folder)) continue;
      const tid = row.threadId ?? row.emailId;
      const cur = byThread.get(tid);
      if (!cur) {
        byThread.set(tid, { newest: row, count: 1 });
      } else {
        cur.count += 1;
        const curDate = (cur.newest.emailDate ?? cur.newest.createdAt).getTime();
        const newDate = (row.emailDate ?? row.createdAt).getTime();
        if (newDate > curDate) cur.newest = row;
      }
    }

    return Array.from(byThread.values())
      .map(({ newest, count }) => ({
        ...cacheRowToThread(newest),
        messageCount: count,
      }))
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, maxResults);
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

    // Cache fallback — same logic as listThreads, but with text matching
    // against subject / from across cached rows for this account.
    if (threads.length === 0) {
      const db = await getDb();
      const likeQ = `%${query}%`;
      const cacheRows = await db
        .select()
        .from(unipileEmailsCache)
        .where(
          and(
            eq(unipileEmailsCache.unipileAccountId, this.unipileAccountId),
            or(
              like(unipileEmailsCache.subject, likeQ),
              like(unipileEmailsCache.fromEmail, likeQ),
              like(unipileEmailsCache.fromName, likeQ),
            ),
          ),
        )
        .orderBy(desc(unipileEmailsCache.emailDate))
        .limit(maxResults);
      if (cacheRows.length > 0) {
        console.log(
          `[UnipileMailAdapter] searchThreads serving ${cacheRows.length} matches from webhook cache`,
        );
        return { threads: cacheRows.map(cacheRowToThread) };
      }
    }

    return { threads };
  }

  /**
   * GET /emails?thread_id=... — full messages in a thread.
   * Falls back to a single-email fetch if Unipile didn't return matches
   * (some providers don't expose thread_id for older messages).
   */
  async getThread(threadId: string, folder?: string): Promise<EmailMessage[]> {
    console.log(
      `[UnipileMailAdapter] getThread threadId=${threadId} folder=${folder ?? "(none)"}`,
    );

    // Step 1: try Unipile's thread endpoint. Wrap in try/catch — Unipile
    // rejects unknown thread_ids with 4xx (it doesn't return empty), so
    // an unknown id would throw and skip the cache fallback below.
    let unipileItems: UnipileEmail[] = [];
    try {
      const res = await listEmails({
        accountId: this.unipileAccountId,
        threadId,
        folder,
        limit: 100,
        metaOnly: false,
      });
      unipileItems = res.items;
    } catch (err) {
      console.log(
        `[UnipileMailAdapter] getThread Unipile /emails?thread_id rejected (likely unknown thread): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
      );
    }
    if (unipileItems.length > 0) {
      console.log(
        `[UnipileMailAdapter] getThread serving ${unipileItems.length} messages from Unipile`,
      );
      return unipileItems
        .map(unipileEmailToMessage)
        .sort((a, b) => a.date.getTime() - b.date.getTime());
    }

    // Step 2: maybe the caller passed an email id rather than a thread id.
    // Wrapped in .catch — 404 here is expected for cache-only emails.
    const single = await getEmail(threadId, this.unipileAccountId).catch(() => null);
    if (single) {
      console.log(`[UnipileMailAdapter] getThread serving 1 message via Unipile getEmail`);
      return [unipileEmailToMessage(single)];
    }

    // Step 3: local webhook cache. Match on either threadId column (Unipile
    // thread id, if known) or emailId column (the Mailbox UI passes the
    // emailId we returned from listThreads when there's no real threadId).
    const db = await getDb();
    const cacheRows = await db
      .select()
      .from(unipileEmailsCache)
      .where(
        and(
          eq(unipileEmailsCache.unipileAccountId, this.unipileAccountId),
          or(
            eq(unipileEmailsCache.threadId, threadId),
            eq(unipileEmailsCache.emailId, threadId),
          ),
        ),
      )
      .orderBy(unipileEmailsCache.emailDate);
    console.log(
      `[UnipileMailAdapter] getThread cache query returned ${cacheRows.length} rows for threadId=${threadId}`,
    );
    if (cacheRows.length > 0) {
      return cacheRows.map(cacheRowToMessage);
    }
    return [];
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
      // Tracking is opt-in via SendEmailInput.track. Sales touches
      // (sendAdHocEmail, sequence sends) pass track:true so Unipile inserts
      // open/click pixels + link redirects; the resulting opens/clicks
      // flow back via /api/unipile/email-tracking-webhook and increment
      // emailDrafts.openCount / clickCount. Mailbox manual sends leave
      // it false so personal email doesn't get tracked.
      trackingOptions: input.track
        ? { opens: true, links: true }
        : { opens: false, links: false },
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
