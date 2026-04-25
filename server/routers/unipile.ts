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
  unipileAccounts,
  unipileInvites,
  unipileMessages,
} from "../../drizzle/schema";
import {
  deleteUnipileAccount,
  generateHostedAuthLink,
  getChatMessages,
  getLinkedInProfile,
  listChats,
  listUnipileAccounts,
  sendLinkedInInvitation,
  sendMessage,
} from "../lib/unipile";
import { protectedProcedure, router } from "../_core/trpc";

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
  GOOGLE: { label: "Gmail", color: "#EA4335", icon: "gmail" },
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
  "GOOGLE",
  "MICROSOFT",
  "IMAP",
];

// ─── Router ───────────────────────────────────────────────────────────────────

export const unipileRouter = router({
  /**
   * Generate a Hosted Auth Wizard link for the current user.
   * The frontend redirects the user to the returned URL.
   */
  generateConnectLink: protectedProcedure
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
      const notifyUrl = `${appBase}/api/unipile/account-webhook?userId=${ctx.user.id}&workspaceId=${ctx.workspaceId}`;
      const successRedirectUrl = `${appBase}/connected-accounts?connected=1`;
      const expiresOn = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

      const result = await generateHostedAuthLink({
        type: input.reconnectAccountId ? "reconnect" : "create",
        providers: input.providers ?? ALL_PROVIDERS,
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
  listConnectedAccounts: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const rows = await db
      .select()
      .from(unipileAccounts)
      .where(
        and(
          eq(unipileAccounts.workspaceId, ctx.workspaceId),
          eq(unipileAccounts.userId, ctx.user.id),
        ),
      )
      .orderBy(desc(unipileAccounts.createdAt));
    return rows;
  }),

  /**
   * Disconnect (delete) a Unipile account.
   */
  disconnectAccount: protectedProcedure
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
  getInbox: protectedProcedure
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
            eq(unipileAccounts.workspaceId, ctx.workspaceId),
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
  getChatMessages: protectedProcedure
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
   * Send a message via Unipile (to existing chat or new chat).
   */
  sendMessage: protectedProcedure
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
        workspaceId: ctx.workspaceId,
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
          workspaceId: ctx.workspaceId,
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
  sendLinkedInInvite: protectedProcedure
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
        workspaceId: ctx.workspaceId,
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
          workspaceId: ctx.workspaceId,
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
  getLinkedInProfile: protectedProcedure
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
  getStoredMessages: protectedProcedure
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
      const conditions = [eq(unipileMessages.workspaceId, ctx.workspaceId)];
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
  getStoredInvites: protectedProcedure
    .input(
      z.object({
        linkedContactId: z.number().optional(),
        linkedLeadId: z.number().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const conditions = [eq(unipileInvites.workspaceId, ctx.workspaceId)];
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
  metrics: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Total outbound messages in last 30 days
    const [msgRow] = await db
      .select({ total: count() })
      .from(unipileMessages)
      .where(
        and(
          eq(unipileMessages.workspaceId, ctx.workspaceId),
          eq(unipileMessages.direction, "outbound"),
          gte(unipileMessages.createdAt, since30d),
        ),
      );
    const messagesSent = Number(msgRow?.total ?? 0);

    // Total invites sent (all time for denominator, last 30d for numerator)
    const [invTotalRow] = await db
      .select({ total: count() })
      .from(unipileInvites)
      .where(eq(unipileInvites.workspaceId, ctx.workspaceId));
    const invitesTotal = Number(invTotalRow?.total ?? 0);

    const [invAcceptedRow] = await db
      .select({ total: count() })
      .from(unipileInvites)
      .where(
        and(
          eq(unipileInvites.workspaceId, ctx.workspaceId),
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
          eq(unipileMessages.workspaceId, ctx.workspaceId),
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
});
