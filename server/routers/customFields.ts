/**
 * Sprint 5 — Custom Fields Framework
 * Admin-configurable field definitions per entity type.
 * Values are stored in the existing JSON `customFields` column on each entity.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { accounts, contacts, customFieldDefs, leads, opportunities } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { adminWsProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";

const ENTITY_TYPES = ["lead", "contact", "account", "opportunity"] as const;

const fieldDefInput = z.object({
  entityType: z.enum(ENTITY_TYPES),
  fieldKey: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "fieldKey must be snake_case starting with a letter"),
  label: z.string().min(1).max(120),
  fieldType: z.enum(["text", "number", "date", "boolean", "select", "multiselect", "url"]),
  options: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional(),
  required: z.boolean().default(false),
  showInList: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
});

export const customFieldsRouter = router({
  /** List field definitions for this workspace (optionally filtered by entityType) */
  listDefs: workspaceProcedure
    .input(z.object({ entityType: z.enum(ENTITY_TYPES).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      let rows = await db
        .select()
        .from(customFieldDefs)
        .where(eq(customFieldDefs.workspaceId, ctx.workspace.id));
      if (input?.entityType) rows = rows.filter((r) => r.entityType === input.entityType);
      return rows.sort((a, b) => a.sortOrder - b.sortOrder);
    }),

  /** Create a new custom field definition (admin only) */
  createDef: adminWsProcedure
    .input(fieldDefInput)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const r = await db.insert(customFieldDefs).values({
        workspaceId: ctx.workspace.id,
        entityType: input.entityType,
        fieldKey: input.fieldKey,
        label: input.label,
        fieldType: input.fieldType,
        options: input.options ?? null,
        required: input.required,
        showInList: input.showInList,
        sortOrder: input.sortOrder,
      });
      return { id: Number((r as any)[0]?.insertId ?? 0) };
    }),

  /** Update an existing field definition (admin only) */
  updateDef: adminWsProcedure
    .input(
      z.object({
        id: z.number(),
        patch: fieldDefInput.partial().omit({ entityType: true, fieldKey: true }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(customFieldDefs)
        .set({ ...input.patch, updatedAt: new Date() })
        .where(and(eq(customFieldDefs.id, input.id), eq(customFieldDefs.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /** Delete a field definition (admin only) */
  deleteDef: adminWsProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .delete(customFieldDefs)
        .where(and(eq(customFieldDefs.id, input.id), eq(customFieldDefs.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /** Get custom field values for a specific entity */
  getValues: workspaceProcedure
    .input(z.object({ entityType: z.enum(ENTITY_TYPES), entityId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return {};
      let row: any = null;
      if (input.entityType === "lead") {
        [row] = await db.select().from(leads).where(and(eq(leads.id, input.entityId), eq(leads.workspaceId, ctx.workspace.id)));
      } else if (input.entityType === "contact") {
        [row] = await db.select().from(contacts).where(and(eq(contacts.id, input.entityId), eq(contacts.workspaceId, ctx.workspace.id)));
      } else if (input.entityType === "account") {
        [row] = await db.select().from(accounts).where(and(eq(accounts.id, input.entityId), eq(accounts.workspaceId, ctx.workspace.id)));
      } else if (input.entityType === "opportunity") {
        [row] = await db.select().from(opportunities).where(and(eq(opportunities.id, input.entityId), eq(opportunities.workspaceId, ctx.workspace.id)));
      }
      return (row?.customFields as Record<string, any>) ?? {};
    }),

  /** Set custom field values for a specific entity */
  setValues: repProcedure
    .input(
      z.object({
        entityType: z.enum(ENTITY_TYPES),
        entityId: z.number(),
        values: z.record(z.string(), z.any()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Validate required fields
      const defs = await db
        .select()
        .from(customFieldDefs)
        .where(and(eq(customFieldDefs.workspaceId, ctx.workspace.id), eq(customFieldDefs.entityType, input.entityType)));

      for (const def of defs.filter((d) => d.required)) {
        const val = input.values[def.fieldKey];
        if (val === undefined || val === null || val === "") {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Required field '${def.label}' is missing` });
        }
      }

      // Merge with existing customFields
      let existing: Record<string, any> = {};
      let currentRow: any = null;
      if (input.entityType === "lead") {
        [currentRow] = await db.select().from(leads).where(and(eq(leads.id, input.entityId), eq(leads.workspaceId, ctx.workspace.id)));
      } else if (input.entityType === "contact") {
        [currentRow] = await db.select().from(contacts).where(and(eq(contacts.id, input.entityId), eq(contacts.workspaceId, ctx.workspace.id)));
      } else if (input.entityType === "account") {
        [currentRow] = await db.select().from(accounts).where(and(eq(accounts.id, input.entityId), eq(accounts.workspaceId, ctx.workspace.id)));
      } else if (input.entityType === "opportunity") {
        [currentRow] = await db.select().from(opportunities).where(and(eq(opportunities.id, input.entityId), eq(opportunities.workspaceId, ctx.workspace.id)));
      }
      if (!currentRow) throw new TRPCError({ code: "NOT_FOUND" });
      existing = (currentRow.customFields as Record<string, any>) ?? {};
      const merged = { ...existing, ...input.values };

      if (input.entityType === "lead") {
        await db.update(leads).set({ customFields: merged }).where(eq(leads.id, input.entityId));
      } else if (input.entityType === "contact") {
        await db.update(contacts).set({ customFields: merged }).where(eq(contacts.id, input.entityId));
      } else if (input.entityType === "account") {
        await db.update(accounts).set({ customFields: merged }).where(eq(accounts.id, input.entityId));
      } else if (input.entityType === "opportunity") {
        await db.update(opportunities).set({ customFields: merged }).where(eq(opportunities.id, input.entityId));
      }

      return { ok: true };
    }),
});
