import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { activities, attachments, notifications, tasks } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import { storagePut } from "../storage";
import { router } from "../_core/trpc";
import { repProcedure, workspaceProcedure } from "../_core/workspace";

/* ─── Tasks ──────────────────────────────────────────────────────────── */

export const tasksRouter = router({
  list: workspaceProcedure
    .input(z.object({
      ownerOnly: z.boolean().optional(),
      status: z.enum(["open", "done", "cancelled"]).optional(),
      relatedType: z.string().optional(),
      relatedId: z.number().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      let rows = await db.select().from(tasks).where(eq(tasks.workspaceId, ctx.workspace.id)).orderBy(tasks.dueAt);
      if (input?.ownerOnly) rows = rows.filter((t) => t.ownerUserId === ctx.user.id);
      if (input?.status) rows = rows.filter((t) => t.status === input.status);
      if (input?.relatedType && input?.relatedId) rows = rows.filter((t) => t.relatedType === input.relatedType && t.relatedId === input.relatedId);
      return rows;
    }),

  create: repProcedure
    .input(z.object({
      title: z.string().min(1),
      description: z.string().optional(),
      type: z.enum(["call", "email", "meeting", "linkedin", "todo", "follow_up"]).default("todo"),
      priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      dueAt: z.string().optional(),
      relatedType: z.string().optional(),
      relatedId: z.number().optional(),
      ownerUserId: z.number().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const r = await db.insert(tasks).values({
        ...input,
        workspaceId: ctx.workspace.id,
        ownerUserId: input.ownerUserId ?? ctx.user.id,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        status: "open",
      });
      const id = Number((r as any)[0]?.insertId ?? 0);
      if (input.ownerUserId && input.ownerUserId !== ctx.user.id) {
        await db.insert(notifications).values({
          workspaceId: ctx.workspace.id,
          userId: input.ownerUserId,
          kind: "task_assigned",
          title: `Task assigned: ${input.title}`,
          relatedType: "task",
          relatedId: id,
        });
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "task", entityId: id, after: input });
      return { id };
    }),

  setStatus: repProcedure.input(z.object({ id: z.number(), status: z.enum(["open", "done", "cancelled"]) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(tasks).set({ status: input.status, completedAt: input.status === "done" ? new Date() : null }).where(and(eq(tasks.id, input.id), eq(tasks.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  update: repProcedure.input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const patch: any = { ...input.patch };
    if (patch.dueAt && typeof patch.dueAt === "string") patch.dueAt = new Date(patch.dueAt);
    await db.update(tasks).set(patch).where(and(eq(tasks.id, input.id), eq(tasks.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(tasks).where(and(eq(tasks.id, input.id), eq(tasks.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});

/* ─── Activities (timeline) ──────────────────────────────────────────── */

const MENTION_RE = /@\[([^\]]+)\]\(user:(\d+)\)/g;

export const activitiesRouter = router({
  list: workspaceProcedure
    .input(z.object({ relatedType: z.string(), relatedId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(activities)
        .where(and(eq(activities.workspaceId, ctx.workspace.id), eq(activities.relatedType, input.relatedType), eq(activities.relatedId, input.relatedId)))
        .orderBy(desc(activities.occurredAt))
        .limit(80);
    }),

  logCall: repProcedure
    .input(z.object({
      relatedType: z.string(),
      relatedId: z.number(),
      disposition: z.enum(["connected", "voicemail", "no_answer", "bad_number", "gatekeeper", "callback_requested", "not_interested"]),
      durationSec: z.number().int().min(0).default(0),
      outcome: z.string().optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.insert(activities).values({
        workspaceId: ctx.workspace.id,
        type: "call",
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        subject: `Call — ${input.disposition.replace(/_/g, " ")}`,
        body: input.notes,
        callDisposition: input.disposition,
        callDurationSec: input.durationSec,
        callOutcome: input.outcome,
        actorUserId: ctx.user.id,
      });
      return { ok: true };
    }),

  logMeeting: repProcedure
    .input(z.object({
      relatedType: z.string(),
      relatedId: z.number(),
      subject: z.string().min(1),
      startedAt: z.string().optional(),
      endedAt: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.insert(activities).values({
        workspaceId: ctx.workspace.id,
        type: "meeting",
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        subject: input.subject,
        body: input.notes,
        meetingStartedAt: input.startedAt ? new Date(input.startedAt) : new Date(),
        meetingEndedAt: input.endedAt ? new Date(input.endedAt) : null,
        meetingAttendees: input.attendees ?? [],
        actorUserId: ctx.user.id,
      });
      return { ok: true };
    }),

  /** Add a free-text note. Parses @[Name](user:ID) mentions and sends notifications. */
  addNote: repProcedure
    .input(z.object({
      relatedType: z.string(),
      relatedId: z.number(),
      body: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const mentioned: number[] = [];
      let m: RegExpExecArray | null;
      const re = new RegExp(MENTION_RE);
      while ((m = re.exec(input.body)) !== null) {
        const uid = Number(m[2]);
        if (Number.isFinite(uid) && !mentioned.includes(uid)) mentioned.push(uid);
      }

      await db.insert(activities).values({
        workspaceId: ctx.workspace.id,
        type: "note",
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        subject: "Note",
        body: input.body,
        mentions: mentioned,
        actorUserId: ctx.user.id,
      });

      for (const uid of mentioned) {
        if (uid === ctx.user.id) continue;
        await db.insert(notifications).values({
          workspaceId: ctx.workspace.id,
          userId: uid,
          kind: "mention",
          title: `${ctx.user.name ?? "Someone"} mentioned you`,
          body: input.body.slice(0, 240),
          relatedType: input.relatedType,
          relatedId: input.relatedId,
        });
      }
      return { ok: true, mentioned };
    }),
});

/* ─── Attachments (S3 via storagePut) ────────────────────────────────── */

export const attachmentsRouter = router({
  list: workspaceProcedure
    .input(z.object({ relatedType: z.string(), relatedId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select().from(attachments)
        .where(and(eq(attachments.workspaceId, ctx.workspace.id), eq(attachments.relatedType, input.relatedType), eq(attachments.relatedId, input.relatedId)))
        .orderBy(desc(attachments.createdAt));
    }),

  upload: repProcedure
    .input(z.object({
      relatedType: z.string(),
      relatedId: z.number(),
      fileName: z.string().min(1),
      mimeType: z.string().optional(),
      base64: z.string().min(1), // raw base64 (no data: prefix)
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const buf = Buffer.from(input.base64, "base64");
      const safeName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const key = `ws-${ctx.workspace.id}/${input.relatedType}-${input.relatedId}/${Date.now()}-${safeName}`;
      const put = await storagePut(key, buf, input.mimeType ?? "application/octet-stream");
      const r = await db.insert(attachments).values({
        workspaceId: ctx.workspace.id,
        relatedType: input.relatedType,
        relatedId: input.relatedId,
        fileKey: put.key,
        url: put.url,
        fileName: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: buf.length,
        uploadedByUserId: ctx.user.id,
      });
      return { id: Number((r as any)[0]?.insertId ?? 0), url: put.url, key: put.key };
    }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(attachments).where(and(eq(attachments.id, input.id), eq(attachments.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});
