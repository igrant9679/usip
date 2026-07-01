/**
 * ScoreDistributionService — preview how a model would score the workspace
 * WITHOUT persisting, so admins can tune thresholds before activating. Buckets
 * by rating, builds a 0..100 histogram, and recommends percentile thresholds.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { prospects, accounts } from "../../../drizzle/schema";
import { loadModelBundle } from "./modelService";
import { computeScore } from "./calculationService";
import { loadScoringContext } from "./fieldResolver";
import { ratingFor, type ObjectType, type Rating, type RatingThresholds } from "./types";

const SAMPLE = 500;

export interface DistributionPreview {
  sampled: number;
  buckets: Record<Rating, number>;
  disqualified: number;
  histogram: number[]; // 10 bins of width 10
  recommended: RatingThresholds;
}

export async function previewDistribution(
  ws: number, modelId: number, override?: Partial<RatingThresholds>,
): Promise<DistributionPreview | null> {
  const db = await getDb();
  if (!db) return null;
  const bundle = await loadModelBundle(ws, modelId);
  if (!bundle) return null;
  const objectType: ObjectType = bundle.model.objectType;

  const ids = objectType === "person"
    ? (await db.select({ id: prospects.id }).from(prospects).where(eq(prospects.workspaceId, ws)).limit(SAMPLE)).map((r) => r.id)
    : (await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.workspaceId, ws)).limit(SAMPLE)).map((r) => r.id);

  const thresholds: RatingThresholds = {
    excellent_min: override?.excellent_min ?? bundle.model.excellentMin,
    good_min: override?.good_min ?? bundle.model.goodMin,
    fair_min: override?.fair_min ?? bundle.model.fairMin,
    not_fit_max: override?.not_fit_max ?? bundle.model.notFitMax,
  };

  const buckets: Record<Rating, number> = { excellent: 0, good: 0, fair: 0, not_a_fit: 0 };
  const histogram = new Array(10).fill(0);
  const scores: number[] = [];
  let disqualified = 0;

  for (const id of ids) {
    const ctx = await loadScoringContext(ws, objectType, id);
    if (!ctx) continue;
    const comp = computeScore({ ...bundle.model, ...thresholdsToModel(thresholds) }, bundle.groups, bundle.criteria, ctx);
    if (comp.isDisqualified) disqualified++;
    const rating = comp.isDisqualified ? "not_a_fit" : ratingFor(comp.normalizedScore, thresholds);
    buckets[rating]++;
    scores.push(comp.normalizedScore);
    histogram[Math.min(9, Math.floor(comp.normalizedScore / 10))]++;
  }

  return { sampled: ids.length, buckets, disqualified, histogram, recommended: recommendThresholds(scores) };
}

function thresholdsToModel(t: RatingThresholds) {
  return { excellentMin: t.excellent_min, goodMin: t.good_min, fairMin: t.fair_min, notFitMax: t.not_fit_max };
}

/** Percentile-based threshold recommendation (~top 20% excellent, next 20% good, next 25% fair). */
export function recommendThresholds(scores: number[]): RatingThresholds {
  if (scores.length < 5) return { excellent_min: 80, good_min: 60, fair_min: 35, not_fit_max: 34 };
  const sorted = [...scores].sort((a, b) => a - b);
  const pct = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
  const excellent = pct(80), good = pct(60), fair = pct(35);
  return {
    excellent_min: Math.max(good + 1, excellent),
    good_min: Math.max(fair + 1, good),
    fair_min: Math.max(1, fair),
    not_fit_max: Math.max(0, fair - 1),
  };
}
