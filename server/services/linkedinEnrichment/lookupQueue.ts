/**
 * One LinkedIn lookup queue (audit 2026-10-20, Phase 3: P6, P7, P90, P92, P157).
 *
 * 🔴 THE GAP. Four bulk paths looked profiles up back to back: the nightly
 * change check, a batch import, bulk Enrich and the company backfill. The
 * account gate allows one lookup per ~90 s, in working hours, up to a daily
 * cap, so every lookup after the first was refused, and each path read the
 * refusal as an answer. The change check ran at 01:00, outside working hours,
 * and marked up to 250 profiles "unavailable" a night while finding no job
 * changes; a batch failed every row after the first; bulk Enrich spent a
 * second, fallback search on each refusal.
 *
 * Now a refusal is typed (LookupResult.blocked). Each path waits out a short
 * spacing hold, stops at a long one (hours, days, the daily cap) and leaves
 * the rest pending. This worker resumes them, every few minutes, in this
 * order, and the gate decides when a lookup may happen:
 *
 *   1. bulk Enrich jobs (a person is waiting on them)
 *   2. batch imports
 *   3. the daily change check (stale profiles, oldest first)
 *
 * A workspace's turn ends at its first long hold: every path shares the same
 * accounts, so the next one would be refused too.
 */
import { getDb } from "../../db";
import { archivedWorkspaceIds } from "../../_core/workspaceArchive";

/** What one path did in its turn. `held` says why it stopped early, if it did. */
export type LookupTurn = { looked: number; held: string | null };

/** A spacing hold this short is waited out inside the turn; longer ones end it. */
export const LOOKUP_WAIT_MS = 3 * 60 * 1000;

let draining = false;

/**
 * Give every workspace with pending LinkedIn work a turn, until `budgetMs` is
 * spent. Re-entrant calls return at once (the cron and a "Run now" can meet).
 */
export async function drainLinkedInLookups(opts: { budgetMs?: number; onlyWorkspaceId?: number } = {}): Promise<{ looked: number; workspaces: number; held: Record<number, string> }> {
  const out = { looked: 0, workspaces: 0, held: {} as Record<number, string> };
  if (draining) return out;
  draining = true;
  try {
    const db = await getDb();
    if (!db) return out;
    const deadline = Date.now() + (opts.budgetMs ?? 9 * 60 * 1000);
    const [{ continueEnrichmentJobs, workspacesWithPendingJobs }, { continueBatches, workspacesWithPendingBatches }, { dailyCheckTurn, workspacesWithDailyCheckDue }] = await Promise.all([
      import("./orchestrator"),
      import("./batchService"),
      import("./dailyCheck"),
    ]);
    const archivedWs = await archivedWorkspaceIds();
    const candidates = opts.onlyWorkspaceId !== undefined
      ? [opts.onlyWorkspaceId]
      : Array.from(new Set([
          ...(await workspacesWithPendingJobs()),
          ...(await workspacesWithPendingBatches()),
          ...(await workspacesWithDailyCheckDue()),
        ]));
    for (const ws of candidates) {
      if (archivedWs.has(ws) || Date.now() >= deadline) continue;
      out.workspaces++;
      for (const turn of [continueEnrichmentJobs, continueBatches, dailyCheckTurn]) {
        if (Date.now() >= deadline) break;
        const r = await turn(ws, deadline);
        out.looked += r.looked;
        if (r.held) { out.held[ws] = r.held; break; }
      }
    }
    return out;
  } finally {
    draining = false;
  }
}

/** Test seam for the re-entrancy guard. */
export function __resetLookupQueueForTests(): void {
  draining = false;
}
