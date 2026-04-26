/**
 * ARE — Prospects Router
 *
 * Manages the prospect queue with two embedded AI agents:
 *
 * ENRICH AGENT — for each prospect, runs:
 *   1. ICP match scoring (LLM rates fit against active ICP)
 *   2. Trigger event detection (news, funding, hires, expansions)
 *   3. Pain signal extraction (infers pain from company/role context)
 *   4. Personalisation hook generation (3 specific hooks per prospect)
 *   5. Google Business data enrichment
 *   6. LinkedIn summary generation
 *   7. Recommended channel + timing
 *
 * SEQUENCE AGENT — for each enriched prospect:
 *   1. Generates a personalised multi-step outreach sequence
 *   2. Self-evaluates quality on 4 dimensions (specificity/clarity/brevity/CTA)
 *   3. If score < 28/40, automatically rewrites until threshold met (max 3 attempts)
 *   4. Generates A/B variant with different hook type
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  areAbVariants,
  areCampaigns,
  icpProfiles,
  notifications,
  prospectIntelligence,
  prospectNotes,
  prospectQueue,
  users,
  workspaceMembers,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { invokeLLM } from "../../_core/llm";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";

/* ─── ICP Match Scorer ───────────────────────────────────────────────────── */

async function scoreIcpMatch(
  prospect: typeof prospectQueue.$inferSelect,
  icp: typeof icpProfiles.$inferSelect,
): Promise<{ score: number; breakdown: Record<string, number> }> {
  const result = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a B2B sales qualification expert. Score how well a prospect matches an Ideal Customer Profile (ICP). Return a JSON object with individual dimension scores and a total.`,
      },
      {
        role: "user",
        content: `
## Prospect
- Name: ${prospect.firstName} ${prospect.lastName}
- Title: ${prospect.title ?? "Unknown"}
- Company: ${prospect.companyName ?? "Unknown"}
- Company Size: ${prospect.companySize ?? "Unknown"}
- Industry: ${prospect.industry ?? "Unknown"}
- Geography: ${prospect.geography ?? "Unknown"}

## ICP
- Target Industries: ${JSON.stringify(icp.targetIndustries)}
- Target Company Size: ${icp.targetCompanySizeMin}–${icp.targetCompanySizeMax} employees
- Target Titles: ${JSON.stringify(icp.targetTitles)}
- Target Geographies: ${JSON.stringify(icp.targetGeographies)}
- Anti-patterns: ${JSON.stringify(icp.antiPatterns)}

Score each dimension 0-20 and provide a total score 0-100.
`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "icp_match_score",
        strict: true,
        schema: {
          type: "object",
          properties: {
            industry: { type: "number" },
            title: { type: "number" },
            companySize: { type: "number" },
            geography: { type: "number" },
            antiPatternPenalty: { type: "number" },
            total: { type: "number" },
          },
          required: ["industry", "title", "companySize", "geography", "antiPatternPenalty", "total"],
          additionalProperties: false,
        },
      },
    },
  });

  const content = result.choices[0]?.message?.content;
  if (!content) return { score: 0, breakdown: {} };
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  return {
    score: Math.min(100, Math.max(0, Math.round(parsed.total))),
    breakdown: {
      industry: parsed.industry,
      title: parsed.title,
      companySize: parsed.companySize,
      geography: parsed.geography,
      antiPatternPenalty: parsed.antiPatternPenalty,
    },
  };
}

/* ─── Enrich Agent ───────────────────────────────────────────────────────── */

export async function runEnrichAgent(
  prospectId: number,
  workspaceId: number,
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const [prospect] = await db
    .select()
    .from(prospectQueue)
    .where(and(eq(prospectQueue.id, prospectId), eq(prospectQueue.workspaceId, workspaceId)))
    .limit(1);
  if (!prospect) return;

  // Mark as enriching
  await db.update(prospectQueue).set({ enrichmentStatus: "enriching" }).where(eq(prospectQueue.id, prospectId));

  try {
    // Get active ICP
    const [icp] = await db
      .select()
      .from(icpProfiles)
      .where(and(eq(icpProfiles.workspaceId, workspaceId), eq(icpProfiles.isActive, true)))
      .limit(1);

    // Score ICP match
    let icpMatchScore = 50;
    let icpMatchBreakdown: Record<string, number> = {};
    if (icp) {
      const match = await scoreIcpMatch(prospect, icp);
      icpMatchScore = match.score;
      icpMatchBreakdown = match.breakdown;
    }

    // Run deep enrichment via LLM
    const enrichResult = await invokeLLM({
      messages: [
        {
          role: "system",
          content: `You are a B2B sales intelligence analyst. Produce a comprehensive enrichment dossier for a prospect. Use your knowledge of the company, industry, and role to identify trigger events, pain signals, and personalisation hooks. Be specific and actionable.`,
        },
        {
          role: "user",
          content: `
## Prospect
- Name: ${prospect.firstName} ${prospect.lastName}
- Title: ${prospect.title ?? "Unknown"}
- Company: ${prospect.companyName ?? "Unknown"} (${prospect.companyDomain ?? "unknown domain"})
- Industry: ${prospect.industry ?? "Unknown"}
- Geography: ${prospect.geography ?? "Unknown"}
- Company Size: ${prospect.companySize ?? "Unknown"}
- Source: ${prospect.sourceType} — ${prospect.sourceUrl ?? ""}

Produce:
1. 3 specific trigger events that make this company a good prospect right now
2. 3 specific pain signals based on their industry/size/role combination
3. 3 highly specific personalisation hooks for cold outreach (reference something real about them)
4. Their likely tech stack based on company type
5. 2-3 recent news items about the company (infer from your knowledge)
6. Any industry events they likely attend
7. A 2-sentence LinkedIn summary for this person
8. A 1-sentence company description
9. Recommended outreach channel (email/linkedin/sms/voice) and best timing
`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "prospect_enrichment",
          strict: true,
          schema: {
            type: "object",
            properties: {
              triggerEvents: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    description: { type: "string" },
                    date: { type: "string" },
                    recencyScore: { type: "number" },
                    sourceUrl: { type: "string" },
                  },
                  required: ["type", "description", "date", "recencyScore", "sourceUrl"],
                  additionalProperties: false,
                },
              },
              painSignals: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    signal: { type: "string" },
                    evidence: { type: "string" },
                    strength: { type: "number" },
                    sourceUrl: { type: "string" },
                  },
                  required: ["signal", "evidence", "strength", "sourceUrl"],
                  additionalProperties: false,
                },
              },
              personalisationHooks: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    hook: { type: "string" },
                    source: { type: "string" },
                    hookType: { type: "string" },
                  },
                  required: ["hook", "source", "hookType"],
                  additionalProperties: false,
                },
              },
              techStack: { type: "array", items: { type: "string" } },
              recentNews: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    headline: { type: "string" },
                    url: { type: "string" },
                    date: { type: "string" },
                    sentiment: { type: "string" },
                  },
                  required: ["headline", "url", "date", "sentiment"],
                  additionalProperties: false,
                },
              },
              industryEvents: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    eventName: { type: "string" },
                    date: { type: "string" },
                    role: { type: "string" },
                    url: { type: "string" },
                  },
                  required: ["eventName", "date", "role", "url"],
                  additionalProperties: false,
                },
              },
              linkedinSummary: { type: "string" },
              companyOneLiner: { type: "string" },
              recommendedChannel: { type: "string" },
              recommendedTiming: {
                type: "object",
                properties: {
                  dayOfWeek: { type: "string" },
                  hourOfDay: { type: "number" },
                  timezone: { type: "string" },
                },
                required: ["dayOfWeek", "hourOfDay", "timezone"],
                additionalProperties: false,
              },
              enrichmentConfidence: { type: "number" },
            },
            required: [
              "triggerEvents", "painSignals", "personalisationHooks", "techStack",
              "recentNews", "industryEvents", "linkedinSummary", "companyOneLiner",
              "recommendedChannel", "recommendedTiming", "enrichmentConfidence",
            ],
            additionalProperties: false,
          },
        },
      },
    });

    const enrichContent = enrichResult.choices[0]?.message?.content;
    if (!enrichContent) throw new Error("Enrichment returned no content");
    const enrichData = JSON.parse(typeof enrichContent === "string" ? enrichContent : JSON.stringify(enrichContent));

    // Upsert intelligence record
    const existing = await db
      .select({ id: prospectIntelligence.id })
      .from(prospectIntelligence)
      .where(eq(prospectIntelligence.prospectQueueId, prospectId))
      .limit(1);

    const channelMap: Record<string, "email" | "linkedin" | "sms" | "voice"> = {
      email: "email", linkedin: "linkedin", sms: "sms", voice: "voice",
    };

    const intelligenceData = {
      prospectQueueId: prospectId,
      workspaceId,
      triggerEvents: enrichData.triggerEvents,
      painSignals: enrichData.painSignals,
      personalisationHooks: enrichData.personalisationHooks,
      techStack: enrichData.techStack,
      recentNews: enrichData.recentNews,
      industryEvents: enrichData.industryEvents,
      linkedinSummary: enrichData.linkedinSummary,
      companyOneLiner: enrichData.companyOneLiner,
      recommendedChannel: (channelMap[enrichData.recommendedChannel] ?? "email") as "email" | "linkedin" | "sms" | "voice",
      recommendedTiming: enrichData.recommendedTiming,
      enrichmentConfidence: Math.min(100, Math.max(0, Math.round(enrichData.enrichmentConfidence))),
    };

    if (existing.length > 0) {
      await db.update(prospectIntelligence).set(intelligenceData).where(eq(prospectIntelligence.prospectQueueId, prospectId));
    } else {
      await db.insert(prospectIntelligence).values(intelligenceData);
    }

    // Update prospect with ICP score
    await db.update(prospectQueue).set({
      icpMatchScore,
      icpMatchBreakdown,
      enrichmentStatus: "complete",
      enrichedAt: new Date(),
    }).where(eq(prospectQueue.id, prospectId));

  } catch (err) {
    await db.update(prospectQueue).set({ enrichmentStatus: "failed" }).where(eq(prospectQueue.id, prospectId));
    throw err;
  }
}

/* ─── Sequence Agent ─────────────────────────────────────────────────────── */

async function generateAndEvaluateSequence(
  prospect: typeof prospectQueue.$inferSelect,
  intel: typeof prospectIntelligence.$inferSelect,
  campaign: typeof areCampaigns.$inferSelect,
  variantKey: "A" | "B",
): Promise<{ steps: unknown[]; qualityScore: number; breakdown: Record<string, number> }> {
  const hooks = (intel.personalisationHooks as Array<{ hook: string; source: string; hookType: string }>) ?? [];
  const triggerEvents = (intel.triggerEvents as Array<{ type: string; description: string }>) ?? [];
  const painSignals = (intel.painSignals as Array<{ signal: string; evidence: string }>) ?? [];

  // Pick different hooks for A vs B
  const primaryHook = variantKey === "A"
    ? (hooks[0]?.hook ?? triggerEvents[0]?.description ?? "your company's growth")
    : (triggerEvents[0]?.description ?? hooks[1]?.hook ?? painSignals[0]?.signal ?? "a challenge in your space");

  const sequencePrompt = `
## Prospect
- Name: ${prospect.firstName} ${prospect.lastName}
- Title: ${prospect.title ?? "Unknown"}
- Company: ${prospect.companyName ?? "Unknown"}
- Industry: ${prospect.industry ?? "Unknown"}
- Company One-liner: ${intel.companyOneLiner ?? ""}
- LinkedIn Summary: ${intel.linkedinSummary ?? ""}

## Primary Hook (${variantKey === "A" ? "personalisation" : "trigger event"})
${primaryHook}

## Pain Signals
${painSignals.slice(0, 2).map((p) => `- ${p.signal}: ${p.evidence}`).join("\n")}

## Campaign Goal
${campaign.goalType === "meeting_booked" ? "Book a 15-minute discovery call" : campaign.goalType === "reply" ? "Get a reply to start a conversation" : "Create an opportunity in the pipeline"}

## Channels Enabled
${JSON.stringify(campaign.channelsEnabled)}

Generate a ${campaign.sequenceTemplate === "standard_7step" ? "7-step" : "5-step"} outreach sequence. Each step must be highly personalised, reference the hook, and feel like it was written by a human who did their research. Avoid generic phrases like "I hope this finds you well" or "I wanted to reach out". Be direct, specific, and brief.
`;

  const seqResult = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are an elite B2B sales copywriter. Write cold outreach sequences that feel warm, specific, and human. Every message must reference something real about the prospect. Never use generic opener phrases.`,
      },
      { role: "user", content: sequencePrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "outreach_sequence",
        strict: true,
        schema: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  stepIndex: { type: "number" },
                  day: { type: "number" },
                  channel: { type: "string" },
                  subject: { type: "string" },
                  body: { type: "string" },
                  variantKey: { type: "string" },
                },
                required: ["stepIndex", "day", "channel", "subject", "body", "variantKey"],
                additionalProperties: false,
              },
            },
          },
          required: ["steps"],
          additionalProperties: false,
        },
      },
    },
  });

  const seqContent = seqResult.choices[0]?.message?.content;
  if (!seqContent) return { steps: [], qualityScore: 0, breakdown: {} };
  const seqData = JSON.parse(typeof seqContent === "string" ? seqContent : JSON.stringify(seqContent));

  // Self-evaluation pass
  const evalResult = await invokeLLM({
    messages: [
      {
        role: "system",
        content: `You are a cold email quality evaluator. Score the sequence on 4 dimensions, each 0-10. Be strict — generic phrases, lack of personalisation, or weak CTAs should score low.`,
      },
      {
        role: "user",
        content: `Evaluate this outreach sequence:\n\n${JSON.stringify(seqData.steps, null, 2)}\n\nScore each dimension 0-10:\n1. Specificity: Does it reference specific, verifiable facts about the prospect?\n2. Clarity: Is the value proposition clear and compelling?\n3. Brevity: Are messages appropriately short (under 150 words for email)?\n4. CTA: Is the call-to-action clear, low-friction, and appropriate for the goal?`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "sequence_quality",
        strict: true,
        schema: {
          type: "object",
          properties: {
            specificity: { type: "number" },
            clarity: { type: "number" },
            brevity: { type: "number" },
            cta: { type: "number" },
            totalScore: { type: "number" },
            feedback: { type: "string" },
          },
          required: ["specificity", "clarity", "brevity", "cta", "totalScore", "feedback"],
          additionalProperties: false,
        },
      },
    },
  });

  const evalContent = evalResult.choices[0]?.message?.content;
  if (!evalContent) return { steps: seqData.steps, qualityScore: 0, breakdown: {} };
  const evalData = JSON.parse(typeof evalContent === "string" ? evalContent : JSON.stringify(evalContent));

  return {
    steps: seqData.steps,
    qualityScore: Math.min(40, Math.max(0, Math.round(evalData.totalScore))),
    breakdown: {
      specificity: evalData.specificity,
      clarity: evalData.clarity,
      brevity: evalData.brevity,
      cta: evalData.cta,
    },
  };
}

export async function runSequenceAgent(prospectId: number, workspaceId: number, campaignId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const [prospect] = await db.select().from(prospectQueue).where(eq(prospectQueue.id, prospectId)).limit(1);
  const [intel] = await db.select().from(prospectIntelligence).where(eq(prospectIntelligence.prospectQueueId, prospectId)).limit(1);
  const [campaign] = await db.select().from(areCampaigns).where(eq(areCampaigns.id, campaignId)).limit(1);
  if (!prospect || !intel || !campaign) return;

  const QUALITY_THRESHOLD = 28;
  const MAX_REWRITES = 3;

  let bestResult = await generateAndEvaluateSequence(prospect, intel, campaign, "A");
  let rewriteCount = 0;

  // Auto-rewrite loop until quality threshold met
  while (bestResult.qualityScore < QUALITY_THRESHOLD && rewriteCount < MAX_REWRITES) {
    rewriteCount++;
    const retry = await generateAndEvaluateSequence(prospect, intel, campaign, "A");
    if (retry.qualityScore > bestResult.qualityScore) {
      bestResult = retry;
    }
  }

  // Generate B variant with different hook
  const variantB = await generateAndEvaluateSequence(prospect, intel, campaign, "B");

  // Save to intelligence record
  await db.update(prospectIntelligence).set({
    generatedSequence: bestResult.steps,
    sequenceQualityScore: bestResult.qualityScore,
    sequenceQualityBreakdown: bestResult.breakdown,
    sequenceRewriteCount: rewriteCount,
  }).where(eq(prospectIntelligence.prospectQueueId, prospectId));

  // Save A/B variants
  const variantASteps = bestResult.steps as Array<{ stepIndex: number; subject?: string; body: string }>;
  const variantBSteps = variantB.steps as Array<{ stepIndex: number; subject?: string; body: string }>;

  if (variantASteps.length > 0) {
    await db.insert(areAbVariants).values({
      workspaceId,
      campaignId,
      stepIndex: 1,
      variantKey: "A",
      hookType: "personalisation",
      subjectLine: variantASteps[0]?.subject ?? "",
      bodyPreview: String(variantASteps[0]?.body ?? "").substring(0, 300),
    }).onDuplicateKeyUpdate({
      set: {
        subjectLine: variantASteps[0]?.subject ?? "",
        bodyPreview: String(variantASteps[0]?.body ?? "").substring(0, 300),
      },
    });
  }

  if (variantBSteps.length > 0) {
    await db.insert(areAbVariants).values({
      workspaceId,
      campaignId,
      stepIndex: 1,
      variantKey: "B",
      hookType: "trigger_event",
      subjectLine: variantBSteps[0]?.subject ?? "",
      bodyPreview: String(variantBSteps[0]?.body ?? "").substring(0, 300),
    }).onDuplicateKeyUpdate({
      set: {
        subjectLine: variantBSteps[0]?.subject ?? "",
        bodyPreview: String(variantBSteps[0]?.body ?? "").substring(0, 300),
      },
    });
  }
}

/* ─── Router ─────────────────────────────────────────────────────────────── */

export const prospectsRouter = router({
  list: workspaceProcedure
    .input(
      z.object({
        campaignId: z.number(),
        enrichmentStatus: z.string().optional(),
        sequenceStatus: z.string().optional(),
        minIcpScore: z.number().optional(),
        limit: z.number().default(50),
        offset: z.number().default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const conditions = [
        eq(prospectQueue.workspaceId, ctx.workspace.id),
        eq(prospectQueue.campaignId, input.campaignId),
      ];
      if (input.enrichmentStatus) {
        conditions.push(eq(prospectQueue.enrichmentStatus, input.enrichmentStatus as "pending" | "enriching" | "complete" | "failed"));
      }
      if (input.sequenceStatus) {
        conditions.push(eq(prospectQueue.sequenceStatus, input.sequenceStatus as "pending" | "approved" | "enrolled" | "skipped" | "completed" | "replied"));
      }
      const rows = await db
        .select()
        .from(prospectQueue)
        .where(and(...conditions))
        .orderBy(desc(prospectQueue.icpMatchScore))
        .limit(input.limit)
        .offset(input.offset);
      return rows;
    }),

  getIntelligence: workspaceProcedure
    .input(z.object({ prospectId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [intel] = await db
        .select()
        .from(prospectIntelligence)
        .where(and(eq(prospectIntelligence.prospectQueueId, input.prospectId), eq(prospectIntelligence.workspaceId, ctx.workspace.id)))
        .limit(1);
      return intel ?? null;
    }),

  /** Trigger enrichment for a single prospect */
  enrich: workspaceProcedure
    .input(z.object({ prospectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      // Run async — don't await to avoid timeout
      runEnrichAgent(input.prospectId, ctx.workspace.id).catch(console.error);
      return { started: true };
    }),

  /** Trigger enrichment for all pending prospects in a campaign */
  enrichBatch: workspaceProcedure
    .input(z.object({ campaignId: z.number(), limit: z.number().default(20) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const pending = await db
        .select({ id: prospectQueue.id })
        .from(prospectQueue)
        .where(
          and(
            eq(prospectQueue.campaignId, input.campaignId),
            eq(prospectQueue.workspaceId, ctx.workspace.id),
            eq(prospectQueue.enrichmentStatus, "pending"),
          ),
        )
        .limit(input.limit);

      // Fire and forget
      for (const p of pending) {
        runEnrichAgent(p.id, ctx.workspace.id).catch(console.error);
      }
      return { started: pending.length };
    }),

  /** Generate sequence for a single enriched prospect */
  generateSequence: workspaceProcedure
    .input(z.object({ prospectId: z.number(), campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      runSequenceAgent(input.prospectId, ctx.workspace.id, input.campaignId).catch(console.error);
      return { started: true };
    }),

  approve: workspaceProcedure
    .input(z.object({ prospectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(prospectQueue).set({
        sequenceStatus: "approved",
        approvedAt: new Date(),
        approvedByUserId: ctx.user.id,
      }).where(and(eq(prospectQueue.id, input.prospectId), eq(prospectQueue.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),

  skip: workspaceProcedure
    .input(z.object({ prospectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(prospectQueue).set({ sequenceStatus: "skipped" })
        .where(and(eq(prospectQueue.id, input.prospectId), eq(prospectQueue.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),

  /** Edit a specific step in the generated sequence */
  editSequenceStep: workspaceProcedure
    .input(z.object({
      prospectId: z.number(),
      stepIndex: z.number(),
      subject: z.string().optional(),
      body: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [intel] = await db
        .select()
        .from(prospectIntelligence)
        .where(and(eq(prospectIntelligence.prospectQueueId, input.prospectId), eq(prospectIntelligence.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!intel) throw new TRPCError({ code: "NOT_FOUND" });

      const steps = (intel.generatedSequence as Array<Record<string, unknown>>) ?? [];
      const updated = steps.map((s) =>
        s.stepIndex === input.stepIndex
          ? { ...s, subject: input.subject ?? s.subject, body: input.body }
          : s,
      );
      await db.update(prospectIntelligence).set({ generatedSequence: updated })
        .where(eq(prospectIntelligence.prospectQueueId, input.prospectId));
      return { success: true };
    }),

  /** Get A/B variant performance for a campaign */
  getAbVariants: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return db
        .select()
        .from(areAbVariants)
        .where(and(eq(areAbVariants.campaignId, input.campaignId), eq(areAbVariants.workspaceId, ctx.workspace.id)))
        .orderBy(areAbVariants.stepIndex, areAbVariants.variantKey);
    }),

  /** Add a prospect manually */
  addManual: workspaceProcedure
    .input(z.object({
      campaignId: z.number(),
      firstName: z.string(),
      lastName: z.string(),
      email: z.string().email().optional(),
      linkedinUrl: z.string().optional(),
      phone: z.string().optional(),
      title: z.string().optional(),
      companyName: z.string().optional(),
      companyDomain: z.string().optional(),
      companySize: z.string().optional(),
      industry: z.string().optional(),
      geography: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { campaignId, ...rest } = input;
      const [row] = await db.insert(prospectQueue).values({
        workspaceId: ctx.workspace.id,
        campaignId,
        sourceType: "ai_research",
        ...rest,
        icpMatchScore: 0,
        enrichmentStatus: "pending",
        sequenceStatus: "pending",
      }).$returningId();
      return { id: row.id };
    }),
  /** Reject a prospect with an optional reason */
  reject: workspaceProcedure
    .input(z.object({ prospectId: z.number(), reason: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(prospectQueue).set({
        sequenceStatus: "skipped",
        rejectedAt: new Date(),
        rejectedByUserId: ctx.user.id,
        rejectionReason: input.reason ?? null,
      }).where(and(eq(prospectQueue.id, input.prospectId), eq(prospectQueue.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),

  /** Bulk approve a list of prospects */
  bulkApprove: workspaceProcedure
    .input(z.object({ prospectIds: z.array(z.number()).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      let approved = 0;
      for (const id of input.prospectIds) {
        const result = await db.update(prospectQueue).set({
          sequenceStatus: "approved",
          approvedAt: new Date(),
          approvedByUserId: ctx.user.id,
        }).where(and(
          eq(prospectQueue.id, id),
          eq(prospectQueue.workspaceId, ctx.workspace.id),
          eq(prospectQueue.sequenceStatus, "pending"),
        ));
        if ((result[0] as any).affectedRows > 0) approved++;
      }
      return { approved };
    }),

  /** Bulk reject a list of prospects with an optional shared reason */
  bulkReject: workspaceProcedure
    .input(z.object({ prospectIds: z.array(z.number()).min(1).max(200), reason: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      let rejected = 0;
      for (const id of input.prospectIds) {
        const result = await db.update(prospectQueue).set({
          sequenceStatus: "skipped",
          rejectedAt: new Date(),
          rejectedByUserId: ctx.user.id,
          rejectionReason: input.reason ?? null,
        }).where(and(
          eq(prospectQueue.id, id),
          eq(prospectQueue.workspaceId, ctx.workspace.id),
        ));
        if ((result[0] as any).affectedRows > 0) rejected++;
      }
      return { rejected };
    }),

  /** Add a note to a prospect */
  addNote: workspaceProcedure
    .input(z.object({
      prospectId: z.number(),
      campaignId: z.number().optional(),
      body: z.string().min(1).max(4000),
      category: z.enum(["general", "qualification", "objection", "follow_up", "intel"]).optional().default("general"),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db.insert(prospectNotes).values({
        workspaceId: ctx.workspace.id,
        prospectQueueId: input.prospectId,
        userId: ctx.user.id,
        body: input.body,
        category: input.category ?? "general",
        isPinned: false,
      }).$returningId();
      // Parse @mentions and fire in-app mention notifications
      const mentionRegex = /@([\w.\- ]+)/g;
      const mentionedNames: string[] = [];
      let mm: RegExpExecArray | null;
      while ((mm = mentionRegex.exec(input.body)) !== null) {
        mentionedNames.push(mm[1].trim().toLowerCase());
      }
      if (mentionedNames.length > 0) {
        const members = await db
          .select({ userId: users.id, name: users.name })
          .from(workspaceMembers)
          .innerJoin(users, eq(workspaceMembers.userId, users.id))
          .where(eq(workspaceMembers.workspaceId, ctx.workspace.id));
        const mentionedUserIds = members
          .filter((mem) =>
            mentionedNames.some((mn) =>
              (mem.name ?? "").toLowerCase().includes(mn) ||
              mn.includes((mem.name ?? "").toLowerCase())
            )
          )
          .map((mem) => mem.userId)
          .filter((uid) => uid !== ctx.user.id);
        if (mentionedUserIds.length > 0) {
          // Encode campaignId + prospectId in the body as a JSON prefix so the Inbox can deep-link
          const deepLinkMeta = input.campaignId
            ? `{"campaignId":${input.campaignId},"prospectId":${input.prospectId}}\n`
            : "";
          await db.insert(notifications).values(
            mentionedUserIds.map((uid) => ({
              workspaceId: ctx.workspace.id,
              userId: uid,
              kind: "mention" as const,
              title: `${ctx.user.name ?? "Someone"} mentioned you in a prospect note`,
              body: deepLinkMeta + input.body.slice(0, 240),
              relatedType: "prospect_note",
              relatedId: row.id,
            }))
          );
        }
      }
      return { id: row.id };
    }),

  /** Edit a note body (only the author can edit) */
  editNote: workspaceProcedure
    .input(z.object({
      noteId: z.number(),
      body: z.string().min(1).max(4000),
      category: z.enum(["general", "qualification", "objection", "follow_up", "intel"]).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [note] = await db.select().from(prospectNotes)
        .where(and(eq(prospectNotes.id, input.noteId), eq(prospectNotes.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!note) throw new TRPCError({ code: "NOT_FOUND" });
      if (note.userId !== ctx.user.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the note author can edit notes." });
      }
      const patch: Record<string, unknown> = { body: input.body, editedAt: new Date() };
      if (input.category) patch.category = input.category;
      await db.update(prospectNotes).set(patch)
        .where(and(eq(prospectNotes.id, input.noteId), eq(prospectNotes.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),
  /** List notes for a prospect, pinned first */
  listNotes: workspaceProcedure
    .input(z.object({ prospectId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return db.select().from(prospectNotes)
        .where(and(
          eq(prospectNotes.prospectQueueId, input.prospectId),
          eq(prospectNotes.workspaceId, ctx.workspace.id),
        ))
        .orderBy(desc(prospectNotes.isPinned), desc(prospectNotes.createdAt));
    }),

  /** Delete a note (only the author or workspace admin can delete) */
  deleteNote: workspaceProcedure
    .input(z.object({ noteId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [note] = await db.select().from(prospectNotes)
        .where(and(eq(prospectNotes.id, input.noteId), eq(prospectNotes.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!note) throw new TRPCError({ code: "NOT_FOUND" });
      if (note.userId !== ctx.user.id && ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only the note author or an admin can delete notes." });
      }
      await db.delete(prospectNotes).where(eq(prospectNotes.id, input.noteId));
      return { success: true };
    }),

  /** Toggle pin on a note */
  pinNote: workspaceProcedure
    .input(z.object({ noteId: z.number(), isPinned: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.update(prospectNotes).set({ isPinned: input.isPinned })
        .where(and(eq(prospectNotes.id, input.noteId), eq(prospectNotes.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),
  /** Rejection analytics — top reasons and counts for a campaign */
  getRejectionStats: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { total: 0, byReason: [] };
      const rejected = await db.select({
        id: prospectQueue.id,
        companyName: prospectQueue.companyName,
        contactName: prospectQueue.contactName,
        contactTitle: prospectQueue.contactTitle,
        rejectionReason: prospectQueue.rejectionReason,
        rejectedAt: prospectQueue.rejectedAt,
      })
        .from(prospectQueue)
        .where(and(
          eq(prospectQueue.campaignId, input.campaignId),
          eq(prospectQueue.workspaceId, ctx.workspace.id),
          eq(prospectQueue.sequenceStatus, "skipped"),
        ))
        .orderBy(desc(prospectQueue.rejectedAt));
      // Aggregate by reason
      const reasonMap = new Map<string, number>();
      for (const p of rejected) {
        const key = p.rejectionReason?.trim() || "No reason given";
        reasonMap.set(key, (reasonMap.get(key) ?? 0) + 1);
      }
      const byReason = Array.from(reasonMap.entries())
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
      return { total: rejected.length, byReason, items: rejected };
    }),

  exportRejections: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { csv: "" };
      const rejected = await db.select({
        id: prospectQueue.id,
        firstName: prospectQueue.firstName,
        lastName: prospectQueue.lastName,
        contactTitle: prospectQueue.contactTitle,
        companyName: prospectQueue.companyName,
        industry: prospectQueue.industry,
        geography: prospectQueue.geography,
        companySize: prospectQueue.companySize,
        email: prospectQueue.email,
        linkedinUrl: prospectQueue.linkedinUrl,
        icpMatchScore: prospectQueue.icpMatchScore,
        rejectionReason: prospectQueue.rejectionReason,
        rejectedAt: prospectQueue.rejectedAt,
        sourceType: prospectQueue.sourceType,
      })
        .from(prospectQueue)
        .where(and(
          eq(prospectQueue.campaignId, input.campaignId),
          eq(prospectQueue.workspaceId, ctx.workspace.id),
          eq(prospectQueue.sequenceStatus, "skipped"),
        ))
        .orderBy(desc(prospectQueue.rejectedAt));
      const escape = (v: unknown) => {
        if (v == null) return "";
        const s = String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const headers = [
        "ID","First Name","Last Name","Title","Company","Industry","Geography",
        "Company Size","Email","LinkedIn URL","ICP Match Score","Rejection Reason","Rejected At","Source",
      ];
      const rows = rejected.map((r) => [
        r.id, r.firstName, r.lastName, r.contactTitle, r.companyName, r.industry,
        r.geography, r.companySize, r.email, r.linkedinUrl, r.icpMatchScore,
        r.rejectionReason, r.rejectedAt ? new Date(r.rejectedAt).toISOString() : "", r.sourceType,
      ].map(escape).join(","));
      return { csv: [headers.join(","), ...rows].join("\n"), count: rejected.length };
    }),

  reEvaluate: workspaceProcedure
    .input(z.object({ prospectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const [prospect] = await db
        .select()
        .from(prospectQueue)
        .where(and(
          eq(prospectQueue.id, input.prospectId),
          eq(prospectQueue.workspaceId, ctx.workspace.id),
        ))
        .limit(1);
      if (!prospect) throw new TRPCError({ code: "NOT_FOUND", message: "Prospect not found" });
      // Get latest active ICP
      const [icp] = await db
        .select()
        .from(icpProfiles)
        .where(and(eq(icpProfiles.workspaceId, ctx.workspace.id), eq(icpProfiles.isActive, true)))
        .limit(1);
      if (!icp) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active ICP profile" });
      const match = await scoreIcpMatch(prospect, icp);
      const autoApproveThreshold = 70; // fallback default
      const newStatus = match.score >= autoApproveThreshold ? "pending" : "skipped";
      await db.update(prospectQueue).set({
        icpMatchScore: match.score,
        icpMatchBreakdown: JSON.stringify(match.breakdown),
        sequenceStatus: newStatus,
        rejectedAt: newStatus === "pending" ? null : prospect.rejectedAt,
        rejectionReason: newStatus === "pending" ? null : prospect.rejectionReason,
      }).where(eq(prospectQueue.id, input.prospectId));
      return { newScore: match.score, newStatus, breakdown: match.breakdown };
    }),

  getWorkspaceMembers: workspaceProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return [];
      return db
        .select({
          userId: users.id,
          name: users.name,
          avatarUrl: users.avatarUrl,
          title: workspaceMembers.title,
        })
        .from(workspaceMembers)
        .innerJoin(users, eq(workspaceMembers.userId, users.id))
        .where(and(
          eq(workspaceMembers.workspaceId, ctx.workspace.id),
        ))
        .orderBy(users.name);
    }),

  reEvaluateAll: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      // Get the campaign to read its actual autoApproveThreshold
      const [campaign] = await db
        .select({ autoApproveThreshold: areCampaigns.autoApproveThreshold })
        .from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.campaignId), eq(areCampaigns.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      // Get latest active ICP
      const [icp] = await db
        .select()
        .from(icpProfiles)
        .where(and(eq(icpProfiles.workspaceId, ctx.workspace.id), eq(icpProfiles.isActive, true)))
        .limit(1);
      if (!icp) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active ICP profile" });
      // Fetch all rejected (skipped) prospects for this campaign
      const rejected = await db
        .select()
        .from(prospectQueue)
        .where(and(
          eq(prospectQueue.campaignId, input.campaignId),
          eq(prospectQueue.workspaceId, ctx.workspace.id),
          eq(prospectQueue.sequenceStatus, "skipped"),
        ));
      if (rejected.length === 0) return { processed: 0, requalified: 0, threshold: campaign.autoApproveThreshold ?? 70 };
      // Use the campaign's actual threshold (fallback 70 if not set)
      const autoApproveThreshold = campaign.autoApproveThreshold ?? 70;
      let requalified = 0;
      for (const prospect of rejected) {
        try {
          const match = await scoreIcpMatch(prospect, icp);
          const newStatus = match.score >= autoApproveThreshold ? "pending" : "skipped";
          if (newStatus === "pending") requalified++;
          await db.update(prospectQueue).set({
            icpMatchScore: match.score,
            icpMatchBreakdown: JSON.stringify(match.breakdown),
            sequenceStatus: newStatus,
            rejectedAt: newStatus === "pending" ? null : prospect.rejectedAt,
            rejectionReason: newStatus === "pending" ? null : prospect.rejectionReason,
          }).where(eq(prospectQueue.id, prospect.id));
        } catch (e) {
          console.error("[reEvaluateAll] Failed for prospect", prospect.id, e);
        }
      }
      return { processed: rejected.length, requalified, threshold: autoApproveThreshold };
    }),
});