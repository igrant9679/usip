/**
 * mailbox.ts — tRPC router for Rep Mailbox (Feature 73)
 *
 * Procedures:
 *   mailbox.listAccounts  — list sending accounts with IMAP configured for this rep
 *   mailbox.listFolders   — list folders/labels for an account
 *   mailbox.listThreads   — paginated thread list for a folder
 *   mailbox.getThread     — full message list for a thread
 *   mailbox.sendNew       — compose and send a new email
 *   mailbox.sendReply     — reply to an existing thread
 *   mailbox.markRead      — mark a message read/unread
 *   mailbox.moveToTrash   — move a message to trash
 *
 * Manager access: managers/admins can pass repUserId to view another rep's mailbox.
 */

import { z } from "zod";
import { router } from "../_core/trpc";
import { workspaceProcedure, managerProcedure, roleRank } from "../_core/workspace";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { sendingAccounts } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { createEmailAdapter } from "../emailAdapter";
import { invokeLLM } from "../_core/llm";

/** Resolve which userId to operate as (managers can view rep inboxes) */
function resolveTargetUser(
  ctx: { user: { id: number }; member: { role: string } },
  repUserId?: number,
): number {
  if (!repUserId || repUserId === ctx.user.id) return ctx.user.id;
  // Only managers/admins can view other reps
  if (roleRank(ctx.member.role as any) < roleRank("manager")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only managers can view other reps' mailboxes" });
  }
  return repUserId;
}

/** Get a sending account by id, verifying it belongs to the workspace */
async function getAccount(accountId: number, workspaceId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const [acc] = await db
    .select()
    .from(sendingAccounts)
    .where(and(eq(sendingAccounts.id, accountId), eq(sendingAccounts.workspaceId, workspaceId)));
  if (!acc) throw new TRPCError({ code: "NOT_FOUND", message: "Sending account not found" });
  return acc;
}

export const mailboxRouter = router({
  /** List sending accounts that have inbox access (IMAP configured) */
  listAccounts: workspaceProcedure
    .input(z.object({ repUserId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      // repUserId is accepted for API compatibility but sending_accounts has no userId column;
      // all accounts in the workspace are shown (filtered by IMAP/OAuth capability below).
      resolveTargetUser(ctx, input.repUserId); // permission check only
      const db = await getDb();
      if (!db) return [];
      const accounts = await db
        .select({
          id: sendingAccounts.id,
          name: sendingAccounts.name,
          email: sendingAccounts.fromEmail,
          provider: sendingAccounts.provider,
          hasImap: sendingAccounts.imapHost,
          hasOauth: sendingAccounts.oauthAccessToken,
        })
        .from(sendingAccounts)
        .where(
          eq(sendingAccounts.workspaceId, ctx.workspace.id)
        );
      return accounts
        .filter((a) => !!a.hasImap)
        .map((a) => ({
          id: a.id,
          name: a.name,
          email: a.email,
          provider: a.provider,
          inboxEnabled: true,
        }));
    }),

  /** List folders/labels for an account */
  listFolders: workspaceProcedure
    .input(z.object({ accountId: z.number(), repUserId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      resolveTargetUser(ctx, input.repUserId);
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const adapter = createEmailAdapter(acc);
      return adapter.listFolders();
    }),

  /** List threads in a folder (paginated) */
  listThreads: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      folder: z.string().default("INBOX"),
      pageToken: z.string().optional(),
      maxResults: z.number().min(1).max(100).default(50),
      repUserId: z.number().optional(),
    }))
    .query(async ({ ctx, input }) => {
      resolveTargetUser(ctx, input.repUserId);
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const adapter = createEmailAdapter(acc);
      return adapter.listThreads(input.folder, input.pageToken, input.maxResults);
    }),

  /** Get all messages in a thread */
  getThread: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      threadId: z.string(),
      folder: z.string().default("INBOX"),
      repUserId: z.number().optional(),
    }))
    .query(async ({ ctx, input }) => {
      resolveTargetUser(ctx, input.repUserId);
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const adapter = createEmailAdapter(acc);
      return adapter.getThread(input.threadId, input.folder);
    }),

  /** Send a new email */
  sendNew: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      to: z.string().email(),
      subject: z.string().min(1),
      bodyHtml: z.string(),
      bodyText: z.string().optional(),
      cc: z.string().optional(),
      bcc: z.string().optional(),
      attachments: z.array(z.object({
        filename: z.string(),
        contentType: z.string(),
        content: z.string(), // base64
      })).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const adapter = createEmailAdapter(acc);
      return adapter.sendEmail({
        fromEmail: acc.fromEmail,
        fromName: acc.fromName ?? acc.name,
        to: input.to,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        bodyText: input.bodyText,
        cc: input.cc,
        bcc: input.bcc,
        attachments: input.attachments,
      });
    }),

  /** Reply to an existing thread */
  sendReply: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      threadId: z.string(),
      inReplyTo: z.string().optional(),
      references: z.string().optional(),
      to: z.string(),
      subject: z.string(),
      bodyHtml: z.string(),
      bodyText: z.string().optional(),
      cc: z.string().optional(),
      attachments: z.array(z.object({
        filename: z.string(),
        contentType: z.string(),
        content: z.string(), // base64
      })).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const adapter = createEmailAdapter(acc);
      return adapter.sendEmail({
        fromEmail: acc.fromEmail,
        fromName: acc.fromName ?? acc.name,
        to: input.to,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        bodyText: input.bodyText,
        cc: input.cc,
        inReplyTo: input.inReplyTo,
        references: input.references,
        replyToThreadId: input.threadId,
        attachments: input.attachments,
      });
    }),

  /** Mark a message read or unread */
  markRead: workspaceProcedure
    .input(z.object({ accountId: z.number(), messageId: z.string(), read: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const adapter = createEmailAdapter(acc);
      await adapter.markRead(input.messageId, input.read);
      return { ok: true };
    }),

  /** Move a message to trash */
  moveToTrash: workspaceProcedure
    .input(z.object({ accountId: z.number(), messageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const adapter = createEmailAdapter(acc);
      await adapter.moveToTrash(input.messageId);
      return { ok: true };
    }),

  /** Move a message to a specific folder/label */
  moveToFolder: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      messageId: z.string(),
      destFolder: z.string(),
      currentFolder: z.string().default("INBOX"),
    }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const adapter = createEmailAdapter(acc);
      await adapter.moveToFolder(input.messageId, input.destFolder, input.currentFolder);
      return { ok: true };
    }),

  /** AI-draft a reply to a thread */
  aiDraftReply: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      messages: z.array(z.object({
        fromEmail: z.string(),
        fromName: z.string().optional(),
        toEmail: z.string().optional(),
        subject: z.string(),
        bodyText: z.string(),
        date: z.string().optional(),
      })),
      senderName: z.string().optional(),
      senderEmail: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const senderName = input.senderName ?? acc.fromName ?? acc.name ?? "";
      const senderEmail = input.senderEmail ?? acc.fromEmail;
      const threadSummary = input.messages
        .map((m, i) => `[Message ${i + 1}] From: ${m.fromName || m.fromEmail} <${m.fromEmail}>\nSubject: ${m.subject}\n${m.bodyText?.slice(0, 800) ?? ""}`)
        .join("\n\n---\n\n");
      const res = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are a professional sales representative named ${senderName} (${senderEmail}). Draft a concise, professional, and friendly reply to the email thread below. Write only the body of the reply — no subject line, no signature placeholder. Keep it under 150 words unless the thread requires more detail. Do not include any preamble like "Here is a draft reply:".`,
          },
          { role: "user", content: `Email thread:\n\n${threadSummary}` },
        ],
      });
      const body = (res as any)?.choices?.[0]?.message?.content ?? "";
      return { body };
    }),

  /** AI-draft a forward intro for a message */
  aiDraftForward: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      originalMessage: z.object({
        fromEmail: z.string(),
        fromName: z.string().optional(),
        subject: z.string(),
        bodyText: z.string(),
        date: z.string().optional(),
      }),
      senderName: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const senderName = input.senderName ?? acc.fromName ?? acc.name ?? "";
      const msg = input.originalMessage;
      const res = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are a professional sales representative named ${senderName}. Write a brief, professional forwarding introduction (2-3 sentences) to accompany the email below when forwarding it to a colleague or prospect. Write only the intro text — no subject line, no signature. Do not include any preamble like "Here is a draft:".`,
          },
          {
            role: "user",
            content: `Original email from ${msg.fromName || msg.fromEmail} <${msg.fromEmail}>:\nSubject: ${msg.subject}\n\n${msg.bodyText?.slice(0, 800) ?? ""}`,
          },
        ],
      });
      const body = (res as any)?.choices?.[0]?.message?.content ?? "";
      return { body };
    }),

  /** Search threads across a folder */
  searchThreads: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      query: z.string().min(1),
      folder: z.string().default("INBOX"),
      maxResults: z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const adapter = createEmailAdapter(acc);
      return adapter.searchThreads(input.query, input.folder, input.maxResults);
    }),

  /** Download an attachment by messageId + attachmentId */
  getAttachment: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      messageId: z.string(),
      attachmentId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const adapter = createEmailAdapter(acc);
      const { data, contentType, filename } = await adapter.getAttachment(input.messageId, input.attachmentId);
      // Return as base64 so it can be decoded in the browser
      return { dataBase64: data.toString("base64"), contentType, filename };
    }),
});
