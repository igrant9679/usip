/**
 * ARE — Campaigns Router
 *
 * Manages autonomous prospecting campaign lifecycle:
 *   list, get, create, update, setStatus, approveBatch
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { areCampaigns, campaignRoutingSuggestions, personas, prospectIntelligence, prospectQueue, prospects, sequences, workspaceSettings } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { router } from "../../_core/trpc";
import { adminWsProcedure, workspaceProcedure } from "../../_core/workspace";
import { runAreEngine } from "../../areEngine";
import { recordAudit } from "../../audit";
import { invokeLLM } from "../../_core/llm";
import { ARE_DEFAULT_SOURCES, normalizeSources } from "@shared/areSources";
import { MIN_STEP_GAP_DAYS, MAX_STEP_GAP_DAYS, effectiveStepGapDays, planRespaceForProspect, sanitizeDayOffsets } from "@shared/areStepCadence";
import { areExecutionQueue } from "../../../drizzle/schema";

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
        /** Days between consecutive steps (0169). Default one week. */
        stepGapDays: z.number().int().min(MIN_STEP_GAP_DAYS).max(MAX_STEP_GAP_DAYS).default(7),
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
          stepGapDays: input.stepGapDays,
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

  /**
   * One dial for the whole engine (Autonomy Center, audit 2026-09-02). The
   * workspace default only ever governed campaigns created LATER, so the
   * page's "engine autonomy" control changed nothing that was running and
   * "All: Off" skipped the engine altogether. This sets every non-archived
   * campaign AND the default in one call. `full` approves+sends above each
   * campaign's own threshold; `batch_approval` is the engine's safest mode
   * (nothing approved without a human). review_release is gone: it never had
   * a branch — the engine treats any remaining rows as batch_approval.
   */
  /* ── Campaign routing (phase 3): the best-fit router ─────────────────── */

  getRoutingSettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { mode: "off" as const, dailyCap: 25, lastRunAt: null as Date | null };
    const [row] = await db.select({ mode: workspaceSettings.campaignRoutingMode, dailyCap: workspaceSettings.campaignRoutingDailyCap, lastRunAt: workspaceSettings.campaignRoutingLastRunAt })
      .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
    return row ?? { mode: "off" as const, dailyCap: 25, lastRunAt: null };
  }),

  setRoutingSettings: adminWsProcedure
    .input(z.object({ mode: z.enum(["off", "approval", "auto"]), dailyCap: z.number().int().min(1).max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: Record<string, unknown> = { campaignRoutingMode: input.mode };
      if (input.dailyCap !== undefined) set.campaignRoutingDailyCap = input.dailyCap;
      await db.insert(workspaceSettings).values({ workspaceId: ctx.workspace.id, ...set } as never).onDuplicateKeyUpdate({ set: set as never });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "campaign_routing_settings", entityId: ctx.workspace.id, after: input });
      return { ok: true as const };
    }),

  /** Score people against every active campaign. Read-only: returns picks. */
  routeBestFit: workspaceProcedure
    .input(z.object({
      prospectIds: z.array(z.number().int().positive()).max(100).default([]),
      contactIds: z.array(z.number().int().positive()).max(100).default([]),
      leadIds: z.array(z.number().int().positive()).max(100).default([]),
    }).refine((v) => v.prospectIds.length + v.contactIds.length + v.leadIds.length > 0, { message: "Pick at least one person." }))
    .query(async ({ ctx, input }) => {
      const { resolveToPeopleIds } = await import("../../services/crossEngineEnrollment");
      const { routeProspects } = await import("../../services/campaignRouter");
      const resolved = await resolveToPeopleIds(ctx.workspace.id, input);
      const picks = await routeProspects(ctx.workspace.id, resolved.prospectIds);
      const db = await getDb();
      const names = db && resolved.prospectIds.length
        ? await db.select({ id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName }).from(prospects)
            .where(and(eq(prospects.workspaceId, ctx.workspace.id), inArray(prospects.id, resolved.prospectIds)))
        : [];
      const nameOf = new Map(names.map((n) => [n.id, `${n.firstName ?? ""} ${n.lastName ?? ""}`.trim()]));
      return { picks: picks.map((p) => ({ ...p, name: nameOf.get(p.prospectId) ?? `#${p.prospectId}` })), unresolved: resolved.unresolved };
    }),

  /** Enroll confirmed picks through the one write path. */
  applyBestFit: workspaceProcedure
    .input(z.object({ picks: z.array(z.object({ prospectId: z.number().int().positive(), campaignId: z.number().int().positive(), fit: z.number().int().min(0).max(100), reasoning: z.string().max(400).default("") })).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const { applyPicks } = await import("../../services/campaignRouter");
      const r = await applyPicks(ctx.workspace.id, input.picks.map((p) => ({ ...p, campaignName: null, alternatives: [], usedModel: false })));
      const db = await getDb();
      if (db) {
        await db.insert(campaignRoutingSuggestions).values(input.picks.map((p) => ({
          workspaceId: ctx.workspace.id, prospectId: p.prospectId, campaignId: p.campaignId, fit: p.fit, reasoning: p.reasoning,
          status: "accepted" as const, source: "manual" as const, decidedAt: new Date(), decidedBy: ctx.user.id,
        })) as never);
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "campaign_routing_apply", entityId: 0, after: r });
      return r;
    }),

  listRoutingSuggestions: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select({
        id: campaignRoutingSuggestions.id, prospectId: campaignRoutingSuggestions.prospectId, campaignId: campaignRoutingSuggestions.campaignId,
        campaignName: areCampaigns.name, fit: campaignRoutingSuggestions.fit, reasoning: campaignRoutingSuggestions.reasoning,
        alternatives: campaignRoutingSuggestions.alternatives, createdAt: campaignRoutingSuggestions.createdAt,
        firstName: prospects.firstName, lastName: prospects.lastName, title: prospects.title, company: prospects.company,
      })
        .from(campaignRoutingSuggestions)
        .innerJoin(areCampaigns, eq(areCampaigns.id, campaignRoutingSuggestions.campaignId))
        .innerJoin(prospects, eq(prospects.id, campaignRoutingSuggestions.prospectId))
        .where(and(eq(campaignRoutingSuggestions.workspaceId, ctx.workspace.id), eq(campaignRoutingSuggestions.status, "pending")))
        .orderBy(desc(campaignRoutingSuggestions.fit), desc(campaignRoutingSuggestions.id))
        .limit(input?.limit ?? 50);
    }),

  decideRoutingSuggestion: workspaceProcedure
    .input(z.object({ id: z.number().int().positive(), decision: z.enum(["accept", "dismiss"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [s] = await db.select().from(campaignRoutingSuggestions)
        .where(and(eq(campaignRoutingSuggestions.id, input.id), eq(campaignRoutingSuggestions.workspaceId, ctx.workspace.id), eq(campaignRoutingSuggestions.status, "pending")));
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Suggestion not found or already decided" });
      let result: { added: number; skipped: number } = { added: 0, skipped: 0 };
      if (input.decision === "accept") {
        const { applyPicks } = await import("../../services/campaignRouter");
        result = await applyPicks(ctx.workspace.id, [{ prospectId: s.prospectId, campaignId: s.campaignId, campaignName: null, fit: s.fit, reasoning: s.reasoning ?? "", alternatives: [], usedModel: false }]);
      }
      await db.update(campaignRoutingSuggestions)
        .set({ status: input.decision === "accept" ? "accepted" : "dismissed", decidedAt: new Date(), decidedBy: ctx.user.id } as never)
        .where(and(eq(campaignRoutingSuggestions.id, input.id), eq(campaignRoutingSuggestions.workspaceId, ctx.workspace.id)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "campaign_routing_suggestion", entityId: input.id, after: { decision: input.decision, ...result } });
      return { ok: true as const, ...result };
    }),

  /**
   * Proposed NEW campaigns (owner ask 2026-09-04): the people no active
   * campaign fits, clustered into audiences, each with the targeting and
   * copy mode a campaign for them would carry. Same dial as routing. All
   * logic in services/campaignProposals.ts; these are the seams.
   */
  listProposals: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }).optional())
    .query(async ({ ctx, input }) => {
      const { listPendingProposals } = await import("../../services/campaignProposals");
      return listPendingProposals(ctx.workspace.id, input?.limit ?? 10);
    }),

  decideProposal: workspaceProcedure
    .input(z.object({ id: z.number().int().positive(), decision: z.enum(["accept", "dismiss"]) }))
    .mutation(async ({ ctx, input }) => {
      const { acceptProposal, dismissProposal } = await import("../../services/campaignProposals");
      let result: { campaignId: number | null; added: number; skipped: number };
      try {
        result = input.decision === "accept"
          ? await acceptProposal(ctx.workspace.id, input.id, ctx.user.id)
          : await dismissProposal(ctx.workspace.id, input.id, ctx.user.id);
      } catch (e) {
        throw new TRPCError({ code: "NOT_FOUND", message: (e as Error).message || "Proposal not found" });
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "campaign_proposal", entityId: input.id, after: { decision: input.decision, ...result } });
      return { ok: true as const, ...result };
    }),

  /** Admin: analyse People now and propose campaigns (records pending rows; never creates). */
  generateProposals: adminWsProcedure
    .mutation(async ({ ctx }) => {
      const { generateProposals } = await import("../../services/campaignProposals");
      const r = await generateProposals(ctx.workspace.id, { source: "manual" });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "campaign_proposal", entityId: ctx.workspace.id, after: r });
      return r;
    }),

  /**
   * A CRM Sequence becomes a fixed-copy campaign in the ONE engine (phase 6).
   * Email steps carry over verbatim (subject, body, merge tags); `days` gaps
   * become cumulative day offsets; task/wait steps only contribute their
   * gap. Created as a DRAFT with batch approval and no targeting, so the
   * owner reviews the steps and adds people (or targeting) before it sends.
   */
  createFixedFromSequence: workspaceProcedure
    .input(z.object({ sequenceId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [seq] = await db.select().from(sequences)
        .where(and(eq(sequences.id, input.sequenceId), eq(sequences.workspaceId, ctx.workspace.id))).limit(1);
      if (!seq) throw new TRPCError({ code: "NOT_FOUND", message: "Sequence not found" });
      const raw = Array.isArray(seq.steps) ? (seq.steps as unknown[]) : [];
      let day = 0;
      const fixedSteps: Array<{ stepIndex: number; day: number; channel: "email"; subject: string; body: string }> = [];
      for (const s of raw) {
        const x = (s ?? {}) as Record<string, unknown>;
        const gap = Number(x.days ?? x.waitDays ?? 0);
        if (Number.isFinite(gap) && gap > 0) day += gap;
        if (x.enabled === false) continue;
        if (x.type !== "email") continue; // task/wait steps: gap only
        fixedSteps.push({
          stepIndex: fixedSteps.length,
          day,
          channel: "email",
          subject: String(x.subject ?? "").slice(0, 240),
          body: String(x.body ?? "").slice(0, 8000),
        });
      }
      if (fixedSteps.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "This sequence has no email steps to convert." });
      const name = `${seq.name}`.slice(0, 190);
      const [row] = await db.insert(areCampaigns).values({
        workspaceId: ctx.workspace.id,
        name,
        description: seq.description ?? `Converted from the sequence "${seq.name}" (phase 6)`,
        autonomyMode: "batch_approval",
        icpOverrides: {},
        prospectSources: ARE_DEFAULT_SOURCES,
        targetProspectCount: 100,
        dailySendCap: 25,
        channelsEnabled: { email: true, linkedin: false },
        sequenceTemplate: "standard_7step",
        stepGapDays: 7,
        goalType: "reply",
        ownerUserId: ctx.user.id,
        copyMode: "fixed",
        fixedSteps,
      } as never).$returningId();
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "are_campaign_from_sequence", entityId: row.id, after: { sequenceId: seq.id, steps: fixedSteps.length } });
      return { id: row.id, name, steps: fixedSteps.length };
    }),

  setAllAutonomy: adminWsProcedure
    .input(z.object({ mode: z.enum(["full", "batch_approval"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const res = await db.update(areCampaigns)
        .set({ autonomyMode: input.mode } as never)
        .where(and(eq(areCampaigns.workspaceId, ctx.workspace.id), ne(areCampaigns.status, "archived" as never)));
      await db.insert(workspaceSettings)
        .values({ workspaceId: ctx.workspace.id, areDefaultAutonomyMode: input.mode } as never)
        .onDuplicateKeyUpdate({ set: { areDefaultAutonomyMode: input.mode } as never });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "are_autonomy_all", entityId: ctx.workspace.id, after: { mode: input.mode, campaignsUpdated: Number((res as any)?.[0]?.affectedRows ?? 0) } });
      return { ok: true as const, campaignsUpdated: Number((res as any)?.[0]?.affectedRows ?? 0) };
    }),

  update: workspaceProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(2).max(200).optional(),
        description: z.string().optional(),
        autonomyMode: z.enum(["full", "batch_approval", "review_release"]).optional(),
        // Copy mode (phase 6): per-person AI copy, or one fixed template per step.
        copyMode: z.enum(["per_person", "fixed"]).optional(),
        fixedSteps: z.array(z.object({
          stepIndex: z.number().int().min(0),
          day: z.number().int().min(0).max(365),
          channel: z.enum(["email", "linkedin"]).default("email"),
          subject: z.string().max(240).default(""),
          body: z.string().max(8000).default(""),
        })).max(12).optional(),
        targetProspectCount: z.number().min(1).max(10000).optional(),
        dailySendCap: z.number().min(1).max(500).optional(),
        channelsEnabled: z.any().optional(),
        sequenceTemplate: z.string().optional(),
        stepGapDays: z.number().int().min(MIN_STEP_GAP_DAYS).max(MAX_STEP_GAP_DAYS).optional(),
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
      if (rest.copyMode !== undefined) updates.copyMode = rest.copyMode;
      if (rest.fixedSteps !== undefined) updates.fixedSteps = rest.fixedSteps;
      if (rest.targetProspectCount !== undefined) updates.targetProspectCount = rest.targetProspectCount;
      if (rest.dailySendCap !== undefined) updates.dailySendCap = rest.dailySendCap;
      if (rest.channelsEnabled !== undefined) updates.channelsEnabled = rest.channelsEnabled;
      if (rest.sequenceTemplate !== undefined) updates.sequenceTemplate = rest.sequenceTemplate;
      if (rest.stepGapDays !== undefined) updates.stepGapDays = effectiveStepGapDays(rest.stepGapDays);
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

  /**
   * Move a campaign's PENDING steps onto its cadence grid (0169): for every
   * in-flight prospect, the k-th step of the ordered sequence is due at
   * first-send + k × stepGapDays (a never-touched prospect keeps its first
   * slot as the anchor); sent rows are untouched; nothing lands in the past.
   * Dry run unless `apply` — the plan says how many rows move and from/to.
   * Owner ask 2026-08-19: the 141 in-flight CommunityForce prospects carried
   * 1–4-day gaps from before the one-week directive.
   */
  respaceSteps: workspaceProcedure
    .input(z.object({ id: z.number(), apply: z.boolean().default(false), gapDays: z.number().int().min(MIN_STEP_GAP_DAYS).max(MAX_STEP_GAP_DAYS).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [campaign] = await db.select().from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id))).limit(1);
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND" });
      const gapDays = effectiveStepGapDays(input.gapDays ?? (campaign as { stepGapDays?: number | null }).stepGapDays);

      const rows = await db
        .select({ id: areExecutionQueue.id, prospectQueueId: areExecutionQueue.prospectQueueId, stepIndex: areExecutionQueue.stepIndex, status: areExecutionQueue.status, scheduledAt: areExecutionQueue.scheduledAt, executedAt: areExecutionQueue.executedAt })
        .from(areExecutionQueue)
        .where(and(eq(areExecutionQueue.workspaceId, ctx.workspace.id), eq(areExecutionQueue.campaignId, input.id)));
      const byProspect = new Map<number, typeof rows>();
      for (const r of rows) { const a = byProspect.get(r.prospectQueueId) ?? []; a.push(r); byProspect.set(r.prospectQueueId, a); }

      // Per-prospect timeline overrides (0170): a campaign respace RE-ANCHORS
      // a custom rhythm, it does not flatten it back onto the uniform grid —
      // clearing an override is the mass timeline editor's explicit call.
      const overrides = new Map<number, number[]>();
      if (byProspect.size > 0) {
        const intel = await db
          .select({ prospectQueueId: prospectIntelligence.prospectQueueId, cadence: prospectIntelligence.cadenceDayOffsets })
          .from(prospectIntelligence)
          .where(and(eq(prospectIntelligence.workspaceId, ctx.workspace.id), inArray(prospectIntelligence.prospectQueueId, Array.from(byProspect.keys()))));
        for (const i of intel) {
          const clean = sanitizeDayOffsets(i.cadence);
          if (clean) overrides.set(i.prospectQueueId, clean);
        }
      }

      const nowMs = Date.now();
      const changes: Array<{ id: number; prospectQueueId: number; stepIndex: number; from: Date; to: Date }> = [];
      let prospectsTouched = 0, prospectsInFlight = 0;
      byProspect.forEach((prows, pq) => {
        if (!prows.some((r) => r.status === "scheduled")) return;
        prospectsInFlight++;
        const plan = planRespaceForProspect(prows, gapDays, nowMs, overrides.get(pq) ?? null);
        if (plan.length) { prospectsTouched++; for (const c of plan) changes.push({ ...c, prospectQueueId: pq }); }
      });
      const times = (arr: Date[]) => arr.length ? { earliest: new Date(Math.min(...arr.map((d) => d.getTime()))).toISOString(), latest: new Date(Math.max(...arr.map((d) => d.getTime()))).toISOString() } : null;
      const plan = {
        campaignId: input.id, gapDays, applied: false,
        prospectsInFlight, prospectsTouched, rowsMoved: changes.length,
        before: times(changes.map((c) => c.from)), after: times(changes.map((c) => c.to)),
        sample: changes.slice(0, 12).map((c) => ({ prospectQueueId: c.prospectQueueId, stepIndex: c.stepIndex, from: c.from.toISOString(), to: c.to.toISOString() })),
      };
      if (!input.apply || changes.length === 0) return plan;
      for (const c of changes) {
        await db.update(areExecutionQueue).set({ scheduledAt: c.to })
          .where(and(eq(areExecutionQueue.id, c.id), eq(areExecutionQueue.workspaceId, ctx.workspace.id), eq(areExecutionQueue.status, "scheduled")));
      }
      if (input.gapDays && input.gapDays !== campaign.stepGapDays) {
        await db.update(areCampaigns).set({ stepGapDays: gapDays } as never).where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id)));
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "are_campaign_respace", entityId: input.id, after: { gapDays, prospectsTouched, rowsMoved: changes.length, before: plan.before, after: plan.after } });
      return { ...plan, applied: true };
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
