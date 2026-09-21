/**
 * savedSearches — the People picker's saved searches (migration 0185).
 *
 * A saved search is a QUERY: the columns, filters and sort the page was
 * showing. That is the whole difference from recordLists, which is a
 * hand-picked SET of records — one word apart and routinely confused.
 *
 * PRIVATE, PER USER. `ownerUserId` is the boundary, so every statement below
 * carries BOTH eq(workspaceId) and eq(ownerUserId). Sharing is deliberately
 * not built: it needs an owner name on the row, an edit-permission rule and a
 * departed-member story, and without it the create sheet's "Visibility and
 * sharing: Restricted" row is finally honest.
 *
 * workspaceProcedure is the right gate: _core/workspace.ts already refuses an
 * archived workspace, and keeping your own search is not a write to shared
 * data, so every role including rep needs it. No cron reads this table and no
 * path resolves a user id outside a request context, so the workspaceArchive /
 * activeMembers gating the engines use does not apply here (stated
 * deliberately, not omitted).
 */
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { z } from "zod";
import { getDb } from "../db";
import { savedSearches } from "../../drizzle/schema";
import { and, desc, eq } from "drizzle-orm";

/** Mirrors COLUMN_KEYS in client/src/components/usip/people/savedSearchConfig.ts
 *  (which derives ColumnKey from it) and therefore COLUMN_REGISTRY. A key this
 *  enum does not know cannot be saved; one that slips in anyway is dropped on
 *  the way out by normalizeViewConfig, because an unknown key makes
 *  COLUMN_REGISTRY[key].label throw and blanks the People table. */
const COLUMN_KEYS = [
  "name", "title", "velocityScore", "company", "emails", "phone",
  "actions", "links", "location", "employees", "industries", "keywords",
] as const;

const SORT_FIELDS = [
  "relevance", "name", "title", "emails", "company", "phone", "employees", "industries",
] as const;

/**
 * The PAGE's filter vocabulary, not prospects.list's input.
 *
 * People.tsx translates on the way to the query — `missingEmail` becomes
 * hasEmail:false, the promoted tri-state becomes a boolean — so `missingEmail`
 * and the tri-states have no counterpart on the server side and a subset rule
 * would be the wrong invariant. The real one, pinned in savedSearches.test.ts:
 * every filter the page can show as a removable pill is a filter a search can
 * store. The caps mirror routers/prospects.ts so a saved value can never be
 * one the list query then refuses.
 */
const viewFiltersSchema = z
  .object({
    emailStatus: z.string().max(40).optional(),
    hasEmail: z.boolean().optional(),
    missingEmail: z.boolean().optional(),
    verification: z.string().max(40).optional(),
    promoted: z.enum(["all", "promoted", "not"]).optional(),
    enrolled: z.enum(["all", "yes", "no"]).optional(),
    search: z.string().max(200).optional(),
    titleQ: z.string().max(200).optional(),
    companyQ: z.string().max(200).optional(),
    locationQ: z.string().max(200).optional(),
    industryQ: z.string().max(200).optional(),
    educationQ: z.string().max(200).optional(),
    linkedinQ: z.string().max(500).optional(),
    hasPhone: z.boolean().optional(),
    hasLinkedin: z.boolean().optional(),
    tiers: z.array(z.enum(["high", "medium", "low"])).max(3).optional(),
    seniorities: z.array(z.string().max(40)).max(12).optional(),
  })
  .strict();

const viewConfigSchema = z
  .object({
    columns: z.array(z.enum(COLUMN_KEYS)).min(1).max(20),
    filters: viewFiltersSchema,
    sort: z.object({ field: z.enum(SORT_FIELDS), dir: z.enum(["asc", "desc"]) }),
  })
  .strict();

/** Only "people" is written today; the column exists so Companies/Deals can
 *  grow a picker without a second migration. */
const surface = z.enum(["people", "companies", "deals"]).default("people");

export const savedSearchesRouter = router({
  list: workspaceProcedure
    .input(z.object({ surface }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(savedSearches)
        .where(
          and(
            eq(savedSearches.workspaceId, ctx.workspace.id),
            eq(savedSearches.ownerUserId, ctx.user.id),
            eq(savedSearches.surface, input.surface),
          ),
        )
        .orderBy(desc(savedSearches.updatedAt));
    }),

  /** Create when `id` is absent, overwrite when it is there. The update path
   *  is what makes a saved search editable at all — without it the only way to
   *  change one is delete-and-recreate, and every column tweak made while it
   *  is active is lost on the next navigation. */
  save: workspaceProcedure
    .input(
      z.object({
        id: z.number().int().optional(),
        surface,
        name: z.string().trim().min(1).max(160),
        config: viewConfigSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      if (input.id) {
        await db
          .update(savedSearches)
          .set({ name: input.name, config: input.config })
          .where(
            and(
              eq(savedSearches.id, input.id),
              eq(savedSearches.workspaceId, ctx.workspace.id),
              eq(savedSearches.ownerUserId, ctx.user.id),
            ),
          );
        return { id: input.id };
      }
      // DESTRUCTURED: for drizzle/mysql2 `await db.insert(...)` resolves to the
      // [ResultSetHeader, FieldPacket[]] tuple, so reading .insertId off it
      // yields undefined → 0, and the picker then snaps back to "Default view"
      // the moment a search is created.
      const [res] = await db.insert(savedSearches).values({
        workspaceId: ctx.workspace.id,
        ownerUserId: ctx.user.id,
        surface: input.surface,
        name: input.name,
        config: input.config,
      });
      return { id: Number((res as any).insertId) };
    }),

  remove: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      // The and(...) is written out at every statement rather than hoisted into
      // a shared const: server/tenantScope.test.ts reads the ARGUMENT TEXT of
      // .where(), so `.where(scoped)` is a clause it cannot check.
      await db
        .delete(savedSearches)
        .where(
          and(
            eq(savedSearches.id, input.id),
            eq(savedSearches.workspaceId, ctx.workspace.id),
            eq(savedSearches.ownerUserId, ctx.user.id),
          ),
        );
      return { ok: true };
    }),

  /** "Come back where I left off." A stamp rather than an isDefault flag: one
   *  UPDATE, no clearing pass, and two rows can never both claim the default.
   *  The client picks max(lastAppliedAt) at read time. */
  markApplied: workspaceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db
        .update(savedSearches)
        .set({ lastAppliedAt: new Date() })
        .where(
          and(
            eq(savedSearches.id, input.id),
            eq(savedSearches.workspaceId, ctx.workspace.id),
            eq(savedSearches.ownerUserId, ctx.user.id),
          ),
        );
      return { ok: true };
    }),
});
