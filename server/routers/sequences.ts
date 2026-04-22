import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { contacts, emailDrafts, enrollments, leads, sequences } from "../../drizzle/schema";
import { recordAudit } from "../audit";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { router } from "../_core/trpc";
import { repProcedure, workspaceProcedure } from "../_core/workspace";

const stepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("email"), subject: z.string(), body: z.string().optional() }),
  z.object({ type: z.literal("wait"), days: z.number().int().min(0).max(60) }),
  z.object({ type: z.literal("task"), body: z.string() }),
]);

export const sequencesRouter = router({
  list: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(sequences).where(eq(sequences.workspaceId, ctx.workspace.id)).orderBy(desc(sequences.updatedAt));
  }),

  get: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [row] = await db.select().from(sequences).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
    return row ?? null;
  }),

  create: repProcedure.input(z.object({ name: z.string().min(1), description: z.string().optional(), steps: z.array(stepSchema).default([]) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const r = await db.insert(sequences).values({ ...input, workspaceId: ctx.workspace.id, ownerUserId: ctx.user.id, status: "draft" });
    return { id: Number((r as any)[0]?.insertId ?? 0) };
  }),

  update: repProcedure.input(z.object({ id: z.number(), patch: z.record(z.string(), z.any()) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(sequences).set(input.patch).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(sequences).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  setStatus: repProcedure.input(z.object({ id: z.number(), status: z.enum(["draft", "active", "paused", "archived"]) })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(sequences).set({ status: input.status }).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /* ── Enrollments ── */
  listEnrollments: workspaceProcedure.input(z.object({ sequenceId: z.number().optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select().from(enrollments).where(eq(enrollments.workspaceId, ctx.workspace.id));
    return input?.sequenceId ? rows.filter((r) => r.sequenceId === input.sequenceId) : rows;
  }),

  enroll: repProcedure.input(z.object({ sequenceId: z.number(), contactId: z.number().optional(), leadId: z.number().optional() })).mutation(async ({ ctx, input }) => {
    if (!input.contactId && !input.leadId) throw new TRPCError({ code: "BAD_REQUEST", message: "contactId or leadId required" });
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.insert(enrollments).values({
      workspaceId: ctx.workspace.id,
      sequenceId: input.sequenceId,
      contactId: input.contactId ?? null,
      leadId: input.leadId ?? null,
      status: "active",
      currentStep: 0,
      nextActionAt: new Date(),
    });
    return { ok: true };
  }),

  pauseEnrollment: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(enrollments).set({ status: "paused" }).where(and(eq(enrollments.id, input.id), eq(enrollments.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});

/* ─── Email Drafts ────────────────────────────────────────────────────── */

export const emailDraftsRouter = router({
  list: workspaceProcedure.input(z.object({ status: z.enum(["pending_review", "approved", "rejected", "sent"]).optional() }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    let rows = await db.select().from(emailDrafts).where(eq(emailDrafts.workspaceId, ctx.workspace.id)).orderBy(desc(emailDrafts.createdAt));
    if (input?.status) rows = rows.filter((r) => r.status === input.status);
    return rows;
  }),

  /** Server-side AI compose. */
  compose: repProcedure
    .input(z.object({
      prompt: z.string().min(4),
      toContactId: z.number().optional(),
      toLeadId: z.number().optional(),
      tone: z.enum(["concise", "warm", "formal", "punchy"]).default("concise"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      let contextLine = "";
      let toEmail: string | null = null;
      if (input.toContactId) {
        const [c] = await db.select().from(contacts).where(and(eq(contacts.id, input.toContactId), eq(contacts.workspaceId, ctx.workspace.id)));
        if (c) {
          contextLine = `Recipient: ${c.firstName} ${c.lastName}, ${c.title ?? "?"}`;
          toEmail = c.email ?? null;
        }
      } else if (input.toLeadId) {
        const [l] = await db.select().from(leads).where(and(eq(leads.id, input.toLeadId), eq(leads.workspaceId, ctx.workspace.id)));
        if (l) {
          contextLine = `Recipient: ${l.firstName} ${l.lastName}, ${l.title ?? "?"} at ${l.company ?? "?"}`;
          toEmail = l.email ?? null;
        }
      }

      let subject = "Quick question";
      let body = "";
      try {
        const out = await invokeLLM({
          messages: [
            { role: "system", content: `You write short B2B sales emails. Tone: ${input.tone}. Output JSON only with keys subject, body. Body should be plain text, max ~120 words, with a clear ask.` },
            { role: "user", content: `${contextLine}\n\nGoal: ${input.prompt}` },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "email_draft",
              strict: true,
              schema: {
                type: "object",
                properties: { subject: { type: "string" }, body: { type: "string" } },
                required: ["subject", "body"],
                additionalProperties: false,
              },
            },
          },
        });
        const content = out.choices?.[0]?.message?.content;
        const parsed = typeof content === "string" ? JSON.parse(content) : content;
        subject = parsed.subject ?? subject;
        body = parsed.body ?? "";
      } catch (e) {
        console.warn("[compose] LLM failed; using fallback", e);
        subject = `Quick thought on ${input.prompt.slice(0, 40)}`;
        body = `Hi {{firstName}},\n\n${input.prompt}\n\nWould a 15-min call next week be useful?\n\nBest,\n{{senderName}}`;
      }

      const r = await db.insert(emailDrafts).values({
        workspaceId: ctx.workspace.id,
        subject, body,
        toContactId: input.toContactId ?? null,
        toLeadId: input.toLeadId ?? null,
        toEmail,
        status: "pending_review",
        aiGenerated: true,
        aiPrompt: input.prompt,
        createdByUserId: ctx.user.id,
      });
      return { id: Number((r as any)[0]?.insertId ?? 0), subject, body };
    }),

  approve: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(emailDrafts).set({ status: "approved", reviewedByUserId: ctx.user.id }).where(and(eq(emailDrafts.id, input.id), eq(emailDrafts.workspaceId, ctx.workspace.id)));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "email_draft", entityId: input.id, after: { status: "approved" } });
    return { ok: true };
  }),

  reject: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(emailDrafts).set({ status: "rejected", reviewedByUserId: ctx.user.id }).where(and(eq(emailDrafts.id, input.id), eq(emailDrafts.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  /** "Send" — for v1 we mark it sent without an actual SMTP relay. */
  send: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(emailDrafts).set({ status: "sent", sentAt: new Date() }).where(and(eq(emailDrafts.id, input.id), eq(emailDrafts.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  update: repProcedure.input(z.object({ id: z.number(), subject: z.string(), body: z.string() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(emailDrafts).set({ subject: input.subject, body: input.body }).where(and(eq(emailDrafts.id, input.id), eq(emailDrafts.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  delete: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.delete(emailDrafts).where(and(eq(emailDrafts.id, input.id), eq(emailDrafts.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
});
