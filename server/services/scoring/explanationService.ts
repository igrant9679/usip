/**
 * ScoreExplanationService — turns persisted breakdown rows into the grouped
 * matched / missed / negative / disqualifier lists the UI renders under a
 * score badge, plus a one-line summary for CRM sync + list hovers.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { scoreResults, scoreResultBreakdowns } from "../../../drizzle/schema";
import type { ObjectType } from "./types";

export interface ScoreExplanation {
  result: typeof scoreResults.$inferSelect | null;
  matched: Array<{ points: number; explanation: string; groupName: string }>;
  missed: Array<{ explanation: string; groupName: string }>;
  negative: Array<{ points: number; explanation: string; groupName: string }>;
  disqualifiers: string[];
  summary: string;
}

export async function getScoreExplanation(
  workspaceId: number, scoreModelId: number, objectType: ObjectType, objectId: number,
): Promise<ScoreExplanation> {
  const db = await getDb();
  if (!db) return { result: null, matched: [], missed: [], negative: [], disqualifiers: [], summary: "" };

  const [result] = await db.select().from(scoreResults)
    .where(and(eq(scoreResults.workspaceId, workspaceId), eq(scoreResults.scoreModelId, scoreModelId),
      eq(scoreResults.objectType, objectType), eq(scoreResults.objectId, objectId))).limit(1);
  if (!result) return { result: null, matched: [], missed: [], negative: [], disqualifiers: [], summary: "No score yet" };

  const rows = await db.select().from(scoreResultBreakdowns)
    .where(eq(scoreResultBreakdowns.scoreResultId, result.id))
    .orderBy(desc(scoreResultBreakdowns.pointsAwarded));

  const matched = rows.filter((r) => r.kind === "matched").map((r) => ({ points: r.pointsAwarded, explanation: r.explanation, groupName: r.groupName }));
  const negative = rows.filter((r) => r.kind === "negative").map((r) => ({ points: r.pointsAwarded, explanation: r.explanation, groupName: r.groupName }));
  const missed = rows.filter((r) => r.kind === "missed").map((r) => ({ explanation: r.explanation, groupName: r.groupName }));
  const disqualifiers = (result.disqualificationReasons as string[] | null) ?? rows.filter((r) => r.kind === "disqualifier").map((r) => r.explanation);

  const ratingLabel: Record<string, string> = { excellent: "Excellent", good: "Good", fair: "Fair", not_a_fit: "Not a fit" };
  const summary = result.isDisqualified
    ? `Not a fit — ${disqualifiers[0] ?? "disqualified"}`
    : `${ratingLabel[result.rating]} ${Math.round(Number(result.normalizedScore))} · ${matched.length} matched${negative.length ? `, ${negative.length} negative` : ""}`;

  return { result, matched, missed, negative, disqualifiers, summary };
}
