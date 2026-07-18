/**
 * ARE — Campaigns Router
 *
 * Manages autonomous prospecting campaign lifecycle:
 *   list, get, create, update, setStatus, approveBatch
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { areCampaigns, personas, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";
import { runAreEngine } from "../../areEngine";
import { invokeLLM } from "../../_core/llm";
import { ARE_DEFAULT_SOURCES, normalizeSources } from "@shared/areSources";

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
        /**
         * Optional reusable persona to seed icpOverrides from. The persona's
         * targeting fields fill any unset fields on icpOverrides; explicit
         * icpOverrides keys win.
         */
        personaId: z.number().optional(),
        /**
         * Per-campaign targeting that overrides the workspace ICP for this
         * campaign's discovery. The wizard fills this with
         * { targetTitles, targetIndustries, employeeMin, employeeMax, keywords }.
         */
        icpOverrides: z.any().optional(),
        // Default: every working source (shared/areSources.ts). Unknown ids
        // are dropped so a stale client can't persist a dead source.
        prospectSources: z
          .array(z.string())
          .default([...ARE_DEFAULT_SOURCES])
          .transform((v) => normalizeSources(v)),
        targetProspectCount: z.number().min(1).max(10000).default(100),
        dailySendCap: z.number().min(1).max(500).default(50),
        channelsEnabled: z.object({
          email: z.boolean().default(true),
          linkedin: z.boolean().default(false),
          sms: z.boolean().default(false),
          voice: z.boolean().default(false),
        }).default({ email: true, linkedin: false, sms: false, voice: false }),
        sequenceTemplate: z.string().default("standard_7step"),
        /** Optional free-form instructions appended to the Sequence Agent's
         *  system prompt for this campaign — voice, tone, do/don't lists. */
        sequencePrompt: z.string().max(4000).nullable().optional(),
        /** Structured prompting editor (0090). Subject/body are AI guidance;
         *  signature is a literal block appended to every generated email. */
        promptSubject: z.string().max(2000).nullable().optional(),
        promptBody: z.string().max(4000).nullable().optional(),
        promptSignature: z.string().max(2000).nullable().optional(),
        goalType: z.enum(["meeting_booked", "reply", "opportunity_created"]).default("reply"),
        autoApproveThreshold: z.number().min(0).max(100).nullable().optional(),
        signalToOpportunityEnabled: z.boolean().default(false),
        /**
         * When true, the campaign is created as `active` (not the default
         * `draft`) and the ARE engine is fired once in the background so the
         * user sees activity within seconds instead of waiting for the next
         * 10-minute cron tick.
         */
        launch: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Resolve persona → seed icpOverrides if a personaId was supplied.
      let icpOverrides: any = input.icpOverrides;
      if (input.personaId) {
        const [p] = await db
          .select()
          .from(personas)
          .where(and(eq(personas.id, input.personaId), eq(personas.workspaceId, ctx.workspace.id)))
          .limit(1);
        if (p) {
          icpOverrides = {
            targetTitles: p.targetTitles ?? [],
            targetIndustries: p.targetIndustries ?? [],
            targetGeographies: p.targetGeographies ?? [],
            employeeMin: p.employeeMin ?? undefined,
            employeeMax: p.employeeMax ?? undefined,
            keywords: p.keywords ?? [],
            ...(input.icpOverrides ?? {}),
          };
        }
      }

      const [row] = await db
        .insert(areCampaigns)
        .values({
          workspaceId: ctx.workspace.id,
          name: input.name,
          description: input.description,
          autonomyMode: input.autonomyMode,
          icpProfileId: input.icpProfileId,
          icpOverrides,
          prospectSources: input.prospectSources,
          targetProspectCount: input.targetProspectCount,
          dailySendCap: input.dailySendCap,
          channelsEnabled: input.channelsEnabled,
          sequenceTemplate: input.sequenceTemplate,
          sequencePrompt: input.sequencePrompt ?? null,
          promptSubject: input.promptSubject ?? null,
          promptBody: input.promptBody ?? null,
          promptSignature: input.promptSignature ?? null,
          goalType: input.goalType,
          autoApproveThreshold: input.autoApproveThreshold ?? null,
          signalToOpportunityEnabled: input.signalToOpportunityEnabled,
          ownerUserId: ctx.user.id,
          ...(input.launch ? { status: "active" as const, startedAt: new Date() } : {}),
        })
        .$returningId();
      // Kick the engine once immediately on launch so phase 1 (enrich) and
      // phase 8 (discovery) fire within seconds — the 10-min cron picks up
      // every subsequent tick on its own.
      if (input.launch) {
        runAreEngine().catch((e) =>
          console.error("[campaigns.create] launch tick failed:", e),
        );
      }
      return { id: row.id, launched: input.launch };
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
        sequencePrompt: z.string().max(4000).nullable().optional(),
        promptSubject: z.string().max(2000).nullable().optional(),
        promptBody: z.string().max(4000).nullable().optional(),
        promptSignature: z.string().max(2000).nullable().optional(),
        goalType: z.enum(["meeting_booked", "reply", "opportunity_created"]).optional(),
        icpOverrides: z.any().optional(),
        prospectSources: z.array(z.string()).optional().transform((v) => (v === undefined ? undefined : normalizeSources(v))),
        autoApproveThreshold: z.number().min(0).max(100).nullable().optional(),
        minConfidence: z.number().int().min(0).max(100).nullable().optional(),
        signalToOpportunityEnabled: z.boolean().optional(),
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
      // sequencePrompt, promptSubject, and promptBody all feed the LLM prompts
      // that build the cached campaign skeleton. Editing any of them must clear
      // generatedTemplate so the change takes effect on the next generation —
      // otherwise the user edits the prompt and nothing changes (the template
      // generator only runs when generatedTemplate is null). promptSignature is
      // appended AFTER generation, so it doesn't need to bust the cache.
      let bustTemplate = false;
      if (rest.sequencePrompt !== undefined) {
        updates.sequencePrompt = rest.sequencePrompt ?? null;
        bustTemplate = true;
      }
      if (rest.promptSubject !== undefined) {
        updates.promptSubject = rest.promptSubject ?? null;
        bustTemplate = true;
      }
      if (rest.promptBody !== undefined) {
        updates.promptBody = rest.promptBody ?? null;
        bustTemplate = true;
      }
      if (rest.promptSignature !== undefined) {
        updates.promptSignature = rest.promptSignature ?? null;
      }
      if (bustTemplate) {
        updates.generatedTemplate = null;
        updates.generatedTemplateAt = null;
      }
      if (rest.goalType !== undefined) updates.goalType = rest.goalType;
      if (rest.icpOverrides !== undefined) updates.icpOverrides = rest.icpOverrides;
      if (rest.prospectSources !== undefined) updates.prospectSources = rest.prospectSources;
      if (rest.autoApproveThreshold !== undefined) updates.autoApproveThreshold = rest.autoApproveThreshold;
      if (rest.minConfidence !== undefined) updates.minConfidence = rest.minConfidence;
      if (rest.signalToOpportunityEnabled !== undefined) updates.signalToOpportunityEnabled = rest.signalToOpportunityEnabled;
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

  /**
   * AI targeting generation — the "runs on its own" setup step. Turns a
   * one-line audience description (e.g. "nonprofit executives at grant-making
   * foundations in the US") into structured discovery targeting so a campaign
   * can be configured with zero manual field entry. Returns the fields; the
   * caller applies them to the wizard / campaign.
   */
  generateTargeting: workspaceProcedure
    .input(z.object({ description: z.string().min(3).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const res = await invokeLLM({
        workspaceId: ctx.workspace.id,
        messages: [
          {
            role: "system",
            content:
              "You are a B2B go-to-market strategist. Convert a plain-English description of a target audience into precise prospecting filters. Return concrete, searchable job titles (include common variants), specific industries, geographies, and intent keywords. Prefer 4-8 titles, 2-5 industries, 1-3 geographies, 2-5 keywords. Use widely-recognised industry names. If a field isn't implied, return an empty array — never invent geographies the user didn't imply.",
          },
          { role: "user", content: `Audience: ${input.description}` },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "campaign_targeting",
            strict: true,
            schema: {
              type: "object",
              properties: {
                targetTitles: { type: "array", items: { type: "string" } },
                targetIndustries: { type: "array", items: { type: "string" } },
                targetGeographies: { type: "array", items: { type: "string" } },
                keywords: { type: "array", items: { type: "string" } },
              },
              required: ["targetTitles", "targetIndustries", "targetGeographies", "keywords"],
              additionalProperties: false,
            },
          },
        },
      });
      const content = res.choices[0]?.message?.content;
      if (!content) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI returned no targeting" });
      let parsed: {
        targetTitles?: unknown; targetIndustries?: unknown;
        targetGeographies?: unknown; keywords?: unknown;
      };
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI targeting was not valid JSON" });
      }
      const clean = (v: unknown): string[] =>
        Array.isArray(v)
          ? Array.from(new Set(v.map((s) => String(s).trim()).filter(Boolean))).slice(0, 12)
          : [];
      return {
        targetTitles: clean(parsed.targetTitles),
        targetIndustries: clean(parsed.targetIndustries),
        targetGeographies: clean(parsed.targetGeographies),
        keywords: clean(parsed.keywords),
      };
    }),

  /** Approve a batch of prospects for enrollment */
  approveBatch: workspaceProcedure
    .input(z.object({ campaignId: z.number(), prospectIds: z.array(z.number()) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.prospectIds.length === 0) return { approved: 0 };

      let approved = 0;
      for (const pid of input.prospectIds) {
        const result = await db
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
        if ((result[0] as { affectedRows?: number }).affectedRows) approved++;
      }

      // Recount from the queue instead of writing the batch size — the old
      // `prospectsApproved: input.prospectIds.length` RESET the counter on
      // every batch (10 approved + 5 more showed 5). A recount is drift-proof
      // and idempotent. Workspace-scoped (the old update wasn't).
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)` })
        .from(prospectQueue)
        .where(
          and(
            eq(prospectQueue.campaignId, input.campaignId),
            eq(prospectQueue.workspaceId, ctx.workspace.id),
            eq(prospectQueue.sequenceStatus, "approved"),
          ),
        );
      await db
        .update(areCampaigns)
        .set({ prospectsApproved: Number(n) })
        .where(and(eq(areCampaigns.id, input.campaignId), eq(areCampaigns.workspaceId, ctx.workspace.id)));

      return { approved };
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

  /**
   * Manually run one ARE engine tick now. The engine also runs on a 10-minute
   * cron; this lets an operator drive it on demand and see the per-phase
   * counts (enriched / approved / enrolled / sent / …) come back immediately.
   */
  runEngine: workspaceProcedure.mutation(async () => {
    return runAreEngine();
  }),
});
