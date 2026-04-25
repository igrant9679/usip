/**
 * emailDelivery.ts
 *
 * Shared helper for sending transactional emails (invites, notifications,
 * expiry warnings, pipeline alerts) via the workspace's configured SMTP
 * delivery settings (smtp_configs table / Settings → Email Delivery).
 *
 * This is intentionally separate from the sendingAccounts table, which is
 * used for outbound sales sequences via Unipile/IMAP.
 *
 * Usage:
 *   const result = await sendWorkspaceEmail(workspaceId, {
 *     to: "alice@acme.com",
 *     subject: "You've been invited",
 *     html: "<p>…</p>",
 *   });
 *   if (!result.ok) console.warn("Email not sent:", result.reason);
 */

import { eq } from "drizzle-orm";
import { smtpConfigs } from "../drizzle/schema";
import { getDb } from "./db";
import { buildTransporter, decrypt } from "./routers/smtpConfig";

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  reason?: string;
}

/**
 * Send a transactional email using the workspace's Email Delivery SMTP config.
 *
 * Returns { ok: true } on success.
 * Returns { ok: false, reason } if no SMTP config is set, config is disabled,
 * or the send fails — callers should treat this as non-fatal.
 */
export async function sendWorkspaceEmail(
  workspaceId: number,
  opts: SendEmailOptions,
): Promise<SendEmailResult> {
  try {
    const db = await getDb();
    if (!db) return { ok: false, reason: "DB unavailable" };

    const [cfg] = await db
      .select()
      .from(smtpConfigs)
      .where(eq(smtpConfigs.workspaceId, workspaceId));

    if (!cfg) return { ok: false, reason: "No SMTP config found for workspace" };
    if (!cfg.enabled) return { ok: false, reason: "SMTP delivery is disabled for this workspace" };
    if (!cfg.host || !cfg.username || !cfg.encryptedPassword) {
      return { ok: false, reason: "Incomplete SMTP config (missing host, username, or password)" };
    }

    let password: string;
    try {
      password = decrypt(cfg.encryptedPassword);
    } catch {
      return { ok: false, reason: "Failed to decrypt SMTP password" };
    }

    const transporter = buildTransporter({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      username: cfg.username,
      password,
    });

    const fromName = cfg.fromName ?? cfg.username;
    const fromEmail = cfg.fromEmail ?? cfg.username;

    await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: Array.isArray(opts.to) ? opts.to.join(", ") : opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      replyTo: opts.replyTo ?? cfg.replyTo ?? undefined,
    });

    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `SMTP send failed: ${msg}` };
  }
}
