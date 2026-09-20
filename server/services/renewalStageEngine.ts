/**
 * renewalStageEngine — keep the STORED customers.renewalStage in step with the
 * derivation everything already reads.
 *
 * Nothing ever moved that column. wonToCustomer stamps "early" on every newly
 * won customer, seed.ts computes a bucket once, and then it sat there while the
 * contract ran down. As of 2026-09-20 every reader derives the stage from
 * contractEnd (@shared/renewalStage, applied in routers/cs.ts and the churn
 * prompts in routers/aiFeatures.ts), so the UI, the KPIs and the assistant are
 * already correct without this sweep.
 *
 * This exists for the readers that are NOT those: a direct table query, a CSV
 * export, a future report. It writes the same value the UI has been showing, so
 * its first tick can surprise nobody.
 *
 * WHAT IT WILL NOT DO:
 *   · touch a `renewed` or `churned` row. Those are outcomes a human recorded
 *     through cs.addAmendment; arithmetic may not revoke one and re-float a
 *     churned customer as an active renewal.
 *   · write a row that is already at its target. customers.updatedAt carries
 *     onUpdateNow(), so a no-op UPDATE is not free — it restamps every customer
 *     in the product every six hours and destroys that column as a signal.
 *   · audit per row. No cron or service in this repo records audit rows, and
 *     audit.ts issues one un-batched INSERT per call; a stage that is a pure
 *     function of one column needs no provenance.
 *
 * WHY THE CANDIDATE SET EXCLUDES SETTLED PAST-DUE ROWS: the query is ordered by
 * the oldest contractEnd, which is exactly the rows that are already at
 * "at_risk" and can never move again. Without the `or(...)` term the 5000-row
 * budget is spent on no-ops every tick while rows crossing the 90/60/30
 * boundaries are never reached. With it the set self-drains: a row settles at
 * at_risk and leaves.
 */
import { and, asc, eq, gte, inArray, isNotNull, ne, notInArray, or } from "drizzle-orm";
import { customers } from "../../drizzle/schema";
import { getDb } from "../db";
import { renewalStageFor, terminalRenewalStages, type RenewalStage } from "@shared/renewalStage";

/** One tick's worth of rows. Bounded like every other sweep in _core/index.ts. */
const SCAN_LIMIT = 5000;

export async function runRenewalStageSweepAllWorkspaces(): Promise<{ scanned: number; moved: number }> {
  const db = await getDb();
  if (!db) return { scanned: 0, moved: 0 };

  const now = new Date();
  const rows = await db
    .select({
      id: customers.id,
      workspaceId: customers.workspaceId,
      contractEnd: customers.contractEnd,
      renewalStage: customers.renewalStage,
    })
    .from(customers)
    .where(
      and(
        isNotNull(customers.contractEnd),
        notInArray(customers.renewalStage, terminalRenewalStages()),
        or(gte(customers.contractEnd, now), ne(customers.renewalStage, "at_risk")),
      ),
    )
    .orderBy(asc(customers.contractEnd))
    .limit(SCAN_LIMIT);

  // Archived workspaces are frozen (2026-08-12) — an archived tenant's rows
  // must stop being rewritten, not just stop being mailed.
  const { archivedWorkspaceIds } = await import("../_core/workspaceArchive");
  const archivedWs = await archivedWorkspaceIds();
  const live = rows.filter((r) => !archivedWs.has(r.workspaceId));

  // Grouped `${workspaceId}:${stage}` so one UPDATE covers every row moving to
  // the same bucket in the same tenant. A plain object with Object.keys(), not
  // a Map — the build target has no downlevelIteration, so for-of over a Map is
  // TS2802.
  const groups: Record<string, number[]> = {};
  for (let i = 0; i < live.length; i++) {
    const r = live[i]!;
    const target = renewalStageFor({ current: r.renewalStage, contractEnd: r.contractEnd, now });
    if (target === r.renewalStage) continue;
    const key = `${r.workspaceId}:${target}`;
    (groups[key] ??= []).push(r.id);
  }

  let moved = 0;
  const keys = Object.keys(groups);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const sep = key.indexOf(":");
    const wsId = Number(key.slice(0, sep));
    const stage = key.slice(sep + 1) as RenewalStage;
    const ids = groups[key]!;
    await db
      .update(customers)
      .set({ renewalStage: stage })
      .where(and(eq(customers.workspaceId, wsId), inArray(customers.id, ids)));
    moved += ids.length;
  }

  return { scanned: live.length, moved };
}
