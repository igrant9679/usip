/**
 * Personas Router
 *
 * Reusable targeting templates ("Job Titles + Industries + Size + Location +
 * Keywords") that can be applied to any outreach object — primarily ARE
 * campaigns, but reusable across sequences and prospect search.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { areCampaigns, personaCategories, personas, researchSectors } from "../../drizzle/schema";
import { cleanPersonaResearch } from "@shared/researchShape";
import { getDb } from "../db";
import { forgetResearchContext } from "../services/research/context";
import { router } from "../_core/trpc";
import { adminWsProcedure, managerProcedure, workspaceProcedure } from "../_core/workspace";

const PersonaFields = z.object({
  name: z.string().min(2).max(120),
  description: z.string().optional(),
  targetTitles: z.array(z.string()),
  targetIndustries: z.array(z.string()),
  targetGeographies: z.array(z.string()),
  employeeMin: z.number().int().min(1).nullable().optional(),
  employeeMax: z.number().int().min(1).nullable().optional(),
  keywords: z.array(z.string()),
  categoryId: z.number().int().nullable().optional(),
  // Research (migration 0201): the sector this buyer belongs to and what the
  // AI writers will need about them. Cleaned by the shared research shape,
  // which also drops anything that looks like a personal email or phone.
  sectorId: z.number().int().nullable().optional(),
  cares: z.string().max(4000).optional(),
  pains: z.array(z.string().max(1000)).max(60).optional(),
  objections: z.array(z.string().max(1000)).max(60).optional(),
  angle: z.string().max(4000).optional(),
});

/** A new persona: the lists it leaves out start empty. */
const PersonaInput = PersonaFields.extend({
  targetTitles: z.array(z.string()).default([]),
  targetIndustries: z.array(z.string()).default([]),
  targetGeographies: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
});

/**
 * A change: only what it names. Built without the defaults, because Zod 4
 * applies a default inside .partial(), so linking a persona to a sector
 * ({ id, sectorId }) emptied its titles, industries, places and keywords
 * (found 2026-11-06 while fixing audit P125).
 */
const PersonaPatch = PersonaFields.partial();

/**
 * The research fields present in an input, cleaned; absent ones stay absent.
 * `dropped` names what the cleaner removed as personal data, which the page
 * reports (audit 2026-10-20, P125: it was dropped silently).
 */
function researchFields(input: { cares?: string; pains?: string[]; objections?: string[]; angle?: string }) {
  const { content, dropped } = cleanPersonaResearch(input);
  const out: Partial<typeof personas.$inferInsert> = {};
  if (input.cares !== undefined) out.cares = content.cares || null;
  if (input.pains !== undefined) out.pains = content.pains;
  if (input.objections !== undefined) out.objections = content.objections;
  if (input.angle !== undefined) out.angle = content.angle || null;
  return { fields: out, dropped };
}

/** A caller-chosen sector must be this workspace's. */
async function assertSectorInWorkspace(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, sectorId: number, workspaceId: number) {
  const [row] = await db
    .select({ id: researchSectors.id })
    .from(researchSectors)
    .where(and(eq(researchSectors.id, sectorId), eq(researchSectors.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Sector not found" });
}

/** Caller-controlled categoryId is hostile until proven workspace-owned. */
async function assertCategoryInWorkspace(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, categoryId: number, workspaceId: number) {
  const [row] = await db
    .select({ id: personaCategories.id })
    .from(personaCategories)
    .where(and(eq(personaCategories.id, categoryId), eq(personaCategories.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Category not found" });
}

/**
 * Built-in preset library — surfaced from `listPresets` so the user can
 * one-click apply a sane starting point. Stored client-side (not in DB) so
 * they don't pollute per-workspace persona lists until the user saves.
 */
export const PRESET_PERSONAS = [
  {
    key: "saas_revops",
    name: "SaaS RevOps Leaders",
    description: "VP/Director of RevOps at mid-market SaaS companies",
    targetTitles: ["VP of Revenue Operations", "Director of RevOps", "Head of Revenue Operations", "Sales Operations Manager"],
    targetIndustries: ["Computer Software", "Software", "SaaS", "Information Technology"],
    targetGeographies: ["United States", "Canada"],
    employeeMin: 50,
    employeeMax: 1000,
    keywords: ["revenue operations", "salesforce", "hubspot", "pipeline analytics"],
  },
  {
    key: "ecom_growth",
    name: "Ecommerce Growth",
    description: "Heads of Growth / DTC marketing at mid-market ecommerce brands",
    targetTitles: ["Head of Growth", "VP of Marketing", "Director of Ecommerce", "DTC Marketing Manager"],
    targetIndustries: ["Retail", "Consumer Goods", "Apparel & Fashion", "Health, Wellness and Fitness"],
    targetGeographies: ["United States"],
    employeeMin: 20,
    employeeMax: 500,
    keywords: ["shopify", "klaviyo", "meta ads", "subscription", "DTC"],
  },
  {
    key: "agency_owners",
    name: "Agency Owners",
    description: "Founders/CEOs of marketing, design, or dev agencies",
    targetTitles: ["Founder", "CEO", "Managing Director", "Agency Owner"],
    targetIndustries: ["Marketing and Advertising", "Design", "Internet"],
    targetGeographies: ["United States", "United Kingdom", "Canada", "Australia"],
    employeeMin: 5,
    employeeMax: 200,
    keywords: ["agency", "consultancy", "client services"],
  },
  {
    key: "fintech_ops",
    name: "Fintech Operations",
    description: "COO / Head of Ops at fintech & payments companies",
    targetTitles: ["COO", "Chief Operating Officer", "Head of Operations", "VP of Operations"],
    targetIndustries: ["Financial Services", "Banking", "Investment Management", "Fintech"],
    targetGeographies: ["United States", "United Kingdom"],
    employeeMin: 50,
    employeeMax: 2000,
    keywords: ["payments", "compliance", "operations automation"],
  },
  {
    key: "healthtech_buyers",
    name: "Healthtech Buyers",
    description: "Practice managers + clinical ops at multi-location healthcare",
    targetTitles: ["Practice Manager", "Director of Operations", "Clinical Operations", "Chief Medical Officer"],
    targetIndustries: ["Hospital & Health Care", "Medical Practice", "Health, Wellness and Fitness"],
    targetGeographies: ["United States"],
    employeeMin: 20,
    employeeMax: 1000,
    keywords: ["EHR", "patient experience", "scheduling"],
  },
] as const;

/**
 * Personas and their categories steer every research writer and campaign that
 * uses them: a manager writes them and an admin deletes them, as in Research
 * (audit 2026-10-20, P31). Any member, viewers included, could do both.
 */
export const personasRouter = router({
  /**
   * Every persona, with how many of this workspace's Revenue Engine campaigns
   * use it and how many of those are active (audit 2026-10-20, U18: "used by
   * N campaigns"), counted in one grouped read.
   */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const rows = await db
      .select()
      .from(personas)
      .where(eq(personas.workspaceId, ctx.workspace.id))
      .orderBy(desc(personas.updatedAt));
    const ids = rows.map((r) => r.id);
    const used = ids.length
      ? await db
        .select({
          personaId: areCampaigns.personaId,
          n: sql<number>`count(*)`,
          active: sql<number>`sum(case when ${areCampaigns.status} = 'active' then 1 else 0 end)`,
        })
        .from(areCampaigns)
        .where(and(eq(areCampaigns.workspaceId, ctx.workspace.id), inArray(areCampaigns.personaId, ids)))
        .groupBy(areCampaigns.personaId)
      : [];
    const byId = new Map(used.map((u) => [u.personaId, u]));
    return rows.map((r) => ({
      ...r,
      campaignCount: Number(byId.get(r.id)?.n ?? 0),
      activeCampaignCount: Number(byId.get(r.id)?.active ?? 0),
    }));
  }),

  listPresets: workspaceProcedure.query(() => PRESET_PERSONAS),

  create: managerProcedure
    .input(PersonaInput)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.categoryId != null) await assertCategoryInWorkspace(db, input.categoryId, ctx.workspace.id);
      if (input.sectorId != null) await assertSectorInWorkspace(db, input.sectorId, ctx.workspace.id);
      const research = researchFields(input);
      const [row] = await db
        .insert(personas)
        .values({
          ...research.fields,
          sectorId: input.sectorId ?? null,
          workspaceId: ctx.workspace.id,
          name: input.name,
          description: input.description,
          targetTitles: input.targetTitles,
          targetIndustries: input.targetIndustries,
          targetGeographies: input.targetGeographies,
          employeeMin: input.employeeMin ?? null,
          employeeMax: input.employeeMax ?? null,
          keywords: input.keywords,
          categoryId: input.categoryId ?? null,
          createdByUserId: ctx.user.id,
        })
        .$returningId();
      forgetResearchContext(ctx.workspace.id);
      return { id: row.id, dropped: research.dropped };
    }),

  /** Create from a preset key (also accepts overrides if user customized). */
  createFromPreset: managerProcedure
    .input(z.object({ presetKey: z.string(), overrides: PersonaPatch.optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const preset = PRESET_PERSONAS.find((p) => p.key === input.presetKey);
      if (!preset) throw new TRPCError({ code: "NOT_FOUND", message: "Preset not found" });
      const merged = {
        name: preset.name,
        description: preset.description,
        targetTitles: [...preset.targetTitles],
        targetIndustries: [...preset.targetIndustries],
        targetGeographies: [...preset.targetGeographies],
        employeeMin: preset.employeeMin as number | null,
        employeeMax: preset.employeeMax as number | null,
        keywords: [...preset.keywords],
        ...(input.overrides ?? {}),
      };
      const [row] = await db
        .insert(personas)
        .values({
          workspaceId: ctx.workspace.id,
          name: merged.name,
          description: merged.description,
          targetTitles: merged.targetTitles,
          targetIndustries: merged.targetIndustries,
          targetGeographies: merged.targetGeographies,
          employeeMin: merged.employeeMin ?? null,
          employeeMax: merged.employeeMax ?? null,
          keywords: merged.keywords,
          isPreset: true,
          createdByUserId: ctx.user.id,
        })
        .$returningId();
      return { id: row.id };
    }),

  update: managerProcedure
    .input(z.object({ id: z.number() }).merge(PersonaPatch))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { id, ...rest } = input;
      const updates: Partial<typeof personas.$inferInsert> = {};
      if (rest.name !== undefined) updates.name = rest.name;
      if (rest.description !== undefined) updates.description = rest.description;
      if (rest.targetTitles !== undefined) updates.targetTitles = rest.targetTitles;
      if (rest.targetIndustries !== undefined) updates.targetIndustries = rest.targetIndustries;
      if (rest.targetGeographies !== undefined) updates.targetGeographies = rest.targetGeographies;
      if (rest.employeeMin !== undefined) updates.employeeMin = rest.employeeMin ?? null;
      if (rest.employeeMax !== undefined) updates.employeeMax = rest.employeeMax ?? null;
      if (rest.keywords !== undefined) updates.keywords = rest.keywords;
      if (rest.categoryId !== undefined) {
        if (rest.categoryId != null) await assertCategoryInWorkspace(db, rest.categoryId, ctx.workspace.id);
        updates.categoryId = rest.categoryId ?? null;
      }
      if (rest.sectorId !== undefined) {
        if (rest.sectorId != null) await assertSectorInWorkspace(db, rest.sectorId, ctx.workspace.id);
        updates.sectorId = rest.sectorId ?? null;
      }
      const research = researchFields(rest);
      Object.assign(updates, research.fields);
      await db
        .update(personas)
        .set(updates)
        .where(and(eq(personas.id, id), eq(personas.workspaceId, ctx.workspace.id)));
      forgetResearchContext(ctx.workspace.id);
      return { success: true, dropped: research.dropped };
    }),

  /** The campaigns whose writers use this persona, for the delete confirmation (P32). */
  usage: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const campaigns = await db
        .select({ id: areCampaigns.id, name: areCampaigns.name, status: areCampaigns.status })
        .from(areCampaigns)
        .where(and(eq(areCampaigns.workspaceId, ctx.workspace.id), eq(areCampaigns.personaId, input.id)))
        .orderBy(asc(areCampaigns.name));
      return { campaigns };
    }),

  /**
   * Refused while an active campaign uses the persona; a draft, paused or
   * finished one is cleared of it, so no campaign keeps a dead id and its
   * writers say they use none (audit 2026-10-20, P32: they kept it and fell
   * back to guessing from titles).
   */
  delete: adminWsProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const using = await db
        .select({ id: areCampaigns.id, name: areCampaigns.name, status: areCampaigns.status })
        .from(areCampaigns)
        .where(and(eq(areCampaigns.workspaceId, ctx.workspace.id), eq(areCampaigns.personaId, input.id)));
      const live = using.filter((c) => c.status === "active");
      if (live.length) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${live.length === 1 ? `The active campaign "${live[0].name}" uses` : `${live.length} active campaigns use`} this persona. Pause ${live.length === 1 ? "it" : "them"}, or give ${live.length === 1 ? "it" : "them"} another persona, first.`,
        });
      }
      if (using.length) {
        await db
          .update(areCampaigns)
          .set({ personaId: null })
          .where(and(eq(areCampaigns.workspaceId, ctx.workspace.id), eq(areCampaigns.personaId, input.id)));
      }
      await db
        .delete(personas)
        .where(and(eq(personas.id, input.id), eq(personas.workspaceId, ctx.workspace.id)));
      forgetResearchContext(ctx.workspace.id);
      return { success: true, campaignsCleared: using.length };
    }),

  // ── Categories ─────────────────────────────────────────────────────
  listCategories: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    return db
      .select()
      .from(personaCategories)
      .where(eq(personaCategories.workspaceId, ctx.workspace.id))
      .orderBy(asc(personaCategories.sortOrder), asc(personaCategories.id));
  }),

  createCategory: managerProcedure
    .input(z.object({ name: z.string().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // New categories land at the end of the current order.
      const existing = await db
        .select({ sortOrder: personaCategories.sortOrder })
        .from(personaCategories)
        .where(eq(personaCategories.workspaceId, ctx.workspace.id))
        .orderBy(desc(personaCategories.sortOrder))
        .limit(1);
      const [row] = await db
        .insert(personaCategories)
        .values({
          workspaceId: ctx.workspace.id,
          name: input.name.trim(),
          sortOrder: (existing[0]?.sortOrder ?? -1) + 1,
        })
        .$returningId();
      return { id: row.id };
    }),

  updateCategory: managerProcedure
    .input(z.object({ id: z.number(), name: z.string().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await assertCategoryInWorkspace(db, input.id, ctx.workspace.id);
      await db
        .update(personaCategories)
        .set({ name: input.name.trim() })
        .where(and(eq(personaCategories.id, input.id), eq(personaCategories.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),

  /** Personas in the category survive — they fall back to Uncategorized. */
  deleteCategory: adminWsProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await assertCategoryInWorkspace(db, input.id, ctx.workspace.id);
      await db
        .update(personas)
        .set({ categoryId: null })
        .where(and(eq(personas.categoryId, input.id), eq(personas.workspaceId, ctx.workspace.id)));
      await db
        .delete(personaCategories)
        .where(and(eq(personaCategories.id, input.id), eq(personaCategories.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),

  /** Full ordered id list → sortOrder = array index. Ids not owned by the
   *  workspace are ignored by the scoped WHERE (not an error — a stale
   *  client list shouldn't fail the whole reorder). */
  reorderCategories: managerProcedure
    .input(z.object({ ids: z.array(z.number().int()).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      for (let i = 0; i < input.ids.length; i++) {
        await db
          .update(personaCategories)
          .set({ sortOrder: i })
          .where(and(eq(personaCategories.id, input.ids[i]), eq(personaCategories.workspaceId, ctx.workspace.id)));
      }
      return { success: true };
    }),
});
