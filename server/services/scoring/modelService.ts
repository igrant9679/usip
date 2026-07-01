/**
 * ScoreModelService + ScoreCriteriaService.
 *
 * CRUD for score models, criteria groups and criteria, plus primary-model
 * enforcement (exactly one primary person model and one primary company model
 * per workspace) and the bundle loader the calculation engine consumes.
 * Every query is workspace-scoped.
 */
import { and, asc, eq, ne } from "drizzle-orm";
import { getDb } from "../../db";
import { scoreModels, scoreCriteriaGroups, scoreCriteria } from "../../../drizzle/schema";
import { OPERATORS, type ObjectType, type CriterionType } from "./types";

type ModelRow = typeof scoreModels.$inferSelect;
type GroupRow = typeof scoreCriteriaGroups.$inferSelect;
type CriterionRow = typeof scoreCriteria.$inferSelect;

const insertId = (res: unknown): number => Number((res as { insertId?: number }[])[0]?.insertId ?? 0);

/* ─── models ─── */
export async function createScoreModel(opts: {
  workspaceId: number; createdByUserId: number; name: string; objectType: ObjectType;
  modelType?: "auto" | "custom"; description?: string | null; impactMode?: "label" | "numeric";
  thresholds?: { excellent_min?: number; good_min?: number; fair_min?: number; not_fit_max?: number };
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const t = opts.thresholds ?? {};
  const res = await db.insert(scoreModels).values({
    workspaceId: opts.workspaceId, createdByUserId: opts.createdByUserId,
    name: opts.name.slice(0, 160), description: opts.description ?? null,
    objectType: opts.objectType, modelType: opts.modelType ?? "custom",
    impactMode: opts.impactMode ?? "label", status: "draft", isPrimary: false,
    excellentMin: t.excellent_min ?? 80, goodMin: t.good_min ?? 60,
    fairMin: t.fair_min ?? 35, notFitMax: t.not_fit_max ?? 34,
  } as never);
  return insertId(res);
}

export async function updateScoreModel(ws: number, modelId: number, patch: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(scoreModels).set(patch as never)
    .where(and(eq(scoreModels.workspaceId, ws), eq(scoreModels.id, modelId)));
}

export async function archiveScoreModel(ws: number, modelId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(scoreModels).set({ status: "archived", isPrimary: false, archivedAt: new Date() } as never)
    .where(and(eq(scoreModels.workspaceId, ws), eq(scoreModels.id, modelId)));
}

/** Enforce a single primary model per object type; activates the chosen one. */
export async function setPrimaryScoreModel(ws: number, modelId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [m] = await db.select().from(scoreModels)
    .where(and(eq(scoreModels.workspaceId, ws), eq(scoreModels.id, modelId))).limit(1);
  if (!m) throw new Error("Model not found");
  await db.update(scoreModels).set({ isPrimary: false } as never)
    .where(and(eq(scoreModels.workspaceId, ws), eq(scoreModels.objectType, m.objectType), ne(scoreModels.id, modelId)));
  await db.update(scoreModels).set({ isPrimary: true, status: "active" } as never)
    .where(and(eq(scoreModels.workspaceId, ws), eq(scoreModels.id, modelId)));
}

export async function getPrimaryModel(ws: number, objectType: ObjectType): Promise<ModelRow | null> {
  const db = await getDb();
  if (!db) return null;
  const [m] = await db.select().from(scoreModels)
    .where(and(eq(scoreModels.workspaceId, ws), eq(scoreModels.objectType, objectType),
      eq(scoreModels.isPrimary, true), eq(scoreModels.status, "active"))).limit(1);
  return m ?? null;
}

export async function listScoreModels(ws: number): Promise<ModelRow[]> {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(scoreModels).where(eq(scoreModels.workspaceId, ws)).orderBy(asc(scoreModels.id));
}

export interface ModelBundle { model: ModelRow; groups: GroupRow[]; criteria: CriterionRow[]; }
export async function loadModelBundle(ws: number, modelId: number): Promise<ModelBundle | null> {
  const db = await getDb();
  if (!db) return null;
  const [model] = await db.select().from(scoreModels)
    .where(and(eq(scoreModels.workspaceId, ws), eq(scoreModels.id, modelId))).limit(1);
  if (!model) return null;
  const groups = await db.select().from(scoreCriteriaGroups)
    .where(and(eq(scoreCriteriaGroups.workspaceId, ws), eq(scoreCriteriaGroups.scoreModelId, modelId)))
    .orderBy(asc(scoreCriteriaGroups.orderIndex));
  const criteria = await db.select().from(scoreCriteria)
    .where(and(eq(scoreCriteria.workspaceId, ws), eq(scoreCriteria.scoreModelId, modelId)))
    .orderBy(asc(scoreCriteria.orderIndex));
  return { model, groups, criteria };
}

/* ─── criteria groups ─── */
export async function createCriteriaGroup(opts: {
  workspaceId: number; scoreModelId: number; name: string; maxPoints: number;
  description?: string | null; weight?: number | null; categoryKey?: string | null; orderIndex?: number;
}): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const res = await db.insert(scoreCriteriaGroups).values({
    workspaceId: opts.workspaceId, scoreModelId: opts.scoreModelId, name: opts.name.slice(0, 160),
    description: opts.description ?? null, maxPoints: opts.maxPoints,
    weight: opts.weight == null ? null : String(opts.weight),
    categoryKey: opts.categoryKey ?? null, orderIndex: opts.orderIndex ?? 0,
  } as never);
  return insertId(res);
}
export async function updateCriteriaGroup(ws: number, groupId: number, patch: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(scoreCriteriaGroups).set(patch as never)
    .where(and(eq(scoreCriteriaGroups.workspaceId, ws), eq(scoreCriteriaGroups.id, groupId)));
}
export async function deleteCriteriaGroup(ws: number, groupId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(scoreCriteria).where(and(eq(scoreCriteria.workspaceId, ws), eq(scoreCriteria.groupId, groupId)));
  await db.delete(scoreCriteriaGroups).where(and(eq(scoreCriteriaGroups.workspaceId, ws), eq(scoreCriteriaGroups.id, groupId)));
}

/* ─── criteria ─── */
export interface CriterionInput {
  groupId: number; fieldName: string; operator: string; valueJson: unknown; points: number;
  impactLabel?: string | null; criterionType: CriterionType;
  categoryKey?: string | null; isNegative?: boolean; isDisqualifier?: boolean;
  explanationTemplate?: string | null; orderIndex?: number;
}

export function validateCriterion(c: CriterionInput): string[] {
  const errors: string[] = [];
  if (!c.fieldName?.trim()) errors.push("field_name is required");
  if (!OPERATORS.includes(c.operator as never)) errors.push(`unknown operator "${c.operator}"`);
  if (!["stackable", "mutually_exclusive", "negative", "disqualifier"].includes(c.criterionType)) errors.push("invalid criterion_type");
  if (typeof c.points !== "number" || c.points < -20 || c.points > 20) errors.push("points must be an integer in [-20, 20]");
  return errors;
}

export async function createCriterion(ws: number, scoreModelId: number, c: CriterionInput): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const errors = validateCriterion(c);
  if (errors.length) throw new Error(errors.join("; "));
  const res = await db.insert(scoreCriteria).values({
    workspaceId: ws, scoreModelId, groupId: c.groupId, fieldName: c.fieldName.slice(0, 80),
    operator: c.operator, valueJson: c.valueJson ?? null, points: Math.round(c.points),
    impactLabel: c.impactLabel ?? null, criterionType: c.criterionType,
    categoryKey: c.categoryKey ?? null,
    isNegative: c.isNegative ?? c.criterionType === "negative" ?? false,
    isDisqualifier: c.isDisqualifier ?? c.criterionType === "disqualifier" ?? false,
    explanationTemplate: c.explanationTemplate ?? null, orderIndex: c.orderIndex ?? 0,
  } as never);
  return insertId(res);
}
export async function updateCriterion(ws: number, criterionId: number, patch: Record<string, unknown>): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.update(scoreCriteria).set(patch as never)
    .where(and(eq(scoreCriteria.workspaceId, ws), eq(scoreCriteria.id, criterionId)));
}
export async function deleteCriterion(ws: number, criterionId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db.delete(scoreCriteria).where(and(eq(scoreCriteria.workspaceId, ws), eq(scoreCriteria.id, criterionId)));
}
