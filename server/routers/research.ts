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
import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { areCampaigns, personas, researchJobs, researchMarkets, researchRevisions, researchSectors, users, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { recordAudit } from "../audit";
import { router } from "../_core/trpc";
import { adminWsProcedure, managerProcedure, workspaceProcedure } from "../_core/workspace";
import { workspaceAnthropicKey } from "../_core/llm";
import { cancelResearchJob, enqueueResearchJob, failOrphanedJobs, type ResearchDraft } from "../services/research/engine";
import { ICP_FALLBACKS, workspaceIcpFallback } from "../services/research/targetingPrior";
import {
  DEFAULT_RESEARCH_DAILY_RUNS,
  MAX_RESEARCH_DAILY_RUNS,
  RESEARCH_MODELS,
  isResearchModel,
  researchModelOf,
} from "@shared/researchModels";
import {
  changedParts,
  cleanMarketContent,
  cleanSectorContent,
  emptyMarketContent,
  emptySectorContent,
  mergeMarketParts,
  mergeSectorParts,
  MARKET_RUN_PARTS,
  RESEARCH_STATUSES,
  SECTOR_RUN_PARTS,
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

/* ── Creating (by hand and from AI research) ────────────────────────────── */

type Source = "manual" | "ai" | "downstream";

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

/* ── AI research runs: limits ───────────────────────────────────────────── */

export const RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

async function researchSettingsOf(db: Db, workspaceId: number) {
  const [row] = await db
    .select({ model: workspaceSettings.researchModel, dailyRuns: workspaceSettings.researchDailyRuns })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const daily = row?.dailyRuns;
  return {
    model: researchModelOf(row?.model),
    dailyRuns: daily != null && daily >= 1 ? Math.min(MAX_RESEARCH_DAILY_RUNS, daily) : DEFAULT_RESEARCH_DAILY_RUNS,
  };
}

/**
 * The runs that count against a person's daily number: everything started in
 * the last 24 hours except a run that failed before spending anything (a
 * refused key, say), which should not cost them a turn.
 */
async function runsCounted(db: Db, workspaceId: number, userId: number) {
  return db
    .select({ id: researchJobs.id, createdAt: researchJobs.createdAt })
    .from(researchJobs)
    .where(and(
      eq(researchJobs.workspaceId, workspaceId),
      eq(researchJobs.userId, userId),
      gt(researchJobs.createdAt, new Date(Date.now() - RUN_WINDOW_MS)),
      or(ne(researchJobs.status, "failed"), gt(researchJobs.costUsd, "0")),
    ))
    .orderBy(asc(researchJobs.createdAt));
}

/** Who may see a run's draft and act on it: anyone in its workspace reads; managers act. */
async function loadJob(db: Db, workspaceId: number, id: number) {
  const [row] = await db
    .select()
    .from(researchJobs)
    .where(and(eq(researchJobs.id, id), eq(researchJobs.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Research run not found" });
  return row;
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
      const r = await insertMarket(db, { workspaceId: ctx.workspace.id, userId: ctx.user.id, content: input.content });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "research_market", entityId: r.id, after: { name: cleanMarketContent(input.content).content.name } });
      return { id: r.id, revision: 1, dropped: r.dropped };
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
          .update(areCampaigns)
          .set({ researchSectorId: null })
          .where(and(eq(areCampaigns.workspaceId, ctx.workspace.id), inArray(areCampaigns.researchSectorId, sectorIds)));
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
        const r = await insertSector(db, { workspaceId: ctx.workspace.id, userId: ctx.user.id, marketId: input.marketId, content: input.content });
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "research_sector", entityId: r.id, after: { name: cleanSectorContent(input.content).content.name, marketId: input.marketId } });
        return { id: r.id, revision: 1, dropped: r.dropped };
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
        .update(areCampaigns)
        .set({ researchSectorId: null })
        .where(and(eq(areCampaigns.workspaceId, ctx.workspace.id), eq(areCampaigns.researchSectorId, row.id)));
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

  /* ── AI research (phase 2) ──────────────────────────────────────────── */

  settings: router({
    /** The research model and daily runs, and whether this workspace can run research at all. */
    get: workspaceProcedure.query(async ({ ctx }) => {
      const db = await requireDb();
      const st = await researchSettingsOf(db, ctx.workspace.id);
      return {
        ...st,
        icpFallback: await workspaceIcpFallback(ctx.workspace.id),
        hasKey: !!(await workspaceAnthropicKey(ctx.workspace.id)),
        models: Object.entries(RESEARCH_MODELS).map(([id, m]) => ({ id, label: m.label, note: m.note, input: m.price.input, output: m.price.output })),
      };
    }),

    set: adminWsProcedure
      .input(z.object({ model: z.string(), dailyRuns: z.number().int().min(1).max(MAX_RESEARCH_DAILY_RUNS) }))
      .mutation(async ({ ctx, input }) => {
        if (!isResearchModel(input.model)) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick one of the listed models" });
        const db = await requireDb();
        const [existing] = await db.select({ ws: workspaceSettings.workspaceId }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id)).limit(1);
        if (existing) {
          await db.update(workspaceSettings).set({ researchModel: input.model, researchDailyRuns: input.dailyRuns }).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
        } else {
          await db.insert(workspaceSettings).values({ workspaceId: ctx.workspace.id, researchModel: input.model, researchDailyRuns: input.dailyRuns });
        }
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "research_settings", entityId: null, after: input });
        return { success: true };
      }),

    /**
     * What discovery uses when a campaign has no targeting of its own (phase
     * 4): the learned ICP (the default, and how it always worked), the
     * researched sectors, or both. Admins.
     */
    setIcpFallback: adminWsProcedure
      .input(z.object({ icpFallback: z.enum(ICP_FALLBACKS) }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        const [existing] = await db.select({ ws: workspaceSettings.workspaceId }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id)).limit(1);
        if (existing) {
          await db.update(workspaceSettings).set({ icpFallback: input.icpFallback }).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
        } else {
          await db.insert(workspaceSettings).values({ workspaceId: ctx.workspace.id, icpFallback: input.icpFallback });
        }
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "research_settings", entityId: null, after: input });
        return { success: true };
      }),
  }),

  runs: router({
    /**
     * Starts a run: research a new market, refresh a market, research a new
     * sector in a market, or refresh a sector. Writes a draft only; nothing
     * changes until a person saves parts of it.
     */
    start: managerProcedure
      .input(z.object({
        kind: z.enum(["market", "sector"]),
        marketId: Id.optional(),
        sectorId: Id.optional(),
        subject: z.string().trim().max(160).optional(),
        focus: z.string().trim().max(2000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        const ws = ctx.workspace.id;
        let marketId: number | null = null;
        let sectorId: number | null = null;
        let subject = "";
        if (input.kind === "sector" && input.sectorId) {
          const sector = await loadSector(db, ws, input.sectorId);
          sectorId = sector.id;
          marketId = sector.marketId;
          subject = sector.name;
        } else if (input.kind === "sector") {
          if (!input.marketId) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the market the sector belongs to" });
          const market = await loadMarket(db, ws, input.marketId);
          marketId = market.id;
          subject = (input.subject ?? "").trim();
          if (!subject) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the sector to research" });
          const siblings = await db.select({ name: researchSectors.name }).from(researchSectors).where(and(eq(researchSectors.workspaceId, ws), eq(researchSectors.marketId, market.id)));
          if (siblings.some((x) => sameName(x.name, subject))) {
            throw new TRPCError({ code: "CONFLICT", message: `This market already has a sector called "${subject}". Open it and use Refresh instead.` });
          }
        } else if (input.marketId) {
          const market = await loadMarket(db, ws, input.marketId);
          marketId = market.id;
          subject = market.name;
        } else {
          subject = (input.subject ?? "").trim();
          if (!subject) throw new TRPCError({ code: "BAD_REQUEST", message: "Name the market to research" });
          const siblings = await db.select({ name: researchMarkets.name }).from(researchMarkets).where(eq(researchMarkets.workspaceId, ws));
          if (siblings.some((x) => sameName(x.name, subject))) {
            throw new TRPCError({ code: "CONFLICT", message: `There is already a market called "${subject}". Open it and use Refresh instead.` });
          }
        }

        if (!(await workspaceAnthropicKey(ws))) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Research runs on this workspace's own Anthropic key. An admin can add one in Settings → Integrations → AI provider keys." });
        }
        await failOrphanedJobs(db, ws);
        const [busy] = await db
          .select({ id: researchJobs.id })
          .from(researchJobs)
          .where(and(eq(researchJobs.workspaceId, ws), eq(researchJobs.userId, ctx.user.id), inArray(researchJobs.status, ["queued", "running"])))
          .limit(1);
        if (busy) throw new TRPCError({ code: "CONFLICT", message: "You already have a research run going. Wait for it to finish, or stop it, first." });
        const st = await researchSettingsOf(db, ws);
        const counted = await runsCounted(db, ws, ctx.user.id);
        if (counted.length >= st.dailyRuns) {
          const free = new Date(new Date(counted[0].createdAt).getTime() + RUN_WINDOW_MS);
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: `You have used your ${st.dailyRuns} research runs for the last 24 hours. The next one frees up at ${free.toISOString()}.`,
          });
        }

        const [row] = await db
          .insert(researchJobs)
          .values({
            workspaceId: ws,
            userId: ctx.user.id,
            kind: input.kind,
            marketId,
            sectorId,
            subject,
            focus: input.focus?.trim() || null,
            status: "queued",
            model: st.model,
          })
          .$returningId();
        await recordAudit({ workspaceId: ws, actorUserId: ctx.user.id, action: "create", entityType: "research_run", entityId: row.id, after: { kind: input.kind, subject, marketId, sectorId, model: st.model } });
        enqueueResearchJob(row.id);
        return { id: row.id };
      }),

    /** Recent runs in the workspace, and where the caller stands against the daily number. */
    list: workspaceProcedure.input(z.object({ limit: z.number().int().min(1).max(50).default(15) }).optional()).query(async ({ ctx, input }) => {
      const db = await requireDb();
      await failOrphanedJobs(db, ctx.workspace.id);
      const rows = await db
        .select({
          id: researchJobs.id,
          kind: researchJobs.kind,
          subject: researchJobs.subject,
          status: researchJobs.status,
          outcome: researchJobs.outcome,
          model: researchJobs.model,
          costUsd: researchJobs.costUsd,
          searches: researchJobs.searches,
          userId: researchJobs.userId,
          marketId: researchJobs.marketId,
          sectorId: researchJobs.sectorId,
          createdAt: researchJobs.createdAt,
          finishedAt: researchJobs.finishedAt,
        })
        .from(researchJobs)
        .where(eq(researchJobs.workspaceId, ctx.workspace.id))
        .orderBy(desc(researchJobs.createdAt))
        .limit(input?.limit ?? 15);
      const ids = Array.from(new Set(rows.map((r) => r.userId)));
      const names = ids.length ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids)) : [];
      const nmap = new Map(names.map((u) => [u.id, u.name || u.email || "Someone"]));
      const st = await researchSettingsOf(db, ctx.workspace.id);
      const counted = await runsCounted(db, ctx.workspace.id, ctx.user.id);
      return {
        runs: rows.map((r) => ({ ...r, byName: nmap.get(r.userId) ?? "A former member", mine: r.userId === ctx.user.id })),
        usedToday: counted.length,
        dailyRuns: st.dailyRuns,
        nextFreeAt: counted.length >= st.dailyRuns ? new Date(new Date(counted[0].createdAt).getTime() + RUN_WINDOW_MS) : null,
      };
    }),

    /** One run: its progress while it works, and its draft (with what it would change) when it is done. */
    get: workspaceProcedure.input(z.object({ id: Id })).query(async ({ ctx, input }) => {
      const db = await requireDb();
      await failOrphanedJobs(db, ctx.workspace.id);
      const job = await loadJob(db, ctx.workspace.id, input.id);
      let current: { revision: number; content: unknown } | null = null;
      let marketName: string | null = null;
      if (job.marketId != null) {
        const [m] = await db.select().from(researchMarkets).where(and(eq(researchMarkets.id, job.marketId), eq(researchMarkets.workspaceId, ctx.workspace.id))).limit(1);
        if (m) {
          marketName = m.name;
          if (job.kind === "market") current = { revision: m.revision, content: marketContentOf(m) };
        }
      }
      if (job.kind === "sector" && job.sectorId != null) {
        const [x] = await db.select().from(researchSectors).where(and(eq(researchSectors.id, job.sectorId), eq(researchSectors.workspaceId, ctx.workspace.id))).limit(1);
        if (x) current = { revision: x.revision, content: sectorContentOf(x) };
      }
      return {
        ...job,
        progress: Array.isArray(job.progress) ? (job.progress as { at: string; line: string }[]) : [],
        sources: Array.isArray(job.sources) ? (job.sources as { title: string; url: string }[]) : [],
        dropped: Array.isArray(job.dropped) ? (job.dropped as string[]) : [],
        draft: (job.draft ?? null) as ResearchDraft | null,
        current,
        marketName,
        mine: job.userId === ctx.user.id,
      };
    }),

    /** Stops a queued or running run. Its owner or an admin. What it spent stays recorded. */
    cancel: managerProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const job = await loadJob(db, ctx.workspace.id, input.id);
      if (job.userId !== ctx.user.id && ctx.member.role !== "admin" && ctx.member.role !== "super_admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the person who started a run, or an admin, can stop it" });
      }
      if (job.status !== "queued" && job.status !== "running") return { success: true, status: job.status };
      cancelResearchJob(job.id);
      await db
        .update(researchJobs)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(and(eq(researchJobs.id, job.id), eq(researchJobs.workspaceId, ctx.workspace.id), inArray(researchJobs.status, ["queued", "running"])));
      return { success: true, status: "cancelled" as const };
    }),

    /**
     * Saves the parts of a finished draft a person chose, as a version of the
     * market or sector ("AI research, run N"), creating it when the run was
     * for a new one; and the personas they ticked, in the sector. A refresh
     * names the revision the person reviewed against, so a save made since is
     * not overwritten.
     */
    accept: managerProcedure
      .input(z.object({
        id: Id,
        parts: z.array(z.string()).max(20),
        personas: z.array(z.number().int().min(0).max(20)).max(20).default([]),
        expectedRevision: Revision.optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        const ws = ctx.workspace.id;
        const job = await loadJob(db, ws, input.id);
        if (job.status !== "done" || !job.draft) throw new TRPCError({ code: "BAD_REQUEST", message: "This run has no finished draft to save" });
        if (job.outcome) throw new TRPCError({ code: "CONFLICT", message: job.outcome === "accepted" ? "This draft was already saved" : "This draft was discarded" });
        const draft = job.draft as ResearchDraft;
        const note = `AI research (run ${job.id})`;
        const ref = `research-run:${job.id}`;
        let resultType: "market" | "sector" = draft.kind;
        let resultId: number;
        const allowed: readonly string[] = draft.kind === "market" ? MARKET_RUN_PARTS : SECTOR_RUN_PARTS;
        const parts = input.parts.filter((x) => allowed.includes(x));
        if (parts.length === 0 && input.personas.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Tick at least one part to save" });

        if (draft.kind === "market") {
          const proposed = cleanMarketContent(draft.content).content;
          if (job.marketId != null) {
            const cur = await loadMarket(db, ws, job.marketId);
            if (input.expectedRevision == null) throw new TRPCError({ code: "BAD_REQUEST", message: "Reload the run and try again" });
            const merged = mergeMarketParts(marketContentOf(cur), proposed, parts);
            await saveMarket(db, { workspaceId: ws, userId: ctx.user.id, id: cur.id, expectedRevision: input.expectedRevision, content: merged, note });
            resultId = cur.id;
          } else {
            const merged = mergeMarketParts(emptyMarketContent(job.subject), proposed, parts);
            resultId = (await insertMarket(db, { workspaceId: ws, userId: ctx.user.id, content: merged, source: "ai", sourceRef: ref, note: `Created from ${note}` })).id;
          }
        } else {
          const proposed = cleanSectorContent(draft.content).content;
          if (job.sectorId != null) {
            const cur = await loadSector(db, ws, job.sectorId);
            if (input.expectedRevision == null) throw new TRPCError({ code: "BAD_REQUEST", message: "Reload the run and try again" });
            const merged = mergeSectorParts(sectorContentOf(cur), proposed, parts);
            if (parts.length) await saveSector(db, { workspaceId: ws, userId: ctx.user.id, id: cur.id, expectedRevision: input.expectedRevision, content: merged, note });
            resultId = cur.id;
          } else {
            if (job.marketId == null) throw new TRPCError({ code: "BAD_REQUEST", message: "This run has no market" });
            const merged = mergeSectorParts(emptySectorContent(job.subject), proposed, parts);
            resultId = (await insertSector(db, { workspaceId: ws, userId: ctx.user.id, marketId: job.marketId, content: merged, source: "ai", sourceRef: ref, note: `Created from ${note}` })).id;
          }
          // The ticked personas, in this sector, starting from its targeting.
          const existing = await db.select({ name: personas.name }).from(personas).where(and(eq(personas.workspaceId, ws), eq(personas.sectorId, resultId)));
          const taken = new Set(existing.map((p) => p.name.trim().toLowerCase()));
          for (const i of Array.from(new Set(input.personas))) {
            const p = draft.personas[i];
            if (!p || taken.has(p.name.trim().toLowerCase())) continue;
            taken.add(p.name.trim().toLowerCase());
            await db.insert(personas).values({
              workspaceId: ws,
              name: p.name.slice(0, 120),
              targetTitles: p.titles,
              targetIndustries: proposed.targeting.industries,
              targetGeographies: proposed.targeting.geographies,
              keywords: proposed.targeting.keywords,
              employeeMin: proposed.targeting.employeeMin,
              employeeMax: proposed.targeting.employeeMax,
              sectorId: resultId,
              cares: p.cares || null,
              pains: p.pains,
              objections: p.objections,
              angle: p.angle || null,
              source: "ai",
              sourceRef: ref,
              createdByUserId: ctx.user.id,
            });
          }
        }

        await db
          .update(researchJobs)
          .set({ outcome: "accepted", reviewedByUserId: ctx.user.id, reviewedAt: new Date(), resultType, resultId })
          .where(and(eq(researchJobs.id, job.id), eq(researchJobs.workspaceId, ws)));
        await recordAudit({ workspaceId: ws, actorUserId: ctx.user.id, action: "update", entityType: "research_run", entityId: job.id, after: { accepted: parts, personas: input.personas, resultType, resultId } });
        return { resultType, resultId };
      }),

    /**
     * Drafts again from a failed run's saved research, without searching or
     * reading anything again: only the drafting step is paid for twice.
     */
    redraft: managerProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const job = await loadJob(db, ctx.workspace.id, input.id);
      if (job.status !== "failed" || !(job.brief ?? "").trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Only a run that failed after its research can draft again" });
      }
      if (!(await workspaceAnthropicKey(ctx.workspace.id))) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Research runs on this workspace's own Anthropic key. An admin can add one in Settings → Integrations → AI provider keys." });
      }
      await db
        .update(researchJobs)
        .set({ status: "queued", error: null, finishedAt: null })
        .where(and(eq(researchJobs.id, job.id), eq(researchJobs.workspaceId, ctx.workspace.id), eq(researchJobs.status, "failed")));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "research_run", entityId: job.id, after: { redraft: true } });
      enqueueResearchJob(job.id);
      return { success: true };
    }),

    /** Sets a finished draft aside without saving any of it. */
    discard: managerProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const job = await loadJob(db, ctx.workspace.id, input.id);
      if (job.outcome) return { success: true };
      await db
        .update(researchJobs)
        .set({ outcome: "discarded", reviewedByUserId: ctx.user.id, reviewedAt: new Date() })
        .where(and(eq(researchJobs.id, job.id), eq(researchJobs.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),
  }),
});
