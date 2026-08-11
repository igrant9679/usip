/**
 * Prospect field-change history (roadmap P3.2, migration 0156) — persists
 * what MergeDecision.previous used to compute and throw away: every
 * REPLACED decision becomes one timeline row (old value + its source, new
 * value + its source/confidence, which trigger did it).
 *
 * Best-effort by contract: history must never fail an enrichment. Called
 * by every mergeAll consumer.
 */
import { getDb } from "../../db";
import { prospectFieldHistory } from "../../../drizzle/schema";
import type { MergeDecision } from "./fieldMerge";

export async function recordFieldHistory(
  workspaceId: number,
  prospectId: number,
  decisions: MergeDecision[],
  trigger: string,
): Promise<void> {
  const replaced = decisions.filter((d) => d.action === "replaced" && d.previous);
  if (replaced.length === 0) return;
  try {
    const db = await getDb();
    if (!db) return;
    await db.insert(prospectFieldHistory).values(replaced.map((d) => ({
      workspaceId,
      prospectId,
      field: d.field.slice(0, 40),
      oldValue: d.previous!.value ?? null,
      newValue: d.value,
      oldSource: d.previous!.provenance?.source?.slice(0, 40) ?? null,
      newSource: d.provenance.source.slice(0, 40),
      newConfidence: d.provenance.confidence,
      trigger: trigger.slice(0, 40),
    })));
  } catch (e) {
    console.error(`[fieldHistory] prospect ${prospectId} write failed:`, (e as Error)?.message ?? e);
  }
}
