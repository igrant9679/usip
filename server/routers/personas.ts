/**
 * Personas Router
 *
 * Reusable targeting templates ("Job Titles + Industries + Size + Location +
 * Keywords") that can be applied to any outreach object — primarily ARE
 * campaigns, but reusable across sequences and prospect search.
 */
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { personaCategories, personas } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";

const PersonaInput = z.object({
  name: z.string().min(2).max(120),
  description: z.string().optional(),
  targetTitles: z.array(z.string()).default([]),
  targetIndustries: z.array(z.string()).default([]),
  targetGeographies: z.array(z.string()).default([]),
  employeeMin: z.number().int().min(1).nullable().optional(),
  employeeMax: z.number().int().min(1).nullable().optional(),
  keywords: z.array(z.string()).default([]),
  categoryId: z.number().int().nullable().optional(),
});

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

export const personasRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    return db
      .select()
      .from(personas)
      .where(eq(personas.workspaceId, ctx.workspace.id))
      .orderBy(desc(personas.updatedAt));
  }),

  listPresets: workspaceProcedure.query(() => PRESET_PERSONAS),

  get: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .select()
        .from(personas)
        .where(and(eq(personas.id, input.id), eq(personas.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),

  create: workspaceProcedure
    .input(PersonaInput)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.categoryId != null) await assertCategoryInWorkspace(db, input.categoryId, ctx.workspace.id);
      const [row] = await db
        .insert(personas)
        .values({
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
      return { id: row.id };
    }),

  /** Create from a preset key (also accepts overrides if user customized). */
  createFromPreset: workspaceProcedure
    .input(z.object({ presetKey: z.string(), overrides: PersonaInput.partial().optional() }))
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

  update: workspaceProcedure
    .input(z.object({ id: z.number() }).merge(PersonaInput.partial()))
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
      await db
        .update(personas)
        .set(updates)
        .where(and(eq(personas.id, id), eq(personas.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),

  delete: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(personas)
        .where(and(eq(personas.id, input.id), eq(personas.workspaceId, ctx.workspace.id)));
      return { success: true };
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

  createCategory: workspaceProcedure
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

  updateCategory: workspaceProcedure
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
  deleteCategory: workspaceProcedure
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
  reorderCategories: workspaceProcedure
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
