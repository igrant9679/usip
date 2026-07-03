/**
 * conversations router — the /v2/conversations unified inbound-reply inbox +
 * autonomous AI reply handling. Surfaces `email_replies`, runs the reply
 * classifier (8-class taxonomy), and applies per-class actions — the key one
 * being: a positive ("willing_to_meet") reply spawns a meeting proposal,
 * closing the sequence → reply → meeting loop.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
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
      let rows = await db.select().from(emailReplies)
        .where(eq(emailReplies.workspaceId, ctx.workspace.id))
        .orderBy(desc(emailReplies.receivedAt));
      const f = input?.filter;
      if (f === "unhandled") rows = rows.filter((r) => !r.handledAt);
      else if (f && f !== "all") rows = rows.filter((r) => r.replyClass === f);
      if (input?.unreadOnly) rows = rows.filter((r) => !r.readAt);
      return rows.slice(0, 300);
    }),

  stats: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { total: 0, unhandled: 0, needsClassify: 0, willingToMeet: 0, meetingsProposed: 0 };
    const rows = await db.select({
      classifiedAt: emailReplies.classifiedAt,
      handledAt: emailReplies.handledAt,
      replyClass: emailReplies.replyClass,
      autoActionTaken: emailReplies.autoActionTaken,
    }).from(emailReplies).where(eq(emailReplies.workspaceId, ctx.workspace.id));
    const s = { total: rows.length, unhandled: 0, needsClassify: 0, willingToMeet: 0, meetingsProposed: 0 };
    for (const r of rows) {
      if (!r.handledAt) s.unhandled++;
      if (!r.classifiedAt) s.needsClassify++;
      if (r.replyClass === "willing_to_meet") s.willingToMeet++;
      if (r.autoActionTaken === "meeting_proposed") s.meetingsProposed++;
    }
    return s;
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
