/**
 * SendGrid Web API v3 — the send path for a `sendgrid` sending account.
 *
 * The Web API rather than SendGrid's SMTP relay, deliberately:
 *   - no dependency on outbound port 587 surviving the host's egress rules,
 *   - structured per-message errors (SendGrid answers 4xx with a JSON `errors`
 *     array naming the field), where SMTP gives one opaque banner line,
 *   - one HTTPS call, so no connection pool to keep warm for a cron-driven
 *     sender that wakes up, sends a handful, and sleeps.
 *
 * SEND-ONLY, and that is not a limitation of this file. A SendGrid API key has
 * no mailbox behind it: there is nothing to poll for replies. A campaign sent
 * this way collects its replies at the `replyTo` address, which is only visible
 * to Velocity if that address belongs to a mailbox connected separately. The UI
 * says so where the key is entered — a campaign sender that silently loses
 * every reply would look finished and be broken.
 */

/** SendGrid rejects a whole request on one bad address, so validate before POSTing. */
const EMAIL_RE = /^[^\s@]+@[^\s@,]+\.[a-z]{2,}$/i;

export interface SendGridMessage {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  fromEmail: string;
  fromName?: string | null;
  replyTo?: string | null;
}

export interface SendGridResult {
  ok: boolean;
  /** SendGrid's per-message id from the X-Message-Id header, when it gives one. */
  messageId?: string;
  reason?: string;
}

/**
 * Build the v3 `mail/send` body. Pure and exported so the shape is testable
 * without a network call — the field names here are a contract with SendGrid,
 * and getting one wrong fails at runtime with a 400 nobody sees until a
 * campaign is already running.
 */
export function buildSendGridPayload(msg: SendGridMessage): Record<string, unknown> {
  const content: Array<{ type: string; value: string }> = [];
  // Order matters to SendGrid: text/plain MUST precede text/html, and it
  // rejects the request outright if they are swapped.
  if (msg.text) content.push({ type: "text/plain", value: msg.text });
  if (msg.html) content.push({ type: "text/html", value: msg.html });
  if (!content.length) content.push({ type: "text/plain", value: "" });

  const payload: Record<string, unknown> = {
    personalizations: [{ to: [{ email: msg.to }] }],
    from: msg.fromName ? { email: msg.fromEmail, name: msg.fromName } : { email: msg.fromEmail },
    subject: msg.subject,
    content,
  };
  if (msg.replyTo) payload.reply_to = { email: msg.replyTo };
  return payload;
}

/** Everything that must be true before we spend a send. Pure. */
export function validateSendGridMessage(msg: SendGridMessage): string | null {
  if (!msg.to || !EMAIL_RE.test(msg.to)) return `Invalid recipient address: ${msg.to || "(empty)"}`;
  if (!msg.fromEmail || !EMAIL_RE.test(msg.fromEmail)) return `Invalid From address: ${msg.fromEmail || "(empty)"}`;
  if (msg.replyTo && !EMAIL_RE.test(msg.replyTo)) return `Invalid Reply-To address: ${msg.replyTo}`;
  if (!msg.subject?.trim()) return "Subject is required";
  return null;
}

/**
 * Turn a SendGrid error body into one readable line.
 *
 * Their errors arrive as `{errors:[{message,field}]}` and the field is usually
 * the whole diagnosis ("from.email" = your sender isn't verified). Dropping it
 * turns a fixable problem into "send failed".
 */
export function describeSendGridError(status: number, body: unknown): string {
  const errs = (body as { errors?: Array<{ message?: string; field?: string }> } | null)?.errors;
  if (Array.isArray(errs) && errs.length) {
    return errs
      .slice(0, 3)
      .map((e) => (e.field ? `${e.field}: ${e.message ?? "invalid"}` : e.message ?? "invalid"))
      .join("; ")
      .slice(0, 300);
  }
  if (status === 401) return "SendGrid rejected the API key (401). Check the key and that it has Mail Send permission.";
  if (status === 403) return "SendGrid returned 403 — usually an unverified sender address or a key without Mail Send scope.";
  if (status === 429) return "SendGrid rate limit hit (429).";
  return `SendGrid returned HTTP ${status}`;
}

/** POST one message. Never throws — callers treat a failure as non-fatal. */
export async function sendViaSendGrid(apiKey: string, msg: SendGridMessage): Promise<SendGridResult> {
  const invalid = validateSendGridMessage(msg);
  if (invalid) return { ok: false, reason: invalid };
  if (!apiKey) return { ok: false, reason: "No SendGrid API key is configured for this account" };

  try {
    const res = await fetch("https://api.sendgrid.net/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildSendGridPayload(msg)),
    });
    // 202 Accepted is the success case; the body is empty.
    if (res.status === 202) {
      return { ok: true, messageId: res.headers.get("x-message-id") ?? undefined };
    }
    const body = await res.json().catch(() => null);
    return { ok: false, reason: describeSendGridError(res.status, body) };
  } catch (e) {
    return { ok: false, reason: `SendGrid request failed: ${(e as Error).message}` };
  }
}

/**
 * Check a key without sending anything.
 *
 * `/v3/scopes` is the cheapest authenticated endpoint and it also tells us
 * whether the key can actually send — a key that authenticates but lacks
 * `mail.send` passes a naive "is it valid" check and then fails on the first
 * real campaign, which is the worst time to find out.
 */
export async function verifySendGridKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  if (!apiKey?.trim()) return { ok: false, error: "API key is required" };
  try {
    const res = await fetch("https://api.sendgrid.net/v3/scopes", {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { ok: false, error: describeSendGridError(res.status, body) };
    }
    const body = (await res.json().catch(() => null)) as { scopes?: string[] } | null;
    const scopes = Array.isArray(body?.scopes) ? body!.scopes! : [];
    // Full-access keys report "mail.send"; restricted keys must be granted it.
    if (scopes.length && !scopes.some((s) => s === "mail.send" || s.startsWith("mail.send"))) {
      return { ok: false, error: "This key authenticates but has no Mail Send permission — it cannot send campaigns." };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Could not reach SendGrid: ${(e as Error).message}` };
  }
}
