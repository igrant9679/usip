/**
 * emailAdapter.ts — Unified email adapter for Rep Mailbox (Feature 73)
 *
 * GmailAdapter  : Google Workspace via Gmail REST API (googleapis)
 * ImapSmtpAdapter: Mailpool own SMTP/IMAP, generic IMAP/SMTP (imapflow + nodemailer)
 */

import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { google } from "googleapis";
import type { SendingAccount } from "../drizzle/schema";
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
}

export interface EmailAdapter {
  listThreads(folder: string, pageToken?: string, maxResults?: number): Promise<{ threads: EmailThread[]; nextPageToken?: string }>;
  getThread(threadId: string): Promise<EmailMessage[]>;
  sendEmail(input: SendEmailInput): Promise<{ messageId: string; threadId?: string }>;
  markRead(messageId: string, read: boolean): Promise<void>;
  moveToTrash(messageId: string): Promise<void>;
  listFolders(): Promise<EmailFolder[]>;
}

/* ─── Gmail Adapter ──────────────────────────────────────────────────────── */

export class GmailAdapter implements EmailAdapter {
  private gmail: ReturnType<typeof google.gmail>;

  constructor(account: SendingAccount) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );
    oauth2Client.setCredentials({
      access_token: account.oauthAccessToken,
      refresh_token: account.oauthRefreshToken,
      expiry_date: account.oauthTokenExpiry ? new Date(account.oauthTokenExpiry).getTime() : undefined,
    });
    this.gmail = google.gmail({ version: "v1", auth: oauth2Client });
  }

  async listThreads(folder = "INBOX", pageToken?: string, maxResults = 50): Promise<{ threads: EmailThread[]; nextPageToken?: string }> {
    const labelMap: Record<string, string> = { INBOX: "INBOX", SENT: "SENT", DRAFTS: "DRAFT", TRASH: "TRASH", SPAM: "SPAM" };
    const labelId = labelMap[folder.toUpperCase()] ?? "INBOX";
    const res = await this.gmail.users.threads.list({ userId: "me", labelIds: [labelId], maxResults, pageToken });
    const threadList = res.data.threads ?? [];
    const threads: EmailThread[] = [];
    await Promise.all(
      threadList.slice(0, 20).map(async (t) => {
        try {
          const detail = await this.gmail.users.threads.get({ userId: "me", id: t.id!, format: "METADATA", metadataHeaders: ["Subject", "From", "Date"] });
          const msgs = detail.data.messages ?? [];
          const last = msgs[msgs.length - 1];
          const headers = last?.payload?.headers ?? [];
          const getH = (n: string) => headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
          const fromRaw = getH("From");
          const fromMatch = fromRaw.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);
          threads.push({
            threadId: t.id!,
            subject: getH("Subject") || "(no subject)",
            snippet: detail.data.snippet ?? "",
            fromEmail: fromMatch?.[2]?.trim() ?? fromRaw,
            fromName: fromMatch?.[1]?.trim() ?? "",
            date: new Date(parseInt(last?.internalDate ?? "0")),
            unread: (last?.labelIds ?? []).includes("UNREAD"),
            messageCount: msgs.length,
            labels: last?.labelIds ?? [],
          });
        } catch { /* skip */ }
      })
    );
    return { threads, nextPageToken: res.data.nextPageToken ?? undefined };
  }

  async getThread(threadId: string): Promise<EmailMessage[]> {
    const res = await this.gmail.users.threads.get({ userId: "me", id: threadId, format: "FULL" });
    return (res.data.messages ?? []).map((msg) => {
      const headers = msg.payload?.headers ?? [];
      const getH = (n: string) => headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value ?? "";
      const fromRaw = getH("From");
      const fromMatch = fromRaw.match(/^"?([^"<]*)"?\s*<?([^>]*)>?$/);
      return {
        messageId: msg.id!,
        threadId,
        subject: getH("Subject") || "(no subject)",
        fromEmail: fromMatch?.[2]?.trim() ?? fromRaw,
        fromName: fromMatch?.[1]?.trim() ?? "",
        toEmail: getH("To"),
        ccEmail: getH("Cc") || undefined,
        date: new Date(parseInt(msg.internalDate ?? "0")),
        bodyText: this._extractBody(msg.payload, "text/plain"),
        bodyHtml: this._extractBody(msg.payload, "text/html"),
        attachments: this._extractAttachments(msg.payload),
        inReplyTo: getH("In-Reply-To") || undefined,
        references: getH("References") || undefined,
        unread: (msg.labelIds ?? []).includes("UNREAD"),
      };
    });
  }

  async sendEmail(input: SendEmailInput): Promise<{ messageId: string; threadId?: string }> {
    const headers = [
      `From: ${input.fromName ? `"${input.fromName}" <${input.fromEmail}>` : input.fromEmail}`,
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      `Content-Type: text/html; charset=utf-8`,
      `MIME-Version: 1.0`,
    ];
    if (input.cc) headers.push(`Cc: ${input.cc}`);
    if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
    if (input.references) headers.push(`References: ${input.references}`);
    const raw = Buffer.from(headers.join("\r\n") + "\r\n\r\n" + input.bodyHtml).toString("base64url");
    const res = await this.gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId: input.replyToThreadId } });
    return { messageId: res.data.id!, threadId: res.data.threadId ?? undefined };
  }

  async markRead(messageId: string, read: boolean): Promise<void> {
    await this.gmail.users.messages.modify({
      userId: "me", id: messageId,
      requestBody: read ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] },
    });
  }

  async moveToTrash(messageId: string): Promise<void> {
    await this.gmail.users.messages.trash({ userId: "me", id: messageId });
  }

  async listFolders(): Promise<EmailFolder[]> {
    const res = await this.gmail.users.labels.list({ userId: "me" });
    return (res.data.labels ?? []).map((l) => ({
      name: l.name ?? "", path: l.id ?? "", unreadCount: l.messagesUnread ?? 0, totalCount: l.messagesTotal ?? 0,
    }));
  }

  private _extractBody(payload: any, mimeType: string): string {
    if (!payload) return "";
    if (payload.mimeType === mimeType && payload.body?.data) return Buffer.from(payload.body.data, "base64").toString("utf8");
    for (const part of payload.parts ?? []) { const f = this._extractBody(part, mimeType); if (f) return f; }
    return "";
  }

  private _extractAttachments(payload: any): Array<{ filename: string; contentType: string; size: number }> {
    const result: Array<{ filename: string; contentType: string; size: number }> = [];
    if (!payload) return result;
    for (const part of payload.parts ?? []) {
      if (part.filename && part.body?.attachmentId) result.push({ filename: part.filename, contentType: part.mimeType ?? "", size: part.body.size ?? 0 });
      result.push(...this._extractAttachments(part));
    }
    return result;
  }
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

  async getThread(threadId: string): Promise<EmailMessage[]> {
    return this.withImap("INBOX", async (client) => {
      const lock = await client.getMailboxLock("INBOX");
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
}

/* ─── Factory ────────────────────────────────────────────────────────────── */

export function createEmailAdapter(account: SendingAccount): EmailAdapter {
  // If explicit IMAP credentials are set, always use IMAP (even for gmail_oauth accounts
  // where the user has configured IMAP instead of relying on the OAuth token).
  if (account.imapHost && account.imapUsername && account.imapPassword) {
    return new ImapSmtpAdapter(account);
  }
  if (account.provider === "gmail_oauth") return new GmailAdapter(account);
  return new ImapSmtpAdapter(account);
}
