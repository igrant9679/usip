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
 *   3. Records that score as a FLAG (a low score shows a Review badge; it does
 *      not trigger a rewrite — see personalizeForProspect)
 *   4. Records the opener as the campaign's A/B variant A, for the A/B tab's
 *      subject/hook labels
 *
 * ⚠️ There is NO A/B EXPERIMENT here, despite the tab's name. Nothing in this
 * file — or anywhere else — ever produces a variant B: every prospect gets one
 * uniquely personalised sequence, so there is no shared copy to test and no
 * split to assign. The tab measures per-step performance with a variant label
 * that is always "A". Header item 4 used to read "Generates A/B variant with
 * different hook type", which it never did. Building a real experiment needs a
 * variant-assignment mechanism (see shared/variantKeys.ts) and is a product
 * decision, not something to infer.
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, getTableColumns, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
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
  prospects,
  reevalRuns,
  users,
  workspaceMembers,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { parseLlmJson } from "./llmJson";
import { invokeLLM, isRetryableLLMError } from "../../_core/llm";
import { router } from "../../_core/trpc";
import { isAdminRole, requireMinRole, workspaceProcedure } from "../../_core/workspace";
import { recordAudit } from "../../audit";
import { BULK_INPUT, runBulkAction } from "./prospectsBulk";
import { notifyIfEnabled } from "../../services/policyNotify";
import { HUMAN_COPY_RULES, humanizeAiCopy } from "../../services/humanCopy";
import { resolveVerifiedEmail } from "../../services/scraper";
import { getQuickEnrichKey, quickenrichFindEmailByLinkedIn } from "../../services/quickenrich";
import { getReoonKey, reoonStatusToUsip, reoonVerifySingle } from "../../services/reoon";
import { buildBrandContext } from "../../services/brandContext";
// The A/B metadata row must be keyed by the same step index + variant key the
// execution queue uses, so both sides read one rule. See shared/variantKeys.ts.
import { DEFAULT_STEP_GAP_DAYS, defaultDayForStep, stepIndexOf } from "@shared/areSequenceSteps";
import { cleanScrapedField } from "@shared/fieldHygiene";
import { MAX_TIMELINE_DAY_OFFSET, MAX_TIMELINE_STEPS, effectiveStepGapDays, planRespaceForProspect, sanitizeDayOffsets } from "@shared/areStepCadence";
import { DEFAULT_VARIANT_KEY, normalizeVariantKey } from "@shared/variantKeys";

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
  const parsed = parseLlmJson(content, "scoreIcpMatch");
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

/**
 * Merge a campaign's icpOverrides over the workspace ICP into the "effective
 * ICP" that scoring must use. Scoring only the global ICP graded a nonprofit
 * campaign's Executive Directors against a B2B-tech profile — every
 * on-audience prospect scored 10-40 and screening auto-rejected them all.
 * Overrides win per-field; the ICP fills gaps + supplies anti-patterns.
 * Returns null when there is neither an ICP nor any override targeting.
 */
function buildEffectiveIcp(
  icp: typeof icpProfiles.$inferSelect | undefined,
  icpOverrides: unknown,
): typeof icpProfiles.$inferSelect | null {
  const ov = (icpOverrides ?? {}) as {
    targetTitles?: string[]; targetIndustries?: string[]; targetGeographies?: string[];
    employeeMin?: number; employeeMax?: number;
  };
  const hasOverrides =
    (ov.targetTitles?.length ?? 0) > 0 ||
    (ov.targetIndustries?.length ?? 0) > 0 ||
    (ov.targetGeographies?.length ?? 0) > 0;
  if (!icp && !hasOverrides) return null;
  return {
    ...(icp ?? {}),
    targetTitles: ov.targetTitles?.length ? ov.targetTitles : (icp?.targetTitles ?? []),
    targetIndustries: ov.targetIndustries?.length ? ov.targetIndustries : (icp?.targetIndustries ?? []),
    targetGeographies: ov.targetGeographies?.length ? ov.targetGeographies : (icp?.targetGeographies ?? []),
    targetCompanySizeMin: ov.employeeMin ?? icp?.targetCompanySizeMin ?? null,
    targetCompanySizeMax: ov.employeeMax ?? icp?.targetCompanySizeMax ?? null,
    antiPatterns: icp?.antiPatterns ?? [],
  } as typeof icpProfiles.$inferSelect;
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

    // Score against the CAMPAIGN's targeting, not just the workspace ICP
    // (see buildEffectiveIcp).
    const [scoringCampaign] = await db
      .select({ icpOverrides: areCampaigns.icpOverrides })
      .from(areCampaigns)
      .where(eq(areCampaigns.id, prospect.campaignId))
      .limit(1);
    const effectiveIcp = buildEffectiveIcp(icp, scoringCampaign?.icpOverrides);

    // Score ICP match
    let icpMatchScore = 50;
    let icpMatchBreakdown: Record<string, number> = {};
    if (effectiveIcp) {
      const match = await scoreIcpMatch(prospect, effectiveIcp, workspaceId);
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
10. inferredCompanyName: the organization this person CURRENTLY works at, extracted from their title/headline (e.g. "Executive Director at Children & Charity International" → "Children & Charity International"). Use the Company field if provided. Empty string if it cannot be determined — never guess.
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
              inferredCompanyName: { type: "string" },
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
              "recentNews", "industryEvents", "linkedinSummary", "companyOneLiner", "inferredCompanyName",
              "recommendedChannel", "recommendedTiming", "enrichmentConfidence",
            ],
            additionalProperties: false,
          },
        },
      },
    });

    const enrichContent = enrichResult.choices[0]?.message?.content;
    if (!enrichContent) throw new Error("Enrichment returned no content");
    const enrichData = parseLlmJson(enrichContent, "enrichAgent");

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

    // ── Email acquisition ────────────────────────────────────────────────
    // ARE's dispatch phase hard-requires an email, but scraped prospects
    // (esp. LinkedIn) arrive without one — often without even a company
    // field, just an org name buried in the headline. The first-party finder
    // (site scrape → name patterns → Reoon two-stage verify) produces a
    // deliverable address WHEN a domain is known. Apollo org search used to
    // resolve name→domain here; removed 2026-08-12 (owner directive —
    // LinkedIn+QuickEnrich are the single source of truth), so rows with a
    // name but no domain now wait for the comprehensive pass's LinkedIn/
    // email-domain paths instead. Best-effort: a failure here never fails
    // the enrichment.
    // Through the ONE cleaner: inferredCompanyName is raw LLM output, and the
    // model's dunno-token is "<UNKNOWN>" — truthy, so a bare trim wrote it to
    // prospect_queue.companyName verbatim (pq 16331/16386, enriched 08-16/17,
    // four days AFTER 0159 scrubbed the table; 16331's subject line then went
    // to a real recipient as "…at <UNKNOWN>"). Migration 0171 re-repairs the
    // stored rows; this is the writer that leaked them.
    const inferredCompany = cleanScrapedField((enrichData as Record<string, unknown>).inferredCompanyName, 200) ?? "";
    let effCompanyName = prospect.companyName ?? (inferredCompany || null);
    let effCompanyDomain: string | null = prospect.companyDomain ?? null;
    let resolvedEmail: string | null = null;
    let resolvedStatus: string | null = null;
    let qeFilledDomain = false;
    if (!prospect.email) {
      try {
        // No Apollo in the waterfall (owner decision 2026-08-12, reaffirmed
        // 2026-08-24: CF runs without an Apollo key — QuickEnrich/LinkedIn
        // supply domains). A domain-less row with a LinkedIn URL asks
        // QuickEnrich's LinkedIn-keyed record for the employer — and often
        // the address itself. Same finder and the same Reoon gate as the
        // sweep's pass: a QuickEnrich address is never send-safe on their
        // word, and an invalid verdict means it is NOT written.
        if (!effCompanyDomain && prospect.linkedinUrl) {
          const qeKey = await getQuickEnrichKey(workspaceId);
          if (qeKey) {
            const qe = await quickenrichFindEmailByLinkedIn(qeKey, prospect.linkedinUrl);
            if (qe.companyDomain) {
              effCompanyDomain = qe.companyDomain;
              qeFilledDomain = true;
            }
            if (qe.companyName && !effCompanyName) effCompanyName = qe.companyName;
            if (qe.email) {
              let status = "unknown";
              try {
                const reoonKey = await getReoonKey(workspaceId);
                if (reoonKey) {
                  const v = await reoonVerifySingle(qe.email, reoonKey, "power");
                  status = reoonStatusToUsip(v.status);
                }
              } catch {
                /* verification unavailable → keep the address, flagged by status "unknown" */
              }
              if (status !== "invalid") {
                resolvedEmail = qe.email;
                resolvedStatus = status;
              }
            }
          }
        }
        if (!resolvedEmail && effCompanyDomain) {
          const found = await resolveVerifiedEmail({
            firstName: prospect.firstName,
            lastName: prospect.lastName,
            companyDomain: effCompanyDomain,
            companyWebsite: effCompanyDomain, // no separate website column on the queue
            workspaceId,
          });
          if (found.email) {
            resolvedEmail = found.email;
            resolvedStatus = found.status;
          }
        }
      } catch (e) {
        console.error(`[AreEngine] email resolution for prospect ${prospectId} failed:`, e);
      }
    }

    // Update prospect with ICP score + everything the chain recovered.
    await db.update(prospectQueue).set({
      icpMatchScore,
      icpMatchBreakdown,
      enrichmentStatus: "complete",
      enrichedAt: new Date(),
      ...(resolvedEmail ? { email: resolvedEmail } : {}),
      ...(effCompanyName && !prospect.companyName ? { companyName: effCompanyName.slice(0, 200) } : {}),
      ...(qeFilledDomain && effCompanyDomain ? { companyDomain: effCompanyDomain.slice(0, 200) } : {}),
    }).where(eq(prospectQueue.id, prospectId));
    if (resolvedEmail) {
      await emitSeqLog(db, workspaceId, prospect.campaignId, "info", "enrich",
        `Found email for ${prospect.firstName ?? ""} ${prospect.lastName ?? ""} → ${resolvedEmail} (${resolvedStatus ?? "unknown"})`.trim());
    }

    // People-as-master: the agent's findings also land on the canonical
    // person record (through the merge — never a blind write). Best-effort.
    if (prospect.personProspectId && (resolvedEmail || effCompanyName || effCompanyDomain)) {
      void import("../../services/personLink")
        .then((m) => m.mergeIntoPerson(workspaceId, prospect.personProspectId!, {
          email: resolvedEmail,
          emailVerification: resolvedStatus,
          companyName: effCompanyName,
          companyDomain: effCompanyDomain,
          source: "are_enrich_agent",
        }))
        .catch((e) => console.error("[personLink] agent writeback failed:", (e as Error)?.message ?? e));
    }

  } catch (err) {
    // Persist a human-readable reason so the Prospects tab can surface it
    // (tooltip + expandable detail) instead of just showing a red 'failed'
    // chip with no explanation. Cap length so a megabyte stack trace
    // doesn't bloat the row.
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 800);
    if (isRetryableLLMError(err)) {
      // Provider rate limit / overload — a fact about the moment, not about
      // this prospect. Back to 'pending' so the engine's next tick retries
      // it, instead of stranding a red 'failed' chip with raw 429 JSON the
      // user has to retry by hand.
      await db.update(prospectQueue).set({
        enrichmentStatus: "pending",
        enrichmentError: `AI provider is rate-limited — enrichment will retry automatically on the next engine pass. (${reason.slice(0, 300)})`,
      }).where(eq(prospectQueue.id, prospectId));
    } else {
      await db.update(prospectQueue).set({
        enrichmentStatus: "failed",
        enrichmentError: reason || "Unknown error",
      }).where(eq(prospectQueue.id, prospectId));
    }
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
  const subjectGuidance = (campaign.promptSubject ?? "").trim();
  const bodyGuidance = (campaign.promptBody ?? "").trim();
  const goalText =
    campaign.goalType === "meeting_booked" ? "Book a 15-minute discovery call"
    : campaign.goalType === "reply" ? "Get a reply to start a conversation"
    : "Create an opportunity in the pipeline";
  const stepCount = campaign.sequenceTemplate === "standard_7step" ? 7 : 5;

  const systemContent =
    `You are an elite B2B sales sequence architect. Design a reusable ${stepCount}-step outreach skeleton for a single campaign. The skeleton will be filled in per-prospect later, so do NOT write subject lines or bodies — write the STRUCTURE (archetype, cadence, what each step should accomplish, the CTA pattern) so that any prospect's data can be slotted in.` +
    (customInstructions ? `\n\n## Campaign-specific instructions\n${customInstructions}` : "") +
    (subjectGuidance ? `\n\n## Subject line preferences (the per-prospect writer will follow these)\n${subjectGuidance}` : "") +
    (bodyGuidance ? `\n\n## Body preferences (the per-prospect writer will follow these)\n${bodyGuidance}` : "");

  const userContent =
    `## Campaign goal\n${goalText}\n\n` +
    `## Channels enabled\n${JSON.stringify(campaign.channelsEnabled)}\n\n` +
    // Days are stated EXACTLY, not as a window for the model to divide. The
    // old "14-day total window for 7-step" produced 0/3/6/8/10/12/14 — the
    // model's own arithmetic, uneven and ~2 days apart. DEFAULT_STEP_GAP_DAYS
    // is the same constant normalizeSequence falls back to, so a sequence
    // that arrives without days schedules on the rhythm the prompt asked for.
    `## Cadence rules\n- First step on day 0.\n- Exactly ${DEFAULT_STEP_GAP_DAYS} days between consecutive steps: the day for step i is i × ${DEFAULT_STEP_GAP_DAYS} (${Array.from({ length: stepCount }, (_, i) => defaultDayForStep(i)).join(", ")}).\n- No two consecutive steps on the same channel unless both are email.\n- Final step is a polite break-up.\n\n` +
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
  const parsed = parseLlmJson(content, "generateCampaignTemplate") as CampaignTemplate;

  await db.update(areCampaigns)
    .set({ generatedTemplate: parsed, generatedTemplateAt: new Date() })
    .where(eq(areCampaigns.id, campaign.id));

  return parsed;
}

/**
 * The hook the personalizer actually leads with, and what KIND of hook it is.
 *
 * One definition, called twice on purpose: the writer picks the hook and the
 * A/B tab labels it, and those two must not be able to disagree. The variant
 * upsert used to hardcode `hookType: "personalisation"` for every row, so a
 * card built on a funding trigger or a pain signal was labelled as a
 * personalisation hook — a displayed field with no relationship to the copy
 * beside it.
 */
/**
 * Intelligence JSON columns are written from LLM output, and the model
 * drifts: live on 2026-08-20 a prospect's painSignals arrived as a STRING,
 * and `(x as Array) ?? []` — which only catches null — passed it through to
 * `.slice(0,2).map(...)`, killing sequence generation for that prospect on
 * every retry ("painSignals.slice(...).map is not a function", campaign 21).
 * One coercion at every read: an array passes, anything else reads as empty.
 * Same rule as normalizeSequence — normalise at the read, never trust `??`.
 */
export function intelArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function primaryHookOf(
  intel: typeof prospectIntelligence.$inferSelect,
): { hook: string; hookType: string } {
  const hooks = intelArray<{ hook?: string; hookType?: string }>(intel.personalisationHooks);
  const triggerEvents = intelArray<{ type?: string; description?: string }>(intel.triggerEvents);
  const painSignals = intelArray<{ signal?: string; evidence?: string }>(intel.painSignals);
  // Truthy checks, not `??`: an empty-string hook is not a hook, and it would
  // otherwise be interpolated into the prompt as a blank "Primary hook" section.
  if (hooks[0]?.hook) return { hook: hooks[0].hook, hookType: hooks[0].hookType || "personalisation" };
  if (triggerEvents[0]?.description) return { hook: triggerEvents[0].description, hookType: "trigger_event" };
  if (painSignals[0]?.signal) return { hook: painSignals[0].signal, hookType: "pain_signal" };
  return { hook: "your company's growth", hookType: "generic" };
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

  // Through the drift guard, and only entries shaped like a pain signal — a
  // string member would interpolate "- undefined: undefined" into the prompt.
  const painSignals = intelArray<{ signal?: string; evidence?: string }>(intel.painSignals)
    .filter((p) => p && typeof p === "object" && (p.signal || p.evidence));
  const { hook: primaryHook } = primaryHookOf(intel);

  const customInstructions = (campaign.sequencePrompt ?? "").trim();
  const subjectGuidance = (campaign.promptSubject ?? "").trim();
  const bodyGuidance = (campaign.promptBody ?? "").trim();
  const signature = (campaign.promptSignature ?? "").trim();
  // The seller's own company + brand voice (migration 0125). "" when the
  // workspace has no branding set or brand-voice applyToAI is off.
  const brandBlock = await buildBrandContext(campaign.workspaceId);
  const systemContent =
    `You are an elite B2B sales copywriter. You will be given a campaign skeleton and a prospect dossier. Fill in subject+body for each step, keeping the structure, cadence, and CTA pattern from the skeleton. Every message must reference something real about the prospect. Never use generic openers ("I hope this finds you well", "I wanted to reach out").` +
    `\n\n${HUMAN_COPY_RULES}` +
    (brandBlock ? `\n\n${brandBlock}` : "") +
    (customInstructions ? `\n\n## Campaign-specific instructions\n${customInstructions}` : "") +
    (subjectGuidance ? `\n\n## Subject line instructions\n${subjectGuidance}` : "") +
    (bodyGuidance ? `\n\n## Body instructions\n${bodyGuidance}` : "") +
    // The signature is appended verbatim after generation, so the model must
    // NOT invent its own — otherwise every email ends with two sign-offs.
    (signature ? `\n\n## Sign-off\nDo NOT write any closing, sign-off, or signature (no "Best,", no name) — a fixed signature is appended automatically. End the body on the CTA.` : "");

  const userContent =
    `## Template (do not change structure, only fill subject + body)\n${JSON.stringify(template.steps, null, 2)}\n\n` +
    `## Prospect\n- Name: ${prospect.firstName} ${prospect.lastName}\n- Title: ${prospect.title ?? "Unknown"}\n- Company: ${prospect.companyName ?? "Unknown"}\n- Industry: ${prospect.industry ?? "Unknown"}\n- Company one-liner: ${intel.companyOneLiner ?? ""}\n- LinkedIn summary: ${intel.linkedinSummary ?? ""}\n\n` +
    `## Primary hook\n${primaryHook}\n\n` +
    `## Pain signals\n${painSignals.slice(0, 2).map((p) => `- ${p.signal ?? ""}${p.evidence ? `: ${p.evidence}` : ""}`).join("\n") || "(none)"}\n\n` +
    `Return one filled step per template step (same stepIndex, day, channel). Keep emails under 120 words. Use {{firstName}} / {{company}} merge tags where natural. When a step's CTA is to book a meeting, make the ask a Markdown link to the sender's scheduling page — [grab 15 minutes]({{bookingLink}}) — instead of proposing specific times; {{bookingLink}} is substituted at send time. Never paste {{bookingLink}} as a raw token.`;

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
                  // No variantKey: the model used to be REQUIRED to return one
                  // with nothing in either prompt explaining what it was, and
                  // whatever it invented became the A/B tab's group-by key.
                  // A variant label is assigned by code or not at all —
                  // shared/variantKeys.ts.
                },
                required: ["stepIndex", "day", "channel", "subject", "body"],
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
  const parsed = parseLlmJson(content, "personalizeForProspect");
  return (parsed.steps ?? []).map((s: any) => {
    const channel = String(s.channel ?? "email").toLowerCase();
    // Scrub AI tells (em dashes, curly/straight mixes, markdown leaks) —
    // the prompt asks, the scrub guarantees. Runs BEFORE the signature
    // append so the owner's own signature text is never rewritten.
    s = { ...s, subject: humanizeAiCopy(String(s.subject ?? "")) };
    let body = humanizeAiCopy(String(s.body ?? ""));
    // Append the literal campaign signature to email steps only. Stored on the
    // generated sequence so it's visible in the viewer and goes out on send.
    // Guard against a re-run double-append (force regen reuses the same step).
    if (signature && channel === "email" && !body.includes(signature)) {
      body = `${body.trimEnd()}\n\n${signature}`;
    }
    // The only variant that exists. Assigned here rather than accepted from the
    // model, and normalised again at the read in shared/areSequenceSteps.ts so
    // sequences generated before this still fold into the same cell.
    return { ...s, body, variantKey: DEFAULT_VARIANT_KEY };
  });
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
  const data = parseLlmJson(content, "evaluateSequenceQuality");
  return {
    score: Math.min(40, Math.max(0, Math.round(data.totalScore))),
    breakdown: { specificity: data.specificity, clarity: data.clarity, brevity: data.brevity, cta: data.cta },
    feedback: String(data.feedback ?? ""),
  };
}

/** Result the awaited generateSequence mutation returns so the client
 *  can render a useful toast + invalidate caches with concrete numbers. */
export interface SequenceAgentResult {
  ok: boolean;
  reused: boolean;
  steps: number;
  qualityScore: number;
  durationMs: number;
  prospectId: number;
}

/** Persist a log row tied to the campaign. Best-effort: never throws,
 *  never blocks the agent. Surfaces in the unified Logs tab. */
async function emitSeqLog(
  db: any,
  workspaceId: number,
  campaignId: number,
  level: "info" | "warn" | "error",
  phase: string,
  message: string,
  details?: unknown,
): Promise<void> {
  try {
    await db.insert(areEngineLogs).values({
      workspaceId,
      campaignId,
      phase,
      level,
      message: message.slice(0, 500),
      details: details === undefined ? null : (details as any),
    });
  } catch (e) {
    console.error("[runSequenceAgent] emitSeqLog failed:", e);
  }
}

/**
 * Generate the sequence for one prospect. Awaited; throws with a clear
 * message on every failure mode so the caller can surface it. Emits
 * `sequence.*` log entries at every phase boundary for the Logs tab.
 *
 * Idempotency: if the prospect already has a non-empty generatedSequence
 * and force=false, returns immediately with reused=true. Pass force=true
 * to bypass and regenerate (used by a future Regenerate action).
 */
export async function runSequenceAgent(
  prospectId: number,
  workspaceId: number,
  campaignId: number,
  options: { force?: boolean; allowWithoutIntel?: boolean } = {},
): Promise<SequenceAgentResult> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const startedAt = Date.now();
  const [prospect] = await db.select().from(prospectQueue).where(eq(prospectQueue.id, prospectId)).limit(1);
  let [intel] = await db.select().from(prospectIntelligence).where(eq(prospectIntelligence.prospectQueueId, prospectId)).limit(1);
  const [campaign] = await db.select().from(areCampaigns).where(eq(areCampaigns.id, campaignId)).limit(1);

  if (!prospect) throw new Error(`Prospect ${prospectId} not found`);
  if (!campaign) throw new Error(`Campaign ${campaignId} not found`);
  if (!intel && !options.allowWithoutIntel) {
    // The prospect was never enriched (or enrichment failed). Without
    // intel there's nothing to personalize against. The AUTONOMOUS path keeps
    // refusing — an unenriched prospect is a data gap the engine should not
    // paper over on its own.
    await emitSeqLog(db, workspaceId, campaignId, "warn", "sequence.skip",
      `Cannot generate sequence — prospect "${prospect.firstName} ${prospect.lastName}" has no enrichment data. Run enrichment first.`,
      { prospectId, reason: "no_intel" });
    throw new Error("Prospect has no enrichment data — enrich it first, then generate the sequence");
  }

  // A HUMAN asked for this one specifically (owner ask 2026-08-14: "make it so
  // I can send anyone manually, even if they're not enriched"). The refusal
  // above was not really about personalisation — personalizeForProspect and
  // primaryHookOf both degrade to the prospect's own name/title/company and a
  // generic hook. It was about storage: the generated sequence is saved ONTO
  // the intelligence row, so with no row there is nowhere to put it. Create the
  // empty dossier, then take the normal path.
  if (!intel) {
    await emitSeqLog(db, workspaceId, campaignId, "info", "sequence.no_intel_manual",
      `Generating a sequence for "${prospect.firstName} ${prospect.lastName}" WITHOUT enrichment (manual request) — copy will personalise from their title and company only`,
      { prospectId });
    await db.insert(prospectIntelligence).values({
      prospectQueueId: prospectId,
      workspaceId,
      enrichmentConfidence: 0,
    } as never);
    [intel] = await db.select().from(prospectIntelligence).where(eq(prospectIntelligence.prospectQueueId, prospectId)).limit(1);
    if (!intel) throw new Error("Could not create a dossier row for this prospect");
  }

  // Idempotency: don't waste LLM tokens if a sequence already exists.
  const existing = (intel.generatedSequence as unknown[]) ?? [];
  if (!options.force && Array.isArray(existing) && existing.length > 0) {
    await emitSeqLog(db, workspaceId, campaignId, "info", "sequence.reuse",
      `Sequence already exists for ${prospect.firstName} ${prospect.lastName} (${existing.length} steps) — reusing without regeneration`,
      { prospectId, steps: existing.length });
    return { ok: true, reused: true, steps: existing.length, qualityScore: intel.sequenceQualityScore ?? 0, durationMs: 0, prospectId };
  }

  await emitSeqLog(db, workspaceId, campaignId, "info", "sequence.start",
    `Sequence generation started for ${prospect.firstName} ${prospect.lastName}`, { prospectId, force: !!options.force });

  try {
    // (1) Ensure the campaign template exists (one LLM call, cached forever).
    const template = await generateCampaignTemplate(campaign, false);
    if (template.steps.length === 0) {
      throw new Error("Campaign template generation returned 0 steps — check the campaign's sequencePrompt + LLM provider");
    }
    await emitSeqLog(db, workspaceId, campaignId, "info", "sequence.template",
      `Campaign template ready: ${template.steps.length} step skeleton (cached)`, { prospectId, steps: template.steps.length });

    // (2) Personalize for this prospect (one LLM call).
    const steps = await personalizeForProspect(template, prospect, intel, campaign);
    if (steps.length === 0) {
      throw new Error("Personalization returned 0 steps — LLM did not respond with parseable JSON");
    }
    await emitSeqLog(db, workspaceId, campaignId, "info", "sequence.personalize",
      `Personalized ${steps.length} steps for ${prospect.firstName} ${prospect.lastName}`, { prospectId, steps: steps.length });

    // (3) Single-pass quality flag.
    const quality = await evaluateSequenceQuality(steps, workspaceId);
    await emitSeqLog(db, workspaceId, campaignId, "info", "sequence.eval",
      `Quality: ${quality.score}/40`, { prospectId, score: quality.score, breakdown: quality.breakdown });

    // Save sequence + quality flag.
    await db.update(prospectIntelligence).set({
      generatedSequence: steps,
      sequenceQualityScore: quality.score,
      sequenceQualityBreakdown: { ...quality.breakdown, feedback: quality.feedback },
      sequenceRewriteCount: 0,
    }).where(eq(prospectIntelligence.prospectQueueId, prospectId));

    // Refresh A/B Variants — opener-only (variant A, the only one that exists).
    // Campaign-level upsert so the tab picks up the new opener on next query;
    // subject/body are therefore the MOST RECENTLY generated prospect's copy,
    // shown as an example, while `sent` aggregates every prospect's sends.
    //
    // stepIndex comes from the STEP, via the same rule the execution queue uses
    // (shared/areSequenceSteps.ts). It was hardcoded to 1 while the queue keyed
    // the opener at 0, and getAbVariantStats joins the two on
    // `${stepIndex}:${variantKey}` — so this row never reached the cell holding
    // the sends, and instead minted a phantom cell one step along at 0 sends.
    const opener = steps[0];
    if (opener) {
      // Clamped to the column widths (hookType varchar(64), subjectLine
      // varchar(240)): hookType can carry an LLM-authored value from the enrich
      // agent's hooks, and an over-long string fails this INSERT at RUNTIME
      // only — tsc and esbuild both pass it.
      const { hookType } = primaryHookOf(intel);
      const subjectLine = String(opener.subject ?? "").substring(0, 240);
      const bodyPreview = String(opener.body ?? "").substring(0, 300);
      await db.insert(areAbVariants).values({
        workspaceId,
        campaignId,
        stepIndex: stepIndexOf(opener, 0),
        variantKey: normalizeVariantKey(opener.variantKey),
        hookType: hookType.substring(0, 64),
        subjectLine,
        bodyPreview,
      }).onDuplicateKeyUpdate({
        // hookType too: it is a label for the copy in the same row, so leaving
        // it stale would describe the previous prospect's hook.
        set: { hookType: hookType.substring(0, 64), subjectLine, bodyPreview },
      });
    }

    const durationMs = Date.now() - startedAt;
    await emitSeqLog(db, workspaceId, campaignId, "info", "sequence.complete",
      `Sequence generated for ${prospect.firstName} ${prospect.lastName} — ${steps.length} steps, quality ${quality.score}/40, ${durationMs}ms`,
      { prospectId, steps: steps.length, qualityScore: quality.score, durationMs });

    return { ok: true, reused: false, steps: steps.length, qualityScore: quality.score, durationMs, prospectId };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    await emitSeqLog(db, workspaceId, campaignId, "error", "sequence.error",
      `Sequence generation failed for ${prospect.firstName} ${prospect.lastName}: ${msg}`,
      { prospectId, error: msg, stack: (err as Error)?.stack });
    throw err;
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
      } else {
        // Rejected prospects (reject/bulkReject set sequenceStatus="skipped")
        // belong in the Rejections tab only — getRejectionStats selects exactly
        // these. Exclude them from the review queue so the two tabs are
        // complementary (a prospect is in Prospects XOR Rejections). Callers
        // that explicitly ask for sequenceStatus="skipped" still get them.
        conditions.push(ne(prospectQueue.sequenceStatus, "skipped"));
      }
      /**
       * How many verified intent signals the enrichment pass found.
       *
       * `triggerEvents` and `painSignals` are the two arrays that describe a
       * reason to reach out NOW, as opposed to icpMatchScore which describes
       * whether this is the right kind of person at all. techStack and
       * recentNews are deliberately excluded: the first is fit, the second is
       * ambient company noise that is often nothing to do with buying.
       */
      const intentSignals = sql<number>`(
        COALESCE(JSON_LENGTH(${prospectIntelligence.triggerEvents}), 0)
        + COALESCE(JSON_LENGTH(${prospectIntelligence.painSignals}), 0)
      )`;

      const rows = await db
        .select({
          ...getTableColumns(prospectQueue),
          intentSignals,
          // Canonical person (People-as-master, migration 0153). The queue
          // columns stay as the engine/display fallback; when a person is
          // linked the tab renders THESE — one record, N campaigns.
          personFirstName: prospects.firstName,
          personLastName: prospects.lastName,
          personTitle: prospects.title,
          personCompany: prospects.company,
          personCompanyDomain: prospects.companyDomain,
          personEmail: prospects.email,
          personEmailStatus: prospects.emailStatus,
          personCatchAllEmail: prospects.catchAllEmail,
          personPhone: prospects.phone,
          personLinkedinUrl: prospects.linkedinUrl,
          personCity: prospects.city,
          personState: prospects.state,
          personCountry: prospects.country,
          personImageUrl: prospects.profileImageUrl,
          personImageSource: prospects.profileImageSource,
          personImageStatus: prospects.profileImageStatus,
        })
        .from(prospectQueue)
        // Scoped on BOTH sides. prospect_intelligence carries its own
        // workspaceId and joining on the queue id alone is the shape that made
        // websiteVisits leak across tenants (24c720e).
        .leftJoin(
          prospectIntelligence,
          and(
            eq(prospectIntelligence.prospectQueueId, prospectQueue.id),
            eq(prospectIntelligence.workspaceId, prospectQueue.workspaceId),
          ),
        )
        .leftJoin(
          prospects,
          and(
            eq(prospects.id, prospectQueue.personProspectId),
            eq(prospects.workspaceId, prospectQueue.workspaceId),
          ),
        )
        .where(and(...conditions))
        /**
         * ICP FIT STAYS THE PRIMARY KEY; intent only breaks ties.
         *
         * This decides who a human approves first, and therefore who gets
         * mailed first. Letting intent OUTRANK fit would need a weight — "an
         * intent signal is worth N points of fit" — and there is nothing in
         * this codebase to derive N from. Inventing one to make the feature
         * look cleverer is the same fabrication refused in 974b903. A
         * tiebreak needs no invented number and can never push a worse-fit
         * prospect above a better-fit one.
         *
         * It is not cosmetic: icpMatchScore is an integer an LLM picks, and
         * those cluster hard on round numbers, so ties are the common case.
         *
         * A row with no intelligence sorts as 0 here. That is NOT the
         * "absent counted as a measured zero" bug fixed in 96b161d — the
         * primary key is untouched, so an unenriched prospect keeps its full
         * fit ranking and only orders after an EQUALLY-fitting one that has
         * evidence behind it.
         */
        .orderBy(desc(prospectQueue.icpMatchScore), desc(intentSignals))
        .limit(input.limit)
        .offset(input.offset);

      // Shape the person as a nested object with the SAME policy-gated
      // profile_image resolution People uses; raw image columns never leave
      // the server (same rule as prospects.list).
      const { resolveProspectProfileImage } = await import("../../services/profileImage");
      return rows.map((r) => {
        const {
          personFirstName, personLastName, personTitle, personCompany, personCompanyDomain,
          personEmail, personEmailStatus, personCatchAllEmail, personPhone, personLinkedinUrl,
          personCity, personState, personCountry, personImageUrl, personImageSource, personImageStatus,
          ...queue
        } = r;
        const person = r.personProspectId && personFirstName !== null
          ? {
              id: r.personProspectId,
              firstName: personFirstName, lastName: personLastName,
              title: personTitle, company: personCompany, companyDomain: personCompanyDomain,
              email: personEmail, emailStatus: personEmailStatus, catchAllEmail: personCatchAllEmail,
              phone: personPhone, linkedinUrl: personLinkedinUrl,
              city: personCity, state: personState, country: personCountry,
              profile_image: resolveProspectProfileImage({
                profileImageUrl: personImageUrl,
                profileImageSource: personImageSource,
                profileImageStatus: personImageStatus,
              }),
            }
          : null;
        return { ...queue, person };
      });
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

  /** Generate a sequence for one enriched prospect — AWAITED.
   *
   *  Previously this returned {started: true} immediately and let
   *  runSequenceAgent run in the background with .catch(console.error).
   *  That made failures invisible (no toast, no log entry) and made the
   *  client guess at completion time. Now the mutation actually waits
   *  for the LLM pipeline to finish, then returns the concrete result
   *  ({ok, reused, steps, qualityScore, durationMs}) or throws a
   *  TRPCError with the underlying error message. */
  generateSequence: workspaceProcedure
    .input(z.object({
      prospectId: z.number(),
      campaignId: z.number(),
      /** Force regeneration even if a sequence already exists. */
      force: z.boolean().default(false),
      /**
       * Generate even with no enrichment behind the prospect. Defaults ON
       * because this procedure IS the manual surface — a person clicked the
       * button for this specific prospect. The autonomous engine calls
       * runSequenceAgent directly and keeps refusing, so unenriched prospects
       * still never get auto-sequenced behind the owner's back.
       */
      allowWithoutEnrichment: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await runSequenceAgent(input.prospectId, ctx.workspace.id, input.campaignId, {
          force: input.force,
          allowWithoutIntel: input.allowWithoutEnrichment,
        });
      } catch (e) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: (e as Error)?.message ?? "Sequence generation failed",
          cause: e instanceof Error ? e : undefined,
        });
      }
    }),

  approve: workspaceProcedure
    .input(z.object({ prospectId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      /**
       * `approvedAt` / `approvedByUserId` record the DECISION, so they are
       * written only when there is one — i.e. only if the row was not already
       * approved. Unconditionally, this re-stamped every call: on 2026-08-17 a
       * repair pass re-approved 141 already-approved rows and overwrote the
       * previous day's approval timestamps, and when the owner then asked
       * "who approved these and when", the record could no longer say. An
       * audit column that any later write can clobber is not an audit column.
       *
       * The status flip still happens regardless (that IS idempotent — it is
       * how canceled/paused rows get back into the engine's approved set).
       */
      await db.update(prospectQueue).set({
        sequenceStatus: "approved",
        approvedAt: sql`COALESCE(${prospectQueue.approvedAt}, NOW())`,
        approvedByUserId: sql`COALESCE(${prospectQueue.approvedByUserId}, ${ctx.user.id})`,
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
    // 100 was below the size of a real campaign's queue (101 rows live), which
    // is how a page boundary became a missing feature.
    .input(z.object({ campaignId: z.number(), limit: z.number().default(500) }))
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
          cadenceDayOffsets: prospectIntelligence.cadenceDayOffsets,
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
            // Filter in SQL, not after. The LIMIT below used to be applied to
            // the UNfiltered set and then trimmed in JS, so skipped rows ate
            // slots and pushed real ones off the end of the page.
            or(
              ne(prospectQueue.sequenceStatus, "skipped"),
              isNotNull(prospectIntelligence.generatedSequence),
            ),
          ),
        )
        // Active sequences FIRST, then a stable id order.
        //
        // There was no ORDER BY at all, so MySQL returned an arbitrary page.
        // Live: campaign 21 holds 101 queue rows; LIMIT 100 dropped exactly one
        // of them, and the one it dropped was the campaign's ONLY enrolled
        // prospect — so the Active tab read "No prospects in 'Active'" while a
        // sequence was running. Ordering by status guarantees the rows a user
        // is most likely to be looking for cannot be the ones truncated.
        .orderBy(
          sql`CASE WHEN ${prospectQueue.sequenceStatus} IN ('enrolled','paused') THEN 0
                   WHEN ${prospectQueue.sequenceStatus} IN ('approved','replied','completed') THEN 1
                   ELSE 2 END`,
          prospectQueue.id,
        )
        .limit(input.limit);
      // Show a prospect unless they were deliberately dismissed.
      //
      // This used to require a sequence OR an approved/enrolled status, which
      // made the tab unusable exactly when it was needed: a "pending" prospect
      // has no sequence, so it was filtered out, so it never appeared, so the
      // Generate button next to it could never be clicked. Chicken and egg.
      // Live: campaign 21 held 88 prospects — 87 pending, 1 enrolled — and this
      // list returned ONE row.
      //
      // The row UI has always handled the empty case ("no sequence" + a
      // Generate action), and the tab's own filter bar offers "pending", so the
      // client was built for these rows all along. Only `skipped` is hidden,
      // and only when there is nothing to show: a skipped prospect that already
      // has a sequence still appears, because hiding real work is worse than
      // showing a dismissed row.
      return rows.filter((r) => {
        const hasSeq = Array.isArray(r.generatedSequence) && (r.generatedSequence as unknown[]).length > 0;
        return hasSeq || String(r.sequenceStatus) !== "skipped";
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

      const steps = intelArray<Record<string, unknown>>(intel.generatedSequence);
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
        .where(and(eq(prospectIntelligence.prospectQueueId, input.prospectId), eq(prospectIntelligence.workspaceId, ctx.workspace.id)));

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
              // Same normalisation as the engine's own write, so editing a step
              // cannot move its sends into a different A/B cell than the one
              // the scheduled row was already counted in.
              variantKey: normalizeVariantKey((updatedStep as { variantKey?: unknown }).variantKey),
            },
          })
          .where(queueWhere);
      }

      return { success: true, scheduledRowsUpdated };
    }),

  /**
   * Set (or clear) a prospect's sequence TIMELINE — the per-prospect override
   * of the campaign cadence (0170). `dayOffsets` are cumulative days from the
   * enrolment anchor, position-aligned with the ordered steps; null returns
   * the prospect to the campaign grid.
   *
   * Written for the mass timeline editor on the Sequences tab (owner ask
   * 2026-08-20: "mass edit the sequences, especially the sequence timeline"),
   * and called per-row by are.prospects.bulk — the same single-procedure rule
   * as every other bulk action, so the mass path and a future per-row button
   * cannot disagree.
   *
   * The override is only real because BOTH schedulers read it: enrolment
   * (areEngine) schedules new rows at anchor + offset, and this procedure
   * re-spaces any ALREADY-SCHEDULED rows immediately (sent rows are history
   * and never move) — a prospect edited after enrolment does not keep the old
   * rhythm until the next respace. Storing a timeline nothing consults would
   * be the inert-settings shape.
   */
  setSequenceTimeline: workspaceProcedure
    .input(z.object({
      prospectId: z.number(),
      /** Cumulative day offsets per ordered step; null clears the override. */
      dayOffsets: z.array(z.number().int().min(0).max(MAX_TIMELINE_DAY_OFFSET)).min(1).max(MAX_TIMELINE_STEPS).nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .select()
        .from(prospectQueue)
        .where(and(eq(prospectQueue.id, input.prospectId), eq(prospectQueue.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Prospect not found" });
      const [intel] = await db
        .select({ id: prospectIntelligence.id })
        .from(prospectIntelligence)
        .where(and(eq(prospectIntelligence.prospectQueueId, input.prospectId), eq(prospectIntelligence.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!intel) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No intelligence record yet — enrich the prospect first, then set its timeline" });
      }

      // The ONE sanitiser — what is stored is exactly what every reader will
      // see, so a non-decreasing 300-day-max timeline is a storage invariant,
      // not a hope.
      const clean = input.dayOffsets === null ? null : sanitizeDayOffsets(input.dayOffsets);
      if (input.dayOffsets !== null && clean === null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Timeline offsets must be a short list of whole day counts" });
      }
      await db
        .update(prospectIntelligence)
        .set({ cadenceDayOffsets: clean })
        .where(and(eq(prospectIntelligence.prospectQueueId, input.prospectId), eq(prospectIntelligence.workspaceId, ctx.workspace.id)));

      // Move any live scheduled rows onto the new timeline NOW. Clearing the
      // override re-spaces onto the campaign grid the same way.
      const execRows = await db
        .select({ id: areExecutionQueue.id, stepIndex: areExecutionQueue.stepIndex, status: areExecutionQueue.status, scheduledAt: areExecutionQueue.scheduledAt, executedAt: areExecutionQueue.executedAt })
        .from(areExecutionQueue)
        .where(and(eq(areExecutionQueue.workspaceId, ctx.workspace.id), eq(areExecutionQueue.prospectQueueId, input.prospectId)));
      let scheduledRowsMoved = 0;
      if (execRows.some((r) => r.status === "scheduled")) {
        const [campaign] = await db
          .select({ stepGapDays: areCampaigns.stepGapDays })
          .from(areCampaigns)
          .where(and(eq(areCampaigns.id, row.campaignId), eq(areCampaigns.workspaceId, ctx.workspace.id)))
          .limit(1);
        const gapDays = effectiveStepGapDays(campaign?.stepGapDays);
        const plan = planRespaceForProspect(execRows, gapDays, Date.now(), clean);
        for (const c of plan) {
          await db.update(areExecutionQueue).set({ scheduledAt: c.to })
            .where(and(eq(areExecutionQueue.id, c.id), eq(areExecutionQueue.workspaceId, ctx.workspace.id), eq(areExecutionQueue.status, "scheduled")));
        }
        scheduledRowsMoved = plan.length;
      }
      return { success: true, cleared: clean === null, scheduledRowsMoved };
    }),

  /**
   * Get A/B variant performance for a campaign.
   *
   * Reads COMPUTED stats (services/performanceMetrics) rather than the
   * are_ab_variants counter columns. Those columns were never written by any
   * code path, so this endpoint used to return sentCount/openCount/replyCount/
   * meetingCount permanently at 0 — the A/B tab's reply-rate bars always showed
   * 0%. Stats are now derived from dispatched execution-queue rows + signal log;
   * the stored row still supplies the subject line / hook type.
   */
  getAbVariants: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { getAbVariantStats } = await import("../../services/performanceMetrics");
      return getAbVariantStats(ctx.workspace.id, input.campaignId);
    }),

  /**
   * One row per SENT message — the individual dispatches getAbVariants rolls
   * up. Owner (2026-08-17): 31 step-1s dispatched should be 31 cards, not one
   * specimen. Same two tables, same attribution; see getDispatchStats.
   */
  getDispatches: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { getDispatchStats } = await import("../../services/performanceMetrics");
      return getDispatchStats(ctx.workspace.id, input.campaignId);
    }),

  /** Add a prospect manually */
  /**
   * Read-only data-quality audit over the whole workspace queue (all
   * campaigns): missing names, broken links, unlinked persons, duplicates,
   * cross-campaign claims, unreconcilable rows. Feeds the Audit card; the
   * fix half is `reconcile` below.
   */
  audit: workspaceProcedure.query(async ({ ctx }) => {
    const { auditQueueProspects } = await import("../../services/are/prospectReconcile");
    return auditQueueProspects(ctx.workspace.id);
  }),

  /**
   * The fix pass (manager+): scrub broken links, link/create canonical
   * persons, re-queue name-less rows that have a profile to enrich from,
   * confidence-gated LinkedIn discovery (bounded — spends bridged-account
   * search allowance), flag unreconcilable rows to Rejections, and enforce
   * one-campaign-per-prospect over historic rows (keeper = most engaged).
   * Audited; returns the run's numbers plus human-readable edge-case notes.
   */
  reconcile: workspaceProcedure
    .input(z.object({ linkedinSearchBudget: z.number().int().min(0).max(50).default(10) }).optional())
    .mutation(async ({ ctx, input }) => {
      requireMinRole(ctx.member.role, "manager", "Reconciling prospects requires manager access.");
      const { reconcileQueueProspects } = await import("../../services/are/prospectReconcile");
      const res = await reconcileQueueProspects({
        workspaceId: ctx.workspace.id,
        userId: ctx.user.id,
        isAdmin: isAdminRole(ctx.member.role),
        linkedinSearchBudget: input?.linkedinSearchBudget ?? 10,
      });
      await recordAudit({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id,
        action: "update", entityType: "are_prospect_reconcile", entityId: 0,
        after: { ...res, notes: res.notes.slice(0, 20) },
      });
      return res;
    }),

  /**
   * Push people who ALREADY exist in the CRM into a campaign and run them
   * through to a generated sequence (owner ask 2026-08-14).
   *
   * `addManual` below only ever accepted a person typed in by hand, and it had
   * no UI caller at all — so there was no way to take someone already in People
   * and put them into a campaign. The engine minting prospects itself was the
   * only route in.
   *
   * Identity, exclusivity and dedup all go through the SAME queueIdentity
   * vocabulary every other ingest seam uses. That is the point: a second way in
   * that invents its own dedup rule is how one person ends up in two campaigns.
   *
   * Enrichment then sequence generation are chained server-side and NOT awaited
   * — runSequenceAgent refuses a prospect with no intelligence, so the order
   * matters, and both are LLM-bound work that would time out an HTTP request.
   * The queue row is returned immediately; the campaign view already polls it.
   */
  pushExisting: workspaceProcedure
    .input(z.object({
      campaignId: z.number(),
      /** CRM prospect ids (People), not queue row ids. */
      prospectIds: z.array(z.number().int().positive()).min(1).max(100),
      /** Generate the sequence once enrichment lands. Off = just queue them. */
      generateSequence: z.boolean().default(true),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [campaign] = await db.select({ id: areCampaigns.id })
        .from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.campaignId), eq(areCampaigns.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });

      const people = await db
        .select({
          id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName,
          email: prospects.email, linkedinUrl: prospects.linkedinUrl, phone: prospects.phone,
          title: prospects.title, company: prospects.company, companyDomain: prospects.companyDomain,
        })
        .from(prospects)
        .where(and(eq(prospects.workspaceId, ctx.workspace.id), inArray(prospects.id, input.prospectIds)));

      const { workspaceQueueIdentityIndex, existingClaim } = await import("../../services/are/queueIdentity");
      const index = await workspaceQueueIdentityIndex(ctx.workspace.id);

      const added: Array<{ prospectId: number; queueId: number }> = [];
      const skipped: Array<{ prospectId: number; reason: string }> = [];

      for (const p of people) {
        const shape = {
          email: p.email, linkedinUrl: p.linkedinUrl,
          firstName: p.firstName, lastName: p.lastName,
          companyName: p.company, companyDomain: p.companyDomain,
        };
        // Identity-less rows are refused at ingest everywhere else; a manual
        // push is no exception. Without a key this person cannot be deduped,
        // and the queue fills with untraceable duplicates.
        const { queueIdentityKeys } = await import("../../services/are/queueIdentity");
        if (queueIdentityKeys(shape).length === 0) {
          skipped.push({ prospectId: p.id, reason: "No email, LinkedIn URL, or name + company to identify them by" });
          continue;
        }
        const claim = existingClaim(index, shape);
        if (claim) {
          skipped.push({
            prospectId: p.id,
            reason: claim.campaignId === input.campaignId
              ? "Already in this campaign"
              : `Already in another campaign (id ${claim.campaignId ?? "—"}) — a prospect can only be in one at a time`,
          });
          continue;
        }

        const [row] = await db.insert(prospectQueue).values({
          workspaceId: ctx.workspace.id,
          campaignId: input.campaignId,
          sourceType: "internal_contact",
          firstName: p.firstName, lastName: p.lastName,
          email: p.email, linkedinUrl: p.linkedinUrl, phone: p.phone,
          title: p.title, companyName: p.company, companyDomain: p.companyDomain,
          // The link back to People — what keeps enrichment, field history and
          // the drawer pointing at one person rather than a queue-only copy.
          personProspectId: p.id,
          icpMatchScore: 0,
          enrichmentStatus: "pending",
          sequenceStatus: "pending",
        }).$returningId();

        added.push({ prospectId: p.id, queueId: row.id });
        // Claim the identity for the rest of THIS batch too, so pushing the
        // same person twice in one selection cannot slip past.
        for (const k of queueIdentityKeys(shape)) if (!index.has(k)) index.set(k, { rowId: row.id, campaignId: input.campaignId });
      }

      // Enrich → sequence, in that order, off the request path.
      for (const a of added) {
        void (async () => {
          await runEnrichAgent(a.queueId, ctx.workspace.id);
          if (input.generateSequence) {
            // allowWithoutIntel: enrichment may legitimately find nothing for
            // this person, and a manual push should still produce a sequence.
            await runSequenceAgent(a.queueId, ctx.workspace.id, input.campaignId, { force: false, allowWithoutIntel: true });
          }
        })().catch((e) => console.error(`[are.pushExisting] queue ${a.queueId}:`, (e as Error)?.message ?? e));
      }

      await recordAudit({
        workspaceId: ctx.workspace.id, actorUserId: ctx.user.id,
        action: "create", entityType: "are_push_existing", entityId: input.campaignId,
        after: { added: added.length, skipped: skipped.length },
      });
      return { added, skipped };
    }),

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
      // Campaign exclusivity: refuse loudly rather than silently creating the
      // workspace's second copy of a person — the message names where they
      // already live so the user can go act on THAT row.
      const { workspaceQueueIdentityIndex, existingClaim } = await import("../../services/are/queueIdentity");
      const claim = existingClaim(await workspaceQueueIdentityIndex(ctx.workspace.id), rest);
      if (claim) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: claim.campaignId === campaignId
            ? "This prospect is already in this campaign."
            : `This prospect already belongs to another campaign (id ${claim.campaignId ?? "—"}). A prospect can only be in one campaign at a time.`,
        });
      }
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
  /**
   * Bulk-import prospects into a campaign from a CSV/list. This is the
   * "bring your own list" path — rows that already carry an email flow
   * straight through enrich → sequence → dispatch; rows with a company
   * domain but no email get one via the enrichment finder. Fills the gap
   * where ARE could only self-scrape or add one prospect at a time.
   */
  importRows: workspaceProcedure
    .input(z.object({
      campaignId: z.number(),
      rows: z.array(z.object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        email: z.string().optional(),
        title: z.string().optional(),
        companyName: z.string().optional(),
        companyDomain: z.string().optional(),
        phone: z.string().optional(),
        linkedinUrl: z.string().optional(),
        industry: z.string().optional(),
        geography: z.string().optional(),
      })).min(1).max(2000),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Campaign must belong to the workspace.
      const [camp] = await db.select({ id: areCampaigns.id })
        .from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.campaignId), eq(areCampaigns.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!camp) throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });

      // Clamp to column widths (same runtime-INSERT guard as the scrapers).
      const clamp = (v: unknown, n: number) => {
        const s = String(v ?? "").trim();
        return s ? (s.length > n ? s.slice(0, n) : s) : undefined;
      };
      const emailOf = (v: unknown) => {
        const s = String(v ?? "").trim().toLowerCase();
        return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s.slice(0, 320) : undefined;
      };

      // Dedup against the WHOLE workspace queue, not just this campaign —
      // campaign exclusivity (2026-08-12) means a row claimed by a sibling
      // campaign is skipped too, and reported under its own counter.
      const { workspaceQueueIdentityIndex, existingClaim, queueIdentityKeys } = await import("../../services/are/queueIdentity");
      const index = await workspaceQueueIdentityIndex(ctx.workspace.id);

      const rows: Array<typeof prospectQueue.$inferInsert> = [];
      let skippedDup = 0, skippedEmpty = 0, skippedOtherCampaign = 0;
      for (const r of input.rows) {
        const first = clamp(r.firstName, 80);
        const last = clamp(r.lastName, 80);
        const email = emailOf(r.email);
        const linkedinUrl = r.linkedinUrl ? String(r.linkedinUrl).trim() : undefined;
        // Need at least a name or an email to be worth anything.
        if (!first && !last && !email) { skippedEmpty++; continue; }
        const shape = { firstName: first, lastName: last, email, linkedinUrl, companyName: clamp(r.companyName, 200), companyDomain: clamp(r.companyDomain, 200) };
        const claim = existingClaim(index, shape);
        if (claim) {
          if (claim.campaignId === input.campaignId) skippedDup++;
          else skippedOtherCampaign++;
          continue;
        }
        for (const k of queueIdentityKeys(shape)) {
          index.set(k, { rowId: -1, campaignId: input.campaignId });
        }
        rows.push({
          workspaceId: ctx.workspace.id,
          campaignId: input.campaignId,
          sourceType: "internal_contact",
          firstName: first,
          lastName: last,
          email,
          title: clamp(r.title, 120),
          companyName: clamp(r.companyName, 200),
          companyDomain: clamp(r.companyDomain, 200),
          phone: clamp(r.phone, 40),
          linkedinUrl,
          industry: clamp(r.industry, 80),
          geography: clamp(r.geography, 120),
          icpMatchScore: 0,
          enrichmentStatus: "pending",
          sequenceStatus: "pending",
        });
      }

      let imported = 0;
      if (rows.length > 0) {
        try {
          await db.insert(prospectQueue).values(rows);
          imported = rows.length;
        } catch {
          // Per-row fallback so one bad row can't drop the whole import.
          for (const row of rows) {
            try { await db.insert(prospectQueue).values(row); imported++; } catch { /* skip */ }
          }
        }
      }
      return { imported, skippedDuplicates: skippedDup, skippedEmpty, skippedOtherCampaign, withEmail: rows.filter((r) => r.email).length };
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

  /**
   * Put approved prospects back in the review queue — the inverse of
   * bulkApprove, which had no inverse.
   *
   * Exists because on 2026-08-16 152 prospects were bulk-approved from the
   * owner's session on an instruction the owner did not intend as one, and
   * the only paths back were `reject` (skipped, out of the queue for good) and
   * `cancelSequence` (canceled, with a reason implying the sequence had run).
   * Neither says "this was never decided". This does: `pending`, approval
   * stamp cleared, every still-scheduled step skipped so nothing sends, and
   * the generated sequence LEFT IN PLACE — it is real work and the next
   * approver may want it. Idempotent: a pending row is untouched.
   *
   * Refuses rows that have already sent a step, unless `force`. A prospect who
   * has received an email is not un-decided; the caller has to say so.
   */
  bulkUnapprove: workspaceProcedure
    .input(z.object({
      prospectIds: z.array(z.number()).min(1).max(200),
      reason: z.string().max(500).optional(),
      /** Also revert prospects who have already had a step SENT. */
      force: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      let reverted = 0, stepsSkipped = 0, refusedSent = 0;
      const reasonText = `Approval reverted${input.reason ? ` — ${input.reason}` : ""}`;
      for (const id of input.prospectIds) {
        const [row] = await db.select({ status: prospectQueue.sequenceStatus, campaignId: prospectQueue.campaignId })
          .from(prospectQueue)
          .where(and(eq(prospectQueue.id, id), eq(prospectQueue.workspaceId, ctx.workspace.id)))
          .limit(1);
        if (!row || row.status === "pending") continue;
        if (!input.force) {
          const [sent] = await db.select({ n: sql<number>`count(*)` }).from(areExecutionQueue)
            .where(and(
              eq(areExecutionQueue.workspaceId, ctx.workspace.id),
              eq(areExecutionQueue.prospectQueueId, id),
              eq(areExecutionQueue.status, "sent"),
            ));
          if (Number(sent?.n ?? 0) > 0) { refusedSent++; continue; }
        }
        // Written out in full at the statement, not assembled — tenantScope.
        const skipRes = await db.update(areExecutionQueue).set({
          status: "skipped",
          failureReason: reasonText,
          executedAt: new Date(),
        }).where(and(
          eq(areExecutionQueue.workspaceId, ctx.workspace.id),
          eq(areExecutionQueue.prospectQueueId, id),
          eq(areExecutionQueue.status, "scheduled"),
        ));
        stepsSkipped += Number((skipRes[0] as any)?.affectedRows ?? 0);
        await db.update(prospectQueue).set({
          sequenceStatus: "pending",
          approvedAt: null,
          approvedByUserId: null,
          rejectedAt: null,
          rejectedByUserId: null,
          rejectionReason: null,
        }).where(and(eq(prospectQueue.id, id), eq(prospectQueue.workspaceId, ctx.workspace.id)));
        await db.insert(areEngineLogs).values({
          workspaceId: ctx.workspace.id,
          campaignId: row.campaignId,
          phase: "approval.revert",
          level: "info",
          message: `Approval reverted for prospect ${id} (was ${row.status}) — back to pending`,
          details: { prospectId: id, before: row.status, reason: input.reason ?? null, actorUserId: ctx.user.id },
        } as never);
        reverted++;
      }
      return { reverted, stepsSkipped, refusedSent };
    }),

  /** Bulk approve a list of prospects */
  /**
   * Display rows for a known set of this campaign's prospects — what a click
   * on a funnel band resolves to (the funnel carries the ids; this carries the
   * people). Scoped to the campaign, capped, ordered as requested.
   */
  byIds: workspaceProcedure
    .input(z.object({ campaignId: z.number().int().positive(), prospectIds: z.array(z.number().int().positive()).min(1).max(500) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const rows = await db
        .select({
          id: prospectQueue.id, firstName: prospectQueue.firstName, lastName: prospectQueue.lastName, title: prospectQueue.title,
          companyName: prospectQueue.companyName, email: prospectQueue.email, linkedinUrl: prospectQueue.linkedinUrl,
          sequenceStatus: prospectQueue.sequenceStatus, enrichmentStatus: prospectQueue.enrichmentStatus, icpMatchScore: prospectQueue.icpMatchScore,
          personProspectId: prospectQueue.personProspectId,
        })
        .from(prospectQueue)
        .where(and(eq(prospectQueue.workspaceId, ctx.workspace.id), eq(prospectQueue.campaignId, input.campaignId), inArray(prospectQueue.id, input.prospectIds)));
      const order = new Map(input.prospectIds.map((id, i) => [id, i] as const));
      return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    }),

  /** Mass actions on this campaign's prospects — see prospectsBulk.ts. */
  bulk: workspaceProcedure
    .input(BULK_INPUT)
    .mutation(async ({ ctx, input }) => {
      requireMinRole(ctx.member.role, "manager", "Only managers and admins can run bulk actions.");
      return runBulkAction(ctx as never, input);
    }),

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
          /**
           * One at a time through the shared gate rather than a bulk insert.
           * Two things it fixes: the "Someone @mentions me" switch was never
           * consulted, and the member lookup above joins `workspaceMembers`
           * with NO `deactivatedAt` filter — so a departed colleague still
           * matched a name and was still notified. `notifyIfEnabled`
           * re-resolves every recipient.
           *
           * A loop of single inserts costs more round-trips than one bulk
           * insert; the mention list is a handful of people at most, and
           * correctness per recipient is worth more than one query.
           */
          for (const uid of mentionedUserIds) {
            await notifyIfEnabled({
              workspaceId: ctx.workspace.id,
              userId: uid,
              event: "mention",
              kind: "mention",
              title: `${ctx.user.name ?? "Someone"} mentioned you in a prospect note`,
              body: deepLinkMeta + input.body.slice(0, 240),
              relatedType: "prospect_note",
              relatedId: row.id,
            });
          }
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
      await db.delete(prospectNotes).where(and(
        eq(prospectNotes.id, input.noteId),
        eq(prospectNotes.workspaceId, ctx.workspace.id),
      ));
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
      // Get latest active ICP + the campaign's own targeting — the effective
      // ICP (overrides win) is what the prospect must be graded against.
      const [icp] = await db
        .select()
        .from(icpProfiles)
        .where(and(eq(icpProfiles.workspaceId, ctx.workspace.id), eq(icpProfiles.isActive, true)))
        .limit(1);
      const [reCamp] = await db
        .select({ icpOverrides: areCampaigns.icpOverrides })
        .from(areCampaigns)
        .where(and(eq(areCampaigns.id, prospect.campaignId), eq(areCampaigns.workspaceId, ctx.workspace.id)))
        .limit(1);
      const effectiveIcp = buildEffectiveIcp(icp, reCamp?.icpOverrides);
      if (!effectiveIcp) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active ICP profile or campaign targeting" });
      const match = await scoreIcpMatch(prospect, effectiveIcp, ctx.workspace.id);
      const autoApproveThreshold = 70; // fallback default
      const newStatus = match.score >= autoApproveThreshold ? "pending" : "skipped";
      await db.update(prospectQueue).set({
        icpMatchScore: match.score,
        icpMatchBreakdown: JSON.stringify(match.breakdown),
        sequenceStatus: newStatus,
        rejectedAt: newStatus === "pending" ? null : prospect.rejectedAt,
        rejectionReason: newStatus === "pending" ? null : prospect.rejectionReason,
      }).where(and(eq(prospectQueue.id, input.prospectId), eq(prospectQueue.workspaceId, ctx.workspace.id)));
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
      // Get the campaign to read its actual autoApproveThreshold + targeting
      const [campaign] = await db
        .select({ autoApproveThreshold: areCampaigns.autoApproveThreshold, icpOverrides: areCampaigns.icpOverrides })
        .from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.campaignId), eq(areCampaigns.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      // Get latest active ICP; grade against the campaign-effective ICP.
      const [icp] = await db
        .select()
        .from(icpProfiles)
        .where(and(eq(icpProfiles.workspaceId, ctx.workspace.id), eq(icpProfiles.isActive, true)))
        .limit(1);
      const effectiveIcp = buildEffectiveIcp(icp, campaign.icpOverrides);
      if (!effectiveIcp) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No active ICP profile or campaign targeting" });
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
          const match = await scoreIcpMatch(prospect, effectiveIcp, ctx.workspace.id);
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