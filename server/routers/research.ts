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
import { areCampaigns, downstreamLinks, personas, researchExternalRefs, researchJobs, researchMarkets, researchRevisions, researchSectors, users, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { recordAudit } from "../audit";
import { router } from "../_core/trpc";
import { adminWsProcedure, managerProcedure, workspaceProcedure } from "../_core/workspace";
import { workspaceAnthropicKey } from "../_core/llm";
import { cancelResearchJob, enqueueResearchJob, failOrphanedJobs, type ResearchDraft } from "../services/research/engine";
import { ICP_FALLBACKS, workspaceIcpFallback } from "../services/research/targetingPrior";
import { commitDownstream, previewDownstream } from "../services/research/downstreamImport";
import { __clearResearchContextCache } from "../services/research/context";
import { personaResultSummaries, researchResults } from "../services/research/results";
import { cleanLinkSettings, type DownstreamMarketExtras } from "@shared/downstreamMap";
import {
  insertMarket,
  insertSector,
  loadMarket,
  loadSector,
  marketContentOf,
  requireDb,
  sameName,
  saveMarket,
  saveSector,
  sectorContentOf,
  writeRevision,
  type Db,
} from "../services/research/store";
export { REVISIONS_KEPT, insertMarket, insertSector, marketContentOf, saveMarket, saveSector, sectorContentOf, type SaveResult } from "../services/research/store";
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
          /** Downstream imports: {stats, funders}. */
          extras: (row.extras ?? null) as DownstreamMarketExtras | null,
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

  /* ── Results (phase 6) ──────────────────────────────────────────────── */

  // What happened to the prospects whose copy a sector or persona shaped:
  // contacted, replies, meetings, the brief check, and which pains, lead-with
  // points, hooks and opening lines got replies. Read by everyone, like the
  // research itself.
  results: router({
    sector: workspaceProcedure
      .input(z.object({ id: Id }))
      .query(({ ctx, input }) => researchResults(ctx.workspace.id, { sectorId: input.id })),
    persona: workspaceProcedure
      .input(z.object({ id: Id }))
      .query(({ ctx, input }) => researchResults(ctx.workspace.id, { personaId: input.id })),
    /** Contacted, replied and meetings per persona, for the persona lists. */
    personas: workspaceProcedure.query(({ ctx }) => personaResultSummaries(ctx.workspace.id)),
  }),

  /* ── Downstream imports (phase 5) ───────────────────────────────────── */

  downstream: router({
    /** The Downstream workspaces linked to this one, with what each brought in. */
    links: workspaceProcedure.query(async ({ ctx }) => {
      const db = await requireDb();
      const rows = await db.select().from(downstreamLinks).where(eq(downstreamLinks.workspaceId, ctx.workspace.id)).orderBy(asc(downstreamLinks.downstreamWorkspaceName));
      const refs = rows.length
        ? await db
            .select({ linkId: researchExternalRefs.linkId, kind: researchExternalRefs.kind, c: sql<number>`count(*)` })
            .from(researchExternalRefs)
            .where(eq(researchExternalRefs.workspaceId, ctx.workspace.id))
            .groupBy(researchExternalRefs.linkId, researchExternalRefs.kind)
        : [];
      return rows.map((l) => {
        const n = (kind: string) => Number(refs.find((r) => r.linkId === l.id && r.kind === kind)?.c ?? 0);
        return {
          id: l.id,
          name: l.downstreamWorkspaceName,
          downstreamWorkspaceId: l.downstreamWorkspaceId,
          sourceUrl: l.sourceUrl,
          status: l.status,
          audience: l.audience,
          useSellerMessaging: l.useSellerMessaging,
          settings: cleanLinkSettings(l.settings),
          marketId: l.marketId,
          lastImportAt: l.lastImportAt,
          lastExportedAt: l.lastExportedAt,
          counts: { sectors: n("sector"), personas: n("persona"), accounts: n("account") },
        };
      });
    }),

    /** This company's narrowing of the market; applies from the next import. */
    updateSettings: adminWsProcedure
      .input(z.object({
        id: Id,
        territory: z.array(z.string().max(120)).max(50),
        employeeMin: z.number().int().min(1).nullable(),
        employeeMax: z.number().int().min(1).nullable(),
        addTitles: z.array(z.string().max(120)).max(50),
        removeTitles: z.array(z.string().max(120)).max(50),
        exclude: z.array(z.string().max(80)).max(50),
      }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        const [l] = await db.select().from(downstreamLinks).where(and(eq(downstreamLinks.id, input.id), eq(downstreamLinks.workspaceId, ctx.workspace.id))).limit(1);
        if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "Downstream link not found" });
        const { id, ...rest } = input;
        const settings = cleanLinkSettings({ ...cleanLinkSettings(l.settings), ...rest });
        await db.update(downstreamLinks).set({ settings }).where(and(eq(downstreamLinks.id, id), eq(downstreamLinks.workspaceId, ctx.workspace.id)));
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "downstream_link", entityId: id, after: { settings } });
        return { success: true };
      }),

    /**
     * Pausing keeps the imported research but stops the writers and targeting
     * using it, and stops imports; resuming brings it back.
     */
    setStatus: adminWsProcedure
      .input(z.object({ id: Id, status: z.enum(["active", "paused"]) }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        const res = await db.update(downstreamLinks).set({ status: input.status }).where(and(eq(downstreamLinks.id, input.id), eq(downstreamLinks.workspaceId, ctx.workspace.id)));
        if (affectedRowsOf(res) !== 1) throw new TRPCError({ code: "NOT_FOUND", message: "Downstream link not found" });
        __clearResearchContextCache();
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "downstream_link", entityId: input.id, after: { status: input.status } });
        return { success: true };
      }),

    /**
     * Unlinks a Downstream workspace. What it imported stays as ordinary
     * research (delete the market to remove it); the next file from it has to
     * be linked again.
     */
    remove: adminWsProcedure.input(z.object({ id: Id })).mutation(async ({ ctx, input }) => {
      const db = await requireDb();
      const [l] = await db.select().from(downstreamLinks).where(and(eq(downstreamLinks.id, input.id), eq(downstreamLinks.workspaceId, ctx.workspace.id))).limit(1);
      if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "Downstream link not found" });
      await db.delete(researchExternalRefs).where(and(eq(researchExternalRefs.workspaceId, ctx.workspace.id), eq(researchExternalRefs.linkId, l.id)));
      await db.delete(downstreamLinks).where(and(eq(downstreamLinks.id, l.id), eq(downstreamLinks.workspaceId, ctx.workspace.id)));
      __clearResearchContextCache();
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "delete", entityType: "downstream_link", entityId: l.id, before: { name: l.downstreamWorkspaceName, downstreamWorkspaceId: l.downstreamWorkspaceId } });
      return { success: true };
    }),

    /** Reads an export and says what an import would do. Nothing is written. */
    preview: adminWsProcedure
      .input(z.object({ fileText: z.string().min(2).max(16 * 1024 * 1024) }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        return previewDownstream(db, ctx.workspace.id, ctx.user.id, ctx.workspace.name, input.fileText);
      }),

    /** Imports what the preview showed, as the person chose. Nothing is sent or launched. */
    commit: adminWsProcedure
      .input(z.object({
        token: z.string().uuid(),
        assign: z.boolean().optional(),
        updateLinkUrl: z.boolean().optional(),
        useSellerMessaging: z.boolean(),
        segments: z.array(z.string().max(300)).max(200),
        importOrganizations: z.boolean(),
        takeDownstream: z.array(z.string().max(300)).max(2000),
      }))
      .mutation(async ({ ctx, input }) => {
        const db = await requireDb();
        const r = await commitDownstream(db, ctx.workspace.id, ctx.user.id, true, input);
        __clearResearchContextCache();
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "downstream_import", entityId: r.linkId, after: { segments: input.segments, importOrganizations: input.importOrganizations, counts: r.counts } });
        return r;
      }),
  }),
});

function affectedRowsOf(r: unknown): number {
  return Number(((Array.isArray(r) ? r[0] : r) as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
}
