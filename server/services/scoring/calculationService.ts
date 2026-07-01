/**
 * ScoreCalculationService — the fit-model scoring engine.
 *
 * computeScore() is PURE: given a model + its groups/criteria and a loaded
 * ScoringContext, it evaluates every criterion (stackable / mutually-exclusive
 * / negative / disqualifier), sums points, normalizes to 0..100, assigns a
 * rating from the model thresholds, and emits an explainable breakdown.
 * persistScoreResult() upserts score_results + breakdowns and records history.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import {
  scoreResults, scoreResultBreakdowns, scoreHistory, scoreModels,
  scoreCriteria, scoreCriteriaGroups,
} from "../../../drizzle/schema";
import { evaluateOperator } from "./operators";
import { resolveField, displayValue, type ScoringContext } from "./fieldResolver";
import {
  ratingFor, clamp, round2, type BreakdownLine, type ScoreComputation,
  type Rating, type RatingThresholds,
} from "./types";

type CriterionRow = typeof scoreCriteria.$inferSelect;
type GroupRow = typeof scoreCriteriaGroups.$inferSelect;
type ModelRow = typeof scoreModels.$inferSelect;

const HUMAN_FIELD: Record<string, string> = {
  title: "Title", seniority: "Seniority", department: "Department",
  functional_area: "Department", industry: "Industry", company: "Company",
  employee_band: "Company size", revenue_band: "Revenue", region: "Region",
  country: "Country", state: "State", city: "City", location: "Location",
  company_fit_rating: "Company Fit", technologies: "Technology",
  hiring_signals: "Hiring signal", intent_topics: "Intent topic",
  website_keywords: "Website", has_verified_email: "Verified email",
  has_phone: "Phone", has_linkedin: "LinkedIn URL", data_age_days: "Data age",
};

function isDisq(c: CriterionRow): boolean {
  return c.criterionType === "disqualifier" || c.isDisqualifier;
}
function isNeg(c: CriterionRow): boolean {
  return c.criterionType === "negative" || c.isNegative || c.points < 0;
}
function categoryOf(c: CriterionRow): string {
  return c.categoryKey?.trim() || `group:${c.groupId}`;
}

function defaultExplanation(c: CriterionRow, groupName: string, applied: number): string {
  if (c.explanationTemplate && c.explanationTemplate.trim()) return c.explanationTemplate.trim();
  const field = HUMAN_FIELD[c.fieldName] ?? c.fieldName.replace(/_/g, " ");
  const raw = c.valueJson as unknown;
  const val = raw == null ? "" : Array.isArray(raw) ? raw.join(", ")
    : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
  const opWord: Record<string, string> = {
    contains: "contains", equals: "is", in: "is one of", starts_with: "starts with",
    ends_with: "ends with", greater_than: ">", less_than: "<", range: "in range",
    exists: "present", not_exists: "missing", fuzzy_match: "~", date_within_last: "within last (days)",
    date_older_than: "older than (days)", score_above: ">", score_below: "<",
  };
  const op = opWord[c.operator] ?? c.operator;
  const sign = applied > 0 ? `+${applied}` : `${applied}`;
  if (c.operator === "exists") return `${sign} ${field} present`;
  if (c.operator === "not_exists") return `${field} missing`;
  return `${sign} ${field} ${op}${val ? ` "${val}"` : ""}`.trim();
}

/** PURE — score one object against one model. */
export function computeScore(
  model: Pick<ModelRow, "excellentMin" | "goodMin" | "fairMin" | "notFitMax">,
  groups: GroupRow[],
  criteria: CriterionRow[],
  ctx: ScoringContext,
): ScoreComputation {
  const groupName = new Map<number, string>(groups.map((g) => [g.id, g.name]));
  const thresholds: RatingThresholds = {
    excellent_min: model.excellentMin, good_min: model.goodMin,
    fair_min: model.fairMin, not_fit_max: model.notFitMax,
  };

  const breakdown: BreakdownLine[] = [];
  const disqualificationReasons: string[] = [];
  let raw = 0;
  let maxPossible = 0;
  let isDisqualified = false;

  // Pre-evaluate matches once.
  const matched = new Map<number, boolean>();
  for (const c of criteria) {
    const value = resolveField(ctx, c.fieldName);
    matched.set(c.id, evaluateOperator(c.operator, value, c.valueJson as unknown, ctx.nowMs));
  }

  // Mutually-exclusive: per category, only the highest-point matched criterion applies.
  const meWinner = new Map<string, number>(); // category -> criterionId
  const meCatMax = new Map<string, number>(); // category -> max positive points (for denominator)
  for (const c of criteria) {
    if (c.criterionType !== "mutually_exclusive") continue;
    const cat = categoryOf(c);
    meCatMax.set(cat, Math.max(meCatMax.get(cat) ?? 0, Math.max(c.points, 0)));
    if (!matched.get(c.id)) continue;
    const cur = meWinner.get(cat);
    const curPts = cur == null ? -Infinity : (criteria.find((x) => x.id === cur)?.points ?? -Infinity);
    if (c.points > curPts) meWinner.set(cat, c.id);
  }
  for (const m of meCatMax.values()) maxPossible += m;

  for (const c of criteria) {
    const gName = groupName.get(c.groupId) ?? "Criteria";
    const hit = matched.get(c.id) ?? false;
    const curVal = displayValue(resolveField(ctx, c.fieldName));

    if (isDisq(c)) {
      if (hit) {
        isDisqualified = true;
        const reason = defaultExplanation(c, gName, 0);
        disqualificationReasons.push(reason);
        breakdown.push({ criterionId: c.id, groupName: gName, fieldName: c.fieldName, matched: true, pointsAwarded: 0, kind: "disqualifier", explanation: reason, currentValue: curVal });
      }
      continue;
    }

    if (isNeg(c)) {
      // negative criteria don't raise the ceiling
      if (hit) {
        raw += c.points;
        breakdown.push({ criterionId: c.id, groupName: gName, fieldName: c.fieldName, matched: true, pointsAwarded: c.points, kind: "negative", explanation: defaultExplanation(c, gName, c.points), currentValue: curVal });
      }
      continue;
    }

    // positive (stackable or mutually_exclusive)
    if (c.criterionType === "mutually_exclusive") {
      const isWinner = meWinner.get(categoryOf(c)) === c.id;
      if (hit && isWinner) {
        raw += c.points;
        breakdown.push({ criterionId: c.id, groupName: gName, fieldName: c.fieldName, matched: true, pointsAwarded: c.points, kind: "matched", explanation: defaultExplanation(c, gName, c.points), currentValue: curVal });
      } else {
        breakdown.push({ criterionId: c.id, groupName: gName, fieldName: c.fieldName, matched: false, pointsAwarded: 0, kind: "missed", explanation: hit ? `${defaultExplanation(c, gName, c.points)} (superseded)` : defaultExplanation(c, gName, c.points), currentValue: curVal });
      }
      continue;
    }

    // stackable positive
    maxPossible += Math.max(c.points, 0);
    if (hit) {
      raw += c.points;
      breakdown.push({ criterionId: c.id, groupName: gName, fieldName: c.fieldName, matched: true, pointsAwarded: c.points, kind: "matched", explanation: defaultExplanation(c, gName, c.points), currentValue: curVal });
    } else {
      breakdown.push({ criterionId: c.id, groupName: gName, fieldName: c.fieldName, matched: false, pointsAwarded: 0, kind: "missed", explanation: defaultExplanation(c, gName, c.points), currentValue: curVal });
    }
  }

  const normalizedScore = maxPossible > 0 ? round2(clamp((raw / maxPossible) * 100, 0, 100)) : 0;
  const rating: Rating = isDisqualified || maxPossible === 0 ? "not_a_fit" : ratingFor(normalizedScore, thresholds);

  return { rawScore: raw, maxPossibleScore: maxPossible, normalizedScore, rating, isDisqualified, disqualificationReasons, breakdown };
}

/** Upsert score_results + breakdowns; record history if the score/rating moved. */
export async function persistScoreResult(opts: {
  workspaceId: number; scoreModelId: number; objectType: "person" | "company"; objectId: number;
  comp: ScoreComputation; changeReason?: string;
}): Promise<{ resultId: number; changed: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const { workspaceId: ws, scoreModelId, objectType, objectId, comp } = opts;

  const [existing] = await db.select().from(scoreResults)
    .where(and(eq(scoreResults.workspaceId, ws), eq(scoreResults.scoreModelId, scoreModelId),
      eq(scoreResults.objectType, objectType), eq(scoreResults.objectId, objectId))).limit(1);

  const prevScore = existing ? Number(existing.normalizedScore) : null;
  const prevRating = existing ? existing.rating : null;
  const changed = !existing || prevScore !== comp.normalizedScore || prevRating !== comp.rating;

  const values = {
    workspaceId: ws, scoreModelId, objectType, objectId,
    rawScore: comp.rawScore, maxPossibleScore: comp.maxPossibleScore,
    normalizedScore: String(comp.normalizedScore), rating: comp.rating,
    isDisqualified: comp.isDisqualified,
    disqualificationReasons: comp.disqualificationReasons.length ? comp.disqualificationReasons : null,
    calculatedAt: new Date(),
  };

  let resultId: number;
  if (existing) {
    resultId = existing.id;
    await db.update(scoreResults).set(values as never).where(eq(scoreResults.id, existing.id));
    await db.delete(scoreResultBreakdowns).where(eq(scoreResultBreakdowns.scoreResultId, existing.id));
  } else {
    const ins = await db.insert(scoreResults).values(values as never);
    resultId = Number((ins as { insertId?: number }[])[0]?.insertId ?? 0);
  }

  if (comp.breakdown.length) {
    await db.insert(scoreResultBreakdowns).values(comp.breakdown.map((b) => ({
      workspaceId: ws, scoreResultId: resultId, criterionId: b.criterionId,
      groupName: b.groupName.slice(0, 160), fieldName: b.fieldName.slice(0, 80),
      matched: b.matched, pointsAwarded: b.pointsAwarded, kind: b.kind,
      explanation: b.explanation.slice(0, 400),
      oldValue: b.oldValue ?? null, currentValue: b.currentValue ?? null,
    })) as never);
  }

  if (changed) {
    await db.insert(scoreHistory).values({
      workspaceId: ws, scoreModelId, objectType, objectId,
      previousScore: prevScore == null ? null : String(prevScore),
      newScore: String(comp.normalizedScore),
      previousRating: prevRating, newRating: comp.rating,
      changeReason: opts.changeReason ?? "recalculated",
    } as never);
  }

  return { resultId, changed };
}
