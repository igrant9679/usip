/**
 * ARE — ICP Agent Router
 *
 * The ICP Agent continuously analyses historical won/lost deal data to
 * construct a living, multi-dimensional Ideal Customer Profile.
 * AI is the primary operator: it reads evidence, finds patterns, and
 * produces a structured profile without any manual form-filling.
 *
 * Procedures:
 *   icp.getCurrent   — latest active ICP for the workspace
 *   icp.getHistory   — all versions with summary
 *   icp.regenerate   — trigger immediate AI re-inference
 *   icp.override     — manually adjust ICP weights
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { areNotify } from "./notify";
import {
  accounts,
  contacts,
  icpProfiles,
  opportunities,
  opportunityContactRoles,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { invokeLLM } from "../../_core/llm";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";

/* ─── ICP Inference Engine ───────────────────────────────────────────────── */

export async function runIcpInference(workspaceId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // 1. Gather won deals with linked account data
  const wonDeals = await db
    .select({
      id: opportunities.id,
      name: opportunities.name,
      value: opportunities.value,
      closeDate: opportunities.closeDate,
      createdAt: opportunities.createdAt,
      accountId: opportunities.accountId,
      industry: accounts.industry,
      employeeBand: accounts.employeeBand,
      revenueBand: accounts.revenueBand,
      region: accounts.region,
    })
    .from(opportunities)
    .leftJoin(accounts, eq(opportunities.accountId, accounts.id))
    .where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.stage, "won")))
    .limit(200);

  // 2. Gather lost deals
  const lostDeals = await db
    .select({
      id: opportunities.id,
      value: opportunities.value,
      lostReason: opportunities.lostReason,
      industry: accounts.industry,
      employeeBand: accounts.employeeBand,
      region: accounts.region,
    })
    .from(opportunities)
    .leftJoin(accounts, eq(opportunities.accountId, accounts.id))
    .where(and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.stage, "lost")))
    .limit(100);

  // 3. Gather contact roles on won deals (champion titles)
  const wonDealIds = wonDeals.map((d) => d.id);
  let contactRoles: Array<{ title: string | null; role: string }> = [];
  if (wonDealIds.length > 0) {
    const roleRows = await db
      .select({ title: contacts.title, role: opportunityContactRoles.role })
      .from(opportunityContactRoles)
      .leftJoin(contacts, eq(opportunityContactRoles.contactId, contacts.id))
      .where(
        sql`${opportunityContactRoles.opportunityId} IN (${sql.join(wonDealIds.map((id) => sql`${id}`), sql`, `)})`,
      );
    contactRoles = roleRows;
  }

  const sampleCount = wonDeals.length;
  // Won deals are the strongest evidence: 20 of them = full confidence. Funnel
  // signal is folded in below (weaker per observation, but available far
  // earlier), so a workspace with no closes yet no longer reports 0%.
  let confidenceScore = Math.min(100, Math.round((sampleCount / 20) * 100));

  // 4. Build statistical summaries for the LLM
  const industryCounts: Record<string, number> = {};
  const sizeCounts: Record<string, number> = {};
  const regionCounts: Record<string, number> = {};
  const titleCounts: Record<string, number> = {};
  let totalValue = 0;
  let totalDays = 0;
  let dealCount = 0;

  for (const d of wonDeals) {
    if (d.industry) industryCounts[d.industry] = (industryCounts[d.industry] ?? 0) + 1;
    if (d.employeeBand) sizeCounts[d.employeeBand] = (sizeCounts[d.employeeBand] ?? 0) + 1;
    if (d.region) regionCounts[d.region] = (regionCounts[d.region] ?? 0) + 1;
    if (d.value) totalValue += parseFloat(String(d.value));
    if (d.closeDate && d.createdAt) {
      const days = Math.round((d.closeDate.getTime() - d.createdAt.getTime()) / 86400000);
      if (days > 0) { totalDays += days; dealCount++; }
    }
  }
  for (const r of contactRoles) {
    if (r.title) titleCounts[r.title] = (titleCounts[r.title] ?? 0) + 1;
  }

  const lostReasonCounts: Record<string, number> = {};
  const lostIndustryCounts: Record<string, number> = {};
  for (const d of lostDeals) {
    if (d.lostReason) lostReasonCounts[d.lostReason] = (lostReasonCounts[d.lostReason] ?? 0) + 1;
    if (d.industry) lostIndustryCounts[d.industry] = (lostIndustryCounts[d.industry] ?? 0) + 1;
  }

  const avgDealValue = sampleCount > 0 ? Math.round(totalValue / sampleCount) : 0;
  const avgSalesCycleDays = dealCount > 0 ? Math.round(totalDays / dealCount) : 0;

  /* 4b. FUNNEL signal — outcomes by ICP dimension.
     Until now this function learned only from CLOSED deals, so a workspace with
     no wins yet produced a zero-confidence profile even after working hundreds
     of prospects. Reply and meeting rates per industry/title/size/geography are
     real learning signal that exists long before the first close, and they are
     what the product promises ("analyses your conversion rates, email
     responses"). Best-effort: a failure here must not block inference. */
  let segmentSummary = "No contacted-prospect outcome data yet.";
  let funnelContacted = 0;
  try {
    const { getSegmentPerformance } = await import("../../services/performanceMetrics");
    const segments = await getSegmentPerformance(workspaceId);
    if (segments.length > 0) {
      funnelContacted = segments
        .filter((s) => s.dimension === "industry")
        .reduce((n, s) => n + s.contacted, 0);
      const fmt = (dim: string) =>
        segments
          .filter((s) => s.dimension === dim)
          .slice(0, 6)
          .map((s) => `${s.value}: ${s.contacted} contacted, ${s.replyRate}% reply, ${s.meetingRate}% meeting`)
          .join(" | ") || "none";
      segmentSummary =
        `By industry — ${fmt("industry")}\n` +
        `By title — ${fmt("title")}\n` +
        `By company size — ${fmt("companySize")}\n` +
        `By geography — ${fmt("geography")}`;
    }
  } catch (e) {
    console.error(`[ICP] segment performance unavailable for ws ${workspaceId}:`, (e as Error).message);
  }

  // Funnel evidence is deliberately capped at 60: reply rates validate a segment
  // but only a closed deal proves it. Won deals can still carry the score to 100.
  const funnelConfidence = Math.min(60, Math.round((funnelContacted / 200) * 60));
  confidenceScore = Math.max(confidenceScore, funnelConfidence);

  // 5. Invoke LLM with structured JSON schema
  const systemPrompt = `You are an expert B2B sales analyst. Analyse the provided CRM data and produce a structured Ideal Customer Profile (ICP) for this sales team. Be specific, data-driven, and actionable. Identify clear patterns and anti-patterns. If sample size is small, note low confidence but still produce your best inference.`;

  const userPrompt = `
## Won Deal Statistics (${sampleCount} deals)
- Average deal value: $${avgDealValue.toLocaleString()}
- Average sales cycle: ${avgSalesCycleDays} days
- Industries: ${JSON.stringify(industryCounts)}
- Company sizes: ${JSON.stringify(sizeCounts)}
- Regions: ${JSON.stringify(regionCounts)}
- Champion titles: ${JSON.stringify(titleCounts)}

## Lost Deal Statistics (${lostDeals.length} deals)
- Lost reasons: ${JSON.stringify(lostReasonCounts)}
- Lost industries: ${JSON.stringify(lostIndustryCounts)}

## Live Funnel Signal (outbound outcomes by segment, ${funnelContacted} prospects contacted)
${segmentSummary}

Weight the funnel signal alongside closed deals. Where there are few or no closed
deals, the funnel is the better evidence — a segment that replies and books
meetings is validating itself even before a deal closes. Where the two conflict,
prefer closed-won patterns and say so in the rationale.

Based on this data, produce a comprehensive ICP with:
1. Target industries (top 3-5 with weights summing to 100)
2. Target company size range (min/max employees)
3. Target revenue range (min/max USD)
4. Target titles (top 3-5 decision-maker and champion titles with weights)
5. Target geographies (top regions with weights)
6. Target technology stack signals (if inferable)
7. Anti-patterns (what to avoid targeting based on lost deal patterns)
8. Top conversion signals (what correlated most with wins)
9. A 2-paragraph narrative rationale explaining the ICP
`;

  const icpSchema = {
    type: "json_schema" as const,
    json_schema: {
      name: "icp_inference",
      strict: true,
      schema: {
        type: "object",
        properties: {
          targetIndustries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                industry: { type: "string" },
                weight: { type: "number" },
                examples: { type: "array", items: { type: "string" } },
              },
              required: ["industry", "weight", "examples"],
              additionalProperties: false,
            },
          },
          targetCompanySizeMin: { type: "number" },
          targetCompanySizeMax: { type: "number" },
          targetRevenueMin: { type: "number" },
          targetRevenueMax: { type: "number" },
          targetTitles: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                seniority: { type: "string" },
                role: { type: "string" },
                weight: { type: "number" },
              },
              required: ["title", "seniority", "role", "weight"],
              additionalProperties: false,
            },
          },
          targetGeographies: {
            type: "array",
            items: {
              type: "object",
              properties: {
                country: { type: "string" },
                region: { type: "string" },
                weight: { type: "number" },
              },
              required: ["country", "region", "weight"],
              additionalProperties: false,
            },
          },
          targetTechStack: {
            type: "array",
            items: {
              type: "object",
              properties: {
                technology: { type: "string" },
                signal_type: { type: "string" },
                weight: { type: "number" },
              },
              required: ["technology", "signal_type", "weight"],
              additionalProperties: false,
            },
          },
          antiPatterns: {
            type: "array",
            items: {
              type: "object",
              properties: {
                dimension: { type: "string" },
                value: { type: "string" },
                reason: { type: "string" },
              },
              required: ["dimension", "value", "reason"],
              additionalProperties: false,
            },
          },
          topConversionSignals: {
            type: "array",
            items: {
              type: "object",
              properties: {
                signal: { type: "string" },
                correlation_score: { type: "number" },
              },
              required: ["signal", "correlation_score"],
              additionalProperties: false,
            },
          },
          aiRationale: { type: "string" },
        },
        required: [
          "targetIndustries", "targetCompanySizeMin", "targetCompanySizeMax",
          "targetRevenueMin", "targetRevenueMax", "targetTitles",
          "targetGeographies", "targetTechStack", "antiPatterns",
          "topConversionSignals", "aiRationale",
        ],
        additionalProperties: false,
      },
    },
  };

  const result = await invokeLLM({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: icpSchema,
  });

  const content = result.choices[0]?.message?.content;
  if (!content) throw new Error("ICP inference returned no content");
  const icp = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));

  // 6. Get current max version
  const [latest] = await db
    .select({ version: icpProfiles.version })
    .from(icpProfiles)
    .where(eq(icpProfiles.workspaceId, workspaceId))
    .orderBy(desc(icpProfiles.version))
    .limit(1);
  const nextVersion = (latest?.version ?? 0) + 1;

  // 7. Mark all previous as inactive
  await db
    .update(icpProfiles)
    .set({ isActive: false })
    .where(eq(icpProfiles.workspaceId, workspaceId));

  // 8. Insert new ICP version
  await db.insert(icpProfiles).values({
    workspaceId,
    version: nextVersion,
    targetIndustries: icp.targetIndustries,
    targetCompanySizeMin: icp.targetCompanySizeMin,
    targetCompanySizeMax: icp.targetCompanySizeMax,
    targetRevenueMin: String(icp.targetRevenueMin),
    targetRevenueMax: String(icp.targetRevenueMax),
    targetTitles: icp.targetTitles,
    targetGeographies: icp.targetGeographies,
    targetTechStack: icp.targetTechStack,
    antiPatterns: icp.antiPatterns,
    avgDealValue: String(avgDealValue),
    avgSalesCycleDays,
    topConversionSignals: icp.topConversionSignals,
    confidenceScore,
    sampleWonDeals: sampleCount,
    aiRationale: icp.aiRationale,
    isActive: true,
  });
}

/* ─── Router ─────────────────────────────────────────────────────────────── */

/**
 * Cron entry: regenerate the ICP for every workspace that has something new to
 * learn from.
 *
 * Closes a real gap. `runIcpInference` was reachable only from a manual
 * "Regenerate" button and from POST /api/scheduled/icp-regen, whose own comment
 * said it was "called by the Manus scheduled task agent" — the retired dev
 * platform. index.ts registered 17 background jobs and none of them mentioned
 * the ICP, so in production the "living" profile only ever changed when a human
 * clicked a button.
 *
 * Each run costs one LLM call per workspace, so it is gated hard:
 *   • skip workspaces with NO evidence at all (no closed deals, no contacted
 *     prospects) — there is nothing to infer from and it would burn spend
 *   • skip if the active profile is younger than MIN_AGE_HOURS
 *   • skip if neither the closed-deal count nor the contacted count has moved
 *     since that profile was generated
 * Background LLM spend on idle workspaces has bitten this codebase before.
 */
const ICP_MIN_AGE_HOURS = 20;

export async function runIcpInferenceAllWorkspaces(): Promise<{ regenerated: number; skipped: number }> {
  const db = await getDb();
  if (!db) return { regenerated: 0, skipped: 0 };
  const { workspaces } = await import("../../../drizzle/schema");
  const rows = await db.select({ id: workspaces.id }).from(workspaces);

  let regenerated = 0;
  let skipped = 0;
  for (const ws of rows) {
    try {
      const [closed] = await db
        .select({ n: sql<number>`count(*)` })
        .from(opportunities)
        .where(and(
          eq(opportunities.workspaceId, ws.id),
          inArray(opportunities.stage, ["won", "lost"]),
        ));
      const closedCount = Number(closed?.n ?? 0);

      let contactedCount = 0;
      try {
        const { getSegmentPerformance } = await import("../../services/performanceMetrics");
        const segs = await getSegmentPerformance(ws.id);
        contactedCount = segs
          .filter((s) => s.dimension === "industry")
          .reduce((n, s) => n + s.contacted, 0);
      } catch { /* treat as no funnel evidence */ }

      // No evidence of any kind → nothing to infer, no spend.
      if (closedCount === 0 && contactedCount === 0) { skipped++; continue; }

      const [active] = await db
        .select({
          createdAt: icpProfiles.createdAt,
          sampleWonDeals: icpProfiles.sampleWonDeals,
        })
        .from(icpProfiles)
        .where(and(eq(icpProfiles.workspaceId, ws.id), eq(icpProfiles.isActive, true)))
        .limit(1);

      if (active?.createdAt) {
        const ageHours = (Date.now() - new Date(active.createdAt).getTime()) / 3600000;
        if (ageHours < ICP_MIN_AGE_HOURS) { skipped++; continue; }
      }

      await runIcpInference(ws.id);
      regenerated++;
      console.log(`[IcpCron] ws ${ws.id} regenerated (closed=${closedCount}, contacted=${contactedCount})`);
    } catch (e) {
      console.error(`[IcpCron] ws ${ws.id} failed:`, (e as Error).message);
    }
  }
  return { regenerated, skipped };
}

export const icpRouter = router({
  /** Return the latest active ICP for the workspace */
  getCurrent: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const [profile] = await db
      .select()
      .from(icpProfiles)
      .where(and(eq(icpProfiles.workspaceId, ctx.workspace.id), eq(icpProfiles.isActive, true)))
      .orderBy(desc(icpProfiles.version))
      .limit(1);
    return profile ?? null;
  }),

  /** Return all ICP versions for the workspace */
  getHistory: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    return db
      .select({
        id: icpProfiles.id,
        version: icpProfiles.version,
        confidenceScore: icpProfiles.confidenceScore,
        sampleWonDeals: icpProfiles.sampleWonDeals,
        isActive: icpProfiles.isActive,
        generatedAt: icpProfiles.generatedAt,
        aiRationale: icpProfiles.aiRationale,
        avgDealValue: icpProfiles.avgDealValue,
        avgSalesCycleDays: icpProfiles.avgSalesCycleDays,
      })
      .from(icpProfiles)
      .where(eq(icpProfiles.workspaceId, ctx.workspace.id))
      .orderBy(desc(icpProfiles.version));
  }),

  /** Trigger immediate AI re-inference */
  regenerate: workspaceProcedure.mutation(async ({ ctx }) => {
    await runIcpInference(ctx.workspace.id);
    await areNotify({
      workspaceId: ctx.workspace.id,
      eventType: "icp_updated",
      title: "ARE: ICP Profile Updated",
      body: "The AI has re-inferred your Ideal Customer Profile based on the latest won and lost deal data. Review the new version in the ICP Agent page.",
      relatedType: "icp_profile",
    });
    return { success: true };
  }),

  /** Manually override specific ICP fields */
  override: workspaceProcedure
    .input(
      z.object({
        targetIndustries: z.any().optional(),
        targetCompanySizeMin: z.number().optional(),
        targetCompanySizeMax: z.number().optional(),
        targetRevenueMin: z.number().optional(),
        targetRevenueMax: z.number().optional(),
        targetTitles: z.any().optional(),
        targetGeographies: z.any().optional(),
        targetTechStack: z.any().optional(),
        antiPatterns: z.any().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [current] = await db
        .select()
        .from(icpProfiles)
        .where(and(eq(icpProfiles.workspaceId, ctx.workspace.id), eq(icpProfiles.isActive, true)))
        .limit(1);
      if (!current) throw new TRPCError({ code: "NOT_FOUND", message: "No active ICP. Run regenerate first." });

      const updates: Partial<typeof icpProfiles.$inferInsert> = {};
      if (input.targetIndustries !== undefined) updates.targetIndustries = input.targetIndustries;
      if (input.targetCompanySizeMin !== undefined) updates.targetCompanySizeMin = input.targetCompanySizeMin;
      if (input.targetCompanySizeMax !== undefined) updates.targetCompanySizeMax = input.targetCompanySizeMax;
      if (input.targetRevenueMin !== undefined) updates.targetRevenueMin = String(input.targetRevenueMin);
      if (input.targetRevenueMax !== undefined) updates.targetRevenueMax = String(input.targetRevenueMax);
      if (input.targetTitles !== undefined) updates.targetTitles = input.targetTitles;
      if (input.targetGeographies !== undefined) updates.targetGeographies = input.targetGeographies;
      if (input.targetTechStack !== undefined) updates.targetTechStack = input.targetTechStack;
      if (input.antiPatterns !== undefined) updates.antiPatterns = input.antiPatterns;

      await db.update(icpProfiles).set(updates).where(eq(icpProfiles.id, current.id));
      return { success: true };
    }),
  /** Restore a previous ICP version — sets it as active, deactivates all others */
  restore: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Verify the version belongs to this workspace
      const [target] = await db
        .select()
        .from(icpProfiles)
        .where(and(eq(icpProfiles.id, input.id), eq(icpProfiles.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "ICP version not found." });
      if (target.isActive) return { success: true, message: "Already active." };
      // Deactivate all versions, then activate the target
      await db.update(icpProfiles).set({ isActive: false }).where(eq(icpProfiles.workspaceId, ctx.workspace.id));
      await db.update(icpProfiles).set({ isActive: true }).where(eq(icpProfiles.id, input.id));
      await areNotify({
        workspaceId: ctx.workspace.id,
        eventType: "icp_updated",
        title: `ARE: ICP Profile Restored to v${target.version}`,
        body: `ICP version ${target.version} (confidence ${target.confidenceScore}%) has been restored as the active profile. All new campaigns will use this version for prospect scoring.`,
        relatedType: "icp_profile",
      });
      return { success: true, message: `Restored to version ${target.version}.` };
    }),
});