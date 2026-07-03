/**
 * conversations router — the /v2/conversations unified inbound-reply inbox +
 * autonomous AI reply handling. Surfaces `email_replies`, runs the reply
 * classifier (8-class taxonomy), and applies per-class actions — the key one
 * being: a positive ("willing_to_meet") reply spawns a meeting proposal,
 * closing the sequence → reply → meeting loop.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { emailReplies, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { recordAudit } from "../audit";
import { router } from "../_core/trpc";
import { adminWsProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";
import { applyReplyAction, classifyReply, runConversationAutopilotForWorkspace, REPLY_CLASSES } from "../services/replyClassifier";

export const conversationsRouter = router({
  list: workspaceProcedure
    .input(z.object({
      filter: z.enum(["all", "unhandled", ...REPLY_CLASSES]).optional(),
      unreadOnly: z.boolean().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      // Push filters + the 300-row cap into SQL — this table can have tens of
      // thousands of replies, so never load them all into memory.
      const conds = [eq(emailReplies.workspaceId, ctx.workspace.id)];
      const f = input?.filter;
      if (f === "unhandled") conds.push(isNull(emailReplies.handledAt));
      else if (f && f !== "all") conds.push(eq(emailReplies.replyClass, f));
      if (input?.unreadOnly) conds.push(isNull(emailReplies.readAt));
      return db.select().from(emailReplies)
        .where(and(...conds))
        .orderBy(desc(emailReplies.receivedAt))
        .limit(300);
    }),

  stats: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { total: 0, unhandled: 0, needsClassify: 0, willingToMeet: 0, meetingsProposed: 0 };
    // Aggregate in SQL — counting tens of thousands of rows in JS is wasteful.
    const [row] = await db.select({
      total: sql<number>`count(*)`,
      unhandled: sql<number>`sum(case when \`handledAt\` is null then 1 else 0 end)`,
      needsClassify: sql<number>`sum(case when \`classifiedAt\` is null then 1 else 0 end)`,
      willingToMeet: sql<number>`sum(case when \`replyClass\` = 'willing_to_meet' then 1 else 0 end)`,
      meetingsProposed: sql<number>`sum(case when \`autoActionTaken\` = 'meeting_proposed' then 1 else 0 end)`,
    }).from(emailReplies).where(eq(emailReplies.workspaceId, ctx.workspace.id));
    return {
      total: Number(row?.total ?? 0),
      unhandled: Number(row?.unhandled ?? 0),
      needsClassify: Number(row?.needsClassify ?? 0),
      willingToMeet: Number(row?.willingToMeet ?? 0),
      meetingsProposed: Number(row?.meetingsProposed ?? 0),
    };
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return null;
    const [row] = await db.select().from(emailReplies)
      .where(and(eq(emailReplies.id, input.id), eq(emailReplies.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  /** Classify a single reply with AI. */
  classify: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [reply] = await db.select().from(emailReplies)
      .where(and(eq(emailReplies.id, input.id), eq(emailReplies.workspaceId, ctx.workspace.id)));
    if (!reply) throw new TRPCError({ code: "NOT_FOUND" });
    const cls = await classifyReply(ctx.workspace.id, reply);
    return cls ?? { replyClass: "none_of_the_above", sentiment: "neutral", confidence: 0, reasoning: "", suggestedReply: "" };
  }),

  /** Classify a batch of unclassified replies on-demand (approval — no auto-action). */
  classifyRecent: repProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const res = await runConversationAutopilotForWorkspace(ctx.workspace.id, "approval", input?.limit ?? 20);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "ai_classify", entityType: "email_reply", entityId: 0, after: res });
      return res;
    }),

  /** Apply the per-class action for a classified reply (creates meeting/task/suppression). */
  applyAction: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [reply] = await db.select().from(emailReplies)
      .where(and(eq(emailReplies.id, input.id), eq(emailReplies.workspaceId, ctx.workspace.id)));
    if (!reply) throw new TRPCError({ code: "NOT_FOUND" });
    if (!reply.classifiedAt) {
      const cls = await classifyReply(ctx.workspace.id, reply);
      if (cls) reply.replyClass = cls.replyClass as any;
    }
    const action = await applyReplyAction(ctx.workspace.id, reply, true);
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "apply_reply_action", entityType: "email_reply", entityId: input.id, after: { action } });
    return { action };
  }),

  markHandled: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(emailReplies).set({ handledAt: new Date(), handledBy: "user", readAt: new Date() } as never)
      .where(and(eq(emailReplies.id, input.id), eq(emailReplies.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  markRead: repProcedure.input(z.object({ id: z.number(), read: z.boolean().default(true) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(emailReplies).set({ readAt: input.read ? new Date() : null } as never)
      .where(and(eq(emailReplies.id, input.id), eq(emailReplies.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** Ensure the reply is classified and return the AI-suggested reply body. */
  draftReply: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [reply] = await db.select().from(emailReplies)
      .where(and(eq(emailReplies.id, input.id), eq(emailReplies.workspaceId, ctx.workspace.id)));
    if (!reply) throw new TRPCError({ code: "NOT_FOUND" });
    if (reply.suggestedReply) return { body: reply.suggestedReply };
    const cls = await classifyReply(ctx.workspace.id, reply);
    return { body: cls?.suggestedReply ?? "" };
  }),

  getAutopilotSettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { mode: "off" as const, dailyCap: 100, lastRunAt: null as Date | null };
    const [row] = await db.select({
      mode: workspaceSettings.conversationAutopilotMode,
      dailyCap: workspaceSettings.conversationAutopilotDailyCap,
      lastRunAt: workspaceSettings.conversationAutopilotLastRunAt,
    }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
    return row ?? { mode: "off" as const, dailyCap: 100, lastRunAt: null };
  }),

  setAutopilotSettings: adminWsProcedure
    .input(z.object({ mode: z.enum(["off", "approval", "auto"]), dailyCap: z.number().int().min(1).max(1000).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: any = { conversationAutopilotMode: input.mode };
      if (input.dailyCap !== undefined) set.conversationAutopilotDailyCap = input.dailyCap;
      await db.insert(workspaceSettings)
        .values({ workspaceId: ctx.workspace.id, ...set } as never)
        .onDuplicateKeyUpdate({ set });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "conversation_autopilot_settings", entityId: ctx.workspace.id, after: input });
      return { ok: true };
    }),
});
