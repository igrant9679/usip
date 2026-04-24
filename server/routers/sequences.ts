import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { contacts, emailDrafts, enrollments, leads, sequenceAbVariants, sequenceEdges, sequenceNodes, sequences, workspaceSettings } from "../../drizzle/schema";
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

  update: repProcedure.input(z.object({
    id: z.number(),
    patch: z.record(z.string(), z.any()),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(sequences).set(input.patch).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
  updateMeta: repProcedure.input(z.object({
    id: z.number(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().optional(),
    dailyCap: z.number().int().min(1).max(10000).nullable().optional(),
    exitConditions: z.array(z.object({ type: z.enum(["reply","bounce","unsubscribe","goal_met","manual"]), enabled: z.boolean() })).optional(),
    settings: z.object({
      timezone: z.string().optional(),
      sendWindowStart: z.string().optional(),
      sendWindowEnd: z.string().optional(),
      skipWeekends: z.boolean().optional(),
      replyDetection: z.boolean().optional(),
    }).optional(),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const { id, ...patch } = input;
    await db.update(sequences).set(patch).where(and(eq(sequences.id, id), eq(sequences.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),
  updateSteps: repProcedure.input(z.object({
    id: z.number(),
    steps: z.array(stepSchema),
  })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [seq] = await db.select().from(sequences).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
    if (!seq) throw new TRPCError({ code: "NOT_FOUND" });
    if (seq.status === "active" || seq.status === "paused") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot edit steps of an active/paused sequence. Pause it first." });
    }
    await db.update(sequences).set({ steps: input.steps, updatedAt: new Date() }).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
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

  /* ── Canvas ── */
  getCanvas: workspaceProcedure.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return { nodes: [], edges: [] };
    const [nodes, edges] = await Promise.all([
      db.select().from(sequenceNodes).where(and(eq(sequenceNodes.sequenceId, input.id), eq(sequenceNodes.workspaceId, ctx.workspace.id))),
      db.select().from(sequenceEdges).where(and(eq(sequenceEdges.sequenceId, input.id), eq(sequenceEdges.workspaceId, ctx.workspace.id))),
    ]);
    return { nodes, edges };
  }),

  saveCanvas: repProcedure
    .input(z.object({
      id: z.number(),
      nodes: z.array(z.object({
        id: z.string(),
        type: z.enum(["start", "email", "wait", "condition", "action", "goal"]),
        positionX: z.number(),
        positionY: z.number(),
        data: z.record(z.string(), z.any()),
      })),
      edges: z.array(z.object({
        id: z.string(),
        source: z.string(),
        target: z.string(),
        sourceHandle: z.string().nullable().optional(),
        label: z.string().nullable().optional(),
      })),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Verify sequence belongs to workspace
      const [seq] = await db.select().from(sequences).where(and(eq(sequences.id, input.id), eq(sequences.workspaceId, ctx.workspace.id)));
      if (!seq) throw new TRPCError({ code: "NOT_FOUND" });
      if (seq.status === "active" || seq.status === "paused") throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot edit canvas of an active/paused sequence" });
      // Replace all nodes + edges atomically
      await db.delete(sequenceNodes).where(and(eq(sequenceNodes.sequenceId, input.id), eq(sequenceNodes.workspaceId, ctx.workspace.id)));
      await db.delete(sequenceEdges).where(and(eq(sequenceEdges.sequenceId, input.id), eq(sequenceEdges.workspaceId, ctx.workspace.id)));
      if (input.nodes.length > 0) {
        await db.insert(sequenceNodes).values(input.nodes.map((n) => ({
          id: n.id,
          sequenceId: input.id,
          workspaceId: ctx.workspace.id,
          type: n.type,
          positionX: n.positionX,
          positionY: n.positionY,
          data: n.data,
        })));
      }
      if (input.edges.length > 0) {
        await db.insert(sequenceEdges).values(input.edges.map((e) => ({
          id: e.id,
          sequenceId: input.id,
          workspaceId: ctx.workspace.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle ?? null,
          label: e.label ?? null,
        })));
      }
      await db.update(sequences).set({ updatedAt: new Date() }).where(eq(sequences.id, input.id));
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
    // Enrollment guard: block contacts with invalid email if workspace setting is enabled
    if (input.contactId) {
      const [settings] = await db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
      if (settings?.blockInvalidEmailsFromSequences) {
        const [contact] = await db.select().from(contacts).where(and(eq(contacts.id, input.contactId), eq(contacts.workspaceId, ctx.workspace.id)));
        if (contact?.emailVerificationStatus === "invalid") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This contact has an invalid email address and is blocked from sequence enrollment. Verify or update their email to proceed." });
        }
      }
    }
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

  resumeEnrollment: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(enrollments).set({ status: "active", nextActionAt: new Date() }).where(and(eq(enrollments.id, input.id), eq(enrollments.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  exitEnrollment: repProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    await db.update(enrollments).set({ status: "exited" }).where(and(eq(enrollments.id, input.id), eq(enrollments.workspaceId, ctx.workspace.id)));
    return { ok: true };
  }),

  pauseOnReply: repProcedure.input(z.object({ enrollmentId: z.number() })).mutation(async ({ ctx, input }) => {
    const { pauseOnReply } = await import("../sequenceEngine");
    await pauseOnReply(input.enrollmentId, ctx.workspace.id);
    return { ok: true };
  }),

  getEnrollmentStats: workspaceProcedure.input(z.object({ sequenceId: z.number() })).query(async ({ ctx, input }) => {
    const { getEnrollmentStats } = await import("../sequenceEngine");
    return getEnrollmentStats(input.sequenceId, ctx.workspace.id);
  }),

  getEnrollmentStepStats: workspaceProcedure.input(z.object({ sequenceId: z.number() })).query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db.select().from(enrollments).where(and(eq(enrollments.sequenceId, input.sequenceId), eq(enrollments.workspaceId, ctx.workspace.id)));
    // Count by currentStep
    const stepCounts: Record<number, number> = {};
    for (const r of rows) {
      stepCounts[r.currentStep] = (stepCounts[r.currentStep] ?? 0) + 1;
    }
    return Object.entries(stepCounts).map(([step, count]) => ({ step: Number(step), count }));
  }),

  /** Sequence performance analytics: open rate, click rate, reply rate, opt-out rate per sequence. */
  getPerformanceAnalytics: workspaceProcedure
    .input(z.object({
      sequenceId: z.number().optional(),
      /** ISO date string YYYY-MM-DD — filter emails sent on or after this date */
      dateFrom: z.string().optional(),
      /** ISO date string YYYY-MM-DD — filter emails sent on or before this date */
      dateTo: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;
      const fromTs = input.dateFrom ? new Date(input.dateFrom).getTime() : null;
      const toTs = input.dateTo ? new Date(input.dateTo + "T23:59:59Z").getTime() : null;

      // Get all sequences in workspace
      const seqRows = await db.select().from(sequences).where(eq(sequences.workspaceId, wsId));
      const targetSeqs = input.sequenceId ? seqRows.filter((s) => s.id === input.sequenceId) : seqRows;

      const results = await Promise.all(targetSeqs.map(async (seq) => {
        // Get all email drafts for this sequence, filtered by sent date range if provided
        let drafts = await db.select().from(emailDrafts).where(and(eq(emailDrafts.sequenceId, seq.id), eq(emailDrafts.workspaceId, wsId)));
        if (fromTs !== null) drafts = drafts.filter((d) => d.sentAt !== null && new Date(d.sentAt).getTime() >= fromTs);
        if (toTs !== null) drafts = drafts.filter((d) => d.sentAt !== null && new Date(d.sentAt).getTime() <= toTs);
        const sent = drafts.filter((d) => d.status === "sent").length;
        const totalOpens = drafts.reduce((s, d) => s + (d.openCount ?? 0), 0);
        const totalClicks = drafts.reduce((s, d) => s + (d.clickCount ?? 0), 0);
        const bounced = drafts.filter((d) => d.bouncedAt !== null).length;
        // Count unique opens (drafts with at least one open)
        const uniqueOpens = drafts.filter((d) => (d.openCount ?? 0) > 0).length;
        // Count unique clicks
        const uniqueClicks = drafts.filter((d) => (d.clickCount ?? 0) > 0).length;

        // Enrollment stats
        const enrs = await db.select().from(enrollments).where(and(eq(enrollments.sequenceId, seq.id), eq(enrollments.workspaceId, wsId)));
        const totalEnrolled = enrs.length;
        const active = enrs.filter((e) => e.status === "active").length;
        const finished = enrs.filter((e) => e.status === "finished").length;
        const exited = enrs.filter((e) => e.status === "exited").length;
        const paused = enrs.filter((e) => e.status === "paused").length;

        // Rates (based on sent emails)
        const openRate = sent > 0 ? Math.round((uniqueOpens / sent) * 100) : 0;
        const clickRate = sent > 0 ? Math.round((uniqueClicks / sent) * 100) : 0;
        const bounceRate = sent > 0 ? Math.round((bounced / sent) * 100) : 0;
        const exitRate = totalEnrolled > 0 ? Math.round((exited / totalEnrolled) * 100) : 0;

        return {
          sequenceId: seq.id,
          sequenceName: seq.name,
          status: seq.status,
          totalEnrolled,
          active,
          finished,
          exited,
          paused,
          sent,
          uniqueOpens,
          uniqueClicks,
          bounced,
          totalOpens,
          totalClicks,
          openRate,
          clickRate,
          bounceRate,
          exitRate,
        };
      }));

      return results;
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

/* ─────────────────────────────────────────────────────────────────────────────
   Sequence A/B Variants Router
   ───────────────────────────────────────────────────────────────────────── */

export const sequenceAbRouter = router({
  /** List all variants for a sequence (optionally filtered by stepIndex) */
  list: workspaceProcedure
    .input(z.object({ sequenceId: z.number(), stepIndex: z.number().optional() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const conds: any[] = [
        eq(sequenceAbVariants.workspaceId, ctx.workspace.id),
        eq(sequenceAbVariants.sequenceId, input.sequenceId),
      ];
      if (input.stepIndex !== undefined) conds.push(eq(sequenceAbVariants.stepIndex, input.stepIndex));
      return db.select().from(sequenceAbVariants).where(and(...conds)).orderBy(sequenceAbVariants.stepIndex, sequenceAbVariants.variantLabel);
    }),

  /** Create a new A/B variant for a step */
  create: workspaceProcedure
    .input(z.object({
      sequenceId: z.number(),
      stepIndex: z.number().int().min(0),
      variantLabel: z.string().min(1).max(32),
      subject: z.string().min(1),
      body: z.string(),
      splitPct: z.number().int().min(1).max(99).default(50),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Verify sequence belongs to workspace
      const [seq] = await db.select({ id: sequences.id }).from(sequences)
        .where(and(eq(sequences.id, input.sequenceId), eq(sequences.workspaceId, ctx.workspace.id)));
      if (!seq) throw new TRPCError({ code: "NOT_FOUND", message: "Sequence not found" });
      const [inserted] = await db.insert(sequenceAbVariants).values({
        workspaceId: ctx.workspace.id,
        sequenceId: input.sequenceId,
        stepIndex: input.stepIndex,
        variantLabel: input.variantLabel,
        subject: input.subject,
        body: input.body,
        splitPct: input.splitPct,
      });
      return { id: (inserted as any).insertId };
    }),

  /** Update an existing variant */
  update: workspaceProcedure
    .input(z.object({
      id: z.number(),
      subject: z.string().optional(),
      body: z.string().optional(),
      splitPct: z.number().int().min(1).max(99).optional(),
      variantLabel: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { id, ...rest } = input;
      const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      if (Object.keys(patch).length > 0) {
        await db.update(sequenceAbVariants).set(patch)
          .where(and(eq(sequenceAbVariants.id, id), eq(sequenceAbVariants.workspaceId, ctx.workspace.id)));
      }
      return { ok: true };
    }),

  /** Delete a variant */
  delete: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.delete(sequenceAbVariants)
        .where(and(eq(sequenceAbVariants.id, input.id), eq(sequenceAbVariants.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),

  /** Get per-variant stats for a sequence step */
  getStats: workspaceProcedure
    .input(z.object({ sequenceId: z.number(), stepIndex: z.number().int().min(0) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const variants = await db.select().from(sequenceAbVariants)
        .where(and(
          eq(sequenceAbVariants.workspaceId, ctx.workspace.id),
          eq(sequenceAbVariants.sequenceId, input.sequenceId),
          eq(sequenceAbVariants.stepIndex, input.stepIndex),
        ));
      return variants.map((v) => ({
        id: v.id,
        variantLabel: v.variantLabel,
        subject: v.subject,
        splitPct: v.splitPct,
        sentCount: v.sentCount,
        openCount: v.openCount,
        replyCount: v.replyCount,
        isWinner: v.isWinner,
        promotedAt: v.promotedAt,
        minSendsForPromotion: v.minSendsForPromotion,
        openRate: v.sentCount > 0 ? Math.round((v.openCount / v.sentCount) * 100) : 0,
        replyRate: v.sentCount > 0 ? Math.round((v.replyCount / v.sentCount) * 100) : 0,
        score: v.sentCount > 0 ? (v.replyCount / v.sentCount) * 100 + (v.openCount / v.sentCount) * 10 : 0,
      }));
    }),

  /** Manually promote a variant as winner for a step */
  promoteWinner: workspaceProcedure
    .input(z.object({ sequenceId: z.number(), stepIndex: z.number().int().min(0), winnerId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Clear existing winner flags for this step
      await db.update(sequenceAbVariants)
        .set({ isWinner: false, promotedAt: null })
        .where(and(
          eq(sequenceAbVariants.workspaceId, ctx.workspace.id),
          eq(sequenceAbVariants.sequenceId, input.sequenceId),
          eq(sequenceAbVariants.stepIndex, input.stepIndex),
        ));
      // Set the new winner
      await db.update(sequenceAbVariants)
        .set({ isWinner: true, promotedAt: new Date() })
        .where(and(
          eq(sequenceAbVariants.id, input.winnerId),
          eq(sequenceAbVariants.workspaceId, ctx.workspace.id),
        ));
      return { ok: true };
    }),

  /** Update min-sends threshold for auto-promotion on a variant */
  setMinSends: workspaceProcedure
    .input(z.object({ id: z.number(), minSendsForPromotion: z.number().int().min(1).max(10000) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(sequenceAbVariants)
        .set({ minSendsForPromotion: input.minSendsForPromotion })
        .where(and(eq(sequenceAbVariants.id, input.id), eq(sequenceAbVariants.workspaceId, ctx.workspace.id)));
      return { ok: true };
    }),
});

/**
 * Standalone function called by the nightly batch to auto-promote A/B winners.
 * For each (sequenceId, stepIndex) group: if all variants meet their minSendsForPromotion
 * threshold and no winner has been set yet, promote the variant with the highest reply rate.
 */
export async function checkAndPromoteAbVariants(): Promise<{ promoted: number }> {
  const db = await getDb();
  if (!db) return { promoted: 0 };
  // Get all variants that haven't been promoted yet
  const variants = await db.select().from(sequenceAbVariants)
    .where(eq(sequenceAbVariants.isWinner, false));
  // Group by (sequenceId, stepIndex)
  const groups = new Map<string, typeof variants>();
  for (const v of variants) {
    const key = `${v.sequenceId}:${v.stepIndex}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(v);
  }
  let promoted = 0;
  for (const [, group] of groups) {
    // Skip if any variant in the group hasn't reached its min-sends threshold
    const allMeetThreshold = group.every(v => v.sentCount >= v.minSendsForPromotion);
    if (!allMeetThreshold || group.length < 2) continue;
    // Check if a winner already exists for this group
    const [existing] = await db.select({ id: sequenceAbVariants.id })
      .from(sequenceAbVariants)
      .where(and(
        eq(sequenceAbVariants.sequenceId, group[0].sequenceId),
        eq(sequenceAbVariants.stepIndex, group[0].stepIndex),
        eq(sequenceAbVariants.isWinner, true),
      ));
    if (existing) continue; // already promoted
    // Find the variant with the highest reply rate (open rate as tiebreaker)
    const winner = group.reduce((best, v) => {
      const score = v.sentCount > 0 ? (v.replyCount / v.sentCount) * 100 + (v.openCount / v.sentCount) * 10 : 0;
      const bestScore = best.sentCount > 0 ? (best.replyCount / best.sentCount) * 100 + (best.openCount / best.sentCount) * 10 : 0;
      return score > bestScore ? v : best;
    });
    // Clear all winner flags for this step then set the winner
    await db.update(sequenceAbVariants)
      .set({ isWinner: false, promotedAt: null })
      .where(and(
        eq(sequenceAbVariants.sequenceId, group[0].sequenceId),
        eq(sequenceAbVariants.stepIndex, group[0].stepIndex),
      ));
    await db.update(sequenceAbVariants)
      .set({ isWinner: true, promotedAt: new Date() })
      .where(eq(sequenceAbVariants.id, winner.id));
    promoted++;
  }
  return { promoted };
}
