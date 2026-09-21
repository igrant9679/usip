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
import { archivedWorkspaceIds } from "../../_core/workspaceArchive";
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
import { closedStageKeys, lostStageKeys, wonStageKeys } from "../../_core/stageSemantics";
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
    .where(and(eq(opportunities.workspaceId, workspaceId), inArray(opportunities.stage, await wonStageKeys(db, workspaceId))))
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
    .where(and(eq(opportunities.workspaceId, workspaceId), inArray(opportunities.stage, await lostStageKeys(db, workspaceId))))
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
 * Each run costs one LLM call per workspace, so it is gated hard, in this order:
 *   • skip archived workspaces — they are frozen
 *   • skip workspaces whose ICP Re-inference Schedule is "manual"
 *   • skip workspaces with NO evidence at all (no closed deals, no contacted
 *     prospects) — there is nothing to infer from and it would burn spend
 *   • skip if the NEWEST profile is younger than the schedule's age floor
 *   • on "on_new_deal" only, skip if the won-deal count has not moved since
 *     that profile was generated
 * Background LLM spend on idle workspaces has bitten this codebase before.
 *
 * Until 2026-09-20 the schedule the user picked on ARE Settings was written to
 * workspace_settings and read by nothing: every workspace ran this daily
 * cadence whatever the card said, and "Manual Only" was not an Off switch at
 * all. Honouring it is what makes the control true.
 */
const ICP_MIN_AGE_HOURS = 20;
/** Age floor for workspaces on "weekly". 164h rather than a strict 7*24: the
 *  cron is boot-relative (server/_core/index.ts registers it as a setTimeout +
 *  24h setInterval), so a full 168 would push a pass past the next tick and
 *  silently stretch weekly into fortnightly on any restart. */
const ICP_WEEKLY_MIN_AGE_HOURS = 164;

export async function runIcpInferenceAllWorkspaces(): Promise<{ regenerated: number; skipped: number; failed: number }> {
  const db = await getDb();
  if (!db) return { regenerated: 0, skipped: 0, failed: 0 };
  const { workspaces, workspaceSettings } = await import("../../../drizzle/schema");
  // One join for the whole fleet rather than a settings SELECT inside the loop.
  // leftJoin because getOrSeedSettings inserts the row lazily, so a workspace
  // can legitimately have none; workspaceId is the PK on workspace_settings, so
  // the join is 1:1 and cannot multiply rows. Same shape as the cadence join in
  // services/enrichmentSweeper.ts.
  const rows = await db
    .select({ id: workspaces.id, schedule: workspaceSettings.areIcpRegenSchedule })
    .from(workspaces)
    .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, workspaces.id));

  let regenerated = 0;
  let skipped = 0;
  let failed = 0;
    const archivedWs = await archivedWorkspaceIds();
  for (const ws of rows) {
    if (archivedWs.has(ws.id)) continue; // archived workspaces are frozen (2026-08-12)
    // NULL means the workspace never touched the card, so it keeps the cadence
    // this cron has always run — wiring the setting up must not silently
    // re-time every existing workspace.
    const schedule = ws.schedule ?? "daily";
    // The Off position, and the cheapest gate here, so it precedes every query.
    if (schedule === "manual") { skipped++; continue; }
    try {
      const wonKeys = await wonStageKeys(db, ws.id);
      const [closed] = await db
        .select({
          n: sql<number>`count(*)`,
          // Folded into the existing aggregate rather than a second query. Won
          // stages are workspace-configurable, so this must ask stageSemantics
          // rather than compare against a literal 'won'.
          won: sql<number>`sum(case when ${inArray(opportunities.stage, wonKeys)} then 1 else 0 end)`,
        })
        .from(opportunities)
        .where(and(
          eq(opportunities.workspaceId, ws.id),
          inArray(opportunities.stage, await closedStageKeys(db, ws.id)),
        ));
      const closedCount = Number(closed?.n ?? 0);
      const wonCount = Number(closed?.won ?? 0); // mysql2 returns SUM() as a string

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

      // NEWEST, not ACTIVE: the question is "when did we last generate", not
      // "how old is the row that happens to be active". icp.restore re-activates
      // an older version and only flips isActive — icp_profiles.createdAt is
      // defaultNow with no onUpdateNow — so reading the active row made the very
      // next cron pass regenerate over the version a human had just chosen.
      // newest.createdAt is always >= active.createdAt, so this can only ever
      // skip more, never spend more.
      const [newest] = await db
        .select({
          createdAt: icpProfiles.createdAt,
          sampleWonDeals: icpProfiles.sampleWonDeals,
        })
        .from(icpProfiles)
        .where(eq(icpProfiles.workspaceId, ws.id))
        .orderBy(desc(icpProfiles.createdAt))
        .limit(1);

      const minAgeHours = schedule === "weekly" ? ICP_WEEKLY_MIN_AGE_HOURS : ICP_MIN_AGE_HOURS;
      if (newest?.createdAt) {
        const ageHours = (Date.now() - new Date(newest.createdAt).getTime()) / 3600000;
        if (ageHours < minAgeHours) { skipped++; continue; }
        // "On new won deal" can never be event-driven — nothing hooks a stage
        // move — so it re-infers on the first pass AFTER the won count moves.
        // The stored counter is the size of the 200-row won sample the profile
        // was built from (the .limit(200) above), so the live count is capped to
        // match. Past 200 wins that degrades to "never": failing closed costs
        // nothing, failing open would regenerate forever. The age floor still
        // applies on this branch, because POST /api/scheduled/icp-regen reaches
        // the same function and an external scheduler can call it at any rate.
        if (schedule === "on_new_deal" && Math.min(wonCount, 200) === newest.sampleWonDeals) { skipped++; continue; }
      }

      await runIcpInference(ws.id);
      regenerated++;
      // The only ICP regeneration that happens behind the user's back, and
      // until 2026-09-20 the only one that told nobody — both existing
      // icp_updated notices answer a button the user just pressed, so the
      // "ICP profile updated" switch on ARE Settings gated a confirmation of
      // the user's own click and nothing else. Bounded to at most one per
      // workspace per pass by the age floor above.
      await areNotify({
        workspaceId: ws.id,
        eventType: "icp_updated",
        title: "ARE: ICP profile re-inferred",
        body: "Your Ideal Customer Profile was regenerated automatically from the latest won and lost deals. Review the new version on the ICP Agent page.",
        relatedType: "icp_profile",
      });
      console.log(`[IcpCron] ws ${ws.id} regenerated (schedule=${schedule}, closed=${closedCount}, contacted=${contactedCount})`);
    } catch (e) {
      failed++;
      console.error(`[IcpCron] ws ${ws.id} failed:`, (e as Error).message);
    }
  }
  return { regenerated, skipped, failed };
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
      await db.update(icpProfiles).set({ isActive: true }).where(and(eq(icpProfiles.id, input.id), eq(icpProfiles.workspaceId, ctx.workspace.id)));
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