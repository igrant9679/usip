/**
 * Scoring router — the Velocity Priority Score API.
 *
 * Exposes fit-model CRUD + criteria, distribution preview, primary-model
 * management, per-object calculate/results/breakdown/history, priority reads,
 * batched recalculation jobs, search-annotation helpers, and default-template
 * install. All queries are workspace-scoped.
 *
 * Permission mapping onto workspace roles: view → any member · create/edit/
 * recalculate → manager+ · set-primary / activate / archive / install / CRM →
 * admin+.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { recordAudit } from "../audit";
import {
  listScoreModels, loadModelBundle, createScoreModel, updateScoreModel,
  archiveScoreModel, setPrimaryScoreModel, getPrimaryModel,
  createCriteriaGroup, updateCriteriaGroup, deleteCriteriaGroup,
  createCriterion, updateCriterion, deleteCriterion, validateCriterion,
} from "../services/scoring/modelService";
import { getScoreExplanation } from "../services/scoring/explanationService";
import { getScoreHistory } from "../services/scoring/historyService";
import { previewDistribution } from "../services/scoring/distributionService";
import {
  recalcForObject, queueRecalculation, getRecalculationJob,
} from "../services/scoring/recalculationService";
import { scoreMapForObjects, priorityMapForObjects } from "../services/scoring/searchFilter";
import { installDefaultModels } from "../services/scoring/defaults";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { priorityScoreResults, scoreResults } from "../../drizzle/schema";

const RANK: Record<string, number> = { super_admin: 4, admin: 3, manager: 2, rep: 1 };
function requireRole(role: string, min: "manager" | "admin") {
  if ((RANK[role] ?? 0) < RANK[min]) {
    throw new TRPCError({ code: "FORBIDDEN", message: "You don't have permission to manage scoring." });
  }
}

const objectType = z.enum(["person", "company"]);
const thresholds = z.object({
  excellent_min: z.number().int().min(0).max(100).optional(),
  good_min: z.number().int().min(0).max(100).optional(),
  fair_min: z.number().int().min(0).max(100).optional(),
  not_fit_max: z.number().int().min(0).max(100).optional(),
}).optional();

const criterionInput = z.object({
  groupId: z.number().int().positive(),
  fieldName: z.string().min(1).max(80),
  operator: z.string().min(1).max(32),
  valueJson: z.any(),
  points: z.number().int().min(-20).max(20),
  criterionType: z.enum(["stackable", "mutually_exclusive", "negative", "disqualifier"]),
  impactLabel: z.string().max(32).optional(),
  categoryKey: z.string().max(48).optional(),
  isNegative: z.boolean().optional(),
  isDisqualifier: z.boolean().optional(),
  explanationTemplate: z.string().max(400).optional(),
  orderIndex: z.number().int().optional(),
});

async function resolveModelId(ws: number, ot: "person" | "company", modelId?: number | null): Promise<number | null> {
  if (modelId) return modelId;
  const m = await getPrimaryModel(ws, ot);
  return m?.id ?? null;
}

export const scoringRouter = router({
  /* ── models ── */
  listModels: workspaceProcedure.query(async ({ ctx }) => {
    const models = await listScoreModels(ctx.workspace.id);
    return {
      models,
      primaryPerson: models.find((m) => m.objectType === "person" && m.isPrimary && m.status === "active") ?? null,
      primaryCompany: models.find((m) => m.objectType === "company" && m.isPrimary && m.status === "active") ?? null,
    };
  }),

  getModel: workspaceProcedure
    .input(z.object({ modelId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const bundle = await loadModelBundle(ctx.workspace.id, input.modelId);
      if (!bundle) throw new TRPCError({ code: "NOT_FOUND" });
      return bundle;
    }),

  createModel: workspaceProcedure
    .input(z.object({
      name: z.string().min(1).max(160), objectType,
      modelType: z.enum(["auto", "custom"]).default("custom"),
      description: z.string().max(2000).optional(), impactMode: z.enum(["label", "numeric"]).default("label"),
      thresholds,
    }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const modelId = await createScoreModel({
        workspaceId: ctx.workspace.id, createdByUserId: ctx.user.id,
        name: input.name, objectType: input.objectType, modelType: input.modelType,
        description: input.description, impactMode: input.impactMode, thresholds: input.thresholds,
      });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "score_model", entityId: modelId });
      return { modelId };
    }),

  updateModel: workspaceProcedure
    .input(z.object({
      modelId: z.number().int().positive(),
      name: z.string().min(1).max(160).optional(),
      description: z.string().max(2000).nullable().optional(),
      status: z.enum(["draft", "active", "archived"]).optional(),
      impactMode: z.enum(["label", "numeric"]).optional(),
      thresholds,
    }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const patch: Record<string, unknown> = {};
      if (input.name != null) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.status) patch.status = input.status;
      if (input.impactMode) patch.impactMode = input.impactMode;
      if (input.thresholds?.excellent_min != null) patch.excellentMin = input.thresholds.excellent_min;
      if (input.thresholds?.good_min != null) patch.goodMin = input.thresholds.good_min;
      if (input.thresholds?.fair_min != null) patch.fairMin = input.thresholds.fair_min;
      if (input.thresholds?.not_fit_max != null) patch.notFitMax = input.thresholds.not_fit_max;
      await updateScoreModel(ctx.workspace.id, input.modelId, patch);
      return { ok: true as const };
    }),

  activateModel: workspaceProcedure
    .input(z.object({ modelId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      await updateScoreModel(ctx.workspace.id, input.modelId, { status: "active" });
      return { ok: true as const };
    }),

  archiveModel: workspaceProcedure
    .input(z.object({ modelId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      await archiveScoreModel(ctx.workspace.id, input.modelId);
      return { ok: true as const };
    }),

  setPrimary: workspaceProcedure
    .input(z.object({ modelId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "admin");
      await setPrimaryScoreModel(ctx.workspace.id, input.modelId);
      const jobId = await queueRecalculation(ctx.workspace.id, "set_primary", input.modelId);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "score_model", entityId: input.modelId, after: { isPrimary: true } });
      return { ok: true as const, recalcJobId: jobId };
    }),

  installDefaults: workspaceProcedure.mutation(async ({ ctx }) => {
    requireRole(ctx.member.role, "admin");
    const ids = await installDefaultModels(ctx.workspace.id, ctx.user.id);
    const jobId = await queueRecalculation(ctx.workspace.id, "install_defaults");
    return { ...ids, recalcJobId: jobId };
  }),

  /* ── criteria groups ── */
  createGroup: workspaceProcedure
    .input(z.object({
      modelId: z.number().int().positive(), name: z.string().min(1).max(160),
      maxPoints: z.number().int(), description: z.string().max(2000).optional(),
      weight: z.number().optional(), categoryKey: z.string().max(48).optional(), orderIndex: z.number().int().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const groupId = await createCriteriaGroup({ workspaceId: ctx.workspace.id, scoreModelId: input.modelId, name: input.name, maxPoints: input.maxPoints, description: input.description, weight: input.weight, categoryKey: input.categoryKey, orderIndex: input.orderIndex });
      return { groupId };
    }),
  updateGroup: workspaceProcedure
    .input(z.object({ groupId: z.number().int().positive(), name: z.string().max(160).optional(), maxPoints: z.number().int().optional(), orderIndex: z.number().int().optional() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const patch: Record<string, unknown> = {};
      if (input.name != null) patch.name = input.name;
      if (input.maxPoints != null) patch.maxPoints = input.maxPoints;
      if (input.orderIndex != null) patch.orderIndex = input.orderIndex;
      await updateCriteriaGroup(ctx.workspace.id, input.groupId, patch);
      return { ok: true as const };
    }),
  deleteGroup: workspaceProcedure
    .input(z.object({ groupId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      await deleteCriteriaGroup(ctx.workspace.id, input.groupId);
      return { ok: true as const };
    }),

  /* ── criteria ── */
  createCriterion: workspaceProcedure
    .input(criterionInput.extend({ modelId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const errors = validateCriterion(input);
      if (errors.length) throw new TRPCError({ code: "BAD_REQUEST", message: errors.join("; ") });
      const criterionId = await createCriterion(ctx.workspace.id, input.modelId, input);
      return { criterionId };
    }),
  updateCriterion: workspaceProcedure
    .input(z.object({
      criterionId: z.number().int().positive(),
      fieldName: z.string().max(80).optional(), operator: z.string().max(32).optional(),
      valueJson: z.any().optional(), points: z.number().int().min(-20).max(20).optional(),
      criterionType: z.enum(["stackable", "mutually_exclusive", "negative", "disqualifier"]).optional(),
      explanationTemplate: z.string().max(400).nullable().optional(), orderIndex: z.number().int().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const patch: Record<string, unknown> = {};
      for (const k of ["fieldName", "operator", "points", "criterionType", "orderIndex"] as const) {
        if (input[k] !== undefined) patch[k] = input[k];
      }
      if (input.valueJson !== undefined) patch.valueJson = input.valueJson;
      if (input.explanationTemplate !== undefined) patch.explanationTemplate = input.explanationTemplate;
      if (input.criterionType) { patch.isNegative = input.criterionType === "negative"; patch.isDisqualifier = input.criterionType === "disqualifier"; }
      await updateCriterion(ctx.workspace.id, input.criterionId, patch);
      return { ok: true as const };
    }),
  deleteCriterion: workspaceProcedure
    .input(z.object({ criterionId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      await deleteCriterion(ctx.workspace.id, input.criterionId);
      return { ok: true as const };
    }),

  /* ── distribution preview ── */
  previewDistribution: workspaceProcedure
    .input(z.object({ modelId: z.number().int().positive(), thresholds }))
    .query(async ({ ctx, input }) => {
      const preview = await previewDistribution(ctx.workspace.id, input.modelId, input.thresholds);
      if (!preview) throw new TRPCError({ code: "NOT_FOUND" });
      return preview;
    }),

  /* ── calculate ── */
  calculate: workspaceProcedure
    .input(z.object({ objectType, objectId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const priority = await recalcForObject(ctx.workspace.id, input.objectType, input.objectId, "manual recalculation");
      const modelId = await resolveModelId(ctx.workspace.id, input.objectType);
      const fit = modelId ? await getScoreExplanation(ctx.workspace.id, modelId, input.objectType, input.objectId) : null;
      return { priority, fit };
    }),

  calculateBulk: workspaceProcedure
    .input(z.object({ objectType, objectIds: z.array(z.number().int().positive()).min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      let ok = 0;
      for (const id of input.objectIds) {
        try { await recalcForObject(ctx.workspace.id, input.objectType, id, "bulk recalculation"); ok++; } catch { /* skip */ }
      }
      return { requested: input.objectIds.length, calculated: ok };
    }),

  /* ── results / breakdown / history / priority ── */
  getResult: workspaceProcedure
    .input(z.object({ objectType, objectId: z.number().int().positive(), modelId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      const modelId = await resolveModelId(ctx.workspace.id, input.objectType, input.modelId);
      const db = await getDb();
      const fit = modelId && db
        ? (await db.select().from(scoreResults).where(and(eq(scoreResults.workspaceId, ctx.workspace.id), eq(scoreResults.scoreModelId, modelId), eq(scoreResults.objectType, input.objectType), eq(scoreResults.objectId, input.objectId))).limit(1))[0] ?? null
        : null;
      const priority = db
        ? (await db.select().from(priorityScoreResults).where(and(eq(priorityScoreResults.workspaceId, ctx.workspace.id), eq(priorityScoreResults.objectType, input.objectType), eq(priorityScoreResults.objectId, input.objectId))).limit(1))[0] ?? null
        : null;
      return { fit, priority, modelId };
    }),

  getBreakdown: workspaceProcedure
    .input(z.object({ objectType, objectId: z.number().int().positive(), modelId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      const modelId = await resolveModelId(ctx.workspace.id, input.objectType, input.modelId);
      if (!modelId) return { result: null, matched: [], missed: [], negative: [], disqualifiers: [], summary: "No primary model" };
      return getScoreExplanation(ctx.workspace.id, modelId, input.objectType, input.objectId);
    }),

  getHistory: workspaceProcedure
    .input(z.object({ objectType, objectId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => getScoreHistory(ctx.workspace.id, input.objectType, input.objectId)),

  getPriority: workspaceProcedure
    .input(z.object({ objectType, objectId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;
      const [row] = await db.select().from(priorityScoreResults)
        .where(and(eq(priorityScoreResults.workspaceId, ctx.workspace.id), eq(priorityScoreResults.objectType, input.objectType), eq(priorityScoreResults.objectId, input.objectId))).limit(1);
      return row ?? null;
    }),

  /* ── search annotation helpers ── */
  scoreMap: workspaceProcedure
    .input(z.object({ objectType, ids: z.array(z.number().int().positive()).max(500), modelId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      const fit = await scoreMapForObjects(ctx.workspace.id, input.objectType, input.ids, input.modelId);
      const priority = await priorityMapForObjects(ctx.workspace.id, input.objectType, input.ids);
      return {
        fit: Object.fromEntries(fit),
        priority: Object.fromEntries(priority),
      };
    }),

  topPriority: workspaceProcedure
    .input(z.object({ objectType, limit: z.number().int().min(1).max(100).default(20) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(priorityScoreResults)
        .where(and(eq(priorityScoreResults.workspaceId, ctx.workspace.id), eq(priorityScoreResults.objectType, input.objectType)))
        .orderBy(desc(priorityScoreResults.priorityScore)).limit(input.limit);
    }),

  /* ── recalculation jobs ── */
  recalcModel: workspaceProcedure
    .input(z.object({ modelId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      requireRole(ctx.member.role, "manager");
      const jobId = await queueRecalculation(ctx.workspace.id, "model", input.modelId);
      return { jobId };
    }),
  recalcWorkspace: workspaceProcedure.mutation(async ({ ctx }) => {
    requireRole(ctx.member.role, "admin");
    const jobId = await queueRecalculation(ctx.workspace.id, "workspace");
    return { jobId };
  }),
  getRecalcJob: workspaceProcedure
    .input(z.object({ jobId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => getRecalculationJob(ctx.workspace.id, input.jobId)),
});
