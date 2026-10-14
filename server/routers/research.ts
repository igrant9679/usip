/**
 * research — markets and the sectors inside them (Research module, phase 1).
 *
 * Owner plan 2026-10-14: each workspace researches any number of industries
 * and sectors, and that research will drive targeting, the Revenue Engine and
 * the AI writers. Phase 1 is the store and the pages, edited by hand; the AI
 * research engine (phase 2) and the Downstream importer (phase 5) write
 * through the same `saveMarket` / `saveSector` paths, so the cleaning, the
 * personal-data scrub and the version history hold for every writer.
 *
 * Rules:
 *   - every read and write is scoped to ctx.workspace — research is never
 *     shared between workspaces (Downstream's house rule, kept by the owner);
 *   - anyone in the workspace can read; managers and admins edit; deleting a
 *     market or sector is an admin's call;
 *   - every save is a version (research_revisions). A save names the revision
 *     it started from; if someone else saved in between, it is refused with
 *     CONFLICT rather than silently overwriting their work.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { personas, researchMarkets, researchRevisions, researchSectors, users } from "../../drizzle/schema";
import { getDb } from "../db";
import { recordAudit } from "../audit";
import { router } from "../_core/trpc";
import { adminWsProcedure, managerProcedure, workspaceProcedure } from "../_core/workspace";
import {
  changedParts,
  cleanMarketContent,
  cleanSectorContent,
  RESEARCH_STATUSES,
  type MarketContent,
  type SectorContent,
} from "@shared/researchShape";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function requireDb(): Promise<Db> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return db;
}

/** Versions kept per market or sector; older ones are pruned on save. */
export const REVISIONS_KEPT = 50;

const CONFLICT_MESSAGE = "Someone else saved this since you opened it. Reload to see their changes, then make yours again.";

const affectedRows = (r: unknown): number =>
  Number(((Array.isArray(r) ? r[0] : r) as { affectedRows?: number } | undefined)?.affectedRows ?? 0);

/* ── Row ⇄ content ──────────────────────────────────────────────────────── */

type MarketRow = typeof researchMarkets.$inferSelect;
type SectorRow = typeof researchSectors.$inferSelect;

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

function marketColumns(c: MarketContent) {
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

function sectorColumns(c: SectorContent) {
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

async function loadMarket(db: Db, workspaceId: number, id: number): Promise<MarketRow> {
  const [row] = await db
    .select()
    .from(researchMarkets)
    .where(and(eq(researchMarkets.id, id), eq(researchMarkets.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Market not found" });
  return row;
}

async function loadSector(db: Db, workspaceId: number, id: number): Promise<SectorRow> {
  const [row] = await db
    .select()
    .from(researchSectors)
    .where(and(eq(researchSectors.id, id), eq(researchSectors.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Sector not found" });
  return row;
}

/** Case-insensitive name clash among siblings (markets in the workspace, sectors in a market). */
function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* ── Versions ───────────────────────────────────────────────────────────── */

async function writeRevision(
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

/* ── Inputs ─────────────────────────────────────────────────────────────── */

/**
 * Content arrives as a loose object and is cleaned by the shared shape, which
 * is the real validation (trims, caps, drops personal data). Zod only bounds
 * the envelope.
 */
const Content = z.record(z.string(), z.unknown());
const Id = z.number().int().positive();
const Revision = z.number().int().min(1);
const Entity = z.enum(["market", "sector"]);

/* ── Router ─────────────────────────────────────────────────────────────── */

export const researchRouter = router({
  markets: router({
    /** Every market in the workspace with its sector counts by status. */
    list: workspaceProcedure.query(async ({ ctx }) => {
      const db = await requireDb();
      const markets = await db
        .select({
          id: researchMarkets.id,
          name: researchMarkets.name,
          tagline: researchMarkets.tagline,
          status: researchMarkets.status,
          source: researchMarkets.source,
          updatedAt: researchMarkets.updatedAt,
        })
        .from(researchMarkets)
        .where(eq(researchMarkets.workspaceId, ctx.workspace.id))
        .orderBy(asc(researchMarkets.name));
      const counts = await db
        .select({ marketId: researchSectors.marketId, status: researchSectors.status, c: sql<number>`count(*)` })
        .from(researchSectors)
        .where(eq(researchSectors.workspaceId, ctx.workspace.id))
        .groupBy(researchSectors.marketId, researchSectors.status);
      return markets.map((m) => {
        const byStatus = { draft: 0, researched: 0, verified: 0 } as Record<(typeof RESEARCH_STATUSES)[number], number>;
        for (const r of counts) if (r.marketId === m.id) byStatus[r.status] = Number(r.c);
        return { ...m, sectorCount: byStatus.draft + byStatus.researched + byStatus.verified, sectorsByStatus: byStatus };
      });
    }),

    /** One market, its content, and its sectors (light rows with persona counts). */
    get: workspaceProcedure.input(z.object({ id: Id })).query(async ({ ctx, input }) => {
      const db = await requireDb();
      const row = await loadMarket(db, ctx.workspace.id, input.id);
      const sectors = await db
        .select({
          id: researchSectors.id,
          name: researchSectors.name,
          shortName: researchSectors.shortName,
          tagline: researchSectors.tagline,
          status: researchSectors.status,
          scores: researchSectors.scores,
          asOf: researchSectors.asOf,
          updatedAt: researchSectors.updatedAt,
        })
        .from(researchSectors)
        .where(and(eq(researchSectors.workspaceId, ctx.workspace.id), eq(researchSectors.marketId, row.id)))
        .orderBy(asc(researchSectors.name));
      const personaCounts = sectors.length
        ? await db
            .select({ sectorId: personas.sectorId, c: sql<number>`count(*)` })
            .from(personas)
            .where(and(eq(personas.workspaceId, ctx.workspace.id), inArray(personas.sectorId, sectors.map((s) => s.id))))
            .groupBy(personas.sectorId)
        : [];
      const pmap = new Map(personaCounts.map((r) => [r.sectorId, Number(r.c)]));
      return {
        market: {
          id: row.id,
          revision: row.revision,
          source: row.source,
          sourceRef: row.sourceRef,
          updatedAt: row.updatedAt,
          content: marketContentOf(row),
        },
        sectors: sectors.map((s) => ({ ...s, personaCount: pmap.get(s.id) ?? 0 })),
      };
    }),

    create: managerProcedure.input(z.object({ content: Content })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const { content, dropped } = cleanMarketContent(input.content);
      if (!content.name) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the market a name" });
      const siblings = await db
        .select({ name: researchMarkets.name })
        .from(researchMarkets)
        .where(eq(researchMarkets.workspaceId, ctx.workspace.id));
      if (siblings.some((s) => sameName(s.name, content.name))) {
        throw new TRPCError({ code: "CONFLICT", message: `There is already a market called "${content.name}"` });
      }
      const [row] = await db
        .insert(researchMarkets)
        .values({
          workspaceId: ctx.workspace.id,
          ...marketColumns(content),
          source: "manual",
          revision: 1,
          createdByUserId: ctx.user.id,
          updatedByUserId: ctx.user.id,
        })
        .$returningId();
      await writeRevision(db, { workspaceId: ctx.workspace.id, entityType: "market", entityId: row.id, revision: 1, data: content, changed: [], note: "Created", userId: ctx.user.id });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "research_market", entityId: row.id, after: { name: content.name } });
      return { id: row.id, revision: 1, dropped };
    }),

    update: managerProcedure
      .input(z.object({ id: Id, expectedRevision: Revision, content: Content }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        const r = await saveMarket(db, { workspaceId: ctx.workspace.id, userId: ctx.user.id, id: input.id, expectedRevision: input.expectedRevision, content: input.content });
        if (r.changed.length) {
          await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "research_market", entityId: input.id, after: { revision: r.revision, changed: r.changed } });
        }
        return r;
      }),

    /** Deletes the market, its sectors and every version; its personas stay, unlinked. */
    delete: adminWsProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const row = await loadMarket(db, ctx.workspace.id, input.id);
      const sectorIds = (await db
        .select({ id: researchSectors.id })
        .from(researchSectors)
        .where(and(eq(researchSectors.workspaceId, ctx.workspace.id), eq(researchSectors.marketId, row.id)))).map((s) => s.id);
      if (sectorIds.length) {
        await db
          .update(personas)
          .set({ sectorId: null })
          .where(and(eq(personas.workspaceId, ctx.workspace.id), inArray(personas.sectorId, sectorIds)));
        await db
          .delete(researchRevisions)
          .where(and(eq(researchRevisions.workspaceId, ctx.workspace.id), eq(researchRevisions.entityType, "sector"), inArray(researchRevisions.entityId, sectorIds)));
        await db
          .delete(researchSectors)
          .where(and(eq(researchSectors.workspaceId, ctx.workspace.id), inArray(researchSectors.id, sectorIds)));
      }
      await db
        .delete(researchRevisions)
        .where(and(eq(researchRevisions.workspaceId, ctx.workspace.id), eq(researchRevisions.entityType, "market"), eq(researchRevisions.entityId, row.id)));
      await db
        .delete(researchMarkets)
        .where(and(eq(researchMarkets.id, row.id), eq(researchMarkets.workspaceId, ctx.workspace.id)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "research_market", entityId: row.id, before: { name: row.name, sectors: sectorIds.length } });
      return { success: true, sectorsDeleted: sectorIds.length };
    }),
  }),

  sectors: router({
    /** Every sector in the workspace, for pickers (persona editor, later campaigns). */
    options: workspaceProcedure.query(async ({ ctx }) => {
      const db = await requireDb();
      return db
        .select({
          id: researchSectors.id,
          name: researchSectors.name,
          status: researchSectors.status,
          marketId: researchSectors.marketId,
          marketName: researchMarkets.name,
        })
        .from(researchSectors)
        .innerJoin(researchMarkets, and(eq(researchMarkets.id, researchSectors.marketId), eq(researchMarkets.workspaceId, ctx.workspace.id)))
        .where(eq(researchSectors.workspaceId, ctx.workspace.id))
        .orderBy(asc(researchMarkets.name), asc(researchSectors.name));
    }),

    get: workspaceProcedure.input(z.object({ id: Id })).query(async ({ ctx, input }) => {
      const db = await requireDb();
      const row = await loadSector(db, ctx.workspace.id, input.id);
      const market = await loadMarket(db, ctx.workspace.id, row.marketId);
      const sectorPersonas = await db
        .select()
        .from(personas)
        .where(and(eq(personas.workspaceId, ctx.workspace.id), eq(personas.sectorId, row.id)))
        .orderBy(asc(personas.name));
      return {
        sector: {
          id: row.id,
          marketId: row.marketId,
          revision: row.revision,
          source: row.source,
          sourceRef: row.sourceRef,
          updatedAt: row.updatedAt,
          content: sectorContentOf(row),
        },
        market: { id: market.id, name: market.name },
        personas: sectorPersonas,
      };
    }),

    create: managerProcedure
      .input(z.object({ marketId: Id, content: Content }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        const market = await loadMarket(db, ctx.workspace.id, input.marketId);
        const { content, dropped } = cleanSectorContent(input.content);
        if (!content.name) throw new TRPCError({ code: "BAD_REQUEST", message: "Give the sector a name" });
        const siblings = await db
          .select({ name: researchSectors.name })
          .from(researchSectors)
          .where(and(eq(researchSectors.workspaceId, ctx.workspace.id), eq(researchSectors.marketId, market.id)));
        if (siblings.some((s) => sameName(s.name, content.name))) {
          throw new TRPCError({ code: "CONFLICT", message: `This market already has a sector called "${content.name}"` });
        }
        const [row] = await db
          .insert(researchSectors)
          .values({
            workspaceId: ctx.workspace.id,
            marketId: market.id,
            ...sectorColumns(content),
            source: "manual",
            revision: 1,
            createdByUserId: ctx.user.id,
            updatedByUserId: ctx.user.id,
          })
          .$returningId();
        await writeRevision(db, { workspaceId: ctx.workspace.id, entityType: "sector", entityId: row.id, revision: 1, data: content, changed: [], note: "Created", userId: ctx.user.id });
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "research_sector", entityId: row.id, after: { name: content.name, marketId: market.id } });
        return { id: row.id, revision: 1, dropped };
      }),

    update: managerProcedure
      .input(z.object({ id: Id, expectedRevision: Revision, content: Content }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        const r = await saveSector(db, { workspaceId: ctx.workspace.id, userId: ctx.user.id, id: input.id, expectedRevision: input.expectedRevision, content: input.content });
        if (r.changed.length) {
          await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "research_sector", entityId: input.id, after: { revision: r.revision, changed: r.changed } });
        }
        return r;
      }),

    /** Deletes the sector and its versions; its personas stay, unlinked. */
    delete: adminWsProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const row = await loadSector(db, ctx.workspace.id, input.id);
      await db
        .update(personas)
        .set({ sectorId: null })
        .where(and(eq(personas.workspaceId, ctx.workspace.id), eq(personas.sectorId, row.id)));
      await db
        .delete(researchRevisions)
        .where(and(eq(researchRevisions.workspaceId, ctx.workspace.id), eq(researchRevisions.entityType, "sector"), eq(researchRevisions.entityId, row.id)));
      await db
        .delete(researchSectors)
        .where(and(eq(researchSectors.id, row.id), eq(researchSectors.workspaceId, ctx.workspace.id)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "research_sector", entityId: row.id, before: { name: row.name, marketId: row.marketId } });
      return { success: true, marketId: row.marketId };
    }),
  }),

  revisions: router({
    /** The version list for one market or sector, newest first (no content). */
    list: workspaceProcedure
      .input(z.object({ entityType: Entity, entityId: Id }))
      .query(async ({ ctx, input }) => {
        const db = await requireDb();
        if (input.entityType === "market") await loadMarket(db, ctx.workspace.id, input.entityId);
        else await loadSector(db, ctx.workspace.id, input.entityId);
        const rows = await db
          .select({
            revision: researchRevisions.revision,
            changed: researchRevisions.changed,
            note: researchRevisions.note,
            savedByUserId: researchRevisions.savedByUserId,
            savedAt: researchRevisions.savedAt,
          })
          .from(researchRevisions)
          .where(and(
            eq(researchRevisions.workspaceId, ctx.workspace.id),
            eq(researchRevisions.entityType, input.entityType),
            eq(researchRevisions.entityId, input.entityId),
          ))
          .orderBy(desc(researchRevisions.revision));
        const ids = Array.from(new Set(rows.map((r) => r.savedByUserId).filter((v): v is number => v != null)));
        const names = ids.length
          ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids))
          : [];
        const nmap = new Map(names.map((u) => [u.id, u.name || u.email || "Someone"]));
        return rows.map((r) => ({
          ...r,
          changed: Array.isArray(r.changed) ? (r.changed as string[]) : [],
          savedByName: r.savedByUserId != null ? nmap.get(r.savedByUserId) ?? "A former member" : "Velocity",
        }));
      }),

    /** One saved version's full content, for viewing and comparing. */
    get: workspaceProcedure
      .input(z.object({ entityType: Entity, entityId: Id, revision: Revision }))
      .query(async ({ ctx, input }) => {
        const db = await requireDb();
        const [row] = await db
          .select()
          .from(researchRevisions)
          .where(and(
            eq(researchRevisions.workspaceId, ctx.workspace.id),
            eq(researchRevisions.entityType, input.entityType),
            eq(researchRevisions.entityId, input.entityId),
            eq(researchRevisions.revision, input.revision),
          ))
          .limit(1);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "That version is no longer kept" });
        const data = input.entityType === "market" ? cleanMarketContent(row.data).content : cleanSectorContent(row.data).content;
        return { revision: row.revision, note: row.note, savedAt: row.savedAt, data };
      }),

    /** Saves an old version's content as a new version. Nothing is lost: the current one stays in history. */
    restore: managerProcedure
      .input(z.object({ entityType: Entity, entityId: Id, revision: Revision, expectedRevision: Revision }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        const [old] = await db
          .select({ data: researchRevisions.data })
          .from(researchRevisions)
          .where(and(
            eq(researchRevisions.workspaceId, ctx.workspace.id),
            eq(researchRevisions.entityType, input.entityType),
            eq(researchRevisions.entityId, input.entityId),
            eq(researchRevisions.revision, input.revision),
          ))
          .limit(1);
        if (!old) throw new TRPCError({ code: "NOT_FOUND", message: "That version is no longer kept" });
        const args = {
          workspaceId: ctx.workspace.id,
          userId: ctx.user.id,
          id: input.entityId,
          expectedRevision: input.expectedRevision,
          content: old.data,
          note: `Restored version ${input.revision}`,
        };
        const r = input.entityType === "market" ? await saveMarket(db, args) : await saveSector(db, args);
        await recordAudit({
          workspaceId: ctx.workspace.id,
          actorUserId: ctx.user.id,
          action: "update",
          entityType: input.entityType === "market" ? "research_market" : "research_sector",
          entityId: input.entityId,
          after: { restoredFrom: input.revision, revision: r.revision, changed: r.changed },
        });
        return r;
      }),
  }),
});
