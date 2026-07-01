/**
 * ScoreHistoryService — read the per-object score-change timeline. Writes
 * happen inside calculationService.persistScoreResult (recorded whenever the
 * normalized score or rating moves).
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { scoreHistory } from "../../../drizzle/schema";
import type { ObjectType } from "./types";

export async function getScoreHistory(
  ws: number, objectType: ObjectType, objectId: number, limit = 50,
) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(scoreHistory)
    .where(and(eq(scoreHistory.workspaceId, ws), eq(scoreHistory.objectType, objectType), eq(scoreHistory.objectId, objectId)))
    .orderBy(desc(scoreHistory.changedAt)).limit(limit);
}
