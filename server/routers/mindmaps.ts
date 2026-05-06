import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { getDb } from "../db";
import { mindmaps, mindmapNodes, mindmapEdges, tasks, activities, notifications } from "../../drizzle/schema";
import { router } from "../_core/trpc";
import { repProcedure } from "../_core/workspace";
import { recordAudit } from "../audit";

// ---------------------------------------------------------------------------
// Mindmap list & CRUD
// ---------------------------------------------------------------------------

const mindmapsRouter = router({
  list: repProcedure.query(async ({ ctx }) => {
    const db = await getDb();
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
      await db
        .update(mindmaps)
        .set({ name: input.name })
        .where(and(eq(mindmaps.id, input.id), eq(mindmaps.workspaceId, ctx.workspace.id)));
    }),

  delete: repProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
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

      return { map, nodes, edges };
    }),

  saveCanvas: repProcedure
    .input(
      z.object({
        id: z.number(),
        nodes: z.array(
          z.object({
            id: z.string(),
            type: z.enum(["root", "topic", "subtopic", "task", "note", "idea"]),
            label: z.string(),
            notes: z.string().optional(),
            posX: z.number(),
            posY: z.number(),
            color: z.string().optional(),
            parentId: z.string().optional(),
            linkedEntityType: z.string().optional(),
            linkedEntityId: z.number().optional(),
          })
        ),
        edges: z.array(
          z.object({
            id: z.string(),
            source: z.string(),
            target: z.string(),
            label: z.string().optional(),
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      const wsId = ctx.workspace.id;

      // Verify ownership
      const [map] = await db
        .select()
        .from(mindmaps)
        .where(and(eq(mindmaps.id, input.id), eq(mindmaps.workspaceId, wsId)));
      if (!map) throw new Error("Mindmap not found");

      // Atomic replace: delete all existing nodes/edges then re-insert
      await db
        .delete(mindmapEdges)
        .where(and(eq(mindmapEdges.mindmapId, input.id), eq(mindmapEdges.workspaceId, wsId)));
      await db
        .delete(mindmapNodes)
        .where(and(eq(mindmapNodes.mindmapId, input.id), eq(mindmapNodes.workspaceId, wsId)));

      if (input.nodes.length > 0) {
        await db.insert(mindmapNodes).values(
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
            linkedEntityType: n.linkedEntityType ?? null,
            linkedEntityId: n.linkedEntityId ?? null,
          }))
        );
      }

      if (input.edges.length > 0) {
        await db.insert(mindmapEdges).values(
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

      // Bump updatedAt on the mindmap
      await db
        .update(mindmaps)
        .set({ updatedAt: new Date() })
        .where(eq(mindmaps.id, input.id));
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
      const wsId = ctx.workspace.id;

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
      const wsId = ctx.workspace.id;

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
