/**
 * primarySource.ts — the workspace's primary prospect source (owner,
 * 2026-11-24: "each workspace to pick which leads/prospect source to use as a
 * primary source; the unselected will be fallback. They should be able to do
 * this in settings").
 *
 * Not a second setting. The workspace has ONE checking order
 * (workspace_settings.areSourceOrder), read by the engine
 * (resolveSourceOrder), Source search and the Search box lookup
 * (registry.eligibleFor). The primary is whichever source that order checks
 * first; picking one writes the same order with the choice moved to the
 * front, and every other source keeps its place as a fallback.
 *
 * It writes the order and nothing else: no source is switched on or off, no
 * key is touched, and a source that bills its previews is not opted into
 * searches that did not tick it (that rule lives in eligibleFor and
 * ARE_OPT_IN_SOURCES, and neither reads the order).
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { recordAudit } from "../audit";
import { orderWithPrimary, primarySourceOf, type AreSourceId, type PrimarySourceId } from "@shared/areSources";

export type PrimarySourceResult = { ok: true; primary: PrimarySourceId; order: AreSourceId[]; changed: boolean };

/** The caller has made sure the settings row exists (getOrSeedSettings). */
export async function setPrimarySource(workspaceId: number, actorUserId: number | null, source: PrimarySourceId): Promise<PrimarySourceResult> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const [row] = await db
    .select({ order: workspaceSettings.areSourceOrder })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const stored = row?.order ?? null;
  const before = primarySourceOf(stored);
  const order = orderWithPrimary(stored, source);
  // Already at the very front of what is stored: nothing to write.
  if (Array.isArray(stored) && stored[0] === source) return { ok: true, primary: source, order, changed: false };
  await db.update(workspaceSettings).set({ areSourceOrder: order } as never).where(eq(workspaceSettings.workspaceId, workspaceId));
  await recordAudit({
    workspaceId, actorUserId, action: "update", entityType: "primary_prospect_source", entityId: workspaceId,
    before: { primary: before }, after: { primary: source, order },
  });
  return { ok: true, primary: source, order, changed: true };
}
