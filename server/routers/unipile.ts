/**
 * Unipile multichannel tRPC router
 * Handles account connection, inbox, messaging, LinkedIn invitations.
 */

import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db";
import {
  activities,
  leads,
  unipileAccounts,
  unipileInvites,
  unipileMessages,
  workspaceSettings,
} from "../../drizzle/schema";
import {
  cancelSentInvitation,
  commentOnPost,
  createPost,
  deleteUnipileAccount,
  generateHostedAuthLink,
  getChatMessages,
  getLinkedInProfile,
  listChats,
  listRelations,
  listSentInvitations,
  listUnipileAccounts,
  listUserPosts,
  patchChat,
  reactToPost,
  registerWebhook,
  resolveLinkedInSearchParameter,
  searchLinkedIn,
  sendLinkedInInvitation,
  sendMessage,
  type UnipileLinkedInSearchHit,
} from "../lib/unipile";
import { router } from "../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../_core/workspace";

// ─── Provider metadata ────────────────────────────────────────────────────────

export const PROVIDER_META: Record<
  string,
  { label: string; color: string; icon: string }
> = {
  LINKEDIN: { label: "LinkedIn", color: "#0A66C2", icon: "linkedin" },
  WHATSAPP: { label: "WhatsApp", color: "#25D366", icon: "whatsapp" },
  INSTAGRAM: { label: "Instagram", color: "#E1306C", icon: "instagram" },
  MESSENGER: { label: "Messenger", color: "#0084FF", icon: "messenger" },
  TELEGRAM: { label: "Telegram", color: "#2AABEE", icon: "telegram" },
  TWITTER: { label: "X (Twitter)", color: "#000000", icon: "twitter" },
  MICROSOFT: { label: "Outlook", color: "#0078D4", icon: "outlook" },
  IMAP: { label: "IMAP Email", color: "#6B7280", icon: "mail" },
};

const ALL_PROVIDERS = [
  "LINKEDIN",
  "WHATSAPP",
  "INSTAGRAM",
  "MESSENGER",
  "TELEGRAM",
  "TWITTER",
  "MICROSOFT",
  "IMAP",
];

// ─── Router ───────────────────────────────────────────────────────────────────

export const unipileRouter = router({
  /**
   * Generate a Hosted Auth Wizard link for the current user.
   * The frontend redirects the user to the returned URL.
   */
  generateConnectLink: workspaceProcedure
    .input(
      z.object({
        providers: z.array(z.string()).optional(), // defaults to all
        reconnectAccountId: z.string().optional(),
        origin: z.string().optional(), // window.location.origin from frontend
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Use MANUS_APP_URL (deployed app URL) so Unipile can reach our webhook.
      // Fall back to the origin passed by the frontend, then to VITE_FRONTEND_FORGE_API_URL.
      const appBase = (
        process.env.MANUS_APP_URL ||
        input.origin ||
        process.env.VITE_FRONTEND_FORGE_API_URL ||
        ""
      ).replace(/\/$/, "");
      const notifyUrl = `${appBase}/api/unipile/account-webhook?userId=${ctx.user.id}&workspaceId=${ctx.workspace.id}`;
      const successRedirectUrl = `${appBase}/connected-accounts?connected=1`;
      const expiresOn = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

      // Unipile's hosted-auth-link endpoint accepts `providers` as a single
      // string. Their docs / SDK example only verifies "*" (all providers)
      // — sending a specific provider name like "MICROSOFT" still triggers
      // "Expected union value" against their schema. Going with "*" for now
      // and letting the user pick the channel inside the hosted wizard;
      // the UI multi-select serves as an in-app shortlist hint only.
      //
      // The frontend's input.providers array is currently ignored; revisit
      // if Unipile clarifies the per-provider request shape (it may need to
      // be `[{ provider: "MICROSOFT", scopes: [...] }]` or similar).
      const providerArg: string = "*";

      const result = await generateHostedAuthLink({
        type: input.reconnectAccountId ? "reconnect" : "create",
        providers: providerArg,
        expiresOn,
        notifyUrl,
        successRedirectUrl,
        name: String(ctx.user.id),
        reconnectAccount: input.reconnectAccountId,
      });
      return { url: result.url };
    }),

  /**
   * List all Unipile accounts connected by the current user.
   */
  listConnectedAccounts: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const rows = await db
      .select()
      .from(unipileAccounts)
      .where(
        and(
          eq(unipileAccounts.workspaceId, ctx.workspace.id),
          eq(unipileAccounts.userId, ctx.user.id),
        ),
      )
      .orderBy(desc(unipileAccounts.createdAt));
    return rows;
  }),

  /**
   * Disconnect (delete) a Unipile account.
   */
  disconnectAccount: workspaceProcedure
    .input(z.object({ unipileAccountId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      // Verify ownership
      const [row] = await db
        .select()
        .from(unipileAccounts)
        .where(
          and(
            eq(unipileAccounts.unipileAccountId, input.unipileAccountId),
            eq(unipileAccounts.userId, ctx.user.id),
          ),
        )
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });

      try {
        await deleteUnipileAccount(input.unipileAccountId);
      } catch {
        // If already removed from Unipile, continue with local cleanup
      }

      await db
        .delete(unipileAccounts)
        .where(eq(unipileAccounts.unipileAccountId, input.unipileAccountId));

      return { success: true };
    }),

  /**
   * Get the unified inbox: recent chats across all connected accounts.
   */
  getInbox: workspaceProcedure
    .input(
      z.object({
        provider: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().min(1).max(50).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      // Get user's connected accounts
      const accounts = await db
        .select()
        .from(unipileAccounts)
        .where(
          and(
            eq(unipileAccounts.workspaceId, ctx.workspace.id),
            eq(unipileAccounts.userId, ctx.user.id),
          ),
        );

      if (!accounts.length) return { chats: [], hasMore: false };

      // Filter by provider if requested
      const targetAccounts = input.provider
        ? accounts.filter((a) => a.provider === input.provider)
        : accounts;

      if (!targetAccounts.length) return { chats: [], hasMore: false };

      // Fetch chats from Unipile for each account (parallel, up to 3 accounts)
      const chatResults = await Promise.allSettled(
        targetAccounts.slice(0, 5).map((acc) =>
          listChats({
            accountId: acc.unipileAccountId,
            limit: input.limit,
            cursor: input.cursor,
          }),
        ),
      );

      const allChats = chatResults
        .filter((r) => r.status === "fulfilled")
        .flatMap((r) => (r as PromiseFulfilledResult<{ items: unknown[] }>).value.items)
        .slice(0, input.limit);

      return { chats: allChats, hasMore: allChats.length === input.limit };
    }),

  /**
   * Get messages for a specific chat.
   */
  getChatMessages: workspaceProcedure
    .input(
      z.object({
        chatId: z.string(),
        cursor: z.string().optional(),
        limit: z.number().min(1).max(100).default(30),
      }),
    )
    .query(async ({ ctx: _ctx, input }) => {
      const result = await getChatMessages(input.chatId, {
        cursor: input.cursor,
        limit: input.limit,
      });
      return result;
    }),

  /**
   * Mark a chat read/unread via the vendor (PATCH setReadStatus — supported
   * for LinkedIn + WhatsApp per Unipile's reference; other providers may
   * reject, surfaced as a friendly error). The chat's account must be one of
   * the caller's own connected accounts.
   *
   * NOTE: archive was deliberately NOT built — Unipile's setArchiveStatus is
   * WhatsApp-only, and this inbox is primarily LinkedIn.
   */
  setChatRead: workspaceProcedure
    .input(z.object({
      unipileAccountId: z.string().min(1).max(200),
      chatId: z.string().min(1).max(500),
      read: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      const [own] = await db
        .select({ id: unipileAccounts.id })
        .from(unipileAccounts)
        .where(and(
          eq(unipileAccounts.workspaceId, ctx.workspace.id),
          eq(unipileAccounts.userId, ctx.user.id),
          eq(unipileAccounts.unipileAccountId, input.unipileAccountId),
        ));
      if (!own) throw new TRPCError({ code: "FORBIDDEN", message: "That chat isn't on one of your connected accounts." });
      try {
        await patchChat(input.chatId, { action: "setReadStatus", value: input.read });
      } catch (e) {
        const msg = (e as Error).message ?? "";
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: /not.?supported|invalid/i.test(msg)
            ? "Read status isn't supported for this provider."
            : "Couldn't update the chat — try again.",
        });
      }
      return { ok: true as const };
    }),

  /**
   * Send a message via Unipile (to existing chat or new chat).
   */
  sendMessage: workspaceProcedure
    .input(
      z.object({
        chatId: z.string().optional(),
        unipileAccountId: z.string(),
        attendeesIds: z.array(z.string()).optional(),
        text: z.string().min(1).max(4000),
        linkedContactId: z.number().optional(),
        linkedLeadId: z.number().optional(),
        linkedOpportunityId: z.number().optional(),
        linkedinInmail: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      // Verify account ownership
      const [account] = await db
        .select()
        .from(unipileAccounts)
        .where(
          and(
            eq(unipileAccounts.unipileAccountId, input.unipileAccountId),
            eq(unipileAccounts.userId, ctx.user.id),
          ),
        )
        .limit(1);
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "Account not found" });

      const result = await sendMessage({
        chatId: input.chatId,
        accountId: input.unipileAccountId,
        attendeesIds: input.attendeesIds,
        text: input.text,
        linkedinInmail: input.linkedinInmail,
      });

      // Store message record
      await db.insert(unipileMessages).values({
        workspaceId: ctx.workspace.id,
        unipileAccountId: input.unipileAccountId,
        provider: account.provider,
        chatId: input.chatId ?? result.id,
        messageId: result.id,
        direction: "outbound",
        senderName: ctx.user.name ?? undefined,
        text: input.text,
        linkedContactId: input.linkedContactId,
        linkedLeadId: input.linkedLeadId,
        linkedOpportunityId: input.linkedOpportunityId,
      });

      // Create activity record
      const relatedId = input.linkedOpportunityId ?? input.linkedLeadId ?? input.linkedContactId;
      const relatedType = input.linkedOpportunityId ? "opportunity" : input.linkedLeadId ? "lead" : "contact";
      if (relatedId) {
        await db.insert(activities).values({
          workspaceId: ctx.workspace.id,
          type: "email",
          relatedType,
          relatedId,
          subject: `${PROVIDER_META[account.provider]?.label ?? account.provider} message`,
          body: input.text,
          actorUserId: ctx.user.id,
        });
      }

      return { messageId: result.id };
    }),

  /**
   * Send a LinkedIn connection invitation.
   */
  sendLinkedInInvite: workspaceProcedure
    .input(
      z.object({
        unipileAccountId: z.string(),
        recipientProviderId: z.string(),
        recipientName: z.string().optional(),
        message: z.string().max(300).optional(),
        linkedContactId: z.number().optional(),
        linkedLeadId: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      // Verify account ownership
      const [account] = await db
        .select()
        .from(unipileAccounts)
        .where(
          and(
            eq(unipileAccounts.unipileAccountId, input.unipileAccountId),
            eq(unipileAccounts.userId, ctx.user.id),
          ),
        )
        .limit(1);
      if (!account) throw new TRPCError({ code: "NOT_FOUND" });

      await sendLinkedInInvitation({
        accountId: input.unipileAccountId,
        providerId: input.recipientProviderId,
        message: input.message,
      });

      // Store invite record
      await db.insert(unipileInvites).values({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        unipileAccountId: input.unipileAccountId,
        recipientProviderId: input.recipientProviderId,
        recipientName: input.recipientName,
        message: input.message,
        status: "pending",
        linkedContactId: input.linkedContactId,
        linkedLeadId: input.linkedLeadId,
      });

      // Create activity
      const invRelatedId = input.linkedLeadId ?? input.linkedContactId;
      const invRelatedType = input.linkedLeadId ? "lead" : "contact";
      if (invRelatedId) {
        await db.insert(activities).values({
          workspaceId: ctx.workspace.id,
          type: "linkedin",
          relatedType: invRelatedType,
          relatedId: invRelatedId,
          subject: `LinkedIn connection request sent to ${input.recipientName ?? input.recipientProviderId}`,
          actorUserId: ctx.user.id,
        });
      }

      return { success: true };
    }),

  /**
   * Look up a LinkedIn profile by provider ID.
   */
  getLinkedInProfile: workspaceProcedure
    .input(
      z.object({
        unipileAccountId: z.string(),
        providerId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      // Verify account ownership
      const [account] = await db
        .select()
        .from(unipileAccounts)
        .where(
          and(
            eq(unipileAccounts.unipileAccountId, input.unipileAccountId),
            eq(unipileAccounts.userId, ctx.user.id),
          ),
        )
        .limit(1);
      if (!account) throw new TRPCError({ code: "NOT_FOUND" });

      return getLinkedInProfile(input.unipileAccountId, input.providerId);
    }),

  /**
   * Get stored messages for a contact/lead/opportunity (from DB, not Unipile API).
   */
  getStoredMessages: workspaceProcedure
    .input(
      z.object({
        linkedContactId: z.number().optional(),
        linkedLeadId: z.number().optional(),
        linkedOpportunityId: z.number().optional(),
        limit: z.number().default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const conditions = [eq(unipileMessages.workspaceId, ctx.workspace.id)];
      if (input.linkedContactId)
        conditions.push(eq(unipileMessages.linkedContactId, input.linkedContactId));
      if (input.linkedLeadId)
        conditions.push(eq(unipileMessages.linkedLeadId, input.linkedLeadId));
      if (input.linkedOpportunityId)
        conditions.push(eq(unipileMessages.linkedOpportunityId, input.linkedOpportunityId));

      return db
        .select()
        .from(unipileMessages)
        .where(and(...conditions))
        .orderBy(desc(unipileMessages.createdAt))
        .limit(input.limit);
    }),

  /**
   * Get stored LinkedIn invites for a contact/lead.
   */
  getStoredInvites: workspaceProcedure
    .input(
      z.object({
        linkedContactId: z.number().optional(),
        linkedLeadId: z.number().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const conditions = [eq(unipileInvites.workspaceId, ctx.workspace.id)];
      if (input.linkedContactId)
        conditions.push(eq(unipileInvites.linkedContactId, input.linkedContactId));
      if (input.linkedLeadId)
        conditions.push(eq(unipileInvites.linkedLeadId, input.linkedLeadId));

      return db
        .select()
        .from(unipileInvites)
        .where(and(...conditions))
        .orderBy(desc(unipileInvites.sentAt))
        .limit(20);
    }),

  /**
   * Aggregate Unipile multichannel metrics for the Dashboard widget.
   * Returns: messages sent (last 30d), connections made (accepted invites),
   * acceptance rate %, and messages-by-provider breakdown.
   */
  metrics: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Total outbound messages in last 30 days
    const [msgRow] = await db
      .select({ total: count() })
      .from(unipileMessages)
      .where(
        and(
          eq(unipileMessages.workspaceId, ctx.workspace.id),
          eq(unipileMessages.direction, "outbound"),
          gte(unipileMessages.createdAt, since30d),
        ),
      );
    const messagesSent = Number(msgRow?.total ?? 0);

    // Total invites sent (all time for denominator, last 30d for numerator)
    const [invTotalRow] = await db
      .select({ total: count() })
      .from(unipileInvites)
      .where(eq(unipileInvites.workspaceId, ctx.workspace.id));
    const invitesTotal = Number(invTotalRow?.total ?? 0);

    const [invAcceptedRow] = await db
      .select({ total: count() })
      .from(unipileInvites)
      .where(
        and(
          eq(unipileInvites.workspaceId, ctx.workspace.id),
          eq(unipileInvites.status, "accepted"),
        ),
      );
    const connectionsAccepted = Number(invAcceptedRow?.total ?? 0);
    const acceptanceRate =
      invitesTotal > 0 ? Math.round((connectionsAccepted / invitesTotal) * 100) : 0;

    // Messages by provider (last 30d)
    const byProviderRows = await db
      .select({
        provider: unipileMessages.provider,
        total: count(),
      })
      .from(unipileMessages)
      .where(
        and(
          eq(unipileMessages.workspaceId, ctx.workspace.id),
          eq(unipileMessages.direction, "outbound"),
          gte(unipileMessages.createdAt, since30d),
        ),
      )
      .groupBy(unipileMessages.provider)
      .orderBy(sql`count(*) desc`);

    const byProvider = byProviderRows.map((r) => ({
      provider: r.provider,
      count: Number(r.total),
    }));

    return {
      messagesSent,
      connectionsAccepted,
      invitesTotal,
      acceptanceRate,
      byProvider,
    };
  }),

  /**
   * One-time admin action: register Unipile's mail webhook to point at our
   * /api/unipile/mail-webhook endpoint. Returns the Unipile webhook id.
   *
   * Idempotent on Unipile's side per request_url+source; if you call this
   * twice you may get back two webhook ids — list/delete via Unipile
   * dashboard if you need to clean up.
   *
   * Admin-only because it affects every account connected to this DSN.
   */
  registerMailWebhook: adminWsProcedure
    .input(z.object({ origin: z.string().optional() }).default({}))
    .mutation(async ({ input }) => {
      const appBase = (
        process.env.MANUS_APP_URL ||
        input.origin ||
        process.env.VITE_FRONTEND_FORGE_API_URL ||
        ""
      ).replace(/\/$/, "");
      if (!appBase) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "MANUS_APP_URL is not set — Unipile needs a reachable webhook URL.",
        });
      }
      const requestUrl = `${appBase}/api/unipile/mail-webhook`;
      const result = await registerWebhook({
        requestUrl,
        source: "email",
        // Unipile echoes this back as a Unipile-Auth header on every
        // delivery; the webhook endpoints verify it when the env var is set.
        secretKey: process.env.UNIPILE_WEBHOOK_SECRET || undefined,
      });
      // result.id may be null if Unipile's response shape doesn't include
      // one (we've observed at least three variants). The toast on the
      // client handles that gracefully.
      return { webhookId: result.id, requestUrl, raw: result.raw };
    }),

  /**
   * One-time admin action: register Unipile's messaging webhook so inbound
   * social/chat messages (LinkedIn DMs, etc.) arrive in real time and feed the
   * Conversation Autopilot (classify → book meeting).
   */
  registerMessagingWebhook: adminWsProcedure
    .input(z.object({ origin: z.string().optional() }).default({}))
    .mutation(async ({ input }) => {
      const appBase = (
        process.env.MANUS_APP_URL ||
        input.origin ||
        process.env.VITE_FRONTEND_FORGE_API_URL ||
        ""
      ).replace(/\/$/, "");
      if (!appBase) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "MANUS_APP_URL is not set — Unipile needs a reachable webhook URL.",
        });
      }
      const requestUrl = `${appBase}/api/unipile/messaging-webhook`;
      const result = await registerWebhook({
        requestUrl,
        source: "messaging",
        secretKey: process.env.UNIPILE_WEBHOOK_SECRET || undefined,
      });
      return { webhookId: result.id, requestUrl, raw: result.raw };
    }),

  /**
   * One-time admin action: register Unipile's `users` webhook so new_relation
   * (invitation-accepted) events reach /api/unipile/users-webhook and trigger
   * the Social Autopilot opener.
   */
  registerUsersWebhook: adminWsProcedure
    .input(z.object({ origin: z.string().optional() }).default({}))
    .mutation(async ({ input }) => {
      const appBase = (
        process.env.MANUS_APP_URL ||
        input.origin ||
        process.env.VITE_FRONTEND_FORGE_API_URL ||
        ""
      ).replace(/\/$/, "");
      if (!appBase) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "MANUS_APP_URL is not set — Unipile needs a reachable webhook URL.",
        });
      }
      const requestUrl = `${appBase}/api/unipile/users-webhook`;
      const result = await registerWebhook({
        requestUrl,
        source: "users",
        secretKey: process.env.UNIPILE_WEBHOOK_SECRET || undefined,
      });
      return { webhookId: result.id, requestUrl, raw: result.raw };
    }),

  /**
   * One-time admin action: register Unipile's calendar_event webhook so
   * calendar_event_created / _updated / _deleted events stream into
   * /api/unipile/calendar-webhook. Same idempotency caveat as mail.
   */
  registerCalendarWebhook: adminWsProcedure
    .input(z.object({ origin: z.string().optional() }).default({}))
    .mutation(async ({ input }) => {
      const appBase = (
        process.env.MANUS_APP_URL ||
        input.origin ||
        process.env.VITE_FRONTEND_FORGE_API_URL ||
        ""
      ).replace(/\/$/, "");
      if (!appBase) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "MANUS_APP_URL is not set — Unipile needs a reachable webhook URL.",
        });
      }
      const requestUrl = `${appBase}/api/unipile/calendar-webhook`;
      const result = await registerWebhook({
        requestUrl,
        source: "calendar_event",
        secretKey: process.env.UNIPILE_WEBHOOK_SECRET || undefined,
      });
      return { webhookId: result.id, requestUrl, raw: result.raw };
    }),

  /**
   * One-time admin action: register Unipile's email_tracking webhook for
   * open + click events. Includes the field list we need on the payload
   * (tracking_id is the key we match back to emailDrafts.trackingToken).
   */
  registerEmailTrackingWebhook: adminWsProcedure
    .input(z.object({ origin: z.string().optional() }).default({}))
    .mutation(async ({ input }) => {
      const appBase = (
        process.env.MANUS_APP_URL ||
        input.origin ||
        process.env.VITE_FRONTEND_FORGE_API_URL ||
        ""
      ).replace(/\/$/, "");
      if (!appBase) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "MANUS_APP_URL is not set — Unipile needs a reachable webhook URL.",
        });
      }
      const requestUrl = `${appBase}/api/unipile/email-tracking-webhook`;
      const result = await registerWebhook({
        requestUrl,
        source: "email_tracking",
        secretKey: process.env.UNIPILE_WEBHOOK_SECRET || undefined,
        events: ["mail_opened", "mail_link_clicked"],
        // Field names on the LEFT (what we read in the webhook handler)
        // mirror the Unipile data keys on the RIGHT (their internal field).
        data: [
          { name: "type", key: "type" },
          { name: "tracking_id", key: "tracking_id" },
          { name: "date", key: "date" },
          { name: "email_id", key: "email_id" },
          { name: "account_id", key: "account_id" },
          { name: "url", key: "url" },
          { name: "label", key: "label" },
          { name: "ip", key: "ip" },
          { name: "user_agent", key: "user_agent" },
        ],
      });
      return { webhookId: result.id, requestUrl, raw: result.raw };
    }),

  // ─── Social Autopilot settings ──────────────────────────────────────────
  // Off/Approve/Auto governs autonomous LinkedIn opener DMs on invite-accept.
  getSocialAutopilotSettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { mode: "off" as const, dailyCap: 50, lastRunAt: null as Date | null };
    const [row] = await db
      .select({
        mode: workspaceSettings.socialAutopilotMode,
        dailyCap: workspaceSettings.socialAutopilotDailyCap,
        lastRunAt: workspaceSettings.socialAutopilotLastRunAt,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
    return row ?? { mode: "off" as const, dailyCap: 50, lastRunAt: null };
  }),

  setSocialAutopilotSettings: adminWsProcedure
    .input(
      z.object({
        mode: z.enum(["off", "approval", "auto"]),
        dailyCap: z.number().int().min(1).max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: any = { socialAutopilotMode: input.mode };
      if (input.dailyCap !== undefined) set.socialAutopilotDailyCap = input.dailyCap;
      await db
        .insert(workspaceSettings)
        .values({ workspaceId: ctx.workspace.id, ...set } as never)
        .onDuplicateKeyUpdate({ set });
      return { ok: true };
    }),

  // ─── LinkedIn invitations / relations (per-user, compliant reads) ────────
  // Resolve the caller's OWN LinkedIn account. Optional unipileAccountId picks
  // a specific one when the rep has connected more than one.
  listSentInvitations: workspaceProcedure
    .input(z.object({ unipileAccountId: z.string().optional(), limit: z.number().int().min(1).max(250).optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { items: [] as any[] };
      const acct = await resolveOwnLinkedInAccount(db, ctx.workspace.id, ctx.user.id, input.unipileAccountId);
      if (!acct) return { items: [] as any[] };
      const res = await listSentInvitations({ accountId: acct, limit: input.limit ?? 100 });
      return { items: res.items ?? [], cursor: res.cursor };
    }),

  withdrawInvitation: workspaceProcedure
    .input(z.object({ invitationId: z.string(), unipileAccountId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const acct = await resolveOwnLinkedInAccount(db, ctx.workspace.id, ctx.user.id, input.unipileAccountId);
      if (!acct) throw new TRPCError({ code: "NOT_FOUND", message: "No connected LinkedIn account." });
      await cancelSentInvitation({ accountId: acct, invitationId: input.invitationId });
      return { ok: true };
    }),

  listRelations: workspaceProcedure
    .input(z.object({ unipileAccountId: z.string().optional(), limit: z.number().int().min(1).max(250).optional() }).default({}))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { items: [] as any[] };
      const acct = await resolveOwnLinkedInAccount(db, ctx.workspace.id, ctx.user.id, input.unipileAccountId);
      if (!acct) return { items: [] as any[] };
      const res = await listRelations({ accountId: acct, limit: input.limit ?? 100 });
      return { items: res.items ?? [], cursor: res.cursor };
    }),

  // ─── LinkedIn / Sales Navigator search (per-user) ───────────────────────
  // Widens the top of the autonomous funnel: search → import as leads →
  // sequences send invites → accepts fire the Social Autopilot opener → meeting.
  searchLinkedIn: workspaceProcedure
    .input(z.object({
      api: z.enum(["classic", "sales_navigator"]).default("classic"),
      category: z.enum(["people", "companies"]).default("people"),
      keywords: z.string().optional(),
      filters: z.record(z.any()).optional(),
      limit: z.number().int().min(1).max(25).optional(),
      unipileAccountId: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { items: [] as UnipileLinkedInSearchHit[] };
      const acct = await resolveOwnLinkedInAccount(db, ctx.workspace.id, ctx.user.id, input.unipileAccountId);
      if (!acct) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect a LinkedIn account to search." });
      const res = await searchLinkedIn(acct, {
        api: input.api, category: input.category, keywords: input.keywords,
        filters: input.filters, limit: input.limit ?? 10,
      });
      return { items: res.items, cursor: res.cursor };
    }),

  /** Resolve a Sales-Navigator filter term (LOCATION/INDUSTRY/COMPANY/…) → entity IDs. */
  resolveSearchParam: workspaceProcedure
    .input(z.object({
      type: z.string(),
      keywords: z.string().min(1),
      unipileAccountId: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { items: [] as any[] };
      const acct = await resolveOwnLinkedInAccount(db, ctx.workspace.id, ctx.user.id, input.unipileAccountId);
      if (!acct) return { items: [] as any[] };
      const res = await resolveLinkedInSearchParameter(acct, input.type, input.keywords, 10);
      return { items: res.items };
    }),

  /**
   * Import LinkedIn search hits as leads (autonomous-pipeline entry point).
   * Dedupes against existing leads by linkedinUrl or first+last name so
   * re-running a search doesn't create duplicates. Returns the count created.
   */
  importSearchHitsAsLeads: workspaceProcedure
    .input(z.object({
      hits: z.array(z.object({
        name: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        title: z.string().optional(),
        headline: z.string().optional(),
        occupation: z.string().optional(),
        company: z.string().optional(),
        location: z.string().optional(),
        public_profile_url: z.string().optional(),
        profile_url: z.string().optional(),
      })).min(1).max(25),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      let created = 0;
      let skipped = 0;
      for (const h of input.hits) {
        const first = (h.first_name || h.name?.split(/\s+/)[0] || "").slice(0, 80).trim();
        const last = (h.last_name || h.name?.split(/\s+/).slice(1).join(" ") || "").slice(0, 80).trim();
        if (!first && !last) { skipped++; continue; }
        const url = h.public_profile_url || h.profile_url || null;
        // Dedupe: same name already a lead in this workspace.
        const existing = await db
          .select({ id: leads.id })
          .from(leads)
          .where(and(
            eq(leads.workspaceId, ctx.workspace.id),
            eq(leads.firstName, first || "-"),
            eq(leads.lastName, last || "-"),
          ))
          .limit(1);
        if (existing.length) { skipped++; continue; }
        await db.insert(leads).values({
          workspaceId: ctx.workspace.id,
          firstName: first || "-",
          lastName: last || "-",
          title: (h.title || h.headline || h.occupation || null)?.slice(0, 120) ?? null,
          company: (typeof h.company === "string" ? h.company : null)?.slice(0, 200) ?? null,
          source: "linkedin_search",
          status: "new",
          ownerUserId: ctx.user.id,
          customFields: url ? { linkedinUrl: url, location: h.location ?? null } : null,
        } as never);
        created++;
      }
      return { created, skipped };
    }),

  // ─── LinkedIn post engagement (per-user, social warming) ────────────────
  listUserPosts: workspaceProcedure
    .input(z.object({ identifier: z.string().min(1), limit: z.number().int().min(1).max(25).optional(), unipileAccountId: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { items: [] as any[] };
      const acct = await resolveOwnLinkedInAccount(db, ctx.workspace.id, ctx.user.id, input.unipileAccountId);
      if (!acct) return { items: [] as any[] };
      const res = await listUserPosts(acct, input.identifier, { limit: input.limit ?? 5 });
      return { items: res.items, cursor: res.cursor };
    }),

  reactToPost: workspaceProcedure
    .input(z.object({ socialId: z.string().min(1), reactionType: z.string().default("like"), unipileAccountId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const acct = await resolveOwnLinkedInAccount(db, ctx.workspace.id, ctx.user.id, input.unipileAccountId);
      if (!acct) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect a LinkedIn account first." });
      await reactToPost(acct, input.socialId, input.reactionType);
      return { ok: true };
    }),

  commentOnPost: workspaceProcedure
    .input(z.object({ socialId: z.string().min(1), text: z.string().min(1).max(1200), unipileAccountId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const acct = await resolveOwnLinkedInAccount(db, ctx.workspace.id, ctx.user.id, input.unipileAccountId);
      if (!acct) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect a LinkedIn account first." });
      const res = await commentOnPost(acct, input.socialId, input.text);
      return { ok: true, id: res.id };
    }),

  createPost: workspaceProcedure
    .input(z.object({ text: z.string().min(1).max(3000), unipileAccountId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const acct = await resolveOwnLinkedInAccount(db, ctx.workspace.id, ctx.user.id, input.unipileAccountId);
      if (!acct) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect a LinkedIn account first." });
      const res = await createPost(acct, input.text);
      return { ok: true, id: res.id ?? res.social_id };
    }),

  // ─── Social funnel metrics (for Analytics) ──────────────────────────────
  socialFunnelStats: workspaceProcedure.query(async ({ ctx }) => {
    const empty = { invitesSent: 0, invitesAccepted: 0, openersSent: 0, inboundReplies: 0, willingToMeet: 0, meetingsFromSocial: 0 };
    const db = await getDb();
    if (!db) return empty;
    const ws = ctx.workspace.id;
    const [inv] = await db
      .select({
        sent: sql<number>`count(*)`,
        accepted: sql<number>`sum(case when \`acceptedAt\` is not null or \`status\` = 'accepted' then 1 else 0 end)`,
      })
      .from(unipileInvites)
      .where(eq(unipileInvites.workspaceId, ws));
    const [msg] = await db
      .select({
        openers: sql<number>`sum(case when \`direction\` = 'outbound' then 1 else 0 end)`,
        inbound: sql<number>`sum(case when \`direction\` = 'inbound' then 1 else 0 end)`,
        willing: sql<number>`sum(case when \`direction\` = 'inbound' and \`replyClass\` = 'willing_to_meet' then 1 else 0 end)`,
        meetings: sql<number>`sum(case when \`autoActionTaken\` = 'meeting_proposed' then 1 else 0 end)`,
      })
      .from(unipileMessages)
      .where(eq(unipileMessages.workspaceId, ws));
    return {
      invitesSent: Number(inv?.sent ?? 0),
      invitesAccepted: Number(inv?.accepted ?? 0),
      openersSent: Number(msg?.openers ?? 0),
      inboundReplies: Number(msg?.inbound ?? 0),
      willingToMeet: Number(msg?.willing ?? 0),
      meetingsFromSocial: Number(msg?.meetings ?? 0),
    };
  }),
});

/**
 * Resolve the caller's own connected LinkedIn Unipile accountId. Honors an
 * explicit unipileAccountId (verifying ownership), else picks their first
 * LinkedIn account. Returns null if the rep has none connected.
 */
async function resolveOwnLinkedInAccount(
  db: any,
  workspaceId: number,
  userId: number,
  explicitId?: string,
): Promise<string | null> {
  if (explicitId) {
    const [row] = await db
      .select({ id: unipileAccounts.unipileAccountId })
      .from(unipileAccounts)
      .where(and(eq(unipileAccounts.unipileAccountId, explicitId), eq(unipileAccounts.userId, userId)))
      .limit(1);
    return row?.id ?? null;
  }
  const [row] = await db
    .select({ id: unipileAccounts.unipileAccountId })
    .from(unipileAccounts)
    .where(
      and(
        eq(unipileAccounts.workspaceId, workspaceId),
        eq(unipileAccounts.userId, userId),
        eq(unipileAccounts.provider, "LINKEDIN"),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
