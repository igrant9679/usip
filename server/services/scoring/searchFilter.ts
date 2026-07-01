/**
 * ScoreSearchFilterService — helpers to annotate, filter and sort search
 * results by score. People/Company/Contacts/Accounts search resolve their own
 * ids first (respecting existing filters), then call these to attach scores and
 * apply the score_filter + score sort from the request.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { scoreResults, priorityScoreResults } from "../../../drizzle/schema";
import { getPrimaryModel } from "./modelService";
import type { ObjectType, Rating } from "./types";

const RATING_RANK: Record<Rating, number> = { not_a_fit: 0, fair: 1, good: 2, excellent: 3 };
const MIN_RATING_RANK: Record<string, number> = { include_not_fit: 0, fair: 1, good: 2, excellent: 3 };

export interface ScoreCell { normalized: number; rating: Rating; disqualified: boolean; }

/** Fit scores for a set of objects under the primary (or given) model. */
export async function scoreMapForObjects(
  ws: number, objectType: ObjectType, ids: number[], modelId?: number | "primary",
): Promise<Map<number, ScoreCell>> {
  const out = new Map<number, ScoreCell>();
  if (!ids.length) return out;
  const db = await getDb();
  if (!db) return out;
  let mid = typeof modelId === "number" ? modelId : null;
  if (mid == null) { const m = await getPrimaryModel(ws, objectType); mid = m?.id ?? null; }
  if (mid == null) return out;
  const rows = await db.select().from(scoreResults)
    .where(and(eq(scoreResults.workspaceId, ws), eq(scoreResults.scoreModelId, mid),
      eq(scoreResults.objectType, objectType), inArray(scoreResults.objectId, ids)));
  for (const r of rows) out.set(r.objectId, { normalized: Number(r.normalizedScore), rating: r.rating as Rating, disqualified: r.isDisqualified });
  return out;
}

export async function priorityMapForObjects(
  ws: number, objectType: ObjectType, ids: number[],
): Promise<Map<number, { priority: number; rating: Rating }>> {
  const out = new Map<number, { priority: number; rating: Rating }>();
  if (!ids.length) return out;
  const db = await getDb();
  if (!db) return out;
  const rows = await db.select().from(priorityScoreResults)
    .where(and(eq(priorityScoreResults.workspaceId, ws), eq(priorityScoreResults.objectType, objectType), inArray(priorityScoreResults.objectId, ids)));
  for (const r of rows) out.set(r.objectId, { priority: Number(r.priorityScore), rating: r.priorityRating as Rating });
  return out;
}

export interface ScoreFilter {
  minimum_rating?: "excellent" | "good" | "fair" | "include_not_fit";
  minimum_score?: number;
  maximum_score?: number;
  disqualified?: boolean;
  missing_score?: boolean;
}
export interface ScoreSort { field: "score" | "priority"; direction: "asc" | "desc"; }

/** Filter + sort a list of ids in-memory using a prepared score map. */
export function applyScoreFilterSort(
  ids: number[], map: Map<number, ScoreCell>, filter?: ScoreFilter, sort?: ScoreSort,
): number[] {
  let out = ids;
  if (filter) {
    out = out.filter((id) => {
      const cell = map.get(id);
      if (filter.missing_score === true) return !cell;
      if (filter.missing_score === false && !cell) return false;
      if (!cell) return filter.minimum_rating === "include_not_fit" || filter.minimum_rating == null;
      if (filter.disqualified === true && !cell.disqualified) return false;
      if (filter.disqualified === false && cell.disqualified) return false;
      if (filter.minimum_rating && filter.minimum_rating !== "include_not_fit"
        && RATING_RANK[cell.rating] < MIN_RATING_RANK[filter.minimum_rating]) return false;
      if (filter.minimum_score != null && cell.normalized < filter.minimum_score) return false;
      if (filter.maximum_score != null && cell.normalized > filter.maximum_score) return false;
      return true;
    });
  }
  if (sort?.field === "score") {
    const dir = sort.direction === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => ((map.get(a)?.normalized ?? -1) - (map.get(b)?.normalized ?? -1)) * dir);
  }
  return out;
}
