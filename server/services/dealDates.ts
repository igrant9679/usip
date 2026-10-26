/**
 * dealDates.ts — the dates a deal's metrics count from, for deals that existed
 * before migration 0211, and the days-in-stage figure every alert reads
 * (audit 2026-10-20, Phase 2: R14, R16, R17).
 *
 * backfillDealDates — once, at boot: every deal with no stageEnteredAt gets
 *   one, and a won or lost deal gets wonAt / lostAt. The best evidence first:
 *   the stage history's last move INTO the current stage; for a win with no
 *   history, the close date if it has passed (proposal accepts and most hand
 *   edits set it to the day it closed); the last update only as a final
 *   resort — that is the very column that made every edit move a win.
 *   Idempotent: it only touches rows whose stageEnteredAt is still NULL.
 *
 * refreshDaysInStage — daysInStage was set to 0 on every move and never
 *   counted up, so "stuck in stage for 14 days" alerts and deal_stuck workflow
 *   rules never fired. The column stays (reports, rules and the AI prompts
 *   read it); it is now recomputed from stageEnteredAt on the 15-minute
 *   pipeline-alert sweep, before the sweep reads it.
 *
 * Both write updatedAt back to the value they read. The column is ON UPDATE
 * CURRENT_TIMESTAMP, and MySQL leaves it alone only when it is set explicitly
 * — otherwise this housekeeping would mark every deal "updated" daily and
 * reorder every list sorted by it.
 */
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { opportunities, opportunityStageHistory } from "../../drizzle/schema";
import { getDb } from "../db";
import { stageResolver, type StageResolver } from "../_core/stageSemantics";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const DAY_MS = 86_400_000;
const BATCH = 500;

export const daysSince = (from: Date, now: Date) => Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));

export async function backfillDealDates(dbArg?: Db, now: Date = new Date()): Promise<{ updated: number }> {
  const db = dbArg ?? (await getDb());
  if (!db) return { updated: 0 };
  const resolvers = new Map<number, StageResolver>();
  let updated = 0;
  // Batches until nothing is left; the cap only guards against a row that
  // will not take the write (it would otherwise be re-read forever).
  for (let round = 0; round < 200; round++) {
    const pending = await db.select({
      id: opportunities.id,
      workspaceId: opportunities.workspaceId,
      pipelineId: opportunities.pipelineId,
      stage: opportunities.stage,
      closeDate: opportunities.closeDate,
      createdAt: opportunities.createdAt,
      updatedAt: opportunities.updatedAt,
    }).from(opportunities).where(isNull(opportunities.stageEnteredAt)).limit(BATCH);
    if (pending.length === 0) break;

    const ids = pending.map((p) => p.id);
    const history = await db.select({
      opportunityId: opportunityStageHistory.opportunityId,
      toStage: opportunityStageHistory.toStage,
      createdAt: opportunityStageHistory.createdAt,
    }).from(opportunityStageHistory)
      .where(inArray(opportunityStageHistory.opportunityId, ids))
      .orderBy(desc(opportunityStageHistory.createdAt));
    // Newest first, so the first hit per (deal, stage) is the last entry.
    const enteredAt = new Map<string, Date>();
    for (const h of history) {
      const key = `${h.opportunityId}:${h.toStage}`;
      if (!enteredAt.has(key) && h.createdAt) enteredAt.set(key, new Date(h.createdAt));
    }

    let progressed = 0;
    for (const o of pending) {
      let stages = resolvers.get(o.workspaceId);
      if (!stages) {
        stages = await stageResolver(db, o.workspaceId);
        resolvers.set(o.workspaceId, stages);
      }
      const meta = stages.resolve(o.pipelineId ?? null, o.stage);
      const moved = enteredAt.get(`${o.id}:${o.stage}`) ?? null;
      const created = o.createdAt ? new Date(o.createdAt) : now;
      const updatedAt = o.updatedAt ? new Date(o.updatedAt) : created;
      const close = o.closeDate ? new Date(o.closeDate) : null;
      const closedAt = moved ?? (meta.isWon && close && close <= now ? close : updatedAt);
      const stageEnteredAt = moved ?? (meta.isWon || meta.isLost ? closedAt : created);
      const res = await db.update(opportunities).set({
        stageEnteredAt,
        wonAt: meta.isWon ? closedAt : null,
        lostAt: meta.isLost ? closedAt : null,
        daysInStage: daysSince(stageEnteredAt, now),
        updatedAt: o.updatedAt,
      } as never).where(and(
        eq(opportunities.id, o.id),
        eq(opportunities.workspaceId, o.workspaceId),
        isNull(opportunities.stageEnteredAt),
      ));
      const n = Number((res as any)?.[0]?.affectedRows ?? (res as any)?.affectedRows ?? 0);
      updated += n;
      progressed += n;
    }
    if (progressed === 0) break;
  }
  if (updated > 0) console.log(`[dealDates] backfilled stage dates on ${updated} deal(s)`);
  return { updated };
}

/** Recompute daysInStage from stageEnteredAt for one workspace; writes only the rows that changed. */
export async function refreshDaysInStage(db: Db, workspaceId: number, now: Date = new Date()): Promise<number> {
  const rows = await db.select({
    id: opportunities.id,
    stageEnteredAt: opportunities.stageEnteredAt,
    daysInStage: opportunities.daysInStage,
    updatedAt: opportunities.updatedAt,
  }).from(opportunities).where(and(eq(opportunities.workspaceId, workspaceId), isNotNull(opportunities.stageEnteredAt)));
  let changed = 0;
  for (const r of rows) {
    const days = daysSince(new Date(r.stageEnteredAt!), now);
    if (days === r.daysInStage) continue;
    await db.update(opportunities).set({ daysInStage: days, updatedAt: r.updatedAt })
      .where(and(eq(opportunities.id, r.id), eq(opportunities.workspaceId, workspaceId)));
    changed++;
  }
  return changed;
}
