/**
 * Archive enforcement for the AUTONOMOUS side of the product.
 *
 * `workspaces.archivedAt` was a label for months — archiveWorkspace stamped
 * it, nothing read it, and the docstring there honestly said so. Enforcement
 * shipped 2026-08-12 (owner-approved, together with un-archive) in two
 * halves:
 *
 *   1. The REQUEST path: `workspaceProcedure` refuses non-super-admin
 *      requests to an archived workspace (one choke point, no cache — the
 *      middleware already holds the workspace row).
 *   2. The AUTONOMOUS path: every per-workspace engine (the *AllWorkspaces
 *      runners, the ARE tick, the sequence engine) skips archived workspaces
 *      via THIS module. An archived workspace must stop sending, spending
 *      and creating records — archiving that keeps mailing people is not
 *      archiving. `archiveEnforcement.test.ts` enumerates the engines and
 *      fails when a new one forgets to consult this.
 *
 * Deliberately fail-open: if the db read fails the engines behave as before
 * (they are all db-gated anyway), and a 60s-stale answer is fine — the cron
 * cadences are minutes, and archiving is a rare, human action.
 */
import { isNotNull } from "drizzle-orm";
import { workspaces } from "../../drizzle/schema";
import { getDb } from "../db";

let cache: { at: number; ids: Set<number> } | null = null;
const TTL_MS = 60_000;

/** Ids of archived workspaces, cached ~60s. Engines: `.has(wsId) → skip`. */
export async function archivedWorkspaceIds(): Promise<Set<number>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.ids;
  const db = await getDb();
  if (!db) return cache?.ids ?? new Set();
  try {
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(isNotNull(workspaces.archivedAt));
    cache = { at: Date.now(), ids: new Set(rows.map((r) => Number(r.id))) };
    return cache.ids;
  } catch (e) {
    console.error("[workspaceArchive] archived-id read failed:", (e as Error).message);
    return cache?.ids ?? new Set();
  }
}

/** Archive/un-archive just happened — the next engine tick must see it. */
export function invalidateArchivedWorkspaceCache(): void {
  cache = null;
}

export async function isWorkspaceArchived(workspaceId: number): Promise<boolean> {
  return (await archivedWorkspaceIds()).has(workspaceId);
}
