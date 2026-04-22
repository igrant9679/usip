/**
 * Sprint 3 — AI Research-to-Draft 5-Stage Pipeline
 *
 * Stages:
 *   1. Prospect research  — company + person profile
 *   2. Signal detection   — recent news, triggers, intent signals
 *   3. Angle generation   — value-prop angles ranked by relevance
 *   4. Draft candidates   — 3 subject+body variants
 *   5. Final selection    — pick best variant, resolve personalization tokens
 *
 * Each stage is a separate tRPC mutation so the UI can stream progress.
 * The pipeline row is created on `start`, updated after each stage, and
 * an email_draft row is created on `finalize`.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  contacts,
  emailDrafts,
  leads,
  opportunities,
  promptVersions,
  researchPipelines,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { invokeLLM } from "../_core/llm";
import { router } from "../_core/trpc";
import { repProcedure, workspaceProcedure } from "../_core/workspace";

/* ─── helpers ────────────────────────────────────────────────────────────── */

async function getRecipientContext(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  workspaceId: number,
  opts: { contactId?: number; leadId?: number; accountId?: number },
) {
  let personName = "";
  let personTitle = "";
  let personEmail: string | null = null;
  let companyName = "";
  let companyIndustry = "";
  let companySize = "";
  let companyRevenue = "";

  if (opts.contactId) {
    const [c] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, opts.contactId), eq(contacts.workspaceId, workspaceId)));
    if (c) {
      personName = `${c.firstName} ${c.lastName}`.trim();
      personTitle = c.title ?? "";
      personEmail = c.email ?? null;
    }
  }
  if (opts.leadId) {
    const [l] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, opts.leadId), eq(leads.workspaceId, workspaceId)));
    if (l) {
      personName = `${l.firstName} ${l.lastName}`.trim();
      personTitle = l.title ?? "";
      personEmail = l.email ?? null;
      companyName = l.company ?? "";
    }
  }
  if (opts.accountId) {
    const [a] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, opts.accountId), eq(accounts.workspaceId, workspaceId)));
    if (a) {
      companyName = a.name ?? companyName;
      companyIndustry = a.industry ?? companyIndustry;
      companySize = a.employeeBand ?? "";
      companyRevenue = a.revenueBand ?? "";
    }
  }

  return { personName, personTitle, personEmail, companyName, companyIndustry, companySize, companyRevenue };
}

async function llmJson<T>(messages: any[], schema: any, fallback: T): Promise<T> {
  try {
    const out = await invokeLLM({
      messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "output", strict: true, schema },
      },
    });
    const content = out.choices?.[0]?.message?.content;
    return (typeof content === "string" ? JSON.parse(content) : content) as T;
  } catch {
    return fallback;
  }
}

/* ─── router ─────────────────────────────────────────────────────────────── */

export const researchPipelineRouter = router({
  /** List recent pipelines for this workspace */
  list: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(20) }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(researchPipelines)
        .where(eq(researchPipelines.workspaceId, ctx.workspace.id))
        .orderBy(desc(researchPipelines.createdAt))
        .limit(input?.limit ?? 20);
    }),

  /** Get a single pipeline by id */
  get: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;
      const [row] = await db
        .select()
        .from(researchPipelines)
        .where(and(eq(researchPipelines.id, input.id), eq(researchPipelines.workspaceId, ctx.workspace.id)));
      return row ?? null;
    }),

  /** Create a new pipeline run and immediately execute all 5 stages */
  start: repProcedure
    .input(
      z.object({
        contactId: z.number().optional(),
        leadId: z.number().optional(),
        accountId: z.number().optional(),
        goal: z.string().min(4).max(400),
        tone: z.enum(["concise", "warm", "formal", "punchy"]).default("concise"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      // Create pipeline row
      const r = await db.insert(researchPipelines).values({
        workspaceId: ctx.workspace.id,
        createdByUserId: ctx.user.id,
        toContactId: input.contactId ?? null,
        toLeadId: input.leadId ?? null,
        toAccountId: input.accountId ?? null,
        status: "running",
        currentStage: 1,
      });
      const pipelineId = Number((r as any)[0]?.insertId ?? 0);

      const ctx_ = { workspaceId: ctx.workspace.id };
      const recipient = await getRecipientContext(db, ctx.workspace.id, {
        contactId: input.contactId,
        leadId: input.leadId,
        accountId: input.accountId,
      });

      try {
        /* ── Stage 1: Prospect research ── */
        const stage1 = await llmJson(
          [
            { role: "system", content: "You are a B2B sales research assistant. Output JSON only." },
            {
              role: "user",
              content: `Research this prospect for an outreach email.\nPerson: ${recipient.personName}, ${recipient.personTitle}\nCompany: ${recipient.companyName} (${recipient.companyIndustry}, ${recipient.companySize} employees, ${recipient.companyRevenue} revenue)\nGoal: ${input.goal}`,
            },
          ],
          {
            type: "object",
            properties: {
              personSummary: { type: "string" },
              companySummary: { type: "string" },
              likelyPainPoints: { type: "array", items: { type: "string" } },
              relevantContext: { type: "string" },
            },
            required: ["personSummary", "companySummary", "likelyPainPoints", "relevantContext"],
            additionalProperties: false,
          },
          { personSummary: "", companySummary: "", likelyPainPoints: [], relevantContext: "" },
        );
        await db.update(researchPipelines).set({ stage1_prospect: stage1, currentStage: 2 }).where(eq(researchPipelines.id, pipelineId));

        /* ── Stage 2: Signal detection ── */
        const stage2 = await llmJson(
          [
            { role: "system", content: "You are a B2B sales intelligence analyst. Output JSON only." },
            {
              role: "user",
              content: `Identify buying signals and triggers for outreach.\nCompany: ${recipient.companyName} (${recipient.companyIndustry})\nContext: ${(stage1 as any).relevantContext}\nGoal: ${input.goal}`,
            },
          ],
          {
            type: "object",
            properties: {
              signals: {
                type: "array",
                items: {
                  type: "object",
                  properties: { signal: { type: "string" }, type: { type: "string" }, relevance: { type: "string" } },
                  required: ["signal", "type", "relevance"],
                  additionalProperties: false,
                },
              },
              bestTimingRationale: { type: "string" },
            },
            required: ["signals", "bestTimingRationale"],
            additionalProperties: false,
          },
          { signals: [], bestTimingRationale: "" },
        );
        await db.update(researchPipelines).set({ stage2_signals: stage2, currentStage: 3 }).where(eq(researchPipelines.id, pipelineId));

        /* ── Stage 3: Angle generation ── */
        const stage3 = await llmJson(
          [
            { role: "system", content: "You are a B2B messaging strategist. Output JSON only." },
            {
              role: "user",
              content: `Generate 3 distinct value-prop angles for this outreach.\nRecipient: ${recipient.personName}, ${recipient.personTitle} at ${recipient.companyName}\nPain points: ${JSON.stringify((stage1 as any).likelyPainPoints)}\nSignals: ${JSON.stringify((stage2 as any).signals?.slice(0, 3))}\nGoal: ${input.goal}`,
            },
          ],
          {
            type: "object",
            properties: {
              angles: {
                type: "array",
                items: {
                  type: "object",
                  properties: { angle: { type: "string" }, hook: { type: "string" }, cta: { type: "string" }, rationale: { type: "string" } },
                  required: ["angle", "hook", "cta", "rationale"],
                  additionalProperties: false,
                },
              },
            },
            required: ["angles"],
            additionalProperties: false,
          },
          { angles: [] },
        );
        await db.update(researchPipelines).set({ stage3_angles: stage3, currentStage: 4 }).where(eq(researchPipelines.id, pipelineId));

        /* ── Stage 4: Draft candidates ── */
        const angles = (stage3 as any).angles ?? [];
        const bestAngle = angles[0] ?? { angle: input.goal, hook: "", cta: "Let's connect", rationale: "" };
        const stage4 = await llmJson(
          [
            {
              role: "system",
              content: `You write short B2B sales emails. Tone: ${input.tone}. Output JSON only. Body max 120 words, plain text, with personalization tokens {{firstName}}, {{company}}, {{senderName}}.`,
            },
            {
              role: "user",
              content: `Write 3 email variants for this outreach.\nRecipient: ${recipient.personName} at ${recipient.companyName}\nAngle: ${bestAngle.angle}\nHook: ${bestAngle.hook}\nCTA: ${bestAngle.cta}\nGoal: ${input.goal}`,
            },
          ],
          {
            type: "object",
            properties: {
              variants: {
                type: "array",
                items: {
                  type: "object",
                  properties: { subject: { type: "string" }, body: { type: "string" }, rationale: { type: "string" } },
                  required: ["subject", "body", "rationale"],
                  additionalProperties: false,
                },
              },
            },
            required: ["variants"],
            additionalProperties: false,
          },
          { variants: [] },
        );
        await db.update(researchPipelines).set({ stage4_draft: stage4, currentStage: 5 }).where(eq(researchPipelines.id, pipelineId));

        /* ── Stage 5: Final selection ── */
        const variants = (stage4 as any).variants ?? [];
        const chosen = variants[0] ?? { subject: "Quick question", body: `Hi {{firstName}},\n\n${input.goal}\n\nBest,\n{{senderName}}`, rationale: "" };
        const stage5 = {
          subject: chosen.subject,
          body: chosen.body,
          rationale: chosen.rationale,
          personalizationTokens: {
            firstName: recipient.personName.split(" ")[0] ?? "there",
            company: recipient.companyName,
            senderName: "{{senderName}}",
          },
          allVariants: variants,
        };

        // Create the email draft
        const draftR = await db.insert(emailDrafts).values({
          workspaceId: ctx.workspace.id,
          subject: stage5.subject,
          body: stage5.body,
          toContactId: input.contactId ?? null,
          toLeadId: input.leadId ?? null,
          toEmail: recipient.personEmail,
          status: "pending_review",
          aiGenerated: true,
          aiPrompt: input.goal,
          createdByUserId: ctx.user.id,
        });
        const draftId = Number((draftR as any)[0]?.insertId ?? 0);

        // Save prompt version history
        await db.insert(promptVersions).values({
          workspaceId: ctx.workspace.id,
          entityType: "email_draft",
          entityId: draftId,
          version: 1,
          subject: stage5.subject,
          body: stage5.body,
          promptUsed: input.goal,
          toneUsed: input.tone,
          createdByUserId: ctx.user.id,
        });

        // Mark pipeline complete
        await db
          .update(researchPipelines)
          .set({ stage5_final: stage5, status: "complete", currentStage: 5, emailDraftId: draftId, completedAt: new Date() })
          .where(eq(researchPipelines.id, pipelineId));

        return { pipelineId, draftId, subject: stage5.subject, body: stage5.body };
      } catch (err: any) {
        await db
          .update(researchPipelines)
          .set({ status: "failed", errorMessage: String(err?.message ?? err) })
          .where(eq(researchPipelines.id, pipelineId));
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Pipeline failed: " + (err?.message ?? "unknown") });
      }
    }),

  /** Get prompt version history for a draft */
  getVersionHistory: workspaceProcedure
    .input(z.object({ emailDraftId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select()
        .from(promptVersions)
        .where(and(eq(promptVersions.entityId, input.emailDraftId), eq(promptVersions.workspaceId, ctx.workspace.id), eq(promptVersions.entityType, "email_draft")))
        .orderBy(desc(promptVersions.version));
    }),
});
