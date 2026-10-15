/**
 * The Research store: the one path that writes markets and sectors (Research
 * module). Content goes in through the shared cleaners, every save is a
 * version, a save names the revision it started from (CONFLICT otherwise),
 * and nothing crosses a workspace. Used by the research router, the AI
 * research engine's accept path and the Downstream importer.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, lt, sql } from "drizzle-orm";
import { researchMarkets, researchRevisions, researchSectors } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { changedParts, cleanMarketContent, cleanSectorContent, type MarketContent, type SectorContent } from "@shared/researchShape";

export type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** Versions kept per market or sector; older ones are pruned on save. */
export const REVISIONS_KEPT = 50;

export const CONFLICT_MESSAGE = "Someone else saved this since you opened it. Reload to see their changes, then make yours again.";

const affectedRows = (r: unknown): number =>
  Number(((Array.isArray(r) ? r[0] : r) as { affectedRows?: number } | undefined)?.affectedRows ?? 0);

/* ── Row ⇄ content ──────────────────────────────────────────────────────── */

export type MarketRow = typeof researchMarkets.$inferSelect;
export type SectorRow = typeof researchSectors.$inferSelect;

export function marketContentOf(row: MarketRow): MarketContent {
  return cleanMarketContent({
    name: row.name,
    tagline: row.tagline,
    status: row.status,
    overview: row.overview,
    openQuestions: row.openQuestions,
    suggestedSectors: row.suggestedSectors,
    glossary: row.glossary,
    competitors: row.competitors,
    sources: row.sources,
  }).content;
}

export function sectorContentOf(row: SectorRow): SectorContent {
  return cleanSectorContent({
    name: row.name,
    shortName: row.shortName,
    tagline: row.tagline,
    summary: row.summary,
    status: row.status,
    asOf: row.asOf,
    scores: row.scores,
    buyers: row.buyers,
    targeting: row.targeting,
    messaging: row.messaging,
    facts: row.facts,
    openQuestions: row.openQuestions,
    sources: row.sources,
  }).content;
}

export function marketColumns(c: MarketContent) {
  return {
    name: c.name,
    tagline: c.tagline || null,
    status: c.status,
    overview: c.overview,
    openQuestions: c.openQuestions,
    suggestedSectors: c.suggestedSectors,
    glossary: c.glossary,
    competitors: c.competitors,
    sources: c.sources,
  };
}

export function sectorColumns(c: SectorContent) {
  return {
    name: c.name,
    shortName: c.shortName || null,
    tagline: c.tagline || null,
    summary: c.summary || null,
    status: c.status,
    asOf: c.asOf || null,
    scores: c.scores,
    buyers: c.buyers,
    targeting: c.targeting,
    messaging: c.messaging,
    facts: c.facts,
    openQuestions: c.openQuestions,
    sources: c.sources,
  };
}

/* ── Loading, scoped ────────────────────────────────────────────────────── */

export async function loadMarket(db: Db, workspaceId: number, id: number): Promise<MarketRow> {
  const [row] = await db
    .select()
    .from(researchMarkets)
    .where(and(eq(researchMarkets.id, id), eq(researchMarkets.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Market not found" });
  return row;
}

export async function loadSector(db: Db, workspaceId: number, id: number): Promise<SectorRow> {
  const [row] = await db
    .select()
    .from(researchSectors)
    .where(and(eq(researchSectors.id, id), eq(researchSectors.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Sector not found" });
  return row;
}

/** Case-insensitive name clash among siblings (markets in the workspace, sectors in a market). */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* ── Versions ───────────────────────────────────────────────────────────── */

export async function writeRevision(
  db: Db,
  args: { workspaceId: number; entityType: "market" | "sector"; entityId: number; revision: number; data: unknown; changed: string[]; note: string; userId: number | null },
) {
  await db.insert(researchRevisions).values({
    workspaceId: args.workspaceId,
    entityType: args.entityType,
    entityId: args.entityId,
    revision: args.revision,
    data: args.data as object,
    changed: args.changed,
    note: args.note.slice(0, 200),
    savedByUserId: args.userId,
  });
  if (args.revision > REVISIONS_KEPT) {
    await db
      .delete(researchRevisions)
      .where(and(
        eq(researchRevisions.workspaceId, args.workspaceId),
        eq(researchRevisions.entityType, args.entityType),
        eq(researchRevisions.entityId, args.entityId),
        lt(researchRevisions.revision, args.revision - REVISIONS_KEPT + 1),
      ));
  }
}

/* ── Saving (the one path every writer uses) ────────────────────────────── */

export type SaveResult = { id: number; revision: number; changed: string[]; dropped: string[] };

export async function saveMarket(
  db: Db,
  args: { workspaceId: number; userId: number | null; id: number; expectedRevision: number; content: unknown; note?: string },
): Promise<SaveResult> {
  const current = await loadMarket(db, args.workspaceId, args.id);
  const { content, dropped } = cleanMarketContent(args.content);
  if (!content.name) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the market a name" });
  if (current.revision !== args.expectedRevision) throw new TRPCError({ code: "CONFLICT", message: CONFLICT_MESSAGE });
  if (!sameName(content.name, current.name)) {
    const siblings = await db
      .select({ id: researchMarkets.id, name: researchMarkets.name })
      .from(researchMarkets)
      .where(eq(researchMarkets.workspaceId, args.workspaceId));
    if (siblings.some((s) => s.id !== args.id && sameName(s.name, content.name))) {
      throw new TRPCError({ code: "CONFLICT", message: `There is already a market called "${content.name}"` });
    }
  }
  const changed = changedParts(marketContentOf(current), content);
  if (changed.length === 0) return { id: args.id, revision: current.revision, changed, dropped };
  const res = await db
    .update(researchMarkets)
    .set({ ...marketColumns(content), revision: sql`${researchMarkets.revision} + 1`, updatedByUserId: args.userId })
    .where(and(
      eq(researchMarkets.id, args.id),
      eq(researchMarkets.workspaceId, args.workspaceId),
      eq(researchMarkets.revision, args.expectedRevision),
    ));
  // Compare-and-swap: a save that landed between our read and this write
  // moved the revision on, so this one matches no row.
  if (affectedRows(res) !== 1) throw new TRPCError({ code: "CONFLICT", message: CONFLICT_MESSAGE });
  const revision = args.expectedRevision + 1;
  await writeRevision(db, { workspaceId: args.workspaceId, entityType: "market", entityId: args.id, revision, data: content, changed, note: args.note ?? "Edited", userId: args.userId });
  return { id: args.id, revision, changed, dropped };
}

export async function saveSector(
  db: Db,
  args: { workspaceId: number; userId: number | null; id: number; expectedRevision: number; content: unknown; note?: string },
): Promise<SaveResult> {
  const current = await loadSector(db, args.workspaceId, args.id);
  const { content, dropped } = cleanSectorContent(args.content);
  if (!content.name) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the sector a name" });
  if (current.revision !== args.expectedRevision) throw new TRPCError({ code: "CONFLICT", message: CONFLICT_MESSAGE });
  if (!sameName(content.name, current.name)) {
    const siblings = await db
      .select({ id: researchSectors.id, name: researchSectors.name })
      .from(researchSectors)
      .where(and(eq(researchSectors.workspaceId, args.workspaceId), eq(researchSectors.marketId, current.marketId)));
    if (siblings.some((s) => s.id !== args.id && sameName(s.name, content.name))) {
      throw new TRPCError({ code: "CONFLICT", message: `This market already has a sector called "${content.name}"` });
    }
  }
  const changed = changedParts(sectorContentOf(current), content);
  if (changed.length === 0) return { id: args.id, revision: current.revision, changed, dropped };
  const res = await db
    .update(researchSectors)
    .set({ ...sectorColumns(content), revision: sql`${researchSectors.revision} + 1`, updatedByUserId: args.userId })
    .where(and(
      eq(researchSectors.id, args.id),
      eq(researchSectors.workspaceId, args.workspaceId),
      eq(researchSectors.revision, args.expectedRevision),
    ));
  if (affectedRows(res) !== 1) throw new TRPCError({ code: "CONFLICT", message: CONFLICT_MESSAGE });
  const revision = args.expectedRevision + 1;
  await writeRevision(db, { workspaceId: args.workspaceId, entityType: "sector", entityId: args.id, revision, data: content, changed, note: args.note ?? "Edited", userId: args.userId });
  return { id: args.id, revision, changed, dropped };
}

/* ── Creating (by hand and from AI research) ────────────────────────────── */

export type ResearchSource = "manual" | "ai" | "downstream";
type Source = ResearchSource;

export async function insertMarket(
  db: Db,
  args: { workspaceId: number; userId: number | null; content: unknown; source?: Source; sourceRef?: string | null; note?: string },
): Promise<{ id: number; dropped: string[] }> {
  const { content, dropped } = cleanMarketContent(args.content);
  if (!content.name) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the market a name" });
  const siblings = await db
    .select({ name: researchMarkets.name })
    .from(researchMarkets)
    .where(eq(researchMarkets.workspaceId, args.workspaceId));
  if (siblings.some((s) => sameName(s.name, content.name))) {
    throw new TRPCError({ code: "CONFLICT", message: `There is already a market called "${content.name}"` });
  }
  const [row] = await db
    .insert(researchMarkets)
    .values({
      workspaceId: args.workspaceId,
      ...marketColumns(content),
      source: args.source ?? "manual",
      sourceRef: args.sourceRef ?? null,
      revision: 1,
      createdByUserId: args.userId,
      updatedByUserId: args.userId,
    })
    .$returningId();
  await writeRevision(db, { workspaceId: args.workspaceId, entityType: "market", entityId: row.id, revision: 1, data: content, changed: [], note: args.note ?? "Created", userId: args.userId });
  return { id: row.id, dropped };
}

export async function insertSector(
  db: Db,
  args: { workspaceId: number; userId: number | null; marketId: number; content: unknown; source?: Source; sourceRef?: string | null; note?: string },
): Promise<{ id: number; dropped: string[] }> {
  const market = await loadMarket(db, args.workspaceId, args.marketId);
  const { content, dropped } = cleanSectorContent(args.content);
  if (!content.name) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the sector a name" });
  const siblings = await db
    .select({ name: researchSectors.name })
    .from(researchSectors)
    .where(and(eq(researchSectors.workspaceId, args.workspaceId), eq(researchSectors.marketId, market.id)));
  if (siblings.some((s) => sameName(s.name, content.name))) {
    throw new TRPCError({ code: "CONFLICT", message: `This market already has a sector called "${content.name}"` });
  }
  const [row] = await db
    .insert(researchSectors)
    .values({
      workspaceId: args.workspaceId,
      marketId: market.id,
      ...sectorColumns(content),
      source: args.source ?? "manual",
      sourceRef: args.sourceRef ?? null,
      revision: 1,
      createdByUserId: args.userId,
      updatedByUserId: args.userId,
    })
    .$returningId();
  await writeRevision(db, { workspaceId: args.workspaceId, entityType: "sector", entityId: row.id, revision: 1, data: content, changed: [], note: args.note ?? "Created", userId: args.userId });
  return { id: row.id, dropped };
}
