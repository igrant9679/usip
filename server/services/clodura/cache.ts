/**
 * Clodura search response cache (24-hour TTL, per workspace)
 * Cache key = SHA-256 of workspaceId + serialised filters + page + perPage
 */
import { createHash } from "crypto";
import { and, eq, lt } from "drizzle-orm";
import { getDb } from "../../db";
import { cloduraSearchCache } from "../../../drizzle/schema";
import type { CloduraSearchParams, CloduraSearchResponse } from "./client";

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function buildCacheKey(workspaceId: number, params: CloduraSearchParams): string {
  const canonical = JSON.stringify({ workspaceId, ...params }, Object.keys({ workspaceId, ...params }).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 64);
}

export async function getCached(
  workspaceId: number,
  params: CloduraSearchParams,
): Promise<CloduraSearchResponse | null> {
  const db = await getDb();
  if (!db) return null;
  const key = buildCacheKey(workspaceId, params);
  const cutoff = new Date(Date.now() - TTL_MS);
  const [row] = await db
    .select()
    .from(cloduraSearchCache)
    .where(
      and(
        eq(cloduraSearchCache.cacheKey, key),
        eq(cloduraSearchCache.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.cachedAt < cutoff) {
    // Expired — delete and return null
    await db
      .delete(cloduraSearchCache)
      .where(
        and(
          eq(cloduraSearchCache.cacheKey, key),
          eq(cloduraSearchCache.workspaceId, workspaceId),
        ),
      );
    return null;
  }
  return row.response as CloduraSearchResponse;
}

export async function setCached(
  workspaceId: number,
  params: CloduraSearchParams,
  response: CloduraSearchResponse,
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const key = buildCacheKey(workspaceId, params);
  // Upsert
  await db
    .insert(cloduraSearchCache)
    .values({ cacheKey: key, workspaceId, response: response as any, cachedAt: new Date() })
    .onDuplicateKeyUpdate({ set: { response: response as any, cachedAt: new Date() } });
}

/** Purge all expired cache rows — called by nightly cron */
export async function purgeExpiredCache(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const cutoff = new Date(Date.now() - TTL_MS);
  await db.delete(cloduraSearchCache).where(lt(cloduraSearchCache.cachedAt, cutoff));
  console.log("[CloduraCache] purged expired rows older than", cutoff.toISOString());
}

/** Purge raw_response from enrichment jobs older than 24h */
export async function purgeStaleEnrichmentRawResponses(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const { cloduraEnrichmentJobs } = await import("../../../drizzle/schema");
  const cutoff = new Date(Date.now() - TTL_MS);
  await db
    .update(cloduraEnrichmentJobs)
    .set({ rawResponse: null, rawResponsePurgedAt: new Date() })
    .where(
      and(
        lt(cloduraEnrichmentJobs.requestedAt, cutoff),
        eq(cloduraEnrichmentJobs.rawResponsePurgedAt, null as any),
      ),
    );
}
