/**
 * mailCompose.ts — what My Mailbox sends, decided in one place so the page
 * and the router agree (audit 2026-10-20, O35 and O59).
 *
 * Pure and dependency-light: the page builds the message with these, the
 * router enforces the attachment limit with the same number, and the tests
 * call them directly.
 */
import { escapeHtml } from "./escapeHtml";
import { isHtmlBody, plainTextToHtml } from "./emailBody";

/**
 * Attachments per email, decoded bytes, all files together. The request body
 * is capped at 50 MB of JSON and base64 adds a third, so anything much past
 * this failed as an opaque "request too large" after the upload had already
 * happened; mail providers refuse messages around 20–25 MB anyway.
 */
export const MAILBOX_ATTACHMENT_LIMIT_BYTES = 20 * 1024 * 1024;

/** Decoded size of a base64 string, without decoding it. */
export function base64Bytes(b64: string): number {
  const s = b64.replace(/\s+/g, "");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

/** "12.4 MB" for the refusal message. */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Null when the files fit, else the sentence that says they don't. */
export function attachmentLimitProblem(totalBytes: number): string | null {
  if (totalBytes <= MAILBOX_ATTACHMENT_LIMIT_BYTES) return null;
  return `Attachments come to ${formatMegabytes(totalBytes)}; one email can carry ${formatMegabytes(MAILBOX_ATTACHMENT_LIMIT_BYTES)}.`;
}

/**
 * The HTML part for what the rep wrote. The rich editor already emits HTML;
 * an AI draft or a template lands in the box as plain text, and that used to
 * be sent with only its newlines turned into <br/> — so a typed "<" or "&"
 * went out as markup (O59). Plain text is escaped now, through the same
 * conversion the editors use.
 */
export function composeBodyHtml(body: string): string {
  return isHtmlBody(body) ? body : plainTextToHtml(body);
}

export type ThreadMessage = {
  messageId: string;
  fromEmail: string;
  toEmail: string;
  ccEmail?: string;
  references?: string;
};

const sameAddress = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Who a Reply goes to, and the threading headers.
 *
 * It answered the LAST message's sender, so in a thread whose last message
 * was the rep's own, Reply addressed the rep (O35). It now answers the last
 * message someone else sent; a thread with only the rep's own messages is a
 * follow-up, addressed to whoever the last one went to.
 *
 * References is the parent's References plus the parent's id (RFC 5322
 * 3.6.4). It carried the parent's References alone, which drops the message
 * being replied to from the chain.
 */
export function replyAddressing(
  messages: ThreadMessage[],
  ownEmail: string | null | undefined,
): { to: string; inReplyTo: string | undefined; references: string | undefined } | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  const fromOther = [...messages].reverse().find((m) => !sameAddress(m.fromEmail, ownEmail));
  const parent = fromOther ?? last;
  const to = fromOther ? fromOther.fromEmail : last.toEmail || last.fromEmail;
  const chain = [parent.references, parent.messageId].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  return { to, inReplyTo: parent.messageId || undefined, references: chain || undefined };
}

export type ForwardedOriginal = {
  fromName?: string | null;
  fromEmail: string;
  toEmail?: string | null;
  ccEmail?: string | null;
  /** Already formatted for the reader, e.g. toLocaleString(). */
  dateLabel: string;
  subject: string;
  /** The original's HTML, already sanitised by the caller; empty if it had none. */
  bodyHtml?: string | null;
  bodyText?: string | null;
};

/**
 * The original message, quoted under the rep's note (O35). Forward used to
 * send only what the rep typed: the original was shown in the dialog as a
 * preview and left out of the email.
 */
export function forwardedBlock(o: ForwardedOriginal): { html: string; text: string } {
  const from = o.fromName ? `${o.fromName} <${o.fromEmail}>` : o.fromEmail;
  const headers: Array<[string, string]> = [
    ["From", from],
    ["Date", o.dateLabel],
    ["Subject", o.subject],
  ];
  if (o.toEmail) headers.push(["To", o.toEmail]);
  if (o.ccEmail) headers.push(["Cc", o.ccEmail]);
  const original = o.bodyHtml?.trim()
    ? o.bodyHtml
    : plainTextToHtml(o.bodyText ?? "");
  const html =
    `<div style="margin-top:18px">` +
    `<p style="margin:0 0 8px;color:#555">---------- Forwarded message ----------</p>` +
    headers.map(([k, v]) => `<div style="color:#555">${k}: ${escapeHtml(v)}</div>`).join("") +
    `<div style="margin-top:12px">${original}</div>` +
    `</div>`;
  const text =
    `\n\n---------- Forwarded message ----------\n` +
    headers.map(([k, v]) => `${k}: ${v}`).join("\n") +
    `\n\n${o.bodyText ?? ""}`;
  return { html, text };
}
