/**
 * recordLists — Apollo-style static saved-record lists.
 *
 * Unlike segments (dynamic, rule-based over contacts), a record list holds an
 * explicit set of members you add/remove by hand. People lists hold prospects,
 * Companies lists hold accounts. Powers /v2/lists and /v2/lists/:id.
 */
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { z } from "zod";
import { getDb } from "../db";
import { recordLists, recordListMembers, prospects, accounts } from "../../drizzle/schema";
import { eq, and, inArray, desc, sql } from "drizzle-orm";

export const recordListsRouter = router({
  /** All lists in the workspace, each with a live member count. */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const lists = await db
      .select()
      .from(recordLists)
      .where(eq(recordLists.workspaceId, ctx.workspace.id))
      .orderBy(desc(recordLists.updatedAt));
    const counts = await db
      .select({ listId: recordListMembers.listId, c: sql<number>`count(*)` })
      .from(recordListMembers)
      .where(eq(recordListMembers.workspaceId, ctx.workspace.id))
      .groupBy(recordListMembers.listId);
    const cmap = new Map(counts.map((r) => [r.listId, Number(r.c)]));
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
      name: z.string().min(1).max(200),
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

  delete: workspaceProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    await db.delete(recordListMembers).where(and(eq(recordListMembers.listId, input.id), eq(recordListMembers.workspaceId, ctx.workspace.id)));
    await db.delete(recordLists).where(and(eq(recordLists.id, input.id), eq(recordLists.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** Member records for a list, joined to the underlying prospect/account row. */
  members: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const mem = await db
      .select()
      .from(recordListMembers)
      .where(and(eq(recordListMembers.listId, input.id), eq(recordListMembers.workspaceId, ctx.workspace.id)))
      .orderBy(desc(recordListMembers.addedAt));
    if (mem.length === 0) return [];
    const prospectIds = mem.filter((m) => m.recordType === "prospect").map((m) => m.recordId);
    const accountIds = mem.filter((m) => m.recordType === "account").map((m) => m.recordId);
    const pRows = prospectIds.length
      ? await db.select().from(prospects).where(and(eq(prospects.workspaceId, ctx.workspace.id), inArray(prospects.id, prospectIds)))
      : [];
    const aRows = accountIds.length
      ? await db.select().from(accounts).where(and(eq(accounts.workspaceId, ctx.workspace.id), inArray(accounts.id, accountIds)))
      : [];
    const pMap = new Map(pRows.map((r) => [r.id, r]));
    const aMap = new Map(aRows.map((r) => [r.id, r]));
    return mem
      .map((m) => ({
        memberId: m.id,
        recordType: m.recordType,
        recordId: m.recordId,
        addedAt: m.addedAt,
        record: m.recordType === "prospect" ? pMap.get(m.recordId) ?? null : m.recordType === "account" ? aMap.get(m.recordId) ?? null : null,
      }))
      .filter((m) => m.record); // drop members whose underlying record was deleted
  }),

  /** Add records to a list (de-duplicated against existing membership). */
  addMembers: workspaceProcedure
    .input(z.object({
      listId: z.number(),
      recordType: z.enum(["prospect", "contact", "account"]),
      recordIds: z.array(z.number()).min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const existing = await db
        .select({ rid: recordListMembers.recordId })
        .from(recordListMembers)
        .where(and(
          eq(recordListMembers.listId, input.listId),
          eq(recordListMembers.workspaceId, ctx.workspace.id),
          eq(recordListMembers.recordType, input.recordType),
        ));
      const have = new Set(existing.map((e) => e.rid));
      const toAdd = input.recordIds.filter((id) => !have.has(id));
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
      return { added: toAdd.length };
    }),

  removeMember: workspaceProcedure.input(z.object({ memberId: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    await db.delete(recordListMembers).where(and(eq(recordListMembers.id, input.memberId), eq(recordListMembers.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});
