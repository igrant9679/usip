/**
 * Score history older than 90 days goes (audit 2026-10-20, F43).
 *
 * lead_score_history gets a row on every re-score (engagement, the stale
 * sweep, Recompute all) and was never pruned; score_history, the priority
 * score's change log, the same. Rows older than SCORE_HISTORY_DAYS are
 * deleted daily, in batches, with one exception per subject: a lead's (or a
 * scored person's or company's) LATEST row is kept however old it is, because
 * the next re-score reads it (latestScore reuses the stored AI fit rather
 * than paying for a new one) and the record page shows it as the current
 * score. Run from the daily log-retention tick (_core/index.ts).
 */
import { and, asc, count, eq, gt, gte, inArray, lt } from "drizzle-orm";
import { leadScoreHistory, scoreHistory } from "../../drizzle/schema";
import { getDb } from "../db";

export const SCORE_HISTORY_DAYS = 90;
const BATCH = 2000;
/** Batches per table per run, so one tick stays short; the rest go tomorrow. */
const MAX_BATCHES = 25;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Old = { id: number; workspaceId: number; subject: string };

/**
 * From a batch of old rows, the ids that may go: every one whose subject has a
 * newer row (a recent one, or a later old one), keeping each subject's newest.
 */
export function deletableIds(batch: Old[], subjectsWithRecent: Set<string>, newestOldBySubject: Map<string, number>): Old[] {
  return batch.filter((r) => subjectsWithRecent.has(r.subject) || newestOldBySubject.get(r.subject) !== r.id);
}

async function deleteGrouped(db: Db, table: typeof leadScoreHistory | typeof scoreHistory, rows: Old[]): Promise<number> {
  const byWs = new Map<number, number[]>();
  for (const r of rows) byWs.set(r.workspaceId, [...(byWs.get(r.workspaceId) ?? []), r.id]);
  let n = 0;
  for (const [ws, ids] of Array.from(byWs.entries())) {
    if (table === leadScoreHistory) {
      await db.delete(leadScoreHistory).where(and(eq(leadScoreHistory.workspaceId, ws), inArray(leadScoreHistory.id, ids)));
    } else {
      await db.delete(scoreHistory).where(and(eq(scoreHistory.workspaceId, ws), inArray(scoreHistory.id, ids)));
    }
    n += ids.length;
  }
  return n;
}

async function pruneLeadRows(db: Db, cutoff: Date): Promise<number> {
  let after = 0;
  let deleted = 0;
  for (let b = 0; b < MAX_BATCHES; b++) {
    const page = await db.select({ id: leadScoreHistory.id, workspaceId: leadScoreHistory.workspaceId, leadId: leadScoreHistory.leadId })
      .from(leadScoreHistory)
      .where(and(lt(leadScoreHistory.computedAt, cutoff), gt(leadScoreHistory.id, after)))
      .orderBy(asc(leadScoreHistory.id))
      .limit(BATCH);
    if (page.length === 0) break;
    after = Number(page[page.length - 1].id);
    const leadIds = Array.from(new Set(page.map((r) => r.leadId)));
    const recent = await db.select({ leadId: leadScoreHistory.leadId, n: count() }).from(leadScoreHistory)
      .where(and(inArray(leadScoreHistory.leadId, leadIds), gte(leadScoreHistory.computedAt, cutoff)))
      .groupBy(leadScoreHistory.leadId);
    const withRecent = new Set(recent.map((r) => String(r.leadId)));
    const noRecent = leadIds.filter((id) => !withRecent.has(String(id)));
    const newestOld = new Map<string, number>();
    if (noRecent.length) {
      const olds = await db.select({ id: leadScoreHistory.id, leadId: leadScoreHistory.leadId }).from(leadScoreHistory)
        .where(and(inArray(leadScoreHistory.leadId, noRecent), lt(leadScoreHistory.computedAt, cutoff)));
      for (const o of olds) {
        const k = String(o.leadId);
        if (Number(o.id) > (newestOld.get(k) ?? 0)) newestOld.set(k, Number(o.id));
      }
    }
    const go = deletableIds(page.map((r) => ({ id: Number(r.id), workspaceId: r.workspaceId, subject: String(r.leadId) })), withRecent, newestOld);
    deleted += await deleteGrouped(db, leadScoreHistory, go);
  }
  return deleted;
}

async function prunePriorityRows(db: Db, cutoff: Date): Promise<number> {
  let after = 0;
  let deleted = 0;
  const key = (r: { workspaceId: number; scoreModelId: number; objectType: string; objectId: number }) => `${r.workspaceId}:${r.scoreModelId}:${r.objectType}:${r.objectId}`;
  for (let b = 0; b < MAX_BATCHES; b++) {
    const page = await db.select({ id: scoreHistory.id, workspaceId: scoreHistory.workspaceId, scoreModelId: scoreHistory.scoreModelId, objectType: scoreHistory.objectType, objectId: scoreHistory.objectId })
      .from(scoreHistory)
      .where(and(lt(scoreHistory.changedAt, cutoff), gt(scoreHistory.id, after)))
      .orderBy(asc(scoreHistory.id))
      .limit(BATCH);
    if (page.length === 0) break;
    after = page[page.length - 1].id;
    const objectIds = Array.from(new Set(page.map((r) => r.objectId)));
    // Every row for these objects, ids and keys only, to find each subject's newest.
    const all = await db.select({ id: scoreHistory.id, workspaceId: scoreHistory.workspaceId, scoreModelId: scoreHistory.scoreModelId, objectType: scoreHistory.objectType, objectId: scoreHistory.objectId, changedAt: scoreHistory.changedAt })
      .from(scoreHistory)
      .where(inArray(scoreHistory.objectId, objectIds));
    const withRecent = new Set<string>();
    const newestOld = new Map<string, number>();
    for (const r of all) {
      const k = key(r);
      if (new Date(r.changedAt).getTime() >= cutoff.getTime()) withRecent.add(k);
      else if (r.id > (newestOld.get(k) ?? 0)) newestOld.set(k, r.id);
    }
    const go = deletableIds(page.map((r) => ({ id: r.id, workspaceId: r.workspaceId, subject: key(r) })), withRecent, newestOld);
    deleted += await deleteGrouped(db, scoreHistory, go);
  }
  return deleted;
}

export async function pruneScoreHistory(now: Date = new Date()): Promise<{ leadRows: number; priorityRows: number }> {
  const db = await getDb();
  if (!db) return { leadRows: 0, priorityRows: 0 };
  const cutoff = new Date(now.getTime() - SCORE_HISTORY_DAYS * 86_400_000);
  const leadRows = await pruneLeadRows(db, cutoff);
  const priorityRows = await prunePriorityRows(db, cutoff);
  if (leadRows || priorityRows) console.log(`[ScoreHistory] pruned ${leadRows} lead score rows and ${priorityRows} priority score rows older than ${SCORE_HISTORY_DAYS} days`);
  return { leadRows, priorityRows };
}
