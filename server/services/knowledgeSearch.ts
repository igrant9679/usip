/**
 * knowledgeSearch.ts — find what the workspace's documents say about
 * something (knowledge base, owner ask 2026-10-05).
 *
 * The workspace's ready, enabled chunks are loaded once and ranked in memory
 * (BM25, knowledgeText.ts); the index is cached for five minutes and dropped
 * the moment a document changes in this process. Read by the brand block
 * (every AI writer) and by the phone agent's search tool.
 *
 * Kept apart from knowledgeBase.ts (ingest + summary) because that file
 * calls the LLM, and the LLM layer reads this one through brandContext.
 */
import { and, eq, inArray } from "drizzle-orm";
import { knowledgeChunks, knowledgeDocuments } from "../../drizzle/schema";
import { getDb } from "../db";
import { buildIndex, searchIndex, type KnowledgeIndex } from "./knowledgeText";

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<number, { at: number; index: KnowledgeIndex }>();

export function invalidateKnowledge(workspaceId?: number): void {
  if (workspaceId == null) cache.clear();
  else cache.delete(workspaceId);
}

export async function knowledgeIndex(workspaceId: number, nowMs = Date.now()): Promise<KnowledgeIndex> {
  const hit = cache.get(workspaceId);
  if (hit && nowMs - hit.at < TTL_MS) return hit.index;
  const db = await getDb();
  let index = buildIndex([]);
  if (db) {
    const docs = await db
      .select({ id: knowledgeDocuments.id, title: knowledgeDocuments.title })
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.workspaceId, workspaceId), eq(knowledgeDocuments.enabled, true), eq(knowledgeDocuments.status, "ready")));
    if (docs.length) {
      const titles = new Map(docs.map((d) => [d.id, d.title]));
      const rows = await db
        .select({ id: knowledgeChunks.id, documentId: knowledgeChunks.documentId, page: knowledgeChunks.page, content: knowledgeChunks.content })
        .from(knowledgeChunks)
        .where(and(eq(knowledgeChunks.workspaceId, workspaceId), inArray(knowledgeChunks.documentId, docs.map((d) => d.id))));
      index = buildIndex(rows.map((r) => ({ id: r.id, title: titles.get(r.documentId) ?? "Document", page: r.page, content: r.content })));
    }
  }
  cache.set(workspaceId, { at: nowMs, index });
  return index;
}

/** The best passages for `query`, or [] (never throws: an AI writer must not fail over this). */
export async function searchKnowledge(workspaceId: number, query: string, k = 4): Promise<{ title: string; page: number | null; content: string }[]> {
  try {
    const index = await knowledgeIndex(workspaceId);
    return searchIndex(index, query, k).map(({ title, page, content }) => ({ title, page, content }));
  } catch (e) {
    console.error("[Knowledge] search failed:", e);
    return [];
  }
}

/** Whether the workspace has any document the AI may use. */
export async function hasKnowledge(workspaceId: number): Promise<boolean> {
  try {
    return (await knowledgeIndex(workspaceId)).chunks.length > 0;
  } catch {
    return false;
  }
}
