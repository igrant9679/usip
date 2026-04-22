/**
 * savedSectionsRouter
 * CRUD for reusable email sections saved from the Visual Email Builder canvas.
 * Sections are workspace-scoped; any member can read, reps+ can create/update/delete their own.
 */
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
import { emailSavedSections } from "../../drizzle/schema";
import { repProcedure, workspaceProcedure } from "../_core/workspace";
import { router } from "../_core/trpc";
import { renderDesignToHtml, resolveMergeTags } from "./emailBuilder";

/* ─── Zod schemas ─────────────────────────────────────────────────────────── */

const SECTION_CATEGORIES = [
  "layout",
  "header",
  "footer",
  "cta",
  "testimonial",
  "pricing",
  "custom",
] as const;

const blockSchema = z.object({
  id: z.string(),
  type: z.string(),
  props: z.record(z.string(), z.unknown()),
  sortOrder: z.number(),
});

const createInput = z.object({
  name: z.string().min(1, "Name is required").max(200),
  description: z.string().max(500).optional(),
  category: z.enum(SECTION_CATEGORIES).default("custom"),
  blocks: z.array(blockSchema).min(1, "At least one block is required"),
});

const updateInput = z.object({
  id: z.number(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  category: z.enum(SECTION_CATEGORIES).optional(),
  blocks: z.array(blockSchema).min(1).optional(),
});

/* ─── Router ──────────────────────────────────────────────────────────────── */

export const savedSectionsRouter = router({
  /** List all saved sections for the workspace, optionally filtered by category */
  list: workspaceProcedure
    .input(
      z.object({
        category: z.enum([...SECTION_CATEGORIES, "all"]).default("all"),
        search: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      let rows = await db
        .select()
        .from(emailSavedSections)
        .where(
          input.category === "all"
            ? eq(emailSavedSections.workspaceId, ctx.workspace.id)
            : and(
                eq(emailSavedSections.workspaceId, ctx.workspace.id),
                eq(emailSavedSections.category, input.category),
              ),
        )
        .orderBy(desc(emailSavedSections.updatedAt));

      // Client-side search filter (name + description)
      if (input.search) {
        const q = input.search.toLowerCase();
        rows = rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            (r.description ?? "").toLowerCase().includes(q),
        );
      }

      return rows;
    }),

  /** Get a single saved section by id */
  get: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [row] = await db
        .select()
        .from(emailSavedSections)
        .where(
          and(
            eq(emailSavedSections.id, input.id),
            eq(emailSavedSections.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);

      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      return row;
    }),

  /** Save a new section from selected canvas blocks */
  create: repProcedure
    .input(createInput)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Pre-render a preview HTML snippet (no subject needed for preview)
      const previewHtml = renderDesignToHtml(
        input.blocks as Parameters<typeof renderDesignToHtml>[0],
        "preview",
        {},
      );

      const [result] = await db.insert(emailSavedSections).values({
        workspaceId: ctx.workspace.id,
        name: input.name,
        description: input.description ?? null,
        category: input.category,
        blocks: input.blocks,
        previewHtml,
        createdByUserId: ctx.user.id,
      });

      const insertId = (result as { insertId: number }).insertId;
      const [created] = await db
        .select()
        .from(emailSavedSections)
        .where(eq(emailSavedSections.id, insertId))
        .limit(1);

      return created;
    }),

  /** Update name, description, category, or blocks of an existing section */
  update: repProcedure
    .input(updateInput)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Verify ownership (creator or admin+)
      const [existing] = await db
        .select()
        .from(emailSavedSections)
        .where(
          and(
            eq(emailSavedSections.id, input.id),
            eq(emailSavedSections.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);

      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });

      const isOwner = existing.createdByUserId === ctx.user.id;
      const isAdmin = ["admin", "super_admin"].includes(ctx.member.role);
      if (!isOwner && !isAdmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the creator or an admin can edit this section.",
        });
      }

      const updateData: Partial<typeof existing> = {};
      if (input.name !== undefined) updateData.name = input.name;
      if (input.description !== undefined)
        updateData.description = input.description;
      if (input.category !== undefined) updateData.category = input.category;
      if (input.blocks !== undefined) {
        updateData.blocks = input.blocks;
        updateData.previewHtml = renderDesignToHtml(
          input.blocks as Parameters<typeof renderDesignToHtml>[0],
          "preview",
          {},
        );
      }

      await db
        .update(emailSavedSections)
        .set(updateData)
        .where(eq(emailSavedSections.id, input.id));

      const [updated] = await db
        .select()
        .from(emailSavedSections)
        .where(eq(emailSavedSections.id, input.id))
        .limit(1);

      return updated;
    }),

  /** Delete a saved section (creator or admin+) */
  delete: repProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [existing] = await db
        .select()
        .from(emailSavedSections)
        .where(
          and(
            eq(emailSavedSections.id, input.id),
            eq(emailSavedSections.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(1);

      if (!existing) throw new TRPCError({ code: "NOT_FOUND" });

      const isOwner = existing.createdByUserId === ctx.user.id;
      const isAdmin = ["admin", "super_admin"].includes(ctx.member.role);
      if (!isOwner && !isAdmin) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the creator or an admin can delete this section.",
        });
      }

      await db
        .delete(emailSavedSections)
        .where(eq(emailSavedSections.id, input.id));

      return { success: true };
    }),
});
