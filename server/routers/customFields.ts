/**
 * Sprint 5 — Custom Fields Framework
 * Admin-configurable field definitions per entity type.
 * Values are stored in the existing JSON `customFields` column on each entity.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, contacts, customFieldDefs, leads, opportunities } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { adminWsProcedure, repProcedure, workspaceProcedure } from "../_core/workspace";
import { reservedCustomFieldKey } from "@shared/customFieldKeys";

const ENTITY_TYPES = ["lead", "contact", "account", "opportunity"] as const;

/**
 * The table each entity type stores its customFields blob on.
 *
 * One mapping, so deleteDef cannot clear values from a different table than the
 * one getValues/setValues read — the four-branch if/else chains below predate
 * this and are left alone rather than rewritten in a bug-fix commit.
 */
const ENTITY_TABLE = {
  lead: leads,
  contact: contacts,
  account: accounts,
  opportunity: opportunities,
} as const;

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
      // The customFields blob is shared with the engines — see
      // @shared/customFieldKeys. A field named `technologies` (snake_case-legal
      // and an ordinary thing to want) is read by the scoring engine, and one
      // named linkedinUrl decides who Social Autopilot sends invites to.
      const clash = reservedCustomFieldKey(input.fieldKey);
      if (clash) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `"${input.fieldKey}" is reserved by ${clash.owner} — it is stored under the same key. Pick another name.`,
        });
      }
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

  /**
   * Delete a field definition AND its stored values (admin only).
   *
   * 🔴 The confirm dialog has always said "Deleting a custom field definition
   * removes its stored values from every record of this type. This cannot be
   * undone." Both halves were false: this deleted the DEFINITION ROW ONLY, and
   * nothing anywhere stripped the key from any record's customFields JSON.
   *
   * So the values survived in full. An admin deleting a field because it held
   * something sensitive was told it was gone and it was not — and recreating a
   * field with the same fieldKey resurrected every old value, because they had
   * never been removed. That also made it trivially UNDOABLE, which is the
   * opposite of what the dialog promised.
   *
   * The values are stripped to match the copy, rather than the copy weakened to
   * match the code — the same call `05dffb2` made for emailTemplates.delete,
   * and for the same reason: the promise is what the admin is relying on.
   *
   * ORDER MATTERS: strip first, delete the definition second. There is no
   * `.transaction(` anywhere in this server, so on a mid-way failure this
   * leaves the definition in place with some values gone — visible and
   * retryable. The other order orphans values under a definition that no
   * longer exists, which nothing would ever clean up.
   */
  deleteDef: adminWsProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Read the def BEFORE deleting it — its entityType and fieldKey are the
      // only way to know which table and which JSON key to clear.
      const [def] = await db
        .select({ entityType: customFieldDefs.entityType, fieldKey: customFieldDefs.fieldKey })
        .from(customFieldDefs)
        .where(and(eq(customFieldDefs.id, input.id), eq(customFieldDefs.workspaceId, ctx.workspace.id)));
      if (!def) return { ok: true, valuesCleared: 0 };

      const table = ENTITY_TABLE[def.entityType as (typeof ENTITY_TYPES)[number]];
      let valuesCleared = 0;
      if (table) {
        /**
         * `fieldKey` is validated snake_case at creation (`^[a-z][a-z0-9_]*$`),
         * so it cannot carry a quote — but it is still bound as a PARAMETER
         * rather than interpolated. A field name reaching SQL as text is the
         * shape this repo has been burned by, and "it was validated on the way
         * in" is an argument about the past, not about this statement.
         */
        const path = `$."${def.fieldKey}"`;
        const res = await db
          .update(table)
          .set({ customFields: sql`JSON_REMOVE(${table.customFields}, ${path})` } as never)
          .where(
            and(
              eq(table.workspaceId, ctx.workspace.id),
              sql`JSON_CONTAINS_PATH(${table.customFields}, 'one', ${path})`,
            ),
          );
        valuesCleared = Number((res as unknown as { affectedRows?: number }[])[0]?.affectedRows ?? 0);
      }

      await db
        .delete(customFieldDefs)
        .where(and(eq(customFieldDefs.id, input.id), eq(customFieldDefs.workspaceId, ctx.workspace.id)));
      return { ok: true, valuesCleared };
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

      /**
       * Only DEFINED keys may be written.
       *
       * The input is `z.record(z.string(), z.any())` and the defs above were
       * used solely to check `required` — so this accepted any key at all, and
       * the blob it writes into is shared with the engines. Without this, a rep
       * could set `linkedinUrl` on a lead and enroll it into Social Autopilot's
       * invite targeting, fabricate `coOwners` on an opportunity, or write the
       * scoring engine's `technologies` / `intentTopics` and move a lead score.
       *
       * The UI cannot trip this: CustomFieldsPanel builds its payload from the
       * definitions it just rendered. Only a hand-made call reaches it.
       */
      const defined = new Set(defs.map((d) => d.fieldKey));
      for (const key of Object.keys(input.values)) {
        if (defined.has(key)) continue;
        const clash = reservedCustomFieldKey(key);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: clash
            ? `"${key}" is reserved by ${clash.owner} and cannot be set as a custom field.`
            : `"${key}" is not a custom field on ${input.entityType}. Define it in Settings first.`,
        });
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
        await db.update(leads).set({ customFields: merged }).where(and(eq(leads.id, input.entityId), eq(leads.workspaceId, ctx.workspace.id)));
      } else if (input.entityType === "contact") {
        await db.update(contacts).set({ customFields: merged }).where(and(eq(contacts.id, input.entityId), eq(contacts.workspaceId, ctx.workspace.id)));
      } else if (input.entityType === "account") {
        await db.update(accounts).set({ customFields: merged }).where(and(eq(accounts.id, input.entityId), eq(accounts.workspaceId, ctx.workspace.id)));
      } else if (input.entityType === "opportunity") {
        await db.update(opportunities).set({ customFields: merged }).where(and(eq(opportunities.id, input.entityId), eq(opportunities.workspaceId, ctx.workspace.id)));
      }

      return { ok: true };
    }),
});
