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
  /**
   * Extra RFC 5322 headers. Used for List-Unsubscribe and
   * List-Unsubscribe-Post (RFC 8058), which Gmail and Yahoo require of bulk
   * senders and which is what makes a mail client's own Unsubscribe button
   * reach us instead of becoming an invisible spam complaint.
   */
  headers?: Record<string, string> | null;
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
  // SendGrid rejects an empty headers object, so only send one when populated.
  if (msg.headers && Object.keys(msg.headers).length > 0) payload.headers = { ...msg.headers };
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
    // api.sendgrid.COM — the .net domain is SendGrid's SMTP/link-tracking
    // domain and does not serve the Web API at all (the connection fails
    // before HTTP). With .net here every send failed as "request failed".
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
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
    const res = await fetch("https://api.sendgrid.com/v3/scopes", {
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

/* ─── verified senders ──────────────────────────────────────────────────── */

export interface SendGridSender {
  /** The address mail is sent FROM. The identity, and our dedupe key. */
  email: string;
  name: string | null;
  replyTo: string | null;
  /** SendGrid's own label for the identity, shown to help the owner recognise it. */
  nickname: string | null;
  /** False for an identity that exists but has not completed verification. */
  verified: boolean;
}

/**
 * A listing either happened or it didn't — never both collapsed into `[]`.
 * (Same rule as the brand provider: an empty list is a real answer, a 401 is
 * not, and a caller that cannot tell them apart will show "no senders" for a
 * key that simply lacks a scope.)
 */
export type SendGridSenderList =
  | { ok: true; senders: SendGridSender[] }
  | { ok: false; error: string };

const asStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Normalize the two shapes SendGrid returns for a sender identity. */
function toSender(raw: Record<string, unknown>): SendGridSender | null {
  // /v3/verified_senders → flat: { from_email, from_name, reply_to, nickname, verified }
  // /v3/senders          → nested: { from: { email, name }, reply_to: { email }, verified }
  const from = (raw.from ?? null) as Record<string, unknown> | null;
  const email = asStr(raw.from_email) ?? asStr(from?.email);
  if (!email) return null;
  const replyToRaw = raw.reply_to;
  const replyTo = asStr(replyToRaw) ?? asStr((replyToRaw as Record<string, unknown> | null)?.email);
  const verifiedRaw = raw.verified;
  const verified = typeof verifiedRaw === "boolean"
    ? verifiedRaw
    : (verifiedRaw as Record<string, unknown> | null)?.status === true;
  return {
    email: email.toLowerCase(),
    name: asStr(raw.from_name) ?? asStr(from?.name),
    replyTo: replyTo ? replyTo.toLowerCase() : null,
    nickname: asStr(raw.nickname),
    verified,
  };
}

/**
 * Every sender identity this key can send from.
 *
 * Two endpoints, because SendGrid moved: `/v3/verified_senders` is the current
 * Sender Verification list, `/v3/senders` the legacy Marketing one. Accounts
 * commonly have identities under only one, and a restricted key may be scoped
 * to only one, so we ask both and merge by address. A 403 from one is NOT a
 * failure while the other answers — only both failing is.
 */
export async function listSendGridSenders(apiKey: string): Promise<SendGridSenderList> {
  const key = apiKey?.trim();
  if (!key) return { ok: false, error: "API key is required" };

  // THREE endpoints, because SendGrid has moved twice and which one answers
  // depends on the account's plan and provisioning, not on the key:
  //   /v3/verified_senders  — current Sender Verification list
  //   /v3/marketing/senders — Marketing Campaigns (new)
  //   /v3/senders           — Marketing Campaigns (legacy, commonly 403s)
  // Any one answering is a success; only all three failing is a failure.
  const endpoints = [
    { name: "verified_senders", url: "https://api.sendgrid.com/v3/verified_senders", pick: (b: unknown) => (b as { results?: unknown[] })?.results },
    { name: "marketing/senders", url: "https://api.sendgrid.com/v3/marketing/senders", pick: (b: unknown) => (b as { results?: unknown[] })?.results ?? (Array.isArray(b) ? b : undefined) },
    { name: "senders", url: "https://api.sendgrid.com/v3/senders", pick: (b: unknown) => (Array.isArray(b) ? b : (b as { results?: unknown[] })?.results) },
  ];

  const byEmail = new Map<string, SendGridSender>();
  const failures: string[] = [];
  let answered = false;
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, { headers: { Authorization: `Bearer ${key}` } });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        failures.push(`${ep.name} → ${res.status} ${describeSendGridError(res.status, body)}`);
        continue;
      }
      const body = await res.json().catch(() => null);
      const rows = ep.pick(body);
      if (!Array.isArray(rows)) { failures.push(`${ep.name} → 200 but an unexpected response shape`); continue; }
      answered = true;
      for (const r of rows) {
        const s = toSender((r ?? {}) as Record<string, unknown>);
        if (!s) continue;
        const prev = byEmail.get(s.email);
        if (!prev || (!prev.verified && s.verified)) byEmail.set(s.email, s);
      }
    } catch (e) {
      failures.push(`${ep.name} → could not reach SendGrid: ${(e as Error).message}`);
    }
  }

  if (answered) {
    return { ok: true, senders: Array.from(byEmail.values()).sort((a, b) => a.email.localeCompare(b.email)) };
  }

  // Nothing answered. Say WHICH endpoints failed and what the key can actually
  // do — "access forbidden, check your scopes" with no scope list sends people
  // hunting through SendGrid for a permission they may already have.
  let scopeNote = "";
  try {
    const res = await fetch("https://api.sendgrid.com/v3/scopes", { headers: { Authorization: `Bearer ${key}` } });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { scopes?: string[] } | null;
      const scopes = Array.isArray(body?.scopes) ? body!.scopes! : [];
      const senderScopes = scopes.filter((x) => /sender/i.test(x));
      scopeNote = senderScopes.length
        ? ` The key does carry ${senderScopes.slice(0, 6).join(", ")}, so this may be a plan/provisioning limit rather than the key.`
        : ` The key reports ${scopes.length} scopes and none of them mention senders — reissue it as Full Access, or add Sender Verification read.`;
    } else {
      scopeNote = ` The key also could not read /v3/scopes (${res.status}), so it may be invalid or revoked.`;
    }
  } catch { /* diagnosis is best-effort */ }

  return { ok: false, error: `SendGrid would not list senders. ${failures.join(" · ")}.${scopeNote}` };
}

/**
 * Domains SendGrid has authenticated for this account.
 *
 * An account set up with Domain Authentication (rather than Single Sender
 * Verification) has NO sender identities to list — any address at the domain
 * may send. Without this the sender picker correctly reports "no senders" and
 * the owner is stuck, because the thing they configured does not appear in
 * the API the picker was reading.
 */
export type SendGridDomainList =
  | { ok: true; domains: string[] }
  | { ok: false; error: string };

/**
 * The full DNS record set SendGrid requires for each authenticated domain —
 * exact host/type/value rows straight from `/v3/whitelabel/domains`, never
 * templates. Unlike listSendGridAuthenticatedDomains this keeps INVALID
 * domains too: a domain whose DNS is missing is precisely the one the owner
 * needs the records for (Home's "Authenticate domains" nudge, owner ask
 * 2026-09-02: "the exact DNS record values for each email").
 */
export type SendGridDomainDns =
  | { ok: true; domains: Array<{ domain: string; valid: boolean; records: Array<{ type: string; host: string; data: string; valid: boolean }> }> }
  | { ok: false; error: string };

export async function listSendGridDomainDns(apiKey: string): Promise<SendGridDomainDns> {
  const key = apiKey?.trim();
  if (!key) return { ok: false, error: "API key is required" };
  try {
    const res = await fetch("https://api.sendgrid.com/v3/whitelabel/domains?limit=100", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { ok: false, error: describeSendGridError(res.status, body) };
    }
    const body = await res.json().catch(() => null);
    if (!Array.isArray(body)) return { ok: false, error: "SendGrid returned an unexpected response shape" };
    const domains = body.flatMap((d) => {
      const r = d as Record<string, unknown>;
      const domain = typeof r.domain === "string" ? r.domain.trim().toLowerCase() : "";
      if (!domain) return [];
      // `dns` is an object whose keys vary by setup (mail_cname/dkim1/dkim2
      // for automated security; mail_server/subdomain_spf/dkim for legacy).
      // Render whatever SendGrid sent rather than assuming a shape.
      const dns = (r.dns && typeof r.dns === "object" ? r.dns : {}) as Record<string, unknown>;
      const records = Object.values(dns).flatMap((rec) => {
        const x = rec as Record<string, unknown>;
        if (typeof x?.host !== "string" || typeof x?.data !== "string") return [];
        return [{
          type: String(x.type ?? "cname").toUpperCase(),
          host: x.host,
          data: x.data,
          valid: x.valid === true || x.valid === "true",
        }];
      });
      return [{ domain, valid: r.valid === true || r.valid === "true", records }];
    });
    return { ok: true, domains };
  } catch (e) {
    return { ok: false, error: `Could not reach SendGrid: ${(e as Error).message}` };
  }
}

export async function listSendGridAuthenticatedDomains(apiKey: string): Promise<SendGridDomainList> {
  const key = apiKey?.trim();
  if (!key) return { ok: false, error: "API key is required" };
  try {
    const res = await fetch("https://api.sendgrid.com/v3/whitelabel/domains?limit=100", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { ok: false, error: describeSendGridError(res.status, body) };
    }
    const body = await res.json().catch(() => null);
    if (!Array.isArray(body)) return { ok: false, error: "SendGrid returned an unexpected response shape" };
    const domains = body
      // `valid` is SendGrid's own word for "DNS is in place and it works".
      .filter((d) => (d as { valid?: unknown })?.valid === true || (d as { valid?: unknown })?.valid === "true")
      .map((d) => {
        const r = d as Record<string, unknown>;
        // The ROOT domain, not `subdomain.domain`. SendGrid's `subdomain`
        // ("em7171") is only the CNAME host carrying its DKIM/return-path
        // records — nobody sends from it. Authenticating cforcefederal.com
        // permits any address AT cforcefederal.com, which is the whole point
        // of Domain Authentication. Building "em7171.cforcefederal.com" and
        // matching against it rejects every real address on the domain.
        return typeof r.domain === "string" && r.domain.trim() ? r.domain.trim().toLowerCase() : null;
      })
      .filter((d): d is string => !!d);
    return { ok: true, domains: Array.from(new Set(domains)).sort() };
  } catch (e) {
    return { ok: false, error: `Could not reach SendGrid: ${(e as Error).message}` };
  }
}
