/**
 * emailAdapter.ts — Unified email adapter for Rep Mailbox (Feature 73)
 *
 * ImapSmtpAdapter: Mailpool own SMTP/IMAP, generic IMAP/SMTP (imapflow + nodemailer)
 */

import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
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
  /** Base64-encoded file attachments */
  attachments?: Array<{ filename: string; contentType: string; content: string }>;
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

/* ─── Factory ────────────────────────────────────────────────────────────── */

export function createEmailAdapter(account: SendingAccount): EmailAdapter {
  return new ImapSmtpAdapter(account);
}
