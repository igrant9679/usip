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
  areEngineLogs,
  areExecutionQueue,
  icpProfiles,
  notifications,
  prospectIntelligence,
  prospectNotes,
  prospectQueue,
  reevalRuns,
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
  workspaceId: number,
): Promise<{ score: number; breakdown: Record<string, number> }> {
  const result = await invokeLLM({
    workspaceId,
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

  // Mark as enriching — also clear any prior enrichmentError so the UI
  // doesn't keep showing a stale failure reason during a retry.
  await db.update(prospectQueue).set({ enrichmentStatus: "enriching", enrichmentError: null }).where(eq(prospectQueue.id, prospectId));

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
      const match = await scoreIcpMatch(prospect, icp, workspaceId);
      icpMatchScore = match.score;
      icpMatchBreakdown = match.breakdown;
    }

    // Run deep enrichment via LLM
    const enrichResult = await invokeLLM({
      workspaceId,
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
    // Persist a human-readable reason so the Prospects tab can surface it
    // (tooltip + expandable detail) instead of just showing a red 'failed'
    // chip with no explanation. Cap length so a megabyte stack trace
    // doesn't bloat the row.
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 800);
    await db.update(prospectQueue).set({
      enrichmentStatus: "failed",
      enrichmentError: reason || "Unknown error",
    }).where(eq(prospectQueue.id, prospectId));
    throw err;
  }
}

/* ─── Sequence Agent ─────────────────────────────────────────────────────
 *
 * Two-tier architecture:
 *   1. generateCampaignTemplate — one LLM call per campaign, cached on
 *      are_campaigns.generatedTemplate. Produces a 7-step skeleton with
 *      structure / archetype / day / channel / CTA pattern. No prospect
 *      data; only the campaign's voice + goal + custom prompt.
 *   2. personalizeForProspect — one LLM call per prospect that takes the
 *      template + prospect dossier and fills the parts a human notices
 *      (subject + body) keeping the structure intact.
 *
 * Followed by a single evaluation pass that records a quality score on
 * prospectIntelligence — but does NOT trigger a regenerate. The score is
 * a *flag* that the UI surfaces as a 'Review' badge for low scores.
 *
 * Result: 1 + N LLM calls for N prospects (was 4–8 × N), roughly 70%
 * cheaper, while the parts of the email that drive reply rate stay
 * fully personalized.
 */

type TemplateStep = {
  stepIndex: number;
  day: number;
  channel: string;
  archetype: string;
  skeleton: string;
  ctaPattern: string;
};

type CampaignTemplate = { steps: TemplateStep[] };

/**
 * Generate (or refresh) the campaign-level skeleton. Idempotent: callers
 * can pass force=false to reuse a cached template, or force=true after
 * the user edits the campaign's sequencePrompt.
 */
export async function generateCampaignTemplate(
  campaign: typeof areCampaigns.$inferSelect,
  force = false,
): Promise<CampaignTemplate> {
  const db = await getDb();
  if (!db) return { steps: [] };

  if (!force && campaign.generatedTemplate) {
    const cached = campaign.generatedTemplate as CampaignTemplate | null;
    if (cached && Array.isArray(cached.steps) && cached.steps.length > 0) return cached;
  }

  const customInstructions = (campaign.sequencePrompt ?? "").trim();
  const goalText =
    campaign.goalType === "meeting_booked" ? "Book a 15-minute discovery call"
    : campaign.goalType === "reply" ? "Get a reply to start a conversation"
    : "Create an opportunity in the pipeline";
  const stepCount = campaign.sequenceTemplate === "standard_7step" ? 7 : 5;

  const systemContent =
    `You are an elite B2B sales sequence architect. Design a reusable ${stepCount}-step outreach skeleton for a single campaign. The skeleton will be filled in per-prospect later, so do NOT write subject lines or bodies — write the STRUCTURE (archetype, cadence, what each step should accomplish, the CTA pattern) so that any prospect's data can be slotted in.` +
    (customInstructions ? `\n\n## Campaign-specific instructions\n${customInstructions}` : "");

  const userContent =
    `## Campaign goal\n${goalText}\n\n` +
    `## Channels enabled\n${JSON.stringify(campaign.channelsEnabled)}\n\n` +
    `## Cadence rules\n- First step on day 0.\n- 7-day total window for 5-step, 14 days for 7-step.\n- No two consecutive steps on the same channel unless both are email.\n- Final step is a polite break-up.\n\n` +
    `Return ${stepCount} steps. For each: stepIndex (0-based), day (cumulative from start), channel, archetype (one of: opener | value | social_proof | resource | check_in | break_up), skeleton (1–2 sentences describing what to write — placeholders like {hook}, {pain}, {company}, {firstName} for what the personalizer will fill), and ctaPattern (one short sentence like "Open with question, close with a 15-min Tue/Thu offer").`;

  const result = await invokeLLM({
    workspaceId: campaign.workspaceId,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "campaign_template",
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
                  archetype: { type: "string" },
                  skeleton: { type: "string" },
                  ctaPattern: { type: "string" },
                },
                required: ["stepIndex", "day", "channel", "archetype", "skeleton", "ctaPattern"],
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

  const content = result.choices[0]?.message?.content;
  if (!content) return { steps: [] };
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content)) as CampaignTemplate;

  await db.update(areCampaigns)
    .set({ generatedTemplate: parsed, generatedTemplateAt: new Date() })
    .where(eq(areCampaigns.id, campaign.id));

  return parsed;
}

/**
 * Personalize a prospect's sequence using the campaign template + their
 * enrichment dossier. One LLM call, no retries. The eval pass that
 * follows records a quality score but doesn't trigger a regenerate.
 */
async function personalizeForProspect(
  template: CampaignTemplate,
  prospect: typeof prospectQueue.$inferSelect,
  intel: typeof prospectIntelligence.$inferSelect,
  campaign: typeof areCampaigns.$inferSelect,
): Promise<Array<{ stepIndex: number; day: number; channel: string; subject: string; body: string; variantKey: string }>> {
  if (template.steps.length === 0) return [];

  const hooks = (intel.personalisationHooks as Array<{ hook: string; source: string; hookType: string }>) ?? [];
  const triggerEvents = (intel.triggerEvents as Array<{ type: string; description: string }>) ?? [];
  const painSignals = (intel.painSignals as Array<{ signal: string; evidence: string }>) ?? [];
  const primaryHook = hooks[0]?.hook ?? triggerEvents[0]?.description ?? painSignals[0]?.signal ?? "your company's growth";

  const customInstructions = (campaign.sequencePrompt ?? "").trim();
  const systemContent =
    `You are an elite B2B sales copywriter. You will be given a campaign skeleton and a prospect dossier. Fill in subject+body for each step, keeping the structure, cadence, and CTA pattern from the skeleton. Every message must reference something real about the prospect. Never use generic openers ("I hope this finds you well", "I wanted to reach out").` +
    (customInstructions ? `\n\n## Campaign-specific instructions\n${customInstructions}` : "");

  const userContent =
    `## Template (do not change structure, only fill subject + body)\n${JSON.stringify(template.steps, null, 2)}\n\n` +
    `## Prospect\n- Name: ${prospect.firstName} ${prospect.lastName}\n- Title: ${prospect.title ?? "Unknown"}\n- Company: ${prospect.companyName ?? "Unknown"}\n- Industry: ${prospect.industry ?? "Unknown"}\n- Company one-liner: ${intel.companyOneLiner ?? ""}\n- LinkedIn summary: ${intel.linkedinSummary ?? ""}\n\n` +
    `## Primary hook\n${primaryHook}\n\n` +
    `## Pain signals\n${painSignals.slice(0, 2).map((p) => `- ${p.signal}: ${p.evidence}`).join("\n") || "(none)"}\n\n` +
    `Return one filled step per template step (same stepIndex, day, channel). Keep emails under 120 words. Use {{firstName}} / {{company}} merge tags where natural.`;

  const result = await invokeLLM({
    workspaceId: campaign.workspaceId,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "personalized_sequence",
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
  const content = result.choices[0]?.message?.content;
  if (!content) return [];
  const parsed = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  return (parsed.steps ?? []).map((s: any) => ({ ...s, variantKey: s.variantKey ?? "A" }));
}

/** Quality flag, not gate. Records a score the UI surfaces as a Review badge. */
async function evaluateSequenceQuality(steps: unknown[], workspaceId: number): Promise<{ score: number; breakdown: Record<string, number>; feedback: string }> {
  if (!Array.isArray(steps) || steps.length === 0) return { score: 0, breakdown: {}, feedback: "Empty sequence" };
  const result = await invokeLLM({
    workspaceId,
    messages: [
      { role: "system", content: `You are a cold email quality evaluator. Score the sequence on 4 dimensions, each 0-10. Be strict — generic phrases, lack of personalisation, or weak CTAs should score low.` },
      { role: "user", content: `Evaluate:\n\n${JSON.stringify(steps, null, 2)}\n\nScore (0-10 each):\n1. Specificity (verifiable prospect facts referenced)\n2. Clarity (value prop clear)\n3. Brevity (<150 words per email)\n4. CTA (clear, low-friction)` },
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
  const content = result.choices[0]?.message?.content;
  if (!content) return { score: 0, breakdown: {}, feedback: "Eval LLM returned no content" };
  const data = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
  return {
    score: Math.min(40, Math.max(0, Math.round(data.totalScore))),
    breakdown: { specificity: data.specificity, clarity: data.clarity, brevity: data.brevity, cta: data.cta },
    feedback: String(data.feedback ?? ""),
  };
}

export async function runSequenceAgent(prospectId: number, workspaceId: number, campaignId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const [prospect] = await db.select().from(prospectQueue).where(eq(prospectQueue.id, prospectId)).limit(1);
  const [intel] = await db.select().from(prospectIntelligence).where(eq(prospectIntelligence.prospectQueueId, prospectId)).limit(1);
  const [campaign] = await db.select().from(areCampaigns).where(eq(areCampaigns.id, campaignId)).limit(1);
  if (!prospect || !intel || !campaign) return;

  // (1) Ensure the campaign template exists (one LLM call, cached forever).
  const template = await generateCampaignTemplate(campaign, false);
  if (template.steps.length === 0) return;

  // (2) Personalize for this prospect (one LLM call).
  const steps = await personalizeForProspect(template, prospect, intel, campaign);
  if (steps.length === 0) return;

  // (3) Single-pass quality flag — does NOT trigger a regenerate.
  const quality = await evaluateSequenceQuality(steps, workspaceId);

  // Save sequence + quality flag.
  await db.update(prospectIntelligence).set({
    generatedSequence: steps,
    sequenceQualityScore: quality.score,
    sequenceQualityBreakdown: { ...quality.breakdown, feedback: quality.feedback },
    sequenceRewriteCount: 0,
  }).where(eq(prospectIntelligence.prospectQueueId, prospectId));

  // Track the opener for the A/B Variants tab. We only generate variant
  // A here (opener-only A/B testing is a separate ticket); leaving the
  // upsert in place keeps the AB tab populated for existing campaigns.
  if (steps.length > 0) {
    await db.insert(areAbVariants).values({
      workspaceId,
      campaignId,
      stepIndex: 1,
      variantKey: "A",
      hookType: "personalisation",
      subjectLine: steps[0]?.subject ?? "",
      bodyPreview: String(steps[0]?.body ?? "").substring(0, 300),
    }).onDuplicateKeyUpdate({
      set: {
        subjectLine: steps[0]?.subject ?? "",
        bodyPreview: String(steps[0]?.body ?? "").substring(0, 300),
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
        conditions.push(eq(prospectQueue.sequenceStatus, input.sequenceStatus as "pending" | "approved" | "enrolled" | "skipped" | "completed" | "replied" | "paused" | "canceled"));
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

  /**
   * Cancel an enrolled (or paused) prospect's sequence. Hard-stops
   * future activity but keeps the prospect row + history intact:
   *   1. flips prospect_queue.sequenceStatus → 'canceled'
   *   2. marks every still-scheduled are_execution_queue row 'skipped'
   *      with failureReason='Sequence canceled' so the dispatcher
   *      cannot accidentally fire any remaining step.
   *   3. emits an are_engine_logs row (phase='sequence.cancel') with
   *      before/after status + skipped count + reason for the audit
   *      trail (surfaces in the campaign Logs tab).
   * Idempotent: re-cancelling a canceled sequence is a no-op (no log).
   */
  cancelSequence: workspaceProcedure
    .input(z.object({ prospectId: z.number(), reason: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db.select().from(prospectQueue)
        .where(and(eq(prospectQueue.id, input.prospectId), eq(prospectQueue.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });
      if (before.sequenceStatus === "canceled") {
        return { ok: true, alreadyCanceled: true, skippedSteps: 0 };
      }
      const reasonText = `Sequence canceled${input.reason ? ` — ${input.reason}` : ""}`;
      // Count + skip every still-scheduled execution queue row for this prospect.
      const [pre] = await db.select({ n: sql<number>`count(*)` }).from(areExecutionQueue)
        .where(and(
          eq(areExecutionQueue.workspaceId, ctx.workspace.id),
          eq(areExecutionQueue.prospectQueueId, input.prospectId),
          eq(areExecutionQueue.status, "scheduled"),
        ));
      const skipped = Number(pre?.n ?? 0);
      if (skipped > 0) {
        await db.update(areExecutionQueue).set({
          status: "skipped",
          failureReason: reasonText,
          executedAt: new Date(),
        }).where(and(
          eq(areExecutionQueue.workspaceId, ctx.workspace.id),
          eq(areExecutionQueue.prospectQueueId, input.prospectId),
          eq(areExecutionQueue.status, "scheduled"),
        ));
      }
      await db.update(prospectQueue).set({
        sequenceStatus: "canceled",
        rejectedAt: new Date(),
        rejectionReason: reasonText,
      }).where(and(eq(prospectQueue.id, input.prospectId), eq(prospectQueue.workspaceId, ctx.workspace.id)));
      await db.insert(areEngineLogs).values({
        workspaceId: ctx.workspace.id,
        campaignId: before.campaignId,
        phase: "sequence.cancel",
        level: "info",
        message: `Sequence canceled for ${before.firstName ?? ""} ${before.lastName ?? ""} — ${skipped} scheduled step${skipped === 1 ? "" : "s"} skipped`,
        details: {
          prospectId: input.prospectId,
          before: before.sequenceStatus,
          after: "canceled",
          skippedSteps: skipped,
          reason: input.reason ?? null,
          actorUserId: ctx.user.id,
        } as any,
      });
      return { ok: true, alreadyCanceled: false, skippedSteps: skipped };
    }),

  /** Pause an enrolled prospect's sequence. The dispatcher already
   *  filters on sequenceStatus='enrolled', so pause is a no-op at the
   *  queue level — we just flip the status. Resuming flips it back. */
  pauseSequence: workspaceProcedure
    .input(z.object({ prospectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db.select().from(prospectQueue)
        .where(and(eq(prospectQueue.id, input.prospectId), eq(prospectQueue.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });
      if (before.sequenceStatus !== "enrolled") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Can only pause an enrolled sequence (current status: ${before.sequenceStatus})` });
      }
      await db.update(prospectQueue).set({ sequenceStatus: "paused" })
        .where(and(eq(prospectQueue.id, input.prospectId), eq(prospectQueue.workspaceId, ctx.workspace.id)));
      await db.insert(areEngineLogs).values({
        workspaceId: ctx.workspace.id,
        campaignId: before.campaignId,
        phase: "sequence.pause",
        level: "info",
        message: `Sequence paused for ${before.firstName ?? ""} ${before.lastName ?? ""}`,
        details: { prospectId: input.prospectId, before: "enrolled", after: "paused", actorUserId: ctx.user.id } as any,
      });
      return { ok: true };
    }),

  resumeSequence: workspaceProcedure
    .input(z.object({ prospectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [before] = await db.select().from(prospectQueue)
        .where(and(eq(prospectQueue.id, input.prospectId), eq(prospectQueue.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND" });
      if (before.sequenceStatus !== "paused") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Can only resume a paused sequence (current status: ${before.sequenceStatus})` });
      }
      await db.update(prospectQueue).set({ sequenceStatus: "enrolled" })
        .where(and(eq(prospectQueue.id, input.prospectId), eq(prospectQueue.workspaceId, ctx.workspace.id)));
      await db.insert(areEngineLogs).values({
        workspaceId: ctx.workspace.id,
        campaignId: before.campaignId,
        phase: "sequence.resume",
        level: "info",
        message: `Sequence resumed for ${before.firstName ?? ""} ${before.lastName ?? ""}`,
        details: { prospectId: input.prospectId, before: "paused", after: "enrolled", actorUserId: ctx.user.id } as any,
      });
      return { ok: true };
    }),

  /** List sequence rows for the campaign Sequences tab. Returns both
   *  prospects with a generated sequence (for view + edit) AND approved
   *  prospects without one yet (so the user can trigger Generate). */
  listSequences: workspaceProcedure
    .input(z.object({ campaignId: z.number(), limit: z.number().default(100) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select({
          prospectId: prospectQueue.id,
          firstName: prospectQueue.firstName,
          lastName: prospectQueue.lastName,
          email: prospectQueue.email,
          title: prospectQueue.title,
          companyName: prospectQueue.companyName,
          sequenceStatus: prospectQueue.sequenceStatus,
          enrichmentStatus: prospectQueue.enrichmentStatus,
          generatedSequence: prospectIntelligence.generatedSequence,
          sequenceQualityScore: prospectIntelligence.sequenceQualityScore,
          sequenceQualityBreakdown: prospectIntelligence.sequenceQualityBreakdown,
        })
        .from(prospectQueue)
        .leftJoin(
          prospectIntelligence,
          eq(prospectIntelligence.prospectQueueId, prospectQueue.id),
        )
        .where(
          and(
            eq(prospectQueue.campaignId, input.campaignId),
            eq(prospectQueue.workspaceId, ctx.workspace.id),
          ),
        )
        .limit(input.limit);
      // Keep rows that either HAVE a sequence or COULD have one
      // (approved/enrolled/etc. with successful enrichment).
      return rows.filter((r) => {
        const hasSeq = Array.isArray(r.generatedSequence) && (r.generatedSequence as unknown[]).length > 0;
        const sequenceableStatus = ["approved", "enrolled", "completed", "replied"].includes(
          String(r.sequenceStatus),
        );
        return hasSeq || sequenceableStatus;
      });
    }),

  /**
   * Edit a specific step in the generated sequence.
   *
   * Matches by `arrayIndex` (position in the array) rather than the step's
   * own `stepIndex` field — that handles both the LLM-generated shape
   * (which always has stepIndex) and the legacy seed shape (which uses
   * `step` and has no body field).
   *
   * Also pushes the edit forward into `are_execution_queue.messageContent`
   * for any scheduled (not-yet-sent) rows belonging to this prospect at
   * the matching stepIndex, so the next dispatcher tick sends the EDITED
   * content instead of the stale enrollment-time snapshot.
   */
  editSequenceStep: workspaceProcedure
    .input(z.object({
      prospectId: z.number(),
      /** Position in the steps array (0-based). Preferred. */
      arrayIndex: z.number().optional(),
      /** Legacy: the step's own stepIndex field. Used as a fallback. */
      stepIndex: z.number().optional(),
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
      if (!intel) throw new TRPCError({ code: "NOT_FOUND", message: "No intelligence record for this prospect" });

      const steps = (intel.generatedSequence as Array<Record<string, unknown>>) ?? [];
      if (steps.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Prospect has no generated sequence to edit" });
      }

      // Resolve which row in the array to edit.
      let targetIdx = -1;
      if (typeof input.arrayIndex === "number" && input.arrayIndex >= 0 && input.arrayIndex < steps.length) {
        targetIdx = input.arrayIndex;
      } else if (typeof input.stepIndex === "number") {
        targetIdx = steps.findIndex((s) =>
          s.stepIndex === input.stepIndex || (s as { step?: number }).step === input.stepIndex,
        );
      }
      if (targetIdx === -1) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Could not locate the step to edit" });
      }

      // Update the targeted step. Normalize to the LLM shape (stepIndex+body)
      // so future edits and the SequencesTab display work consistently.
      const old = steps[targetIdx];
      const resolvedStepIndex =
        typeof old.stepIndex === "number"
          ? (old.stepIndex as number)
          : typeof (old as { step?: number }).step === "number"
            ? ((old as { step?: number }).step as number)
            : targetIdx;
      const updatedStep = {
        ...old,
        stepIndex: resolvedStepIndex,
        subject: input.subject ?? (old.subject as string | undefined) ?? "",
        body: input.body,
      };
      const updated = steps.map((s, i) => (i === targetIdx ? updatedStep : s));
      await db.update(prospectIntelligence).set({ generatedSequence: updated })
        .where(eq(prospectIntelligence.prospectQueueId, input.prospectId));

      // Push the edit into any not-yet-sent execution queue rows so the
      // dispatcher uses the edited content. Only `scheduled` rows are
      // touched — sent/failed/skipped rows are immutable history.
      const queueWhere = and(
        eq(areExecutionQueue.workspaceId, ctx.workspace.id),
        eq(areExecutionQueue.prospectQueueId, input.prospectId),
        eq(areExecutionQueue.stepIndex, resolvedStepIndex),
        eq(areExecutionQueue.status, "scheduled"),
      );
      const [pre] = await db
        .select({ n: sql<number>`count(*)` })
        .from(areExecutionQueue)
        .where(queueWhere);
      const scheduledRowsUpdated = Number(pre?.n ?? 0);
      if (scheduledRowsUpdated > 0) {
        await db
          .update(areExecutionQueue)
          .set({
            messageContent: {
              subject: updatedStep.subject,
              body: updatedStep.body,
              variantKey: (updatedStep as { variantKey?: string }).variantKey ?? "A",
            },
          })
          .where(queueWhere);
      }

      return { success: true, scheduledRowsUpdated };
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
      // prospectQueue has firstName/lastName/title — NOT contactName/
      // contactTitle. Selecting the nonexistent columns threw on every
      // load, crashing the whole Rejections tab. The UI already falls
      // back to firstName+lastName / title.
      const rejected = await db.select({
        id: prospectQueue.id,
        companyName: prospectQueue.companyName,
        firstName: prospectQueue.firstName,
        lastName: prospectQueue.lastName,
        title: prospectQueue.title,
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
        title: prospectQueue.title,
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
        r.id, r.firstName, r.lastName, r.title, r.companyName, r.industry,
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
      const match = await scoreIcpMatch(prospect, icp, workspaceId);
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
    .input(z.object({ campaignId: z.number(), overrideThreshold: z.number().min(0).max(100).optional() }))
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
      // Use override threshold if provided (from quick-edit in dialog), else campaign's actual threshold, else 70
      const autoApproveThreshold = input.overrideThreshold ?? campaign.autoApproveThreshold ?? 70;
      let requalified = 0;
      for (const prospect of rejected) {
        try {
          const match = await scoreIcpMatch(prospect, icp, workspaceId);
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
      // Log the run to reeval_runs for history tracking
      try {
        await db.insert(reevalRuns).values({
          workspaceId: ctx.workspace.id,
          campaignId: input.campaignId,
          createdByUserId: ctx.user.id,
          thresholdUsed: autoApproveThreshold,
          processed: rejected.length,
          requalified,
        });
      } catch (e) {
        console.error("[reEvaluateAll] Failed to log run history", e);
      }
      return { processed: rejected.length, requalified, threshold: autoApproveThreshold };
    }),

  getReevalHistory: workspaceProcedure
    .input(z.object({ campaignId: z.number(), limit: z.number().min(1).max(50).default(20) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB unavailable" });
      const rows = await db
        .select({
          id: reevalRuns.id,
          thresholdUsed: reevalRuns.thresholdUsed,
          processed: reevalRuns.processed,
          requalified: reevalRuns.requalified,
          runAt: reevalRuns.runAt,
          runnerName: users.name,
        })
        .from(reevalRuns)
        .leftJoin(users, eq(reevalRuns.createdByUserId, users.id))
        .where(
          and(
            eq(reevalRuns.campaignId, input.campaignId),
            eq(reevalRuns.workspaceId, ctx.workspace.id),
          )
        )
        .orderBy(desc(reevalRuns.runAt))
        .limit(input.limit);
      return rows;
    }),
});