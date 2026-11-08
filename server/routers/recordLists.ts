/**
 * recordLists — Apollo-style static saved-record lists.
 *
 * Unlike segments (dynamic, rule-based over contacts), a record list holds an
 * explicit set of members you add/remove by hand. People lists hold prospects,
 * Companies lists hold accounts. Powers /v2/lists and /v2/lists/:id.
 */
import { TRPCError } from "@trpc/server";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { z } from "zod";
import { listMemberCounts, listMemberPage } from "../services/listMembers";
import { getDb } from "../db";
import { recordLists, recordListMembers, prospects, accounts } from "../../drizzle/schema";
import { eq, and, inArray, desc, isNull } from "drizzle-orm";

export const recordListsRouter = router({
  /** All lists in the workspace, each with a live member count: the members its page shows (P46). */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const lists = await db
      .select()
      .from(recordLists)
      .where(eq(recordLists.workspaceId, ctx.workspace.id))
      .orderBy(desc(recordLists.updatedAt));
    const cmap = await listMemberCounts(db, ctx.workspace.id);
    return lists.map((l) => ({ ...l, memberCount: cmap.get(l.id) ?? 0 }));
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return null;
    const [l] = await db
      .select()
      .from(recordLists)
      .where(and(eq(recordLists.id, input.id), eq(recordLists.workspaceId, ctx.workspace.id)));
    return l ?? null;
  }),

  create: workspaceProcedure
    .input(z.object({
      name: z.string().trim().min(1, "Give the list a name").max(200),
      entityType: z.enum(["people", "companies"]).default("people"),
      description: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [res] = await db.insert(recordLists).values({
        workspaceId: ctx.workspace.id,
        name: input.name,
        entityType: input.entityType,
        description: input.description ?? null,
        createdByUserId: ctx.user.id,
      });
      return { id: Number((res as any).insertId) };
    }),

  /** Rename a list, or change its description (owner ask 2026-10-06: there was no way to rename one). */
  update: workspaceProcedure
    .input(z.object({
      id: z.number(),
      name: z.string().trim().min(1, "Give the list a name").max(200).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const patch: { name?: string; description?: string | null; updatedAt: Date } = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description || null;
      const [res] = await db.update(recordLists).set(patch)
        .where(and(eq(recordLists.id, input.id), eq(recordLists.workspaceId, ctx.workspace.id)));
      if (Number((res as { affectedRows?: number })?.affectedRows ?? 1) === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "That list is not in this workspace." });
      }
      return { ok: true };
    }),

  delete: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    await db.delete(recordListMembers).where(and(eq(recordListMembers.listId, input.id), eq(recordListMembers.workspaceId, ctx.workspace.id)));
    await db.delete(recordLists).where(and(eq(recordLists.id, input.id), eq(recordLists.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /**
   * One page of a list's members with the columns the list shows, searched
   * and sorted in SQL, and the ids of its people for "Add all to…" (P49).
   */
  members: workspaceProcedure
    .input(z.object({
      id: z.number(),
      page: z.number().int().min(1).default(1),
      perPage: z.number().int().min(10).max(500).default(100),
      search: z.string().max(200).optional(),
      sort: z.enum(["added", "name"]).default("added"),
    }))
    .query(({ ctx, input }) => listMemberPage(ctx.workspace.id, input)),

  /**
   * Add records to a list (de-duplicated against existing membership).
   *
   * Only what the list can show is added (audit 2026-10-20, P46, P50): a
   * People list takes this workspace's people, a Companies list its
   * companies that aren't archived. Anything else used to be stored and
   * counted on the index while the page hid it. The rest are reported back
   * as `skipped`, and the ones already on the list as `alreadyOn`.
   */
  addMembers: workspaceProcedure
    .input(z.object({
      listId: z.number(),
      recordType: z.enum(["prospect", "contact", "account"]),
      recordIds: z.array(z.number()).min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db0 = await getDb();
      if (!db0) throw new Error("Database unavailable");
      /**
       * One add at a time per list (audit 2026-10-20, P47): two clicks both
       * read the members before either wrote, and both inserted. The list row
       * is locked first, so the second add waits for the first and then reads
       * its rows. No unique key, because live data may already hold duplicates.
       */
      return db0.transaction(async (db) => {
        const [list] = await db.select({ entityType: recordLists.entityType }).from(recordLists)
          .where(and(eq(recordLists.id, input.listId), eq(recordLists.workspaceId, ctx.workspace.id)))
          .for("update");
        if (!list) throw new TRPCError({ code: "NOT_FOUND", message: "That list is not in this workspace." });
        const wants = list.entityType === "companies" ? "account" : "prospect";
        if (input.recordType !== wants) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `A ${list.entityType === "companies" ? "Companies" : "People"} list holds ${list.entityType === "companies" ? "companies" : "people"} only.` });
        }
        const ids = Array.from(new Set(input.recordIds));
        const live = wants === "account"
          ? await db.select({ id: accounts.id }).from(accounts)
              .where(and(eq(accounts.workspaceId, ctx.workspace.id), inArray(accounts.id, ids), isNull(accounts.archivedAt)))
          : await db.select({ id: prospects.id }).from(prospects)
              .where(and(eq(prospects.workspaceId, ctx.workspace.id), inArray(prospects.id, ids)));
        const liveIds = new Set(live.map((r) => r.id));
        const existing = await db
          .select({ rid: recordListMembers.recordId })
          .from(recordListMembers)
          .where(and(
            eq(recordListMembers.listId, input.listId),
            eq(recordListMembers.workspaceId, ctx.workspace.id),
            eq(recordListMembers.recordType, input.recordType),
          ));
        const have = new Set(existing.map((e) => e.rid));
        const toAdd = ids.filter((id) => liveIds.has(id) && !have.has(id));
        const alreadyOn = ids.filter((id) => liveIds.has(id) && have.has(id)).length;
        if (toAdd.length) {
          await db.insert(recordListMembers).values(
            toAdd.map((id) => ({
              workspaceId: ctx.workspace.id,
              listId: input.listId,
              recordType: input.recordType,
              recordId: id,
              addedByUserId: ctx.user.id,
            })),
          );
          // bump the list's updatedAt
          await db.update(recordLists).set({ updatedAt: new Date() }).where(and(eq(recordLists.id, input.listId), eq(recordLists.workspaceId, ctx.workspace.id)));
        }
        return { added: toAdd.length, alreadyOn, skipped: ids.length - liveIds.size };
      });
    }),

  /**
   * Resolve this People list's old contact members to People (audit A55):
   * each becomes the person it maps to; one that can't be resolved stays on
   * the list and is reported with why. Also runs once after every boot.
   */
  resolveContactMembers: workspaceProcedure
    .input(z.object({ listId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [list] = await db.select({ entityType: recordLists.entityType }).from(recordLists)
        .where(and(eq(recordLists.id, input.listId), eq(recordLists.workspaceId, ctx.workspace.id))).limit(1);
      if (!list) throw new TRPCError({ code: "NOT_FOUND", message: "That list is not in this workspace." });
      if (list.entityType === "companies") return { converted: 0, duplicates: 0, unresolved: [] as Array<{ contactId: number; reason: string }> };
      const { resolveContactListMembers, UNRESOLVED_REASON_LABEL } = await import("../services/listContactMembers");
      const r = await resolveContactListMembers({ workspaceId: ctx.workspace.id, listId: input.listId });
      return {
        converted: r.converted,
        duplicates: r.duplicates,
        unresolved: r.unresolved.map((u) => ({ contactId: u.contactId, reason: UNRESOLVED_REASON_LABEL[u.reason] })),
      };
    }),

  /** Returns what it removed, so the page can offer Undo (audit 2026-10-20, P139). */
  removeMember: workspaceProcedure.input(z.object({ memberId: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const [removed] = await db
      .select({ listId: recordListMembers.listId, recordType: recordListMembers.recordType, recordId: recordListMembers.recordId })
      .from(recordListMembers)
      .where(and(eq(recordListMembers.id, input.memberId), eq(recordListMembers.workspaceId, ctx.workspace.id)));
    await db.delete(recordListMembers).where(and(eq(recordListMembers.id, input.memberId), eq(recordListMembers.workspaceId, ctx.workspace.id)));
    return { ok: true, removed: removed ?? null };
  }),
});
