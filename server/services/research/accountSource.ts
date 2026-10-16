/**
 * Marks the companies a Downstream import brought in as sourced by Research
 * (owner, 2026-10-16: "the companies imported or identified by the Research
 * module ... should be identified as sourced by Research"). Runs after every
 * import and once at startup, so companies imported before the marking
 * existed are marked too, without importing again. Idempotent.
 *
 * - research_sector_id: the sector the company's Downstream segment became,
 *   when the company has none yet (a sector already set is never replaced).
 * - source_type "research_downstream": only for companies the import created,
 *   which are the ones with no source that were created after the link was
 *   made. A company that already existed and was matched keeps its source.
 */
import { and, eq, inArray } from "drizzle-orm";
import { accounts, downstreamLinks, researchExternalRefs } from "../../../drizzle/schema";
import { getDb } from "../../db";
import type { Db } from "./store";
import { RESEARCH_SOURCES } from "@shared/researchSource";

const CHUNK = 500;

export async function markDownstreamAccounts(db: Db, workspaceId: number, linkId: number): Promise<{ sector: number; source: number }> {
  const done = { sector: 0, source: 0 };
  const [link] = await db
    .select({ createdAt: downstreamLinks.createdAt })
    .from(downstreamLinks)
    .where(and(eq(downstreamLinks.id, linkId), eq(downstreamLinks.workspaceId, workspaceId)))
    .limit(1);
  if (!link) return done;
  const refs = await db
    .select({ kind: researchExternalRefs.kind, ref: researchExternalRefs.ref, velocityId: researchExternalRefs.velocityId })
    .from(researchExternalRefs)
    .where(and(eq(researchExternalRefs.workspaceId, workspaceId), eq(researchExternalRefs.linkId, linkId)));
  const sectorByRef = new Map(refs.filter((r) => r.kind === "sector").map((r) => [r.ref, r.velocityId]));
  const accountIds = refs.filter((r) => r.kind === "account").map((r) => r.velocityId);
  const linkedAt = new Date(link.createdAt).getTime();

  for (let i = 0; i < accountIds.length; i += CHUNK) {
    const rows = await db
      .select({ id: accounts.id, sourceType: accounts.sourceType, researchSectorId: accounts.researchSectorId, createdAt: accounts.createdAt, customFields: accounts.customFields })
      .from(accounts)
      .where(and(eq(accounts.workspaceId, workspaceId), inArray(accounts.id, accountIds.slice(i, i + CHUNK))));
    for (const a of rows) {
      const cf = (a.customFields && typeof a.customFields === "object" ? a.customFields : {}) as Record<string, unknown>;
      const sector = sectorByRef.get(String(cf.downstreamSegmentRef ?? ""));
      const patch: { researchSectorId?: number; sourceType?: string } = {};
      if (a.researchSectorId == null && sector != null) patch.researchSectorId = sector;
      if (!a.sourceType && new Date(a.createdAt).getTime() >= linkedAt) patch.sourceType = RESEARCH_SOURCES.downstream;
      if (!patch.researchSectorId && !patch.sourceType) continue;
      await db.update(accounts).set(patch).where(and(eq(accounts.id, a.id), eq(accounts.workspaceId, workspaceId)));
      if (patch.researchSectorId) done.sector++;
      if (patch.sourceType) done.source++;
    }
  }
  return done;
}

/** Every workspace's Downstream links, once (at startup). Never throws. */
export async function markAllDownstreamAccounts(): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const links = await db.select({ id: downstreamLinks.id, workspaceId: downstreamLinks.workspaceId }).from(downstreamLinks);
    for (const l of links) {
      const r = await markDownstreamAccounts(db, l.workspaceId, l.id);
      if (r.sector || r.source) console.log(`[ResearchSource] ws=${l.workspaceId} link=${l.id}: ${r.source} companies marked as sourced by Research, ${r.sector} given their research sector`);
    }
  } catch (e) {
    console.error("[ResearchSource] marking imported companies failed:", e instanceof Error ? e.message : e);
  }
}
