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
 * `start` checks the recipient, creates the pipeline row and returns; the
 * stages run after the response, writing each stage's output to the row as
 * they go, so the page's poll shows progress (audit 2026-10-20, P144: the
 * request used to run every stage before returning). The email_draft row is
 * created at stage 5. A stage whose AI call fails fails the run; no stock
 * draft is saved in its place (P67).
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, lt } from "drizzle-orm";
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
import type { ResearchUse } from "../services/research/context";
import { router } from "../_core/trpc";
import { repProcedure, workspaceProcedure } from "../_core/workspace";

/* ─── helpers ────────────────────────────────────────────────────────────── */

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function getRecipientContext(
  db: Db,
  workspaceId: number,
  opts: { contactId?: number; leadId?: number; accountId?: number },
) {
  let found = false;
  let firstName = "";
  let personName = "";
  let personTitle = "";
  let personEmail: string | null = null;
  let companyName = "";
  let companyIndustry = "";
  let companySize = "";
  let companyRevenue = "";
  let accountId = opts.accountId;

  if (opts.contactId) {
    const [c] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, opts.contactId), eq(contacts.workspaceId, workspaceId)));
    if (c) {
      found = true;
      firstName = c.firstName ?? "";
      personName = `${c.firstName} ${c.lastName}`.trim();
      personTitle = c.title ?? "";
      personEmail = c.email ?? null;
      companyName = c.companyName ?? "";
      // The contact's own company, when the caller named none.
      accountId ??= c.accountId ?? undefined;
    }
  }
  if (opts.leadId) {
    const [l] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, opts.leadId), eq(leads.workspaceId, workspaceId)));
    if (l) {
      found = true;
      firstName = l.firstName ?? "";
      personName = `${l.firstName} ${l.lastName}`.trim();
      personTitle = l.title ?? "";
      personEmail = l.email ?? null;
      companyName = l.company ?? "";
    }
  }
  if (accountId) {
    const [a] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.workspaceId, workspaceId)));
    if (a) {
      companyName = a.name ?? companyName;
      companyIndustry = a.industry ?? companyIndustry;
      companySize = a.employeeBand ?? "";
      companyRevenue = a.revenueBand ?? "";
    }
  }

  return { found, firstName, personName, personTitle, personEmail, companyName, companyIndustry, companySize, companyRevenue };
}

type Recipient = Awaited<ReturnType<typeof getRecipientContext>>;

/** One stage's AI call. A failure throws and fails the run (P67: it used to return an empty fallback). */
async function llmJson<T>(workspaceId: number, stage: string, messages: any[], schema: any, opts?: { sendersBrand?: boolean }, research?: ResearchUse): Promise<T> {
  try {
    const out = await invokeLLM({
      workspaceId,
      messages,
      sendersBrand: opts?.sendersBrand,
      research,
      response_format: {
        type: "json_schema",
        json_schema: { name: "output", strict: true, schema },
      },
    });
    const content = out.choices?.[0]?.message?.content;
    return (typeof content === "string" ? JSON.parse(content) : content) as T;
  } catch (e) {
    throw new Error(`${stage}: the AI call failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * A pipeline still "running" this long after its last write was cut off by a
 * restart: the stages run after the response, in the process that took it.
 */
export const PIPELINE_ORPHAN_MS = 10 * 60_000;

async function failOrphanedPipelines(db: Db, workspaceId: number): Promise<void> {
  await db
    .update(researchPipelines)
    .set({ status: "failed", errorMessage: "Stopped when the server restarted. Run it again." })
    .where(and(
      eq(researchPipelines.workspaceId, workspaceId),
      eq(researchPipelines.status, "running"),
      lt(researchPipelines.updatedAt, new Date(Date.now() - PIPELINE_ORPHAN_MS)),
    ));
}

/** Runs started by this process and not yet finished, so tests can wait for them. */
const inFlight = new Set<Promise<void>>();

export async function __settleResearchPipelines(): Promise<void> {
  while (inFlight.size) await Promise.all(Array.from(inFlight));
}

/**
 * The five stages, after the response. Each writes its output as it finishes;
 * a failure marks the run failed, naming the stage.
 */
async function runStages(
  db: Db,
  input: { workspaceId: number; userId: number; pipelineId: number; recipient: Recipient; contactId?: number; leadId?: number; goal: string; tone: string },
): Promise<void> {
  const { pipelineId, recipient } = input;
  const ws = input.workspaceId;
  const own = and(eq(researchPipelines.id, pipelineId), eq(researchPipelines.workspaceId, ws));
  // The prospect's market research, by their title and industry.
  const marketFor = (surface: "research" | "outreach"): ResearchUse => ({ surface, prospectTitle: recipient.personTitle || null, industry: recipient.companyIndustry || null });

  try {
    /* ── Stage 1: Prospect research ── */
    const stage1 = await llmJson<any>(
      ws,
      "Prospect research",
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
      undefined,
      marketFor("research"),
    );
    await db.update(researchPipelines).set({ stage1_prospect: stage1, currentStage: 2 }).where(own);

    /* ── Stage 2: Signal detection ── */
    const stage2 = await llmJson<any>(
      ws,
      "Signal detection",
      [
        { role: "system", content: "You are a B2B sales intelligence analyst. Output JSON only." },
        {
          role: "user",
          content: `Identify buying signals and triggers for outreach.\nCompany: ${recipient.companyName} (${recipient.companyIndustry})\nContext: ${stage1?.relevantContext ?? ""}\nGoal: ${input.goal}`,
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
      undefined,
      marketFor("research"),
    );
    await db.update(researchPipelines).set({ stage2_signals: stage2, currentStage: 3 }).where(own);

    /* ── Stage 3: Angle generation ── */
    const stage3 = await llmJson<any>(
      ws,
      "Angle generation",
      [
        { role: "system", content: "You are a B2B messaging strategist. Output JSON only." },
        {
          role: "user",
          content: `Generate 3 distinct value-prop angles for this outreach.\nRecipient: ${recipient.personName}, ${recipient.personTitle} at ${recipient.companyName}\nPain points: ${JSON.stringify(stage1?.likelyPainPoints)}\nSignals: ${JSON.stringify(stage2?.signals?.slice(0, 3))}\nGoal: ${input.goal}`,
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
      undefined,
      marketFor("research"),
    );
    await db.update(researchPipelines).set({ stage3_angles: stage3, currentStage: 4 }).where(own);

    /* ── Stage 4: Draft candidates ── */
    const angles = stage3?.angles ?? [];
    const bestAngle = angles[0] ?? { angle: input.goal, hook: "", cta: "Let's connect", rationale: "" };
    const stage4 = await llmJson<any>(
      ws,
      "Draft candidates",
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
      // Stage 4 writes the emails a prospect receives; stages 1-3 are research.
      { sendersBrand: true },
      marketFor("outreach"),
    );
    await db.update(researchPipelines).set({ stage4_draft: stage4, currentStage: 5 }).where(own);

    /* ── Stage 5: Final selection ── */
    const variants: { subject?: string; body?: string; rationale?: string }[] = stage4?.variants ?? [];
    const chosen = variants.find((v) => v?.subject?.trim() && v?.body?.trim());
    // No stock "Quick question" email in place of one the AI did not write (P67).
    if (!chosen) throw new Error("Draft candidates: the AI wrote no email to choose from");
    const stage5 = {
      subject: chosen.subject!,
      body: chosen.body!,
      rationale: chosen.rationale ?? "",
      personalizationTokens: {
        // An empty first name falls back too (P146: split(" ")[0] is "", never undefined).
        firstName: recipient.firstName.trim() || recipient.personName.split(" ")[0] || "there",
        company: recipient.companyName,
        senderName: "{{senderName}}",
      },
      allVariants: variants,
    };

    // Create the email draft
    const draftR = await db.insert(emailDrafts).values({
      workspaceId: ws,
      subject: stage5.subject,
      body: stage5.body,
      toContactId: input.contactId ?? null,
      toLeadId: input.leadId ?? null,
      toEmail: recipient.personEmail,
      status: "pending_review",
      aiGenerated: true,
      aiPrompt: input.goal,
      createdByUserId: input.userId,
    });
    const draftId = Number((draftR as any)[0]?.insertId ?? 0);

    // Save prompt version history
    await db.insert(promptVersions).values({
      workspaceId: ws,
      entityType: "email_draft",
      entityId: draftId,
      version: 1,
      subject: stage5.subject,
      body: stage5.body,
      promptUsed: input.goal,
      toneUsed: input.tone,
      createdByUserId: input.userId,
    });

    // Mark pipeline complete
    await db
      .update(researchPipelines)
      .set({ stage5_final: stage5, status: "complete", currentStage: 5, emailDraftId: draftId, completedAt: new Date() })
      .where(own);
  } catch (err: any) {
    await db
      .update(researchPipelines)
      .set({ status: "failed", errorMessage: String(err?.message ?? err).slice(0, 2000) })
      .where(own);
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
      await failOrphanedPipelines(db, ctx.workspace.id);
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
      await failOrphanedPipelines(db, ctx.workspace.id);
      const [row] = await db
        .select()
        .from(researchPipelines)
        .where(and(eq(researchPipelines.id, input.id), eq(researchPipelines.workspaceId, ctx.workspace.id)));
      return row ?? null;
    }),

  /**
   * Starts a pipeline for one person and returns at once; the stages run after
   * the response (P144). A run needs someone to research and write to (P16:
   * the page sent no recipient, so every stage researched nobody and the draft
   * went to no one).
   */
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
      if (!input.contactId && !input.leadId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Pick the person the email is for." });
      }
      const recipient = await getRecipientContext(db, ctx.workspace.id, {
        contactId: input.contactId,
        leadId: input.leadId,
        accountId: input.accountId,
      });
      if (!recipient.found) throw new TRPCError({ code: "NOT_FOUND", message: "That person is not in this workspace." });
      if (!recipient.personEmail) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${recipient.personName || "This person"} has no email address, so a draft to them could not be sent. Add one first.`,
        });
      }

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

      const run: Promise<void> = runStages(db, { ...input, workspaceId: ctx.workspace.id, userId: ctx.user.id, pipelineId, recipient })
        .catch((e) => console.error(`[researchPipeline] ${pipelineId} crashed:`, e instanceof Error ? e.message : e))
        .finally(() => { inFlight.delete(run); });
      inFlight.add(run);
      return { pipelineId };
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
