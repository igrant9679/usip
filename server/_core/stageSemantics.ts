/**
 * DB-facing half of the won/lost stage semantics — see shared/stageSemantics.ts
 * for why the flags exist and what the precedence rules are.
 *
 * Two shapes, deliberately different:
 *
 *   READS  — `stageIndexFor` unions every pipeline in the workspace and caches
 *            the answer ~60s. Aggregations (pipeline value, win rate, revenue
 *            widgets) are workspace-level questions, and `opportunities.
 *            pipelineId` is nullable and nothing backfills it, so per-pipeline
 *            precision on a read would just drop the legacy rows.
 *   WRITES — `resolvedStageFor` / `canonical*StageKey` hit the table directly
 *            and prefer the deal's OWN pipeline. A stage move is a per-deal
 *            question and must never be answered from a stale cache.
 *
 * The cache exists because `resolveWidgetData` runs once PER WIDGET (a
 * ten-widget dashboard is ten page-load reads) and inboundReplyPoller asks
 * inside its per-reply loop. Shape copied from _core/workspaceArchive.ts: 60s
 * TTL, fail-open to the last good value, one exported invalidator called from
 * every mutation that can change the answer.
 *
 * Takes `db` as its first argument rather than calling getDb(): server/db.ts is
 * itself a consumer (getWorkspaceCounts), so importing it here would close a
 * module-init cycle. Same reason server/services/wonToCustomer.ts does it.
 */
import { and, eq } from "drizzle-orm";
import { buildStageIndex, type StageIndex } from "@shared/stageSemantics";
import { crmPipelines, crmPipelineStages } from "../../drizzle/schema";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const TTL_MS = 60_000;
const cache: Record<number, { at: number; index: StageIndex }> = {};

/** Workspace-wide won/lost/open verdicts, cached ~60s. */
export async function stageIndexFor(db: Db, workspaceId: number): Promise<StageIndex> {
  const hit = cache[workspaceId];
  if (hit && Date.now() - hit.at < TTL_MS) return hit.index;
  try {
    const rows = await db
      .select({ key: crmPipelineStages.key, isWon: crmPipelineStages.isWon, isLost: crmPipelineStages.isLost })
      .from(crmPipelineStages)
      .where(eq(crmPipelineStages.workspaceId, workspaceId));
    const index = buildStageIndex(rows);
    cache[workspaceId] = { at: Date.now(), index };
    return index;
  } catch (e) {
    // Fail-open to the last good answer, and to the NAME DEFAULTS if there is
    // none. Returning an index with an empty won set on a transient read error
    // would zero out closed-won revenue for every workspace at once.
    console.error("[stageSemantics] stage-flag read failed:", (e as Error).message);
    return hit?.index ?? buildStageIndex([]);
  }
}

export async function wonStageKeys(db: Db, workspaceId: number): Promise<string[]> {
  return (await stageIndexFor(db, workspaceId)).wonKeys();
}

export async function lostStageKeys(db: Db, workspaceId: number): Promise<string[]> {
  return (await stageIndexFor(db, workspaceId)).lostKeys();
}

export async function closedStageKeys(db: Db, workspaceId: number): Promise<string[]> {
  return (await stageIndexFor(db, workspaceId)).closedKeys();
}

type StageRow = {
  key: string;
  pipelineId: number;
  isWon: boolean | number | null;
  isLost: boolean | number | null;
  defaultWinProb: number | null;
};

async function stageRowsFor(db: Db, workspaceId: number): Promise<StageRow[]> {
  return db
    .select({
      key: crmPipelineStages.key,
      pipelineId: crmPipelineStages.pipelineId,
      isWon: crmPipelineStages.isWon,
      isLost: crmPipelineStages.isLost,
      defaultWinProb: crmPipelineStages.defaultWinProb,
    })
    .from(crmPipelineStages)
    .where(eq(crmPipelineStages.workspaceId, workspaceId))
    .orderBy(crmPipelineStages.sortOrder, crmPipelineStages.id);
}

async function defaultPipelineId(db: Db, workspaceId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: crmPipelines.id })
    .from(crmPipelines)
    .where(and(eq(crmPipelines.workspaceId, workspaceId), eq(crmPipelines.isDefault, true)))
    .limit(1);
  return row ? Number(row.id) : null;
}

/**
 * Won/lost verdict for ONE stage move, resolved against the deal's own pipeline
 * where it has one.
 *
 * Search order: the deal's pipeline → the workspace's default pipeline → the
 * workspace-wide index. That last hop matters: `opportunities.pipelineId` is
 * null for every legacy row and for everything proposals.ts creates, and the
 * old code skipped the flags entirely in that case (`if (before.pipelineId)`),
 * so a custom Won stage never fired the Closed Won → Customer step.
 */
export async function resolvedStageFor(
  db: Db,
  workspaceId: number,
  pipelineId: number | null,
  stageKey: string,
): Promise<{ isWon: boolean; isLost: boolean; defaultWinProb: number | null }> {
  const rows = (await stageRowsFor(db, workspaceId)).filter((r) => r.key === stageKey);
  let match = pipelineId ? rows.find((r) => Number(r.pipelineId) === pipelineId) : undefined;
  if (!match && rows.length > 0) {
    const defId = await defaultPipelineId(db, workspaceId);
    match = defId ? rows.find((r) => Number(r.pipelineId) === defId) : undefined;
  }
  if (match) {
    const isLost = !!Number(match.isLost);
    return {
      isWon: !isLost && !!Number(match.isWon),
      isLost,
      defaultWinProb: match.defaultWinProb ?? null,
    };
  }
  const index = await stageIndexFor(db, workspaceId);
  return { isWon: index.isWon(stageKey), isLost: index.isLost(stageKey), defaultWinProb: null };
}

async function canonicalKey(
  db: Db,
  workspaceId: number,
  pipelineId: number | null,
  want: "won" | "lost",
): Promise<string> {
  const rows = (await stageRowsFor(db, workspaceId)).filter((r) => {
    const lost = !!Number(r.isLost);
    return want === "lost" ? lost : !lost && !!Number(r.isWon);
  });
  if (rows.length === 0) return want;
  const own = pipelineId ? rows.find((r) => Number(r.pipelineId) === pipelineId) : undefined;
  if (own) return own.key;
  const defId = await defaultPipelineId(db, workspaceId);
  const fallback = defId ? rows.find((r) => Number(r.pipelineId) === defId) : undefined;
  return (fallback ?? rows[0]).key;
}

/** The stage key a "this deal is won" write should store. */
export function canonicalWonStageKey(db: Db, workspaceId: number, pipelineId: number | null): Promise<string> {
  return canonicalKey(db, workspaceId, pipelineId, "won");
}

/** The stage key a "this deal is lost" write should store. */
export function canonicalLostStageKey(db: Db, workspaceId: number, pipelineId: number | null): Promise<string> {
  return canonicalKey(db, workspaceId, pipelineId, "lost");
}

/**
 * A stage's flags, a stage's existence, or which pipeline is the default just
 * changed — the next read must not answer from the 60s memo.
 */
export function invalidateStageIndex(workspaceId?: number): void {
  if (workspaceId === undefined) {
    Object.keys(cache).forEach((k) => { delete cache[Number(k)]; });
    return;
  }
  delete cache[workspaceId];
}
