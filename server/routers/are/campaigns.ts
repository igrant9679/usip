/**
 * ARE — Campaigns Router
 *
 * Manages autonomous prospecting campaign lifecycle:
 *   list, get, create, update, setStatus, approveBatch
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { areCampaigns, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";

export const campaignsRouter = router({
  list: workspaceProcedure
    .input(z.object({ status: z.string().optional(), limit: z.number().default(50) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const conditions = [eq(areCampaigns.workspaceId, ctx.workspace.id)];
      if (input.status) {
        conditions.push(eq(areCampaigns.status, input.status as "draft" | "active" | "paused" | "completed"));
      }
      return db
        .select()
        .from(areCampaigns)
        .where(and(...conditions))
        .orderBy(desc(areCampaigns.createdAt))
        .limit(input.limit);
    }),

  get: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [campaign] = await db
        .select()
        .from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND" });
      return campaign;
    }),

  create: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(2).max(200),
        description: z.string().optional(),
        autonomyMode: z.enum(["full", "batch_approval", "review_release"]).default("batch_approval"),
        icpProfileId: z.number().optional(),
        icpOverrides: z.any().optional(),
        prospectSources: z.array(z.string()).default(["internal", "google_business", "linkedin", "news"]),
        targetProspectCount: z.number().min(1).max(10000).default(100),
        dailySendCap: z.number().min(1).max(500).default(50),
        channelsEnabled: z.object({
          email: z.boolean().default(true),
          linkedin: z.boolean().default(false),
          sms: z.boolean().default(false),
          voice: z.boolean().default(false),
        }).default({ email: true, linkedin: false, sms: false, voice: false }),
        sequenceTemplate: z.string().default("standard_7step"),
        goalType: z.enum(["meeting_booked", "reply", "opportunity_created"]).default("reply"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .insert(areCampaigns)
        .values({
          workspaceId: ctx.workspace.id,
          name: input.name,
          description: input.description,
          autonomyMode: input.autonomyMode,
          icpProfileId: input.icpProfileId,
          icpOverrides: input.icpOverrides,
          prospectSources: input.prospectSources,
          targetProspectCount: input.targetProspectCount,
          dailySendCap: input.dailySendCap,
          channelsEnabled: input.channelsEnabled,
          sequenceTemplate: input.sequenceTemplate,
          goalType: input.goalType,
          ownerUserId: ctx.user.id,
        })
        .$returningId();
      return { id: row.id };
    }),

  update: workspaceProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(2).max(200).optional(),
        description: z.string().optional(),
        autonomyMode: z.enum(["full", "batch_approval", "review_release"]).optional(),
        targetProspectCount: z.number().min(1).max(10000).optional(),
        dailySendCap: z.number().min(1).max(500).optional(),
        channelsEnabled: z.any().optional(),
        sequenceTemplate: z.string().optional(),
        goalType: z.enum(["meeting_booked", "reply", "opportunity_created"]).optional(),
        icpOverrides: z.any().optional(),
        prospectSources: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { id, ...rest } = input;
      const updates: Partial<typeof areCampaigns.$inferInsert> = {};
      if (rest.name !== undefined) updates.name = rest.name;
      if (rest.description !== undefined) updates.description = rest.description;
      if (rest.autonomyMode !== undefined) updates.autonomyMode = rest.autonomyMode;
      if (rest.targetProspectCount !== undefined) updates.targetProspectCount = rest.targetProspectCount;
      if (rest.dailySendCap !== undefined) updates.dailySendCap = rest.dailySendCap;
      if (rest.channelsEnabled !== undefined) updates.channelsEnabled = rest.channelsEnabled;
      if (rest.sequenceTemplate !== undefined) updates.sequenceTemplate = rest.sequenceTemplate;
      if (rest.goalType !== undefined) updates.goalType = rest.goalType;
      if (rest.icpOverrides !== undefined) updates.icpOverrides = rest.icpOverrides;
      if (rest.prospectSources !== undefined) updates.prospectSources = rest.prospectSources;
      await db
        .update(areCampaigns)
        .set(updates)
        .where(and(eq(areCampaigns.id, id), eq(areCampaigns.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),

  setStatus: workspaceProcedure
    .input(z.object({ id: z.number(), status: z.enum(["draft", "active", "paused", "completed"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const updates: Partial<typeof areCampaigns.$inferInsert> = { status: input.status };
      if (input.status === "active") updates.startedAt = new Date();
      if (input.status === "completed") updates.completedAt = new Date();
      await db
        .update(areCampaigns)
        .set(updates)
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),

  /** Approve a batch of prospects for enrollment */
  approveBatch: workspaceProcedure
    .input(z.object({ campaignId: z.number(), prospectIds: z.array(z.number()) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.prospectIds.length === 0) return { approved: 0 };

      for (const pid of input.prospectIds) {
        await db
          .update(prospectQueue)
          .set({
            sequenceStatus: "approved",
            approvedAt: new Date(),
            approvedByUserId: ctx.user.id,
          })
          .where(
            and(
              eq(prospectQueue.id, pid),
              eq(prospectQueue.campaignId, input.campaignId),
              eq(prospectQueue.workspaceId, ctx.workspace.id),
            ),
          );
      }

      // Update campaign counter
      await db
        .update(areCampaigns)
        .set({
          prospectsApproved: input.prospectIds.length,
        })
        .where(eq(areCampaigns.id, input.campaignId));

      return { approved: input.prospectIds.length };
    }),

  delete: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(areCampaigns)
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),
});
