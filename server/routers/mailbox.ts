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
import { sendingAccounts, unipileAccounts, users, workspaceSettings, emailReplies, unipileEmailsCache } from "../../drizzle/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { createEmailAdapter } from "../emailAdapter";
import { invokeLLM } from "../_core/llm";
import { researchUseForRecipient, threadCounterparty } from "../services/research/recipient";
import { assertSendAllowed } from "../sendLimits";
import { escapeHtml } from "@shared/escapeHtml";
import { isHtmlBody, htmlBodyToText } from "@shared/emailBody";
import { HUMAN_COPY_RULES, humanizeAiCopy } from "../services/humanCopy";
import { assertOutboundNotPausedFor, recipientAddresses } from "../services/outboundPause";
import { describeSuppression, findSuppression } from "../services/suppression";
import { attachmentLimitProblem, base64Bytes } from "@shared/mailCompose";
import { cachedMailboxRead, invalidateMailboxCache } from "../services/mailboxCache";

/**
 * Append the rep's email signature to outbound HTML / text if it isn't
 * already present in the body. Prefers the per-user override
 * (users.emailSignature) over the workspace default
 * (workspace_settings.emailSignature). Skips silently if no signature is
 * configured at either level.
 *
 * HTML rendering uses <br> between lines (not per-line <p>) so Outlook
 * doesn't add paragraph-spacing between each line of the signature —
 * sigs look right when they're tight. The outer <div> carries the
 * single ~18px gap that separates body from signature.
 */
async function appendSignature(
  workspaceId: number,
  userId: number,
  bodyHtml: string,
  bodyText: string | undefined,
): Promise<{ bodyHtml: string; bodyText: string | undefined }> {
  // The compose editor is Tiptap, and the client historically passed its HTML
  // as BOTH parts — so the text/plain alternative was raw markup. Normalize
  // here, at the one seam every mailbox send passes through.
  if (isHtmlBody(bodyText)) bodyText = htmlBodyToText(bodyText!);
  const db = await getDb();
  if (!db) return { bodyHtml, bodyText };
  const [userRow] = await db
    .select({ emailSignature: users.emailSignature })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const userSig = (userRow?.emailSignature ?? "").trim();
  let sig = userSig;
  if (!sig) {
    const [ws] = await db
      .select({ emailSignature: workspaceSettings.emailSignature })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);
    sig = (ws?.emailSignature ?? "").trim();
  }
  if (!sig) return { bodyHtml, bodyText };
  // Already present (rough check — the user pasted it manually, or a
  // template already contains it). Don't double-append.
  if (bodyHtml.includes(sig) || (bodyText && bodyText.includes(sig))) {
    return { bodyHtml, bodyText };
  }
  const escape = escapeHtml; // one escaper — @shared/escapeHtml
  const sigHtml = sig.split("\n").map(escape).join("<br>");
  return {
    bodyHtml: `${bodyHtml}<div style="margin-top:18px;color:#555;line-height:1.4">${sigHtml}</div>`,
    bodyText: bodyText ? `${bodyText}\n\n${sig}` : undefined,
  };
}

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

/**
 * Verify the caller is allowed to use this mailbox account, to read it or to
 * write to it.
 *
 * For Unipile-bridged personal mailboxes (Microsoft 365 etc.), the
 * account's underlying unipile_accounts.userId is the rep's id. Only
 * that rep — or a manager+ — may read it, or send / mark-read / move
 * messages from it. Reads used to check nothing, so any member could pass a
 * teammate's account id and read their mail (audit 2026-10-20, O18). Without this, a rep with a stale accountId from a
 * previous session could send from a teammate's mailbox.
 *
 * Non-Unipile (shared workspace SMTP) accounts skip the check — those
 * are shared outreach infrastructure by design.
 */
async function assertMailboxOwnership(
  ctx: { user: { id: number }; member: { role: string } },
  account: { id: number; unipileAccountId: string | null },
  refusal: string,
): Promise<void> {
  if (!account.unipileAccountId) return; // shared SMTP — anyone in workspace
  // Managers / admins can act on any rep's mailbox (matches the
  // resolveTargetUser pattern used by read paths).
  if (roleRank(ctx.member.role as any) >= roleRank("manager")) return;
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const [row] = await db
    .select({ userId: unipileAccounts.userId })
    .from(unipileAccounts)
    .where(eq(unipileAccounts.unipileAccountId, account.unipileAccountId))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Bridged account row not found — was it disconnected?",
    });
  }
  if (row.userId !== ctx.user.id) {
    throw new TRPCError({ code: "FORBIDDEN", message: refusal });
  }
}
/**
 * What compose and reply must refuse before anything is sent (audit
 * 2026-10-20, O34). They checked the pause, ownership and the daily cap, and
 * nothing else:
 *
 *   · a mailbox switched off in Sending Accounts still sent — the switch
 *     every other sender respects (proposal mail, the pools, the system
 *     sender) did nothing here;
 *   · an address that unsubscribed, bounced, complained or was added by hand
 *     still got the email. The ONE check (services/suppression), both lists,
 *     by ADDRESS: a company domain on the do-not-prospect list does not stop
 *     a rep writing to a person there from their own mailbox.
 *
 * Refused with the reason, so the page shows why and where to change it.
 * Attachments are capped here too (O59): past the limit the request failed as
 * an opaque "too large" after the whole upload.
 */
async function assertMailboxCanSend(
  workspaceId: number,
  account: { enabled?: boolean | null },
  recipients: Array<string | null | undefined>,
  attachments: Array<{ content: string }> | undefined,
): Promise<void> {
  if (account.enabled === false) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "This mailbox is switched off in Sending Accounts, so it can't send. Switch it back on there to use it.",
    });
  }
  for (const address of recipientAddresses(recipients)) {
    const hit = await findSuppression(workspaceId, { email: address }, "email", { domain: false });
    if (hit) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Not sent: ${address} — ${describeSuppression(hit)}. Remove the address from Suppressions to email it.`,
      });
    }
  }
  const tooBig = attachmentLimitProblem((attachments ?? []).reduce((n, a) => n + base64Bytes(a.content), 0));
  if (tooBig) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: tooBig });
}

/**
 * The rep's text with its signature, then the quoted original underneath
 * (O35: Forward used to send the rep's note alone). The signature goes under
 * what the rep wrote, not under the quote, which is why the quote travels
 * separately instead of inside bodyHtml.
 */
async function bodyForSend(
  workspaceId: number,
  userId: number,
  input: { bodyHtml: string; bodyText?: string; quoted?: { html: string; text: string } },
): Promise<{ bodyHtml: string; bodyText: string | undefined }> {
  const withSig = await appendSignature(workspaceId, userId, input.bodyHtml, input.bodyText);
  if (!input.quoted) return withSig;
  return {
    bodyHtml: withSig.bodyHtml + input.quoted.html,
    bodyText: (withSig.bodyText ?? "") + input.quoted.text,
  };
}

const QUOTED = z.object({ html: z.string(), text: z.string() }).optional();

/**
 * A forward's original attachments, named by message and attachment id (audit
 * 2026-10-20, F26/O35). The forward used to say its attachments were not
 * included; the server now fetches each one through the same provider read
 * the download button uses, from the mailbox the forward is sent from, and
 * sends it with the forward. Bounded, and counted toward the same 20 MB limit
 * as files the rep attaches.
 */
const FORWARDED = z.object({
  messageId: z.string().min(1).max(500),
  attachments: z.array(z.object({ attachmentId: z.string().min(1).max(500), filename: z.string().max(500) })).max(20),
}).optional();

async function forwardedAttachments(
  adapter: { getAttachment(messageId: string, attachmentId: string): Promise<{ data: Buffer; contentType: string; filename: string }> },
  forwarded: z.infer<typeof FORWARDED>,
): Promise<Array<{ filename: string; contentType: string; content: string }>> {
  if (!forwarded?.attachments.length) return [];
  const out: Array<{ filename: string; contentType: string; content: string }> = [];
  for (const a of forwarded.attachments) {
    let got: { data: Buffer; contentType: string; filename: string };
    try {
      got = await adapter.getAttachment(forwarded.messageId, a.attachmentId);
    } catch (e) {
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: `Could not fetch "${a.filename}" from the original to forward it. Nothing was sent. ${e instanceof Error ? e.message.slice(0, 200) : ""}`.trim(),
      });
    }
    if (!got.data?.length) {
      throw new TRPCError({ code: "BAD_GATEWAY", message: `"${a.filename}" came back empty from the mailbox, so the forward was not sent.` });
    }
    // The provider's filename is often "attachment"; the one the page showed is better.
    const filename = got.filename && got.filename !== "attachment" ? got.filename : a.filename || "attachment";
    out.push({ filename, contentType: got.contentType || "application/octet-stream", content: got.data.toString("base64") });
  }
  return out;
}

const assertMailboxWriteOwnership = (ctx: Parameters<typeof assertMailboxOwnership>[0], account: Parameters<typeof assertMailboxOwnership>[1]) =>
  assertMailboxOwnership(ctx, account, "You can only send from your own connected mailbox.");
const assertMailboxReadOwnership = (ctx: Parameters<typeof assertMailboxOwnership>[0], account: Parameters<typeof assertMailboxOwnership>[1]) =>
  assertMailboxOwnership(ctx, account, "You can only read your own connected mailbox.");

export const mailboxRouter = router({
  /**
   * List inbox-enabled sending accounts for the current user.
   *
   * /my-mailbox shows the rep's *personal* inbox(es). The dropdown is
   * filtered to:
   *   - Unipile-bridged accounts whose underlying unipile_accounts row
   *     belongs to ctx.user.id (each user only sees their own M365 mailbox)
   *   - any plain-IMAP rows in the workspace are NOT listed here, since
   *     IMAP/SMTP accounts are shared outreach infrastructure used by
   *     sequences/campaigns — not personal mailboxes. (If/when per-user
   *     IMAP becomes a feature, this filter can widen.)
   *
   * Managers may pass repUserId to view another rep's personal mailbox.
   */
  listAccounts: workspaceProcedure
    .input(z.object({ repUserId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const targetUserId = resolveTargetUser(ctx, input.repUserId);
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .select({
          id: sendingAccounts.id,
          name: sendingAccounts.name,
          email: sendingAccounts.fromEmail,
          provider: sendingAccounts.provider,
          unipileAccountId: sendingAccounts.unipileAccountId,
          enabled: sendingAccounts.enabled,
        })
        .from(sendingAccounts)
        .innerJoin(
          unipileAccounts,
          eq(unipileAccounts.unipileAccountId, sendingAccounts.unipileAccountId),
        )
        .where(
          and(
            eq(sendingAccounts.workspaceId, ctx.workspace.id),
            isNotNull(sendingAccounts.unipileAccountId),
            eq(unipileAccounts.userId, targetUserId),
          ),
        );
      return rows.map((a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        provider: a.provider,
        inboxEnabled: true,
        unipileBridged: true,
        /** Switched off in Sending Accounts: readable, but sends are refused (O34). */
        enabled: a.enabled !== false,
      }));
    }),

  /**
   * Resolve an email_reply notification → enough to open the right
   * conversation in the mailbox. Backs the Inbox "Open in Mailbox"
   * deep-link (/mailbox?reply=<id>). Returns the sending account the
   * reply came in on + the sender email/subject so the UI can switch
   * to that account view and pre-search the thread.
   */
  locateReply: workspaceProcedure
    .input(z.object({ replyId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [r] = await db
        .select({
          sendingAccountId: emailReplies.sendingAccountId,
          fromEmail: emailReplies.fromEmail,
          subject: emailReplies.subject,
        })
        .from(emailReplies)
        .where(
          and(
            eq(emailReplies.id, input.replyId),
            eq(emailReplies.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Reply not found" });
      return r;
    }),

  /** List folders/labels for an account */
  listFolders: workspaceProcedure
    .input(z.object({ accountId: z.number(), repUserId: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      resolveTargetUser(ctx, input.repUserId);
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      await assertMailboxReadOwnership(ctx, acc);
      const adapter = createEmailAdapter(acc);
      // Kept briefly, after the read was authorised (L8).
      return cachedMailboxRead(acc, "folders", [], () => adapter.listFolders());
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
      await assertMailboxReadOwnership(ctx, acc);
      const adapter = createEmailAdapter(acc);
      // An adapter failure must NOT render as "This folder is empty" — an
      // empty folder and a broken fetch are different facts, and collapsing
      // them cost a whole debugging round-trip on the owner's mailbox
      // (2026-08-10). The error travels to the UI, which shows it in place
      // of the empty-state.
      //
      // Kept for MAILBOX_CACHE_TTL_MS per mailbox, folder and page, after the
      // read was authorised above, and dropped by every change to the mailbox
      // (audit 2026-10-20, L8): the provider read took 8.9 s live, on every
      // open and every refetch. A failed read is never kept.
      try {
        const res = await cachedMailboxRead(acc, "threads", [input.folder, input.pageToken ?? null, input.maxResults],
          () => adapter.listThreads(input.folder, input.pageToken, input.maxResults));
        return { ...res, error: null as string | null };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[mailbox.listThreads] account=${input.accountId} folder=${input.folder}: ${msg}`);
        return { threads: [], nextPageToken: undefined, error: msg.slice(0, 300) };
      }
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
      await assertMailboxReadOwnership(ctx, acc);
      const adapter = createEmailAdapter(acc);
      return adapter.getThread(input.threadId, input.folder);
    }),

  /** Send a new email */
  sendNew: workspaceProcedure
    .input(z.object({
      accountId: z.number(),
      // One address, or several separated by commas (a forward goes through
      // here now, F26, and a forward could always go to more than one).
      to: z.string().trim().min(3).max(2000).refine(
        (v) => v.split(/[,;]/).map((x) => x.trim()).filter(Boolean).every((x) => z.string().email().safeParse(x.replace(/^.*<([^<>]+)>$/, "$1").trim()).success),
        "Enter a valid email address, or several separated by commas",
      ),
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
      /** A forwarded original, quoted under the signature (O35). */
      quoted: QUOTED,
      /** A forward's original attachments, fetched here and sent with it (F26). */
      forwardAttachmentsOf: FORWARDED,
    }))
    .mutation(async ({ ctx, input }) => {
      // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything"). Team-only mail still goes.
      await assertOutboundNotPausedFor(ctx.workspace.id, [input.to, input.cc, input.bcc]);
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      await assertMailboxWriteOwnership(ctx, acc);
      // Refused recipients first, so nothing is fetched for a send that cannot go.
      await assertMailboxCanSend(ctx.workspace.id, acc, [input.to, input.cc, input.bcc], input.attachments);
      const adapter = createEmailAdapter(acc);
      // The forward's originals (F26), from this same mailbox, then the limit
      // asked again over everything the email will carry.
      const carried = await forwardedAttachments(adapter, input.forwardAttachmentsOf);
      const attachments = [...(input.attachments ?? []), ...carried];
      if (carried.length) await assertMailboxCanSend(ctx.workspace.id, acc, [input.to, input.cc, input.bcc], attachments);
      // Cap gate before signature so a blocked send produces a clear
      // error instead of doing the (slow) signature build for nothing.
      await assertSendAllowed(ctx.workspace.id, acc.id);
      const withSig = await bodyForSend(ctx.workspace.id, ctx.user.id, input);
      return adapter.sendEmail({
        fromEmail: acc.fromEmail,
        fromName: acc.fromName ?? acc.name,
        to: input.to,
        subject: input.subject,
        bodyHtml: withSig.bodyHtml,
        bodyText: withSig.bodyText,
        cc: input.cc,
        bcc: input.bcc,
        attachments: attachments.length ? attachments : undefined,
        // Sitewide email log (migration 0163). Inbox composes previously left
        // NO trace anywhere in Velocity — the message existed only in the
        // provider's Sent folder.
        logMeta: { source: "mailbox", sourceLabel: input.forwardAttachmentsOf || input.quoted ? "Forward" : null, userId: ctx.user.id },
      }).finally(() => invalidateMailboxCache({ accountId: acc.id }));
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
      /** A forwarded original, quoted under the signature (O35). */
      quoted: QUOTED,
    }))
    .mutation(async ({ ctx, input }) => {
      // Pause all outbound holds person sends too (owner, 2026-10-06: "Block everything"). Team-only mail still goes.
      await assertOutboundNotPausedFor(ctx.workspace.id, [input.to, input.cc]);
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      await assertMailboxWriteOwnership(ctx, acc);
      await assertMailboxCanSend(ctx.workspace.id, acc, [input.to, input.cc], input.attachments);
      const adapter = createEmailAdapter(acc);
      // Cap gate before signature so a blocked send produces a clear
      // error instead of doing the (slow) signature build for nothing.
      await assertSendAllowed(ctx.workspace.id, acc.id);
      const withSig = await bodyForSend(ctx.workspace.id, ctx.user.id, input);
      return adapter.sendEmail({
        fromEmail: acc.fromEmail,
        fromName: acc.fromName ?? acc.name,
        to: input.to,
        subject: input.subject,
        bodyHtml: withSig.bodyHtml,
        bodyText: withSig.bodyText,
        cc: input.cc,
        inReplyTo: input.inReplyTo,
        references: input.references,
        replyToThreadId: input.threadId,
        attachments: input.attachments,
        // As sendNew: replies sent from the Inbox were recorded nowhere.
        logMeta: { source: "mailbox", sourceLabel: "Reply", userId: ctx.user.id },
      }).finally(() => invalidateMailboxCache({ accountId: acc.id }));
    }),

  /**
   * Mark a message read or unread.
   *
   * Threads served from the local unipile_emails_cache (Unipile's live
   * thread endpoint returns nothing for webhook-delivered mail) carry a
   * cache emailId that Unipile's PUT /emails/{id} doesn't recognize → it
   * 404s with "Email not found". That used to bubble as a hard error and
   * a scary "Failed to update read state" toast on every such email,
   * even though the email itself displayed fine.
   *
   * Read-state is a best-effort nicety. When Unipile 404s we persist the
   * read state to the cache (readDate) instead so the UI stays consistent
   * and no error surfaces. Genuine non-404 failures still throw.
   */
  markRead: workspaceProcedure
    .input(z.object({ accountId: z.number(), messageId: z.string(), read: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      await assertMailboxWriteOwnership(ctx, acc);
      const adapter = createEmailAdapter(acc);

      const syncCache = async () => {
        const db = await getDb();
        if (!db || !acc.unipileAccountId) return;
        await db
          .update(unipileEmailsCache)
          .set({ readDate: input.read ? new Date() : null })
          .where(
            and(
              eq(unipileEmailsCache.unipileAccountId, acc.unipileAccountId),
              eq(unipileEmailsCache.emailId, input.messageId),
              // `acc` is verified by getAccount(accountId, workspace) above; the
              // workspace term is on the statement so it holds on its own.
              eq(unipileEmailsCache.workspaceId, ctx.workspace.id),
            ),
          );
      };

      try {
        await adapter.markRead(input.messageId, input.read);
        // Keep the cache in sync so a later cache-served render of this
        // thread reflects the same read state.
        await syncCache().catch(() => {});
        invalidateMailboxCache({ accountId: acc.id }); // the unread counts changed (L8)
        return { ok: true as const };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const is404 = /→\s*404\b/.test(msg) || /not\s*found/i.test(msg);
        if (is404) {
          // Cache-only / webhook email — nothing to update remotely.
          // Persist read state locally and report success.
          await syncCache().catch(() => {});
          invalidateMailboxCache({ accountId: acc.id });
          return { ok: true as const, local: true as const };
        }
        // Real failure (auth, 5xx, network) — surface it.
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not update read state.",
        });
      }
    }),

  /** Move a message to trash */
  moveToTrash: workspaceProcedure
    .input(z.object({ accountId: z.number(), messageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      await assertMailboxWriteOwnership(ctx, acc);
      const adapter = createEmailAdapter(acc);
      await adapter.moveToTrash(input.messageId);
      invalidateMailboxCache({ accountId: acc.id }); // L8
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
      await assertMailboxWriteOwnership(ctx, acc);
      const adapter = createEmailAdapter(acc);
      await adapter.moveToFolder(input.messageId, input.destFolder, input.currentFolder);
      invalidateMailboxCache({ accountId: acc.id }); // L8
      return { ok: true };
    }),

  /**
   * The page's Refresh button (L8): forget what was kept for these mailboxes,
   * so the next read goes to the provider. Only for mailboxes the caller may
   * read.
   */
  refresh: workspaceProcedure
    .input(z.object({ accountIds: z.array(z.number().int()).min(1).max(20) }))
    .mutation(async ({ ctx, input }) => {
      for (const id of input.accountIds) {
        const acc = await getAccount(id, ctx.workspace.id);
        await assertMailboxReadOwnership(ctx, acc);
        invalidateMailboxCache({ accountId: acc.id });
      }
      return { ok: true as const };
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
        sendersBrand: true,
        messages: [
          {
            role: "system",
            content: `You are a professional sales representative named ${senderName} (${senderEmail}). Draft a concise, professional, and friendly reply to the email thread below. Write only the body of the reply — no subject line, no signature placeholder. Keep it under 150 words unless the thread requires more detail. Do not include any preamble like "Here is a draft reply:".

${HUMAN_COPY_RULES}`,
          },
          { role: "user", content: `Email thread:\n\n${threadSummary}` },
        ],
        // The other party's market research, when their address is a record here.
        research: await researchUseForRecipient(ctx.workspace.id, "reply", {}, [threadCounterparty(input.messages, senderEmail)]),
      });
      const body = humanizeAiCopy((res as any)?.choices?.[0]?.message?.content ?? "");
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
      /** Whom it is being forwarded to, when the To field is filled. */
      toEmail: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const acc = await getAccount(input.accountId, ctx.workspace.id);
      const senderName = input.senderName ?? acc.fromName ?? acc.name ?? "";
      const msg = input.originalMessage;
      const res = await invokeLLM({
        sendersBrand: true,
        messages: [
          {
            role: "system",
            content: `You are a professional sales representative named ${senderName}. Write a brief, professional forwarding introduction (2-3 sentences) to accompany the email below when forwarding it to a colleague or prospect. Write only the intro text — no subject line, no signature. Do not include any preamble like "Here is a draft:".

${HUMAN_COPY_RULES}`,
          },
          {
            role: "user",
            content: `Original email from ${msg.fromName || msg.fromEmail} <${msg.fromEmail}>:\nSubject: ${msg.subject}\n\n${msg.bodyText?.slice(0, 800) ?? ""}`,
          },
        ],
        // The research on whoever it goes to, else on whoever wrote it.
        research: await researchUseForRecipient(ctx.workspace.id, "reply", {}, [input.toEmail, msg.fromEmail]),
      });
      const body = humanizeAiCopy((res as any)?.choices?.[0]?.message?.content ?? "");
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
      await assertMailboxReadOwnership(ctx, acc);
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
      await assertMailboxReadOwnership(ctx, acc);
      const adapter = createEmailAdapter(acc);
      const { data, contentType, filename } = await adapter.getAttachment(input.messageId, input.attachmentId);
      // Return as base64 so it can be decoded in the browser
      return { dataBase64: data.toString("base64"), contentType, filename };
    }),
});
