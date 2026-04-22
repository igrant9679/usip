/**
 * AI Research-to-Email Draft Pipeline (MKT-014..MKT-017)
 * 5 stages: Org Research → Contact Research → Fit Analysis → 3-Variant Draft Generation → Queue
 */
import { z } from "zod";
import { router } from "../_core/trpc";
import { workspaceProcedure } from "../_core/workspace";
import { getDb } from "../db";
import { TRPCError } from "@trpc/server";
import { eq, and, inArray, desc, isNull } from "drizzle-orm";
import {
  aiPipelineJobs,
  emailDrafts,
  contacts,
  accounts,
  leads,
} from "../../drizzle/schema";
import { invokeLLM } from "../_core/llm";

/* ─── Helpers ─────────────────────────────────────────────────────────── */

async function runPipelineForContact(
  workspaceId: number,
  jobId: number,
  contactId: number | null,
  leadId: number | null,
  triggeredByUserId: number
) {
  const db = await getDb();
  if (!db) return;

  // Mark running
  await db
    .update(aiPipelineJobs)
    .set({ status: "running" })
    .where(eq(aiPipelineJobs.id, jobId));

  try {
    // Fetch contact/lead + account context
    let firstName = "";
    let lastName = "";
    let title = "";
    let email = "";
    let linkedinUrl = "";
    let companyName = "";
    let domain = "";
    let industry = "";
    let employeeBand = "";

    if (contactId) {
      const [c] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.workspaceId, workspaceId)));
      if (c) {
        firstName = c.firstName;
        lastName = c.lastName;
        title = c.title ?? "";
        email = c.email ?? "";
        linkedinUrl = c.linkedinUrl ?? "";
        if (c.accountId) {
          const [acc] = await db
            .select()
            .from(accounts)
            .where(eq(accounts.id, c.accountId));
          if (acc) {
            companyName = acc.name;
            domain = acc.domain ?? "";
            industry = acc.industry ?? "";
            employeeBand = acc.employeeBand ?? "";
          }
        }
      }
    } else if (leadId) {
      const [l] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.id, leadId), eq(leads.workspaceId, workspaceId)));
      if (l) {
        firstName = l.firstName;
        lastName = l.lastName;
        title = l.title ?? "";
        email = l.email ?? "";
        companyName = l.company ?? "";
      }
    }

    const fullName = `${firstName} ${lastName}`.trim();

    // Stage 1 — Org Research
    const orgResearchRes = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a B2B sales research assistant. Provide concise, factual research summaries for sales outreach. Keep responses under 200 words.",
        },
        {
          role: "user",
          content: `Research the company "${companyName}" (domain: ${domain || "unknown"}, industry: ${industry || "unknown"}, size: ${employeeBand || "unknown"}).
Summarize: (1) what the company does, (2) recent news or growth signals, (3) likely pain points for a sales conversation, (4) technology or operational context relevant to outreach.`,
        },
      ],
    });
    const orgResearch =
      (orgResearchRes.choices?.[0]?.message?.content as string) ?? "";

    // Save org research
    await db
      .update(aiPipelineJobs)
      .set({ orgResearch })
      .where(eq(aiPipelineJobs.id, jobId));

    // Stage 2 — Contact Research
    const contactResearchRes = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a B2B sales research assistant. Provide concise contact-level research for personalized outreach. Keep responses under 150 words.",
        },
        {
          role: "user",
          content: `Research the contact: ${fullName}, Title: ${title}, Company: ${companyName}.
${linkedinUrl ? `LinkedIn: ${linkedinUrl}` : ""}
Summarize: (1) their likely role and decision-making authority, (2) professional background or expertise, (3) likely priorities and challenges based on their title, (4) personalization angles for outreach.`,
        },
      ],
    });
    const contactResearch =
      (contactResearchRes.choices?.[0]?.message?.content as string) ?? "";

    // Save contact research
    await db
      .update(aiPipelineJobs)
      .set({ contactResearch })
      .where(eq(aiPipelineJobs.id, jobId));

    // Stage 3 — Fit Analysis (structured JSON)
    const fitAnalysisRes = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a B2B sales fit analyst. Analyze prospect fit and return structured JSON only.",
        },
        {
          role: "user",
          content: `Based on this research, analyze the prospect fit:
Company: ${companyName} (${industry}, ${employeeBand})
Contact: ${fullName}, ${title}
Org Research: ${orgResearch}
Contact Research: ${contactResearch}

Return JSON with these exact fields:
- fit_score: number 0-100
- pain_points: array of 3 strings (specific pain points this prospect likely has)
- recommended_products: array of 2-3 strings (product/solution angles to lead with)
- objection_risks: array of 2 strings (likely objections to anticipate)
- personalization_hooks: array of 2 strings (specific details to reference in email)`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "fit_analysis",
          strict: true,
          schema: {
            type: "object",
            properties: {
              fit_score: { type: "number" },
              pain_points: { type: "array", items: { type: "string" } },
              recommended_products: { type: "array", items: { type: "string" } },
              objection_risks: { type: "array", items: { type: "string" } },
              personalization_hooks: { type: "array", items: { type: "string" } },
            },
            required: [
              "fit_score",
              "pain_points",
              "recommended_products",
              "objection_risks",
              "personalization_hooks",
            ],
            additionalProperties: false,
          },
        },
      },
    });

    let fitAnalysis: Record<string, unknown> = {};
    try {
      const raw = fitAnalysisRes.choices?.[0]?.message?.content as string;
      fitAnalysis = JSON.parse(raw);
    } catch {
      fitAnalysis = { fit_score: 50, pain_points: [], recommended_products: [], objection_risks: [], personalization_hooks: [] };
    }

    // Save fit analysis
    await db
      .update(aiPipelineJobs)
      .set({ fitAnalysis })
      .where(eq(aiPipelineJobs.id, jobId));

    // Stage 4 — 3-Variant Draft Generation
    const tones = [
      { tone: "formal", instruction: "Write a formal, professional email. Lead with business value and ROI. Use precise language and a respectful tone." },
      { tone: "casual", instruction: "Write a warm, conversational email. Be friendly and approachable. Use natural language as if you know the person." },
      { tone: "value_prop", instruction: "Write a value-proposition-focused email. Lead with a specific pain point and immediately offer a clear solution. Be direct and outcome-focused." },
    ];

    const painPoints = (fitAnalysis.pain_points as string[]) ?? [];
    const hooks = (fitAnalysis.personalization_hooks as string[]) ?? [];
    const products = (fitAnalysis.recommended_products as string[]) ?? [];

    let draftsGenerated = 0;
    for (const { tone, instruction } of tones) {
      const draftRes = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are an expert B2B sales email writer. ${instruction} Keep emails under 150 words. Return JSON with "subject" and "body" fields only.`,
          },
          {
            role: "user",
            content: `Write a cold outreach email to ${fullName} (${title} at ${companyName}).
Pain points to address: ${painPoints.slice(0, 2).join("; ")}
Products/solutions to mention: ${products.slice(0, 2).join(", ")}
Personalization hooks: ${hooks.slice(0, 2).join("; ")}
Org context: ${orgResearch.slice(0, 300)}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "email_draft",
            strict: true,
            schema: {
              type: "object",
              properties: {
                subject: { type: "string" },
                body: { type: "string" },
              },
              required: ["subject", "body"],
              additionalProperties: false,
            },
          },
        },
      });

      let subject = "";
      let body = "";
      try {
        const raw = draftRes.choices?.[0]?.message?.content as string;
        const parsed = JSON.parse(raw);
        subject = parsed.subject ?? "";
        body = parsed.body ?? "";
      } catch {
        subject = `Reaching out to ${companyName}`;
        body = `Hi ${firstName},\n\nI wanted to reach out about how we can help ${companyName}.\n\nBest,`;
      }

      // Stage 5 — Queue draft for review
      await db.insert(emailDrafts).values({
        workspaceId,
        subject,
        body,
        toContactId: contactId ?? undefined,
        toLeadId: leadId ?? undefined,
        toEmail: email || undefined,
        pipelineJobId: jobId,
        status: "ai_pending_review" as any,
        aiGenerated: true,
        tone,
        createdByUserId: triggeredByUserId,
      });
      draftsGenerated++;
    }

    // Mark done
    await db
      .update(aiPipelineJobs)
      .set({ status: "done", draftsGenerated, completedAt: new Date() })
      .where(eq(aiPipelineJobs.id, jobId));
  } catch (err: any) {
    await db
      .update(aiPipelineJobs)
      .set({ status: "failed", errorMessage: err?.message ?? "Unknown error", completedAt: new Date() })
      .where(eq(aiPipelineJobs.id, jobId));
  }
}

/* ─── Router ──────────────────────────────────────────────────────────── */

export const aiPipelineRouter = router({
  /** Trigger pipeline for a single contact */
  runForContact: workspaceProcedure
    .input(z.object({ contactId: z.number().optional(), leadId: z.number().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [job] = await db
        .insert(aiPipelineJobs)
        .values({
          workspaceId: ctx.workspace.id,
          contactId: input.contactId ?? null,
          leadId: input.leadId ?? null,
          status: "queued",
          triggeredByUserId: ctx.user.id,
        })
        .$returningId();
      const jobId = (job as any).id;
      // Run async (fire and forget — client polls getQueueStats)
      setImmediate(() =>
        runPipelineForContact(
          ctx.workspace.id,
          jobId,
          input.contactId ?? null,
          input.leadId ?? null,
          ctx.user.id
        )
      );
      return { jobId };
    }),

  /** Trigger pipeline for multiple contacts */
  runBulk: workspaceProcedure
    .input(z.object({ contactIds: z.array(z.number()) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const jobIds: number[] = [];
      for (const contactId of input.contactIds) {
        const [job] = await db
          .insert(aiPipelineJobs)
          .values({
            workspaceId: ctx.workspace.id,
            contactId,
            status: "queued",
            triggeredByUserId: ctx.user.id,
          })
          .$returningId();
        const jobId = (job as any).id;
        jobIds.push(jobId);
        setImmediate(() =>
          runPipelineForContact(ctx.workspace.id, jobId, contactId, null, ctx.user.id)
        );
      }
      return { jobIds, count: jobIds.length };
    }),

  /** Get recent pipeline jobs for this workspace */
  getJobs: workspaceProcedure
    .input(z.object({ limit: z.number().default(20) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const jobs = await db
        .select()
        .from(aiPipelineJobs)
        .where(eq(aiPipelineJobs.workspaceId, ctx.workspace.id))
        .orderBy(desc(aiPipelineJobs.createdAt))
        .limit(input.limit);
      return jobs;
    }),

  /** Get queue stats — count of drafts by status */
  getQueueStats: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const drafts = await db
      .select()
      .from(emailDrafts)
      .where(
        and(
          eq(emailDrafts.workspaceId, ctx.workspace.id),
          inArray(emailDrafts.status as any, ["ai_pending_review", "approved", "rejected", "sent"])
        )
      );
    const stats = {
      pending_review: 0,
      approved: 0,
      rejected: 0,
      sent: 0,
      total: drafts.length,
    };
    for (const d of drafts) {
      if (d.status === "ai_pending_review") stats.pending_review++;
      else if (d.status === "approved") stats.approved++;
      else if (d.status === "rejected") stats.rejected++;
      else if (d.status === "sent") stats.sent++;
    }
    return stats;
  }),

  /** Get draft review queue (ai_pending_review drafts with job context) */
  getDraftQueue: workspaceProcedure
    .input(z.object({ page: z.number().default(1), pageSize: z.number().default(20) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const offset = (input.page - 1) * input.pageSize;
      const drafts = await db
        .select()
        .from(emailDrafts)
        .where(
          and(
            eq(emailDrafts.workspaceId, ctx.workspace.id),
            eq(emailDrafts.status as any, "ai_pending_review")
          )
        )
        .orderBy(desc(emailDrafts.createdAt))
        .limit(input.pageSize)
        .offset(offset);

      // Attach job context for each draft
      const jobIds = Array.from(new Set(drafts.map((d) => d.pipelineJobId).filter(Boolean))) as number[];
      const jobs =
        jobIds.length > 0
          ? await db.select().from(aiPipelineJobs).where(inArray(aiPipelineJobs.id, jobIds))
          : [];
      const jobMap = Object.fromEntries(jobs.map((j) => [j.id, j]));

      return drafts.map((d) => ({
        ...d,
        job: d.pipelineJobId ? jobMap[d.pipelineJobId] ?? null : null,
      }));
    }),

  /** Approve a draft (optionally with edits) */
  approveDraft: workspaceProcedure
    .input(
      z.object({
        draftId: z.number(),
        subject: z.string().optional(),
        body: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [draft] = await db
        .select()
        .from(emailDrafts)
        .where(
          and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.workspaceId, ctx.workspace.id))
        );
      if (!draft) throw new TRPCError({ code: "NOT_FOUND" });
      await db
        .update(emailDrafts)
        .set({
          status: "approved",
          subject: input.subject ?? draft.subject,
          body: input.body ?? draft.body,
          reviewedByUserId: ctx.user.id,
        })
        .where(eq(emailDrafts.id, input.draftId));
      return { ok: true };
    }),

  /** Reject a draft */
  rejectDraft: workspaceProcedure
    .input(z.object({ draftId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(emailDrafts)
        .set({ status: "rejected", reviewedByUserId: ctx.user.id })
        .where(
          and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.workspaceId, ctx.workspace.id))
        );
      return { ok: true };
    }),

  /** Bulk approve all pending drafts for a job */
  bulkApproveDrafts: workspaceProcedure
    .input(z.object({ draftIds: z.array(z.number()) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db
        .update(emailDrafts)
        .set({ status: "approved", reviewedByUserId: ctx.user.id })
        .where(
          and(
            inArray(emailDrafts.id, input.draftIds),
            eq(emailDrafts.workspaceId, ctx.workspace.id)
          )
        );
      return { ok: true, count: input.draftIds.length };
    }),

  /** Regenerate a draft with a revision preset */
  regenerateDraft: workspaceProcedure
    .input(
      z.object({
        draftId: z.number(),
        preset: z.enum(["more_formal", "shorter", "stronger_cta", "different_angle"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [draft] = await db
        .select()
        .from(emailDrafts)
        .where(
          and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.workspaceId, ctx.workspace.id))
        );
      if (!draft) throw new TRPCError({ code: "NOT_FOUND" });

      const presetInstructions: Record<string, string> = {
        more_formal: "Rewrite this email to be more formal and professional. Use precise business language.",
        shorter: "Rewrite this email to be shorter — maximum 80 words. Keep only the most important points.",
        stronger_cta: "Rewrite this email with a stronger, more specific call to action. Make the next step crystal clear.",
        different_angle: "Rewrite this email from a completely different angle. Use a different opening hook and value proposition.",
      };

      const regenRes = await invokeLLM({
        messages: [
          {
            role: "system",
            content: `You are an expert B2B sales email writer. ${presetInstructions[input.preset]} Return JSON with "subject" and "body" fields only.`,
          },
          {
            role: "user",
            content: `Original subject: ${draft.subject}\nOriginal body: ${draft.body}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "email_draft",
            strict: true,
            schema: {
              type: "object",
              properties: {
                subject: { type: "string" },
                body: { type: "string" },
              },
              required: ["subject", "body"],
              additionalProperties: false,
            },
          },
        },
      });

      let newSubject = draft.subject;
      let newBody = draft.body;
      try {
        const raw = regenRes.choices?.[0]?.message?.content as string;
        const parsed = JSON.parse(raw);
        newSubject = parsed.subject ?? draft.subject;
        newBody = parsed.body ?? draft.body;
      } catch {
        // keep original on parse failure
      }

      await db
        .update(emailDrafts)
        .set({ subject: newSubject, body: newBody, status: "ai_pending_review" as any })
        .where(eq(emailDrafts.id, input.draftId));

      return { subject: newSubject, body: newBody };
    }),

  /** Score an email draft for effectiveness (1-10) */
  scoreDraft: workspaceProcedure
    .input(z.object({ draftId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [draft] = await db
        .select()
        .from(emailDrafts)
        .where(
          and(eq(emailDrafts.id, input.draftId), eq(emailDrafts.workspaceId, ctx.workspace.id))
        );
      if (!draft) throw new TRPCError({ code: "NOT_FOUND" });

      const scoreRes = await invokeLLM({
        messages: [
          {
            role: "system",
            content:
              "You are an expert B2B sales email coach. Score emails and provide actionable feedback. Return JSON only.",
          },
          {
            role: "user",
            content: `Score this B2B sales email:
Subject: ${draft.subject}
Body: ${draft.body}

Return JSON with:
- score: number 1-10
- strengths: array of 2 strings (what works well)
- improvements: array of 2 strings (specific improvements)
- alt_subjects: array of 3 alternative subject lines`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "email_score",
            strict: true,
            schema: {
              type: "object",
              properties: {
                score: { type: "number" },
                strengths: { type: "array", items: { type: "string" } },
                improvements: { type: "array", items: { type: "string" } },
                alt_subjects: { type: "array", items: { type: "string" } },
              },
              required: ["score", "strengths", "improvements", "alt_subjects"],
              additionalProperties: false,
            },
          },
        },
      });

      try {
        const raw = scoreRes.choices?.[0]?.message?.content as string;
        return JSON.parse(raw);
      } catch {
        return { score: 5, strengths: [], improvements: [], alt_subjects: [] };
      }
    }),
});
