/**
 * ScoreRecalculationService — scores an object with a model, recalculates all
 * scores for an object (primary fit model + Velocity Priority Score), and runs
 * batched async recalculation jobs for a whole model or workspace with progress
 * tracking + safe retry. One failed record never aborts the batch.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { prospects, accounts, scoreModels, scoreRecalculationJobs } from "../../../drizzle/schema";
import { loadModelBundle, getPrimaryModel } from "./modelService";
import { computeScore, persistScoreResult } from "./calculationService";
import { loadScoringContext } from "./fieldResolver";
import { calculatePriorityForObject, persistPriority } from "./priorityService";
import type { ObjectType, ScoreComputation } from "./types";

const MAX_BATCH = 5000;
const insertId = (res: unknown): number => Number((res as { insertId?: number }[])[0]?.insertId ?? 0);

/** Score one object against one specific model (fit models only). */
export async function scoreObjectWithModel(
  ws: number, modelId: number, objectType: ObjectType, objectId: number, reason?: string,
): Promise<ScoreComputation | null> {
  const bundle = await loadModelBundle(ws, modelId);
  if (!bundle || bundle.model.objectType !== objectType) return null;
  const ctx = await loadScoringContext(ws, objectType, objectId);
  if (!ctx) return null;
  const comp = computeScore(bundle.model, bundle.groups, bundle.criteria, ctx);
  await persistScoreResult({ workspaceId: ws, scoreModelId: modelId, objectType, objectId, comp, changeReason: reason });
  return comp;
}

/** Recalculate the primary fit score + Velocity Priority Score for one object. */
export async function recalcForObject(ws: number, objectType: ObjectType, objectId: number, reason?: string) {
  const model = await getPrimaryModel(ws, objectType);
  if (model) await scoreObjectWithModel(ws, model.id, objectType, objectId, reason);
  const p = await calculatePriorityForObject(ws, objectType, objectId);
  if (p) await persistPriority(ws, objectType, objectId, p);
  return p;
}

async function objectIdsFor(ws: number, objectType: ObjectType): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];
  if (objectType === "person") {
    const rows = await db.select({ id: prospects.id }).from(prospects)
      .where(eq(prospects.workspaceId, ws)).limit(MAX_BATCH);
    return rows.map((r) => r.id);
  }
  const rows = await db.select({ id: accounts.id }).from(accounts)
    .where(eq(accounts.workspaceId, ws)).limit(MAX_BATCH);
  return rows.map((r) => r.id);
}

async function bumpJob(jobId: number, patch: Record<string, unknown>) {
  const db = await getDb();
  if (!db) return;
  await db.update(scoreRecalculationJobs).set(patch as never).where(eq(scoreRecalculationJobs.id, jobId));
}

/** Process a queued recalculation job (async, progress-tracked). */
export async function processRecalculationJob(jobId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const [job] = await db.select().from(scoreRecalculationJobs).where(eq(scoreRecalculationJobs.id, jobId)).limit(1);
  if (!job) return;
  const ws = job.workspaceId;

  // Which object types to sweep.
  let objectTypes: ObjectType[] = ["person", "company"];
  if (job.scoreModelId) {
    const [m] = await db.select({ t: scoreModels.objectType }).from(scoreModels)
      .where(and(eq(scoreModels.workspaceId, ws), eq(scoreModels.id, job.scoreModelId))).limit(1);
    if (m) objectTypes = [m.t as ObjectType];
  }

  const targets: Array<{ type: ObjectType; id: number }> = [];
  for (const t of objectTypes) for (const id of await objectIdsFor(ws, t)) targets.push({ type: t, id });

  await bumpJob(jobId, { status: "running", startedAt: new Date(), totalRecords: targets.length });

  let processed = 0, failed = 0;
  for (const t of targets) {
    try {
      if (job.scoreModelId) await scoreObjectWithModel(ws, job.scoreModelId, t.type, t.id, "batch recalculation");
      await recalcForObject(ws, t.type, t.id, "batch recalculation");
    } catch (e) {
      failed++;
      console.error(`[scoring] recalc job ${jobId} failed on ${t.type}:${t.id}`, (e as Error).message);
    }
    processed++;
    if (processed % 25 === 0) await bumpJob(jobId, { processedRecords: processed, failedRecords: failed });
  }
  await bumpJob(jobId, { status: "completed", processedRecords: processed, failedRecords: failed, completedAt: new Date() });
}

/** Queue a recalculation job and process it asynchronously. */
export async function queueRecalculation(ws: number, jobType: string, scoreModelId?: number | null): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const res = await db.insert(scoreRecalculationJobs).values({
    workspaceId: ws, scoreModelId: scoreModelId ?? null, jobType, status: "queued",
  } as never);
  const jobId = insertId(res);
  void processRecalculationJob(jobId).catch((e) => console.error(`[scoring] job ${jobId} crashed:`, (e as Error).message));
  return jobId;
}

export async function getRecalculationJob(ws: number, jobId: number) {
  const db = await getDb();
  if (!db) return null;
  const [job] = await db.select().from(scoreRecalculationJobs)
    .where(and(eq(scoreRecalculationJobs.workspaceId, ws), eq(scoreRecalculationJobs.id, jobId))).limit(1);
  return job ?? null;
}
