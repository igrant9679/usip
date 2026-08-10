/**
 * Backfill: inline the already-stored https profile photos while their signed
 * URLs still resolve.
 *
 * Everything enriched before the mirror shipped holds a media.licdn.com URL
 * whose signature lapses ~2 weeks after retrieval (all rows stored 2026-08-10
 * expire ~2026-08-27). This sweep downloads each one into a data URI before
 * that happens; URLs that already expired are marked `failed_to_load` so the
 * resolver stops offering a dead link and audits can see why.
 *
 * Scope: enrichment_provider images only — user uploads are already inline
 * and are never touched. Transient failures (network, 5xx) are left alone
 * for the next run; the cron re-runs every 6h from _core/index.ts.
 */
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../../db";
import { prospects } from "../../../drizzle/schema";
import { isExpiredLicdnUrl, mirrorImageToDataUri } from "./profileImageMirror";

export interface ImageBackfillResult {
  scanned: number;
  mirrored: number;
  expiredMarked: number;
  keptForRetry: number;
}

export async function mirrorStoredProfileImages(limit = 200): Promise<ImageBackfillResult> {
  const out: ImageBackfillResult = { scanned: 0, mirrored: 0, expiredMarked: 0, keptForRetry: 0 };
  const db = await getDb();
  if (!db) return out;

  // Only rows still holding a remote URL — mirrored rows hold data: URIs and
  // fall out of the predicate, which is what makes the sweep idempotent.
  const rows = await db
    .select({ id: prospects.id, workspaceId: prospects.workspaceId, url: prospects.profileImageUrl })
    .from(prospects)
    .where(and(
      eq(prospects.profileImageSource, "enrichment_provider"),
      eq(prospects.profileImageStatus, "available"),
      like(prospects.profileImageUrl, "https://%"),
    ))
    .limit(limit);

  for (const r of rows) {
    out.scanned++;
    if (!r.url) continue;
    try {
      const mirrored = await mirrorImageToDataUri(r.url);
      if (mirrored.ok) {
        await db.update(prospects)
          .set({ profileImageUrl: mirrored.dataUri, profileImageLastVerifiedAt: new Date() })
          .where(and(eq(prospects.workspaceId, r.workspaceId), eq(prospects.id, r.id)));
        out.mirrored++;
      } else if (mirrored.reason === "expired" || (mirrored.reason.startsWith("http_4") && isExpiredLicdnUrl(r.url))) {
        await db.update(prospects)
          .set({ profileImageStatus: "failed_to_load" })
          .where(and(eq(prospects.workspaceId, r.workspaceId), eq(prospects.id, r.id)));
        out.expiredMarked++;
      } else {
        // network / 5xx / odd 4xx on a live signature — retry next run.
        out.keptForRetry++;
      }
    } catch {
      out.keptForRetry++;
    }
  }
  return out;
}
