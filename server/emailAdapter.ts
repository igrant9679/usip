/**
 * emailAdapter.ts — Unified email adapter for Rep Mailbox (Feature 73)
 *
 * ImapSmtpAdapter: Mailpool own SMTP/IMAP, generic IMAP/SMTP (imapflow + nodemailer)
 */

import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { SendingAccount } from "../drizzle/schema";
import { recordEmailsSent } from "./usageCounters";
import { createDecipheriv, createCipheriv, randomBytes } from "crypto";

/* ─── Encryption helpers ─────────────────────────────────────────────────── */
function getEncKey(): Buffer {
  const secret = process.env.JWT_SECRET ?? "fallback-dev-secret-32-bytes!!!";
  return Buffer.from(secret.padEnd(32, "0").slice(0, 32));
}
export function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}
export function decryptField(ciphertext: string): string {
  const [ivHex, tagHex, encHex] = ciphertext.split(":");
  if (!ivHex || !tagHex || !encHex) throw new Error("Invalid ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", getEncKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(encHex, "hex")).toString("utf8") + decipher.final("utf8");
}

/* ─── Shared types ───────────────────────────────────────────────────────── */

export interface EmailThread {
  threadId: string;
  subject: string;
  snippet: string;
  fromEmail: string;
  fromName: string;
  date: Date;
  unread: boolean;
  messageCount: number;
  labels: string[];
}

export interface EmailMessage {
  messageId: string;
  threadId: string;
  subject: string;
  fromEmail: string;
  fromName: string;
  toEmail: string;
  ccEmail?: string;
  date: Date;
  bodyText: string;
  bodyHtml: string;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  inReplyTo?: string;
  references?: string;
  unread: boolean;
}

export interface EmailFolder {
  name: string;
  path: string;
  unreadCount: number;
  totalCount: number;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
  replyToThreadId?: string;
  fromName?: string;
  fromEmail: string;
  /**
   * Reply-To. `sendCampaignEmailViaPool` has always passed this — through an
   * `as any` cast, which is why the interface never listed it. Declared now
   * because the SendGrid adapter genuinely depends on it: with no inbox behind
   * an API key, Reply-To is the ONLY way a reply reaches a human.
   */
  replyTo?: string;
  /** Base64-encoded file attachments */
  attachments?: Array<{ filename: string; contentType: string; content: string }>;
  /**
   * Enable open/click tracking via the provider (Unipile only — IMAP path
   * has no equivalent). Defaults to false to preserve the "personal
   * mailbox doesn't get tracked" rule; sales touches (sendAdHocEmail,
   * sequence sends) should opt in by passing track:true.
   */
  track?: boolean;
}

export interface EmailAdapter {
  listThreads(folder: string, pageToken?: string, maxResults?: number): Promise<{ threads: EmailThread[]; nextPageToken?: string }>;
  searchThreads(query: string, folder?: string, maxResults?: number): Promise<{ threads: EmailThread[] }>;
  getThread(threadId: string, folder?: string): Promise<EmailMessage[]>;
  getAttachment(messageId: string, attachmentId: string): Promise<{ data: Buffer; contentType: string; filename: string }>;
  sendEmail(input: SendEmailInput): Promise<{ messageId: string; threadId?: string }>;
  markRead(messageId: string, read: boolean): Promise<void>;
  moveToTrash(messageId: string): Promise<void>;
  moveToFolder(messageId: string, destFolder: string, currentFolder?: string): Promise<void>;
  listFolders(): Promise<EmailFolder[]>;
}

/* ─── IMAP/SMTP Adapter (Mailpool own servers, generic IMAP) ─────────────── */

export class ImapSmtpAdapter implements EmailAdapter {
  private account: SendingAccount;

  constructor(account: SendingAccount) {
    this.account = account;
  }

  private async withImap<T>(folder: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const acc = this.account;
    if (!acc.imapHost || !acc.imapUsername || !acc.imapPassword) throw new Error("IMAP not configured for this account");
    let password: string;
    try { password = decryptField(acc.imapPassword); } catch { password = acc.imapPassword; }
    const client = new ImapFlow({
      host: acc.imapHost, port: acc.imapPort ?? 993, secure: acc.imapSecure ?? true,
      auth: { user: acc.imapUsername, pass: password }, logger: false,
    });
    await client.connect();
    try { return await fn(client); }
    finally { await client.logout().catch(() => {}); }
  }

  async listFolders(): Promise<EmailFolder[]> {
    return this.withImap("INBOX", async (client) => {
      const list = await client.list();
      const folders: EmailFolder[] = [];
      for (const mb of list) {
        try {
          const status = await client.status(mb.path, { messages: true, unseen: true });
          folders.push({ name: mb.name, path: mb.path, unreadCount: status.unseen ?? 0, totalCount: status.messages ?? 0 });
        } catch { folders.push({ name: mb.name, path: mb.path, unreadCount: 0, totalCount: 0 }); }
      }
      return folders;
    });
  }

  async listThreads(folder = "INBOX", _pageToken?: string, maxResults = 50): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
    return this.withImap(folder, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ all: true }, { uid: true });
        const recent = uids.slice(-maxResults).reverse();
        if (recent.length === 0) return { threads: [] };
        const threads: EmailThread[] = [];
        for await (const msg of client.fetch(recent.join(","), { uid: true, flags: true, envelope: true }, { uid: true })) {
          const env = msg.envelope;
          const from = env?.from?.[0];
          threads.push({
            threadId: String(msg.uid), subject: env?.subject ?? "(no subject)", snippet: "",
            fromEmail: from?.address ?? "", fromName: from?.name ?? "",
            date: env?.date ?? new Date(), unread: !msg.flags.has("\\Seen"),
            messageCount: 1, labels: [...msg.flags],
          });
        }
        return { threads };
      } finally { lock.release(); }
    });
  }

  async getThread(threadId: string, folder = "INBOX"): Promise<EmailMessage[]> {
    return this.withImap(folder, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const msgs: EmailMessage[] = [];
        for await (const msg of client.fetch(threadId, { uid: true, flags: true, envelope: true, source: true }, { uid: true })) {
          const parsed = await simpleParser(msg.source);
          const toVal = parsed.to;
          const ccVal = parsed.cc;
          msgs.push({
            messageId: String(msg.uid), threadId,
            subject: parsed.subject ?? "(no subject)",
            fromEmail: parsed.from?.value?.[0]?.address ?? "",
            fromName: parsed.from?.value?.[0]?.name ?? "",
            toEmail: toVal ? (Array.isArray(toVal) ? toVal.map((a: any) => a.text).join(", ") : (toVal as any).text) : "",
            ccEmail: ccVal ? (Array.isArray(ccVal) ? ccVal.map((a: any) => a.text).join(", ") : (ccVal as any).text) : undefined,
            date: parsed.date ?? new Date(),
            bodyText: parsed.text ?? "", bodyHtml: parsed.html || parsed.textAsHtml || "",
            attachments: (parsed.attachments ?? []).map((a) => ({ filename: a.filename ?? "attachment", contentType: a.contentType, size: a.size ?? 0 })),
            inReplyTo: parsed.inReplyTo ?? undefined,
            references: Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references ?? undefined),
            unread: !msg.flags.has("\\Seen"),
          });
        }
        return msgs;
      } finally { lock.release(); }
    });
  }

  async sendEmail(input: SendEmailInput): Promise<{ messageId: string }> {
    const acc = this.account;
    if (!acc.smtpHost || !acc.smtpUsername || !acc.smtpPassword) throw new Error("SMTP not configured");
    let smtpPassword: string;
    try { smtpPassword = decryptField(acc.smtpPassword); } catch { smtpPassword = acc.smtpPassword; }
    const transporter = nodemailer.createTransport({
      host: acc.smtpHost, port: acc.smtpPort ?? 587, secure: acc.smtpSecure ?? false,
      auth: { user: acc.smtpUsername, pass: smtpPassword },
    });
    const info = await transporter.sendMail({
      from: input.fromName ? `"${input.fromName}" <${input.fromEmail}>` : input.fromEmail,
      to: input.to, cc: input.cc, bcc: input.bcc,
      subject: input.subject, text: input.bodyText, html: input.bodyHtml,
      inReplyTo: input.inReplyTo, references: input.references,
      attachments: input.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, "base64"),
        contentType: a.contentType,
      })),
    });
    return { messageId: info.messageId };
  }

  async markRead(messageId: string, read: boolean): Promise<void> {
    return this.withImap("INBOX", async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        if (read) await client.messageFlagsAdd(messageId, ["\\Seen"], { uid: true });
        else await client.messageFlagsRemove(messageId, ["\\Seen"], { uid: true });
      } finally { lock.release(); }
    });
  }

  async moveToTrash(messageId: string): Promise<void> {
    return this.withImap("INBOX", async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try { await client.messageMove(messageId, "Trash", { uid: true }); }
      finally { lock.release(); }
    });
  }

  async moveToFolder(messageId: string, destFolder: string, currentFolder = "INBOX"): Promise<void> {
    return this.withImap(currentFolder, async (client) => {
      const lock = await client.getMailboxLock(currentFolder);
      try { await client.messageMove(messageId, destFolder, { uid: true }); }
      finally { lock.release(); }
    });
  }

  async searchThreads(query: string, folder = "INBOX", maxResults = 20): Promise<{ threads: EmailThread[] }> {
    return this.withImap(folder, async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search({ text: query }, { uid: true });
        const recent = uids.slice(-maxResults).reverse();
        if (recent.length === 0) return { threads: [] };
        const threads: EmailThread[] = [];
        for await (const msg of client.fetch(recent.join(","), { uid: true, flags: true, envelope: true }, { uid: true })) {
          const env = msg.envelope;
          const from = env?.from?.[0];
          threads.push({
            threadId: String(msg.uid), subject: env?.subject ?? "(no subject)", snippet: "",
            fromEmail: from?.address ?? "", fromName: from?.name ?? "",
            date: env?.date ?? new Date(), unread: !msg.flags.has("\\Seen"),
            messageCount: 1, labels: [...msg.flags],
          });
        }
        return { threads };
      } finally { lock.release(); }
    });
  }

  async getAttachment(messageId: string, attachmentIndex: string): Promise<{ data: Buffer; contentType: string; filename: string }> {
    return this.withImap("INBOX", async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        let result: { data: Buffer; contentType: string; filename: string } | null = null;
        for await (const msg of client.fetch(messageId, { source: true }, { uid: true })) {
          const parsed = await simpleParser(msg.source);
          const idx = parseInt(attachmentIndex, 10);
          const att = parsed.attachments?.[isNaN(idx) ? 0 : idx];
          if (att) result = { data: att.content as Buffer, contentType: att.contentType, filename: att.filename ?? "attachment" };
        }
        return result ?? { data: Buffer.alloc(0), contentType: "application/octet-stream", filename: "attachment" };
      } finally { lock.release(); }
    });
  }
}

/* ─── SendGrid Adapter (Migration 0140) — SEND ONLY ──────────────────────── */

/**
 * A SendGrid API key can send mail and nothing else: there is no mailbox behind
 * it to read. Rather than pretend, this adapter splits the interface in two.
 *
 *  - LISTING reads (`listThreads`, `searchThreads`, `listFolders`) return EMPTY.
 *    These get polled by reply detection and inbox UI across every account; an
 *    empty inbox is the literal truth here, and throwing on a poll would fill
 *    the logs with an error that is really a fact about the provider.
 *  - PER-MESSAGE operations THROW. They can only be reached with a message id,
 *    and no listing here ever yields one, so arriving with one means a genuine
 *    bug upstream — a silent no-op would hide it.
 *
 * The consequence a workspace must understand: replies to a SendGrid campaign
 * land at the account's Reply-To and are invisible to Velocity unless that
 * address is a mailbox connected separately. The Settings card says this.
 */
const SEND_ONLY = "This is a SendGrid sending account — it can send mail but has no inbox to read. Connect the Reply-To address as a mailbox to see replies.";

export class SendGridAdapter implements EmailAdapter {
  private account: SendingAccount;
  constructor(account: SendingAccount) {
    this.account = account;
  }

  async sendEmail(input: SendEmailInput): Promise<{ messageId: string; threadId?: string }> {
    const { sendViaSendGrid } = await import("./services/sendgrid");
    const { tryDecryptSecret } = await import("./_core/crypto");
    const apiKey = tryDecryptSecret((this.account as any).sendgridApiKeyEnc);
    if (!apiKey) throw new Error("No SendGrid API key is configured for this sending account.");

    // Reply-To precedence: explicit input → the account's stored Reply-To →
    // the workspace's INBOUND reply address (owner ask 2026-08-13: replies
    // collect only in Velocity, no human inbox required). Resolved per send
    // because the inbound config is a workspace setting the admin can add
    // or clear at any time.
    let replyTo = input.replyTo ?? this.account.replyTo ?? null;
    if (!replyTo) {
      try {
        const { getDb } = await import("./db");
        const db = await getDb();
        if (db) {
          const { workspaceSettings } = await import("../drizzle/schema");
          const { eq } = await import("drizzle-orm");
          const [ws] = await db
            .select({ domain: workspaceSettings.sendgridInboundDomain, token: workspaceSettings.sendgridInboundToken })
            .from(workspaceSettings)
            .where(eq(workspaceSettings.workspaceId, this.account.workspaceId))
            .limit(1);
          if (ws?.domain && ws?.token) {
            const { inboundReplyAddress } = await import("./sendgridInbound");
            replyTo = inboundReplyAddress(ws.token, ws.domain);
          }
        }
      } catch (e) {
        console.error("[SendGridAdapter] inbound reply-to lookup failed:", (e as Error).message);
      }
    }

    const res = await sendViaSendGrid(apiKey, {
      to: input.to,
      subject: input.subject,
      html: input.bodyHtml,
      text: input.bodyText,
      fromEmail: input.fromEmail || this.account.fromEmail,
      fromName: input.fromName ?? this.account.fromName,
      replyTo,
    });
    // Throw rather than return a sentinel: the pool sender counts a resolved
    // sendEmail as a delivered send and increments the daily quota on it.
    if (!res.ok) throw new Error(res.reason ?? "SendGrid send failed");
    return { messageId: res.messageId ?? "" };
  }

  async listThreads(): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
    return { threads: [] };
  }
  async searchThreads(): Promise<{ threads: EmailThread[] }> {
    return { threads: [] };
  }
  async listFolders(): Promise<EmailFolder[]> {
    return [];
  }
  async getThread(): Promise<EmailMessage[]> {
    throw new Error(SEND_ONLY);
  }
  async getAttachment(): Promise<{ data: Buffer; contentType: string; filename: string }> {
    throw new Error(SEND_ONLY);
  }
  async markRead(): Promise<void> {
    throw new Error(SEND_ONLY);
  }
  async moveToTrash(): Promise<void> {
    throw new Error(SEND_ONLY);
  }
  async moveToFolder(): Promise<void> {
    throw new Error(SEND_ONLY);
  }
}

/* ─── Factory ────────────────────────────────────────────────────────────── */

function buildEmailAdapter(account: SendingAccount): EmailAdapter {
  // Checked before the Unipile bridge: a SendGrid account never has a
  // unipileAccountId, but ordering this first makes the send-only path
  // unambiguous rather than dependent on another column being empty.
  if (account.provider === "sendgrid") return new SendGridAdapter(account);
  // Bridged Unipile-managed accounts are detected by the unipileAccountId
  // column being set (regardless of the legacy provider value, in case this
  // row was migrated from a stub `outlook_oauth` provider).
  if (account.unipileAccountId) {
    // Lazy import to avoid pulling Unipile types into IMAP-only call sites.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { UnipileMailAdapter } = require("./unipileMailAdapter") as typeof import("./unipileMailAdapter");
    return new UnipileMailAdapter(account);
  }
  return new ImapSmtpAdapter(account);
}

/**
 * Every adapter, with its `sendEmail` metered.
 *
 * `usage_counters.emailsSent` is read by usage.currentMonth and rendered on
 * Settings → Billing as "Emails sent", and NOTHING WROTE IT — the tile showed
 * 0 for every workspace forever, exactly like `llmTokens` did before a1c1f99.
 *
 * Counted HERE rather than at the 11 `createEmailAdapter` call sites, for the
 * reason the LLM meter sits inside invokeLLM: a per-call-site counter misses
 * the twelfth. Every adapter is constructed through this factory, so wrapping
 * the instance covers all three implementations and every caller at once.
 *
 * ⚠️ This is ONE OF THREE transmission points, and the others must not also
 * count or a send would be counted twice. `sendWorkspaceEmail`'s raw
 * SMTP-config branch and `operations.sendScheduleNow` bypass the adapter
 * entirely and record their own; `sendSystemEmail` and
 * `sendCampaignEmailViaPool` are orchestrators that reach transmission through
 * exactly one of the three, so they count once without knowing about counting.
 *
 * Only SUCCESSFUL sends: a throw from the underlying adapter propagates before
 * the increment is reached, because nothing was delivered.
 *
 * `sendingAccountDailyStats.sentCount` is a DIFFERENT counter — per account,
 * per day, enforcing `dailySendLimit`. Both are correct and neither replaces
 * the other.
 */
export function createEmailAdapter(account: SendingAccount): EmailAdapter {
  const adapter = buildEmailAdapter(account);
  const send = adapter.sendEmail.bind(adapter);
  adapter.sendEmail = async (input) => {
    const result = await send(input);
    await recordEmailsSent(account.workspaceId, 1);
    return result;
  };
  return adapter;
}
