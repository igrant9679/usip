import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, and, inArray } from "drizzle-orm";
import { assertOwnerInWorkspace, requireInWorkspace } from "../services/foreignIds";
import { getDb } from "../db";
import { mindmaps, mindmapNodes, mindmapEdges, tasks, activities, notifications } from "../../drizzle/schema";
import { router } from "../_core/trpc";
import { repProcedure } from "../_core/workspace";
import { recordAudit } from "../audit";

/**
 * The version a save is based on: the map's updatedAt, in whole seconds, which
 * is all a MySQL timestamp keeps. saveCanvas writes a whole second so the value
 * it returns is the value a later read gives back.
 */
const canvasVersion = (d: Date | string | null | undefined) => (d ? Math.floor(new Date(d).getTime() / 1000) : 0);

// ---------------------------------------------------------------------------
// Mindmap list & CRUD
// ---------------------------------------------------------------------------

const mindmapsRouter = router({
  list: repProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    return db
      .select()
      .from(mindmaps)
      .where(eq(mindmaps.workspaceId, ctx.workspace.id))
      .orderBy(mindmaps.updatedAt);
  }),

  create: repProcedure
    .input(z.object({ name: z.string().min(1).max(240), description: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [result] = await db.insert(mindmaps).values({
        workspaceId: ctx.workspace.id,
        name: input.name,
        description: input.description ?? null,
        createdByUserId: ctx.user.id,
      });
      const id = Number((result as any).insertId ?? 0);
      await recordAudit({
        workspaceId: ctx.workspace.id,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "mindmap",
        entityId: id,
        after: input,
      });
      return { id };
    }),

  rename: repProcedure
    .input(z.object({ id: z.number(), name: z.string().min(1).max(240) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db
        .update(mindmaps)
        .set({ name: input.name })
        .where(and(eq(mindmaps.id, input.id), eq(mindmaps.workspaceId, ctx.workspace.id)));
    }),

  delete: repProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      await db
        .delete(mindmapEdges)
        .where(and(eq(mindmapEdges.mindmapId, input.id), eq(mindmapEdges.workspaceId, ctx.workspace.id)));
      await db
        .delete(mindmapNodes)
        .where(and(eq(mindmapNodes.mindmapId, input.id), eq(mindmapNodes.workspaceId, ctx.workspace.id)));
      await db
        .delete(mindmaps)
        .where(and(eq(mindmaps.id, input.id), eq(mindmaps.workspaceId, ctx.workspace.id)));
    }),

  // ---------------------------------------------------------------------------
  // Canvas: load & save
  // ---------------------------------------------------------------------------

  getCanvas: repProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const [map] = await db
        .select()
        .from(mindmaps)
        .where(and(eq(mindmaps.id, input.id), eq(mindmaps.workspaceId, ctx.workspace.id)));
      if (!map) throw new Error("Mindmap not found");

      const nodes = await db
        .select()
        .from(mindmapNodes)
        .where(and(eq(mindmapNodes.mindmapId, input.id), eq(mindmapNodes.workspaceId, ctx.workspace.id)));

      const edges = await db
        .select()
        .from(mindmapEdges)
        .where(and(eq(mindmapEdges.mindmapId, input.id), eq(mindmapEdges.workspaceId, ctx.workspace.id)));

      return { map, nodes, edges, version: canvasVersion(map.updatedAt) };
    }),

  // The limits are the columns' (drizzle/schema.ts): an over-long label used to
  // pass here and fail the insert AFTER the delete, leaving the map empty (G22).
  saveCanvas: repProcedure
    .input(
      z.object({
        id: z.number(),
        /**
         * The version (getCanvas.version, or the last save's) this canvas was
         * built from. When the map has been saved since, the save is refused
         * rather than overwriting the newer copy with an older one (G22). Left
         * out, the save overwrites (the "keep mine" choice).
         */
        baseVersion: z.number().int().optional(),
        nodes: z.array(
          z.object({
            id: z.string().min(1).max(64),
            type: z.enum(["root", "topic", "subtopic", "task", "note", "idea"]),
            label: z.string().max(240),
            notes: z.string().max(20_000).optional(),
            posX: z.number(),
            posY: z.number(),
            color: z.string().max(30).optional(),
            parentId: z.string().max(64).optional(),
            linkedEntityType: z.string().max(30).optional(),
            linkedEntityId: z.number().optional(),
          })
        ).max(2_000),
        edges: z.array(
          z.object({
            id: z.string().min(1).max(64),
            source: z.string().min(1).max(64),
            target: z.string().min(1).max(64),
            label: z.string().max(120).optional(),
          })
        ).max(4_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const wsId = ctx.workspace.id;

      // Verify ownership
      const [map] = await db
        .select()
        .from(mindmaps)
        .where(and(eq(mindmaps.id, input.id), eq(mindmaps.workspaceId, wsId)));
      if (!map) throw new Error("Mindmap not found");
      if (input.baseVersion !== undefined && canvasVersion(map.updatedAt) !== input.baseVersion) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This map was saved somewhere else after you opened it.",
        });
      }

      /**
       * A node links only to this workspace's task or note (audit 2026-10-20,
       * X1.1): any (type, id) was stored. A link that is not one is dropped,
       * not refused, so a map whose task was since deleted still saves.
       */
      const idsOf = (type: string) => input.nodes.filter((n) => n.linkedEntityType === type && n.linkedEntityId != null).map((n) => n.linkedEntityId as number);
      const taskIds = idsOf("task");
      const noteIds = idsOf("note");
      const liveTasks = new Set(taskIds.length ? (await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.workspaceId, wsId), inArray(tasks.id, taskIds)))).map((r) => r.id) : []);
      const liveNotes = new Set(noteIds.length ? (await db.select({ id: activities.id }).from(activities).where(and(eq(activities.workspaceId, wsId), inArray(activities.id, noteIds)))).map((r) => r.id) : []);
      const linkKept = (n: { linkedEntityType?: string; linkedEntityId?: number }) =>
        n.linkedEntityId != null && ((n.linkedEntityType === "task" && liveTasks.has(n.linkedEntityId)) || (n.linkedEntityType === "note" && liveNotes.has(n.linkedEntityId)));

      // Replace every node and edge in one transaction: the old code deleted
      // first and inserted after with none, so a failed insert left the map
      // empty (G22). A failure now leaves the map as it was.
      const savedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      await db.transaction(async (tx) => {
        await tx
          .delete(mindmapEdges)
          .where(and(eq(mindmapEdges.mindmapId, input.id), eq(mindmapEdges.workspaceId, wsId)));
        await tx
          .delete(mindmapNodes)
          .where(and(eq(mindmapNodes.mindmapId, input.id), eq(mindmapNodes.workspaceId, wsId)));

        if (input.nodes.length > 0) {
          await tx.insert(mindmapNodes).values(
            input.nodes.map((n) => ({
              id: n.id,
              mindmapId: input.id,
              workspaceId: wsId,
              type: n.type,
              label: n.label,
              notes: n.notes ?? null,
              posX: Math.round(n.posX),
              posY: Math.round(n.posY),
              color: n.color ?? null,
              parentId: n.parentId ?? null,
              linkedEntityType: linkKept(n) ? n.linkedEntityType! : null,
              linkedEntityId: linkKept(n) ? n.linkedEntityId! : null,
            }))
          );
        }

        if (input.edges.length > 0) {
          await tx.insert(mindmapEdges).values(
            input.edges.map((e) => ({
              id: e.id,
              mindmapId: input.id,
              workspaceId: wsId,
              source: e.source,
              target: e.target,
              label: e.label ?? null,
            }))
          );
        }

        // Bump updatedAt on the mindmap: it is the canvas's version.
        await tx
          .update(mindmaps)
          .set({ updatedAt: savedAt })
          .where(and(eq(mindmaps.id, input.id), eq(mindmaps.workspaceId, wsId)));
      });
      return { version: canvasVersion(savedAt) };
    }),

  // ---------------------------------------------------------------------------
  // CRM Action Triggers: create Task or Note from a node
  // ---------------------------------------------------------------------------

  createLinkedTask: repProcedure
    .input(
      z.object({
        mindmapId: z.number(),
        nodeId: z.string(),
        title: z.string().min(1),
        description: z.string().optional(),
        dueAt: z.string().optional(),
        priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
        ownerUserId: z.number().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const wsId = ctx.workspace.id;
      // This workspace's map, and an owner who works here (X1.1).
      await requireInWorkspace(db, mindmaps, input.mindmapId, wsId, "Mindmap");
      await assertOwnerInWorkspace(wsId, input.ownerUserId);

      // Create the task
      const [result] = await db.insert(tasks).values({
        workspaceId: wsId,
        title: input.title,
        description: input.description ?? null,
        type: "todo",
        priority: input.priority,
        status: "open",
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        ownerUserId: input.ownerUserId ?? ctx.user.id,
        relatedType: "mindmap",
        relatedId: input.mindmapId,
      });
      const taskId = Number((result as any).insertId ?? 0);

      // Update the node to link it
      await db
        .update(mindmapNodes)
        .set({ linkedEntityType: "task", linkedEntityId: taskId })
        .where(and(eq(mindmapNodes.id, input.nodeId), eq(mindmapNodes.workspaceId, wsId)));

      // Notify assignee if different from actor
      if (input.ownerUserId && input.ownerUserId !== ctx.user.id) {
        await db.insert(notifications).values({
          workspaceId: wsId,
          userId: input.ownerUserId,
          kind: "task_assigned",
          title: `Task assigned from Mindmap: ${input.title}`,
          relatedType: "task",
          relatedId: taskId,
        });
      }

      await recordAudit({
        workspaceId: wsId,
        actorUserId: ctx.user.id,
        action: "create",
        entityType: "task",
        entityId: taskId,
        after: { ...input, source: "mindmap" },
      });

      return { taskId };
    }),

  createLinkedNote: repProcedure
    .input(
      z.object({
        mindmapId: z.number(),
        nodeId: z.string(),
        body: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database unavailable");
      const wsId = ctx.workspace.id;
      await requireInWorkspace(db, mindmaps, input.mindmapId, wsId, "Mindmap");

      // Store as an activity note linked to the mindmap
      const [result] = await db.insert(activities).values({
        workspaceId: wsId,
        type: "note",
        relatedType: "mindmap",
        relatedId: input.mindmapId,
        subject: "Note from Mindmap",
        body: input.body,
        actorUserId: ctx.user.id,
        occurredAt: new Date(),
      });
      const activityId = Number((result as any).insertId ?? 0);

      // Update the node to link it
      await db
        .update(mindmapNodes)
        .set({ linkedEntityType: "note", linkedEntityId: activityId })
        .where(and(eq(mindmapNodes.id, input.nodeId), eq(mindmapNodes.workspaceId, wsId)));

      return { activityId };
    }),
});

export { mindmapsRouter };
