/**
 * Streaming AI draft routes for mailbox compose.
 *
 *   POST /api/mailbox/draft-reply/stream
 *     Body: { accountId, messages: [{fromEmail, fromName?, toEmail?, subject, bodyText, date?}], senderName?, senderEmail? }
 *     Returns: text/event-stream
 *
 *   POST /api/mailbox/draft-forward/stream
 *     Body: { accountId, originalMessage: {fromEmail, fromName?, subject, bodyText, date?}, senderName? }
 *     Returns: text/event-stream
 *
 * Mirrors the prompt-building logic of `mailbox.aiDraftReply` /
 * `mailbox.aiDraftForward` in server/routers/mailbox.ts:230-300. Built on
 * the shared runSSEStream helper — just declares input validation +
 * prompt construction.
 */
import type { Express, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { sendingAccounts } from "../drizzle/schema";
import { runSSEStream } from "./_core/streamHelpers";

type Msg = {
  fromEmail: string;
  fromName?: string;
  toEmail?: string;
  subject: string;
  bodyText: string;
  date?: string;
};

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function parseThreadMessages(raw: unknown): Msg[] {
  if (!Array.isArray(raw)) throw new Error("messages must be an array");
  return raw.map((m, i) => {
    if (typeof m !== "object" || m === null) {
      throw new Error(`messages[${i}] must be an object`);
    }
    const o = m as Record<string, unknown>;
    if (typeof o.fromEmail !== "string" || typeof o.subject !== "string" || typeof o.bodyText !== "string") {
      throw new Error(`messages[${i}] missing fromEmail/subject/bodyText`);
    }
    return {
      fromEmail: o.fromEmail,
      fromName: asStr(o.fromName),
      toEmail: asStr(o.toEmail),
      subject: o.subject,
      bodyText: o.bodyText,
      date: asStr(o.date),
    };
  });
}

function parseOriginalMessage(raw: unknown): Msg {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("originalMessage must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.fromEmail !== "string" || typeof o.subject !== "string" || typeof o.bodyText !== "string") {
    throw new Error("originalMessage missing fromEmail/subject/bodyText");
  }
  return {
    fromEmail: o.fromEmail,
    fromName: asStr(o.fromName),
    subject: o.subject,
    bodyText: o.bodyText,
    date: asStr(o.date),
  };
}

export function registerMailboxStreamRoutes(app: Express) {
  app.post("/api/mailbox/draft-reply/stream", (req: Request, res: Response) =>
    runSSEStream(req, res, {
      async buildMessages({ workspaceId, db }) {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const accountId = Number(body.accountId);
        if (!Number.isFinite(accountId)) throw new Error("accountId required");

        const [acc] = await db
          .select()
          .from(sendingAccounts)
          .where(
            and(
              eq(sendingAccounts.id, accountId),
              eq(sendingAccounts.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        if (!acc) throw new Error("Sending account not found");

        const messages = parseThreadMessages(body.messages);
        const senderName = asStr(body.senderName) ?? acc.fromName ?? acc.name ?? "";
        const senderEmail = asStr(body.senderEmail) ?? acc.fromEmail;

        const threadSummary = messages
          .map(
            (m, i) =>
              `[Message ${i + 1}] From: ${m.fromName || m.fromEmail} <${m.fromEmail}>\nSubject: ${m.subject}\n${m.bodyText.slice(0, 800)}`,
          )
          .join("\n\n---\n\n");

        return {
          messages: [
            {
              role: "system",
              content: `You are a professional sales representative named ${senderName} (${senderEmail}). Draft a concise, professional, and friendly reply to the email thread below. Write only the body of the reply — no subject line, no signature placeholder. Keep it under 150 words unless the thread requires more detail. Do not include any preamble like "Here is a draft reply:".`,
            },
            { role: "user", content: `Email thread:\n\n${threadSummary}` },
          ],
        };
      },
    }),
  );

  app.post("/api/mailbox/draft-forward/stream", (req: Request, res: Response) =>
    runSSEStream(req, res, {
      async buildMessages({ workspaceId, db }) {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const accountId = Number(body.accountId);
        if (!Number.isFinite(accountId)) throw new Error("accountId required");

        const [acc] = await db
          .select()
          .from(sendingAccounts)
          .where(
            and(
              eq(sendingAccounts.id, accountId),
              eq(sendingAccounts.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        if (!acc) throw new Error("Sending account not found");

        const original = parseOriginalMessage(body.originalMessage);
        const senderName = asStr(body.senderName) ?? acc.fromName ?? acc.name ?? "";

        const threadSummary = `From: ${original.fromName || original.fromEmail} <${original.fromEmail}>\nSubject: ${original.subject}\n${original.bodyText.slice(0, 1000)}`;

        return {
          messages: [
            {
              role: "system",
              content: `You are a professional sales representative named ${senderName}. Write a brief, professional forwarding introduction (2-3 sentences) to accompany the email below when forwarding it to a colleague or prospect. Write only the intro text — no subject line, no signature. Do not include any preamble like "Here is a draft:".`,
            },
            { role: "user", content: `Email to forward:\n\n${threadSummary}` },
          ],
        };
      },
    }),
  );
}
