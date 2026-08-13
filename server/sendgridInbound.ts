/**
 * SendGrid Inbound Parse → Velocity replies (owner ask 2026-08-13: "replies
 * populate only in Velocity, not the From address's inbox").
 *
 * A SendGrid API key has no mailbox — replies used to require a human
 * Reply-To inbox that then filled up. Instead: sends carry
 * `Reply-To: r-{token}@{inbound domain}`; the subdomain's MX record points
 * at `mx.sendgrid.net`; SendGrid's Inbound Parse POSTs each message here as
 * multipart/form-data; and the reply flows through processInboundReply —
 * the SAME pipeline the mailbox pollers feed, so the Unified Inbox,
 * reply classification, notifications, ARE signals, and pause-on-reply all
 * fire identically. No human inbox is involved anywhere.
 *
 * SECURITY MODEL. Inbound Parse cannot sign its posts, so the endpoint is
 * public by necessity. The unguessable token IN THE RECIPIENT ADDRESS is
 * the authentication: a post whose recipient doesn't carry a live token is
 * dropped (200, silently — never confirm or deny a token to a prober).
 * Always 200 unless the request is malformed: SendGrid retries non-2xx for
 * hours and then DISABLES the webhook, which would silently lose replies.
 *
 * DEDUP: SendGrid retries and mailing lists resend — a reply whose
 * Message-ID is already stored for the workspace is acknowledged and
 * skipped.
 */
import type { Express, Request, Response } from "express";
import Busboy from "busboy";
import { simpleParser } from "mailparser";
import { and, eq } from "drizzle-orm";
import { emailReplies, sendingAccounts, workspaceSettings } from "../drizzle/schema";
import { getDb } from "./db";

/** The Reply-To local part: r-{token}. Exported for the adapter + tests. */
export function inboundReplyAddress(token: string, domain: string): string {
  return `r-${token}@${domain}`;
}

/** Pull the token out of any recipient shaped like r-{token}@host. */
export function tokenFromRecipient(recipient: string): string | null {
  const m = /(?:^|<|,|\s)r-([a-z0-9]{16,64})@/i.exec(recipient);
  return m ? m[1]!.toLowerCase() : null;
}

/** Collect Inbound Parse's multipart fields (bounded — never buffer files). */
function readForm(req: Request): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    const bb = Busboy({ headers: req.headers, limits: { fieldSize: 25 * 1024 * 1024, files: 0 } });
    bb.on("field", (name, value) => { fields[name] = value; });
    // Attachments arrive as files when "send raw" is off — drain, keep nothing.
    bb.on("file", (_n, stream) => { stream.resume(); });
    bb.on("close", () => resolve(fields));
    bb.on("error", reject);
    req.pipe(bb);
  });
}

export function registerSendGridInboundRoute(app: Express): void {
  app.post("/api/sendgrid/inbound", async (req: Request, res: Response) => {
    try {
      const fields = await readForm(req);

      // Recipient: envelope.to is authoritative; fall back to the To header.
      let recipient = "";
      try {
        const env = JSON.parse(fields.envelope ?? "{}") as { to?: string[] };
        recipient = env.to?.[0] ?? "";
      } catch { /* header fallback below */ }
      if (!recipient) recipient = fields.to ?? "";
      const token = tokenFromRecipient(recipient);
      if (!token) { res.status(200).send("ok"); return; }

      const db = await getDb();
      if (!db) { res.status(200).send("ok"); return; }
      const [ws] = await db
        .select({ workspaceId: workspaceSettings.workspaceId, domain: workspaceSettings.sendgridInboundDomain })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.sendgridInboundToken, token))
        .limit(1);
      if (!ws) { res.status(200).send("ok"); return; }

      // Parse the message. "Send raw" config posts the full MIME in `email`;
      // the parsed config posts discrete fields. Support both.
      let fromEmail = "", fromName = "", subject = "", bodyText = "", bodyHtml = "";
      let messageId = "", inReplyTo = "", references = "";
      if (fields.email) {
        const parsed = await simpleParser(fields.email);
        fromEmail = parsed.from?.value?.[0]?.address ?? "";
        fromName = parsed.from?.value?.[0]?.name ?? "";
        subject = parsed.subject ?? "";
        bodyText = parsed.text ?? "";
        bodyHtml = typeof parsed.html === "string" ? parsed.html : "";
        messageId = parsed.messageId ?? "";
        inReplyTo = parsed.inReplyTo ?? "";
        references = Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references ?? "");
      } else {
        const fromRaw = fields.from ?? "";
        const m = /^\s*(?:"?([^"<]*)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?\s*$/.exec(fromRaw);
        fromName = (m?.[1] ?? "").trim();
        fromEmail = (m?.[2] ?? "").trim();
        subject = fields.subject ?? "";
        bodyText = fields.text ?? "";
        bodyHtml = fields.html ?? "";
        const headers = fields.headers ?? "";
        messageId = /^message-id:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? "";
        inReplyTo = /^in-reply-to:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? "";
        references = /^references:\s*(.+)$/im.exec(headers)?.[1]?.trim() ?? "";
      }
      if (!fromEmail) { res.status(200).send("ok"); return; }

      // Loop guard: our own reply address, or an empty sender, never ingests.
      if (tokenFromRecipient(fromEmail)) { res.status(200).send("ok"); return; }

      // Dedup on Message-ID within the workspace (SendGrid retries).
      if (messageId) {
        const [dup] = await db.select({ id: emailReplies.id }).from(emailReplies)
          .where(and(eq(emailReplies.workspaceId, ws.workspaceId), eq(emailReplies.messageId, messageId)))
          .limit(1);
        if (dup) { res.status(200).send("ok"); return; }
      }

      // Attribute to the workspace's SendGrid sending account (the sender
      // whose campaigns carry this Reply-To), falling back to any enabled
      // account so a reply is never dropped for bookkeeping reasons. The
      // notification recipient is the workspace's standing notify user —
      // sending accounts carry no user of their own.
      const accounts = await db
        .select({ id: sendingAccounts.id, hasSg: sendingAccounts.sendgridApiKeyEnc })
        .from(sendingAccounts)
        .where(and(eq(sendingAccounts.workspaceId, ws.workspaceId), eq(sendingAccounts.enabled, true)))
        .orderBy(sendingAccounts.id);
      const account = accounts.find((a) => !!a.hasSg) ?? accounts[0];
      if (!account) { res.status(200).send("ok"); return; }
      const { workspaceNotifyUserId } = await import("./_core/activeMembers");
      const notifyUserId = await workspaceNotifyUserId(ws.workspaceId);

      const { processInboundReply } = await import("./inboundReplyPoller");
      await processInboundReply({
        workspaceId: ws.workspaceId,
        sendingAccountId: account.id,
        userId: notifyUserId ?? undefined,
        fromEmail: fromEmail.toLowerCase(),
        fromName,
        subject,
        bodyText,
        bodyHtml,
        messageId,
        inReplyTo,
        references,
        receivedAt: new Date(),
      });
      res.status(200).send("ok");
    } catch (e) {
      // Malformed multipart is the only 4xx: SendGrid gives up on repeated
      // 4xx for THAT message only, which is correct for garbage.
      console.error("[sendgridInbound] failed:", (e as Error).message);
      res.status(400).send("bad request");
    }
  });
}
