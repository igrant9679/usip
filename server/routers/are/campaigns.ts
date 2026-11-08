/**
 * ARE — Campaigns Router
 *
 * Manages autonomous prospecting campaign lifecycle:
 *   list, get, create, update, setStatus
 */
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { areCampaigns, areEngineLogs, campaignRoutingSuggestions, personas, prospectIntelligence, prospectQueue, prospects, researchSectors, sequences, workspaceSettings } from "../../../drizzle/schema";

/**
 * A first launch asks for the workspace's time zone while it is still the UTC
 * default (audit 2026-10-20, A31). The cap and the window moved to the
 * workspace's zone, but a workspace that never chose one still ran on UTC with
 * nothing saying so. A workspace that wants UTC launches with confirmTimezone.
 */
async function assertTimezoneChosen(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workspaceId: number): Promise<void> {
  const [row] = await db
    .select({ timezone: workspaceSettings.timezone })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .limit(1);
  const tz = String(row?.timezone ?? "").trim();
  if (!tz || tz === "UTC") throw new TRPCError({ code: "PRECONDITION_FAILED", message: TIMEZONE_UNSET_ON_LAUNCH });
}

/** The workspace's Revenue Engine daily cap (ARE Settings), as the engine reads it (A19). */
async function workspaceAreCap(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, workspaceId: number): Promise<number> {
  const [s] = await db.select({ cap: workspaceSettings.areDefaultDailySendCap }).from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId)).limit(1);
  return Number(s?.cap ?? ARE_WORKSPACE_DAILY_CAP_DEFAULT);
}

/** Archived campaigns (F15) only when asked for, else none of them. */
const archivedIs = (archived: boolean) => (archived ? isNotNull(areCampaigns.archivedAt) : isNull(areCampaigns.archivedAt));

/** A caller-chosen research sector must be this workspace's. */
async function assertResearchSectorInWorkspace(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, sectorId: number, workspaceId: number) {
  const [row] = await db
    .select({ id: researchSectors.id })
    .from(researchSectors)
    .where(and(eq(researchSectors.id, sectorId), eq(researchSectors.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Research sector not found" });
}
import { getDb } from "../../db";
import { router } from "../../_core/trpc";
import { adminWsProcedure, managerProcedure, workspaceProcedure } from "../../_core/workspace";
import { ARE_WORKSPACE_DAILY_CAP_DEFAULT, DISCOVERY_REST_MS, DISCOVERY_SOURCE_FEATURE, ENGINE_LOG_RETENTION_DAYS, areWorkspaceSendsLeft, runAreEngine } from "../../areEngine";
import { sendIncreaseRefusal } from "@shared/areCampaignBasics";
import { isOutboundPaused } from "../../services/outboundPause";
import { AI_CALLS_PER_SOURCE } from "@shared/spendPreview";
// Loaded with the router so the rewrite job's kind is registered at boot, and a
// job a restart cut off is picked up again (audit F14).
import "../../services/are/rewriteNotStarted";
import { listUsableAccounts } from "../../services/linkedinLookup";
import { getWorkspaceSendWindow } from "../../services/sendWindow";
import { getWorkspaceTimezone, startOfLocalDay } from "../../services/workspaceTimezone";
import { TIMEZONE_UNSET_ON_LAUNCH, describeSendWindow, isWithinSendWindow, nextSendWindowOpening } from "@shared/sendWindow";
import { promoteApprovedProspects } from "../../services/are/approvePromotion";
import { respaceOverdueSteps } from "../../services/are/stepHold";
import { recountCampaignCounters } from "../../services/are/campaignCounters";
import { campaignCapMessage, campaignHeadroom } from "../../services/are/campaignConcurrency";
import { getAreHubFunnelTotals } from "../../services/performanceMetrics";
import { recordAudit } from "../../audit";
import { invokeLLM, contentText } from "../../_core/llm";
import { ARE_DEFAULT_SOURCES, ARE_SOURCES, campaignSources, discoveryIsOff, normalizeSources, resolveSourceOrder, type AreSourceId } from "@shared/areSources";
import { MIN_STEP_GAP_DAYS, MAX_STEP_GAP_DAYS, effectiveStepGapDays, planRespaceForProspect, sanitizeDayOffsets } from "@shared/areStepCadence";
import { areExecutionQueue, sendingAccounts, spendLedger } from "../../../drizzle/schema";
import { EMPTY_FIXED_COPY, usableFixedSteps } from "@shared/areFixedCopy";
import { describeSources } from "../../services/prospectSources/registry";
import { spendDay } from "../../services/spend";
import { assertInWorkspace, requireInWorkspace } from "../../services/foreignIds";
import { campaignPreflight, preflightRefusal } from "../../services/are/campaignPreflight";
import { icpProfiles } from "../../../drizzle/schema";
import { affectedRowsOf, claimRow } from "../../_core/claim";

/** The model-token meters (services/spend), summed per source for F12. */
const TOKEN_METERS = ["input_tokens", "output_tokens", "cache_write_tokens", "cache_read_tokens"];
/** Which prospect_queue sourceType values each ARE source writes (routers/are/scraper.ts saveScrapeJobAndQueue). */
const QUEUE_TYPES_BY_SOURCE: Record<string, string[]> = {
  internal: ["internal_contact", "internal_lead"],
  linkedin: ["linkedin_people"],
  news: ["news_event"],
};


/**
 * The one surviving trace of a spent sender pool. When the pool reports every
 * mailbox spent the engine re-schedules the rows and clears their
 * failureReason (areEngine.ts:1923-1927), so this substring of the dispatch
 * log line is all there is to read. Kept here, next to the only reader, and
 * pinned to the engine's wording by a guard test — if the engine's phrasing
 * changes and this does not, the panel silently reports "no pool trouble" for
 * a pool that is spent.
 */
const POOL_HELD_MARKER = "email steps held and re-scheduled: ";

/**
 * The engine writes ONE discovery summary per call, carrying its per-source
 * breakdown in `details.perSource`. Matched by this prefix, and pinned to the
 * engine's own wording by a guard test for the same reason POOL_HELD_MARKER is:
 * if the engine rewords the line and this does not follow, every source reads
 * "never attempted" while discovery is running normally.
 */
const DISCOVERY_SUMMARY_MARKER = "Discovery slice ";

export const campaignsRouter = router({
  /** A page of campaigns, newest first; `count` is how many there are (audit 2026-10-20, A62). */
  list: workspaceProcedure
    .input(z.object({
      status: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
      /** Archived campaigns (F15) are left out unless this is true, which lists only them. */
      archived: z.boolean().default(false),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const conditions = [eq(areCampaigns.workspaceId, ctx.workspace.id), archivedIs(input.archived)];
      if (input.status) {
        conditions.push(eq(areCampaigns.status, input.status as "draft" | "active" | "paused" | "completed"));
      }
      return db
        .select()
        .from(areCampaigns)
        .where(and(...conditions))
        // The id breaks createdAt ties, so a campaign is on exactly one page.
        .orderBy(desc(areCampaigns.createdAt), desc(areCampaigns.id))
        .limit(input.limit)
        .offset(input.offset);
    }),

  count: workspaceProcedure
    .input(z.object({ status: z.string().optional(), archived: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const conditions = [eq(areCampaigns.workspaceId, ctx.workspace.id), archivedIs(input.archived)];
      if (input.status) {
        conditions.push(eq(areCampaigns.status, input.status as "draft" | "active" | "paused" | "completed"));
      }
      const [row] = await db.select({ n: sql<number>`count(*)` }).from(areCampaigns).where(and(...conditions));
      return { total: Number(row?.n ?? 0) };
    }),

  /**
   * The hub's Pipeline Funnel, for the WHOLE workspace.
   *
   * 🔴 The hub used to build it by summing the counter columns of whatever
   * `list({ limit: 100 })` returned — the newest hundred campaigns, ordered by
   * createdAt — and print the result as "{n} discovered". A 101st campaign
   * left the funnel silently, and the summed counters are denormalised (0175
   * had to hand-decrement meetingsBooked for phantom bookings). Derived from
   * source rows instead, by the same module /v2/analytics reads, so the two
   * funnels cannot print different numbers for the same word.
   */
  funnelTotals: workspaceProcedure.query(async ({ ctx }) => getAreHubFunnelTotals(ctx.workspace.id)),

  get: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [campaign] = await db
        .select()
        .from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id)))
        .limit(1);
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND" });
      // The header's counters, recounted now (A50): the engine only recounts
      // active campaigns, so a paused one's header froze. Stored back, so the
      // campaign list and the hub read the same numbers. A failed recount
      // leaves the stored ones: the page still opens.
      const counters = await recountCampaignCounters(db, ctx.workspace.id, campaign.id).catch((e) => {
        console.error(`[are.campaigns.get] recount failed for campaign ${campaign.id}:`, (e as Error)?.message ?? e);
        return {};
      });
      return { ...campaign, ...counters };
    }),

  create: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(2).max(200),
        description: z.string().optional(),
        autonomyMode: z.enum(["full", "batch_approval", "review_release"]).default("batch_approval"),
        icpProfileId: z.number().optional(),
        /**
         * Optional reusable persona to seed icpOverrides from. The persona's
         * targeting fields fill any unset fields on icpOverrides; explicit
         * icpOverrides keys win.
         */
        personaId: z.number().optional(),
        /** Research (phase 3): the sector whose research this campaign's AI writers use. Defaults to the persona's sector. */
        researchSectorId: z.number().int().nullable().optional(),
        /**
         * Per-campaign targeting that overrides the workspace ICP for this
         * campaign's discovery. The wizard fills this with
         * { targetTitles, targetIndustries, employeeMin, employeeMax, keywords }.
         */
        icpOverrides: z.any().optional(),
        // Default: every working source (shared/areSources.ts). Unknown ids
        // are dropped so a stale client can't persist a dead source.
        prospectSources: z
          .array(z.string())
          .default([...ARE_DEFAULT_SOURCES])
          .transform((v) => normalizeSources(v)),
        targetProspectCount: z.number().min(1).max(10000).default(100),
        dailySendCap: z.number().min(1).max(500).default(50),
        channelsEnabled: z.object({
          email: z.boolean().default(true),
          linkedin: z.boolean().default(false),
          sms: z.boolean().default(false),
          voice: z.boolean().default(false),
        }).default({ email: true, linkedin: false, sms: false, voice: false }),
        sequenceTemplate: z.string().default("standard_7step"),
        /** Days between consecutive steps (0169). Default one week. */
        stepGapDays: z.number().int().min(MIN_STEP_GAP_DAYS).max(MAX_STEP_GAP_DAYS).default(7),
        /** Optional free-form instructions appended to the Sequence Agent's
         *  system prompt for this campaign — voice, tone, do/don't lists. */
        sequencePrompt: z.string().max(4000).nullable().optional(),
        /** Structured prompting editor (0090). Subject/body are AI guidance;
         *  signature is a literal block appended to every generated email. */
        promptSubject: z.string().max(2000).nullable().optional(),
        promptBody: z.string().max(4000).nullable().optional(),
        promptSignature: z.string().max(2000).nullable().optional(),
        goalType: z.enum(["meeting_booked", "reply", "opportunity_created"]).default("reply"),
        autoApproveThreshold: z.number().min(0).max(100).nullable().optional(),
        signalToOpportunityEnabled: z.boolean().default(false),
        /**
         * When true, the campaign is created as `active` (not the default
         * `draft`) and the ARE engine is fired once in the background so the
         * user sees activity within seconds instead of waiting for the next
         * 10-minute cron tick.
         */
        launch: z.boolean().default(false),
        /** Launch even though the workspace's zone is still the UTC default (A31). */
        confirmTimezone: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.launch && !input.confirmTimezone) await assertTimezoneChosen(db, ctx.workspace.id);

      // Resolve persona → seed icpOverrides if a personaId was supplied.
      let icpOverrides: any = input.icpOverrides;
      // Research (phase 3): the campaign remembers its persona and sector so
      // its writers use that research instead of guessing from job titles.
      let personaIdKept: number | null = null;
      let researchSectorId: number | null = null;
      if (input.researchSectorId != null) {
        await assertResearchSectorInWorkspace(db, input.researchSectorId, ctx.workspace.id);
        researchSectorId = input.researchSectorId;
      }
      // The ICP profile it targets is this workspace's (audit 2026-10-20, X1.1).
      await assertInWorkspace(db, icpProfiles, input.icpProfileId, ctx.workspace.id, "ICP profile");
      if (input.personaId) {
        const [p] = await db
          .select()
          .from(personas)
          .where(and(eq(personas.id, input.personaId), eq(personas.workspaceId, ctx.workspace.id)))
          .limit(1);
        if (p) {
          personaIdKept = p.id;
          researchSectorId ??= p.sectorId ?? null;
          icpOverrides = {
            targetTitles: p.targetTitles ?? [],
            targetIndustries: p.targetIndustries ?? [],
            targetGeographies: p.targetGeographies ?? [],
            employeeMin: p.employeeMin ?? undefined,
            employeeMax: p.employeeMax ?? undefined,
            keywords: p.keywords ?? [],
            ...(input.icpOverrides ?? {}),
          };
        }
      }

      // Max Concurrent Campaigns, enforced at the door rather than in the tick
      // loop (2026-09-20 — the slider had saved a number nothing read since it
      // shipped). Drafts are always allowed: the limit is on what RUNS, and
      // refusing to let someone write a campaign down helps nobody.
      if (input.launch) {
        const h = await campaignHeadroom(ctx.workspace.id);
        if (!h.hasRoom) throw new TRPCError({ code: "FORBIDDEN", message: campaignCapMessage(h) });
      }

      const [row] = await db
        .insert(areCampaigns)
        .values({
          workspaceId: ctx.workspace.id,
          name: input.name,
          description: input.description,
          autonomyMode: input.autonomyMode,
          icpProfileId: input.icpProfileId,
          icpOverrides,
          prospectSources: input.prospectSources,
          targetProspectCount: input.targetProspectCount,
          dailySendCap: input.dailySendCap,
          channelsEnabled: input.channelsEnabled,
          sequenceTemplate: input.sequenceTemplate,
          stepGapDays: input.stepGapDays,
          sequencePrompt: input.sequencePrompt ?? null,
          promptSubject: input.promptSubject ?? null,
          promptBody: input.promptBody ?? null,
          promptSignature: input.promptSignature ?? null,
          goalType: input.goalType,
          autoApproveThreshold: input.autoApproveThreshold ?? null,
          signalToOpportunityEnabled: input.signalToOpportunityEnabled,
          personaId: personaIdKept,
          researchSectorId,
          ownerUserId: ctx.user.id,
          ...(input.launch ? { status: "active" as const, startedAt: new Date() } : {}),
        })
        .$returningId();
      // Kick the engine once immediately on launch so phase 1 (enrich) and
      // phase 8 (discovery) fire within seconds — the 10-min cron picks up
      // every subsequent tick on its own.
      if (input.launch) {
        runAreEngine({ workspaceId: ctx.workspace.id }).catch((e) =>
          console.error("[campaigns.create] launch tick failed:", e),
        );
      }
      return { id: row.id, launched: input.launch };
    }),

  /**
   * One dial for the whole engine (Autonomy Center, audit 2026-09-02). The
   * workspace default only ever governed campaigns created LATER, so the
   * page's "engine autonomy" control changed nothing that was running and
   * "All: Off" skipped the engine altogether. This sets every non-archived
   * campaign AND the default in one call. `full` approves+sends above each
   * campaign's own threshold; `batch_approval` is the engine's safest mode
   * (nothing approved without a human). review_release is gone: it never had
   * a branch — the engine treats any remaining rows as batch_approval.
   */
  /* ── Campaign routing (phase 3): the best-fit router ─────────────────── */

  getRoutingSettings: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { mode: "off" as const, dailyCap: 25, lastRunAt: null as Date | null };
    const [row] = await db.select({ mode: workspaceSettings.campaignRoutingMode, dailyCap: workspaceSettings.campaignRoutingDailyCap, lastRunAt: workspaceSettings.campaignRoutingLastRunAt })
      .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, ctx.workspace.id));
    return row ?? { mode: "off" as const, dailyCap: 25, lastRunAt: null };
  }),

  setRoutingSettings: adminWsProcedure
    .input(z.object({ mode: z.enum(["off", "approval", "auto"]), dailyCap: z.number().int().min(1).max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const set: Record<string, unknown> = { campaignRoutingMode: input.mode };
      if (input.dailyCap !== undefined) set.campaignRoutingDailyCap = input.dailyCap;
      await db.insert(workspaceSettings).values({ workspaceId: ctx.workspace.id, ...set } as never).onDuplicateKeyUpdate({ set: set as never });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "campaign_routing_settings", entityId: ctx.workspace.id, after: input });
      return { ok: true as const };
    }),

  /** Score people against every active campaign. Read-only: returns picks. */
  routeBestFit: workspaceProcedure
    .input(z.object({
      prospectIds: z.array(z.number().int().positive()).max(100).default([]),
      contactIds: z.array(z.number().int().positive()).max(100).default([]),
      leadIds: z.array(z.number().int().positive()).max(100).default([]),
    }).refine((v) => v.prospectIds.length + v.contactIds.length + v.leadIds.length > 0, { message: "Pick at least one person." }))
    .query(async ({ ctx, input }) => {
      const { resolveToPeopleIds } = await import("../../services/crossEngineEnrollment");
      const { routeProspects } = await import("../../services/campaignRouter");
      const resolved = await resolveToPeopleIds(ctx.workspace.id, input);
      const picks = await routeProspects(ctx.workspace.id, resolved.prospectIds);
      const db = await getDb();
      const names = db && resolved.prospectIds.length
        ? await db.select({ id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName }).from(prospects)
            .where(and(eq(prospects.workspaceId, ctx.workspace.id), inArray(prospects.id, resolved.prospectIds)))
        : [];
      const nameOf = new Map(names.map((n) => [n.id, `${n.firstName ?? ""} ${n.lastName ?? ""}`.trim()]));
      return { picks: picks.map((p) => ({ ...p, name: nameOf.get(p.prospectId) ?? `#${p.prospectId}` })), unresolved: resolved.unresolved };
    }),

  /** Enroll confirmed picks through the one write path. */
  applyBestFit: workspaceProcedure
    .input(z.object({ picks: z.array(z.object({ prospectId: z.number().int().positive(), campaignId: z.number().int().positive(), fit: z.number().int().min(0).max(100), reasoning: z.string().max(400).default("") })).min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      // Every pick's person and campaign are this workspace's (X1.1): the
      // routing suggestions below were written with whatever ids were sent.
      const db0 = await getDb();
      if (!db0) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await assertInWorkspace(db0, prospects, input.picks.map((p) => p.prospectId), ctx.workspace.id, "person");
      await assertInWorkspace(db0, areCampaigns, input.picks.map((p) => p.campaignId), ctx.workspace.id, "campaign");
      const { applyPicks } = await import("../../services/campaignRouter");
      const r = await applyPicks(ctx.workspace.id, input.picks.map((p) => ({ ...p, campaignName: null, alternatives: [], usedModel: false })));
      const db = await getDb();
      if (db) {
        await db.insert(campaignRoutingSuggestions).values(input.picks.map((p) => ({
          workspaceId: ctx.workspace.id, prospectId: p.prospectId, campaignId: p.campaignId, fit: p.fit, reasoning: p.reasoning,
          status: "accepted" as const, source: "manual" as const, decidedAt: new Date(), decidedBy: ctx.user.id,
        })) as never);
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "campaign_routing_apply", entityId: 0, after: r });
      return r;
    }),

  listRoutingSuggestions: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      return db.select({
        id: campaignRoutingSuggestions.id, prospectId: campaignRoutingSuggestions.prospectId, campaignId: campaignRoutingSuggestions.campaignId,
        campaignName: areCampaigns.name, fit: campaignRoutingSuggestions.fit, reasoning: campaignRoutingSuggestions.reasoning,
        alternatives: campaignRoutingSuggestions.alternatives, createdAt: campaignRoutingSuggestions.createdAt,
        firstName: prospects.firstName, lastName: prospects.lastName, title: prospects.title, company: prospects.company,
      })
        .from(campaignRoutingSuggestions)
        .innerJoin(areCampaigns, and(eq(areCampaigns.id, campaignRoutingSuggestions.campaignId), eq(areCampaigns.workspaceId, campaignRoutingSuggestions.workspaceId)))
        .innerJoin(prospects, and(eq(prospects.id, campaignRoutingSuggestions.prospectId), eq(prospects.workspaceId, campaignRoutingSuggestions.workspaceId)))
        .where(and(eq(campaignRoutingSuggestions.workspaceId, ctx.workspace.id), eq(campaignRoutingSuggestions.status, "pending")))
        .orderBy(desc(campaignRoutingSuggestions.fit), desc(campaignRoutingSuggestions.id))
        .limit(input?.limit ?? 50);
    }),

  decideRoutingSuggestion: workspaceProcedure
    .input(z.object({ id: z.number().int().positive(), decision: z.enum(["accept", "dismiss"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [s] = await db.select().from(campaignRoutingSuggestions)
        .where(and(eq(campaignRoutingSuggestions.id, input.id), eq(campaignRoutingSuggestions.workspaceId, ctx.workspace.id), eq(campaignRoutingSuggestions.status, "pending")));
      if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Suggestion not found or already decided" });
      let result: { added: number; skipped: number } = { added: 0, skipped: 0 };
      if (input.decision === "accept") {
        const { applyPicks } = await import("../../services/campaignRouter");
        result = await applyPicks(ctx.workspace.id, [{ prospectId: s.prospectId, campaignId: s.campaignId, campaignName: null, fit: s.fit, reasoning: s.reasoning ?? "", alternatives: [], usedModel: false }]);
      }
      await db.update(campaignRoutingSuggestions)
        .set({ status: input.decision === "accept" ? "accepted" : "dismissed", decidedAt: new Date(), decidedBy: ctx.user.id } as never)
        .where(and(eq(campaignRoutingSuggestions.id, input.id), eq(campaignRoutingSuggestions.workspaceId, ctx.workspace.id)));
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "campaign_routing_suggestion", entityId: input.id, after: { decision: input.decision, ...result } });
      return { ok: true as const, ...result };
    }),

  /**
   * Accept every pending routing suggestion at once (owner ask 2026-09-08).
   * Same write path as accepting one — applyPicks already takes an array —
   * so duplicates and people already in outreach are skipped, not doubled.
   * Bounded at 200 per call; the button shows the count it will act on.
   */
  acceptAllRoutingSuggestions: workspaceProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const rows = await db.select().from(campaignRoutingSuggestions)
      .where(and(eq(campaignRoutingSuggestions.workspaceId, ctx.workspace.id), eq(campaignRoutingSuggestions.status, "pending")))
      .orderBy(desc(campaignRoutingSuggestions.fit), desc(campaignRoutingSuggestions.id))
      .limit(200);
    if (rows.length === 0) return { ok: true as const, accepted: 0, added: 0, skipped: 0 };
    const { applyPicks } = await import("../../services/campaignRouter");
    const result = await applyPicks(ctx.workspace.id, rows.map((s) => ({ prospectId: s.prospectId, campaignId: s.campaignId, campaignName: null, fit: s.fit, reasoning: s.reasoning ?? "", alternatives: [], usedModel: false })));
    await db.update(campaignRoutingSuggestions)
      .set({ status: "accepted", decidedAt: new Date(), decidedBy: ctx.user.id } as never)
      .where(and(eq(campaignRoutingSuggestions.workspaceId, ctx.workspace.id), inArray(campaignRoutingSuggestions.id, rows.map((s) => s.id))));
    await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "campaign_routing_suggestion", entityId: 0, after: { acceptAll: rows.length, ...result } });
    return { ok: true as const, accepted: rows.length, ...result };
  }),

  /**
   * Proposed NEW campaigns (owner ask 2026-09-04): the people no active
   * campaign fits, clustered into audiences, each with the targeting and
   * copy mode a campaign for them would carry. Same dial as routing. All
   * logic in services/campaignProposals.ts; these are the seams.
   */
  listProposals: workspaceProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }).optional())
    .query(async ({ ctx, input }) => {
      const { listPendingProposals } = await import("../../services/campaignProposals");
      return listPendingProposals(ctx.workspace.id, input?.limit ?? 10);
    }),

  decideProposal: workspaceProcedure
    .input(z.object({ id: z.number().int().positive(), decision: z.enum(["accept", "dismiss"]) }))
    .mutation(async ({ ctx, input }) => {
      const { acceptProposal, dismissProposal } = await import("../../services/campaignProposals");
      let result: { campaignId: number | null; added: number; skipped: number };
      try {
        result = input.decision === "accept"
          ? await acceptProposal(ctx.workspace.id, input.id, ctx.user.id)
          : await dismissProposal(ctx.workspace.id, input.id, ctx.user.id);
      } catch (e) {
        throw new TRPCError({ code: "NOT_FOUND", message: (e as Error).message || "Proposal not found" });
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "campaign_proposal", entityId: input.id, after: { decision: input.decision, ...result } });
      return { ok: true as const, ...result };
    }),

  /**
   * Accept every pending proposal (owner ask 2026-09-08). Each becomes a
   * DRAFT campaign with its people queued pending — nothing sends until the
   * campaign is activated and its first batch approved, which is why a bulk
   * accept is safe here. One failure never blocks the rest.
   */
  acceptAllProposals: workspaceProcedure.mutation(async ({ ctx }) => {
    const { listPendingProposals, acceptProposal } = await import("../../services/campaignProposals");
    const pending = await listPendingProposals(ctx.workspace.id, 50);
    let created = 0, added = 0, skipped = 0;
    const failed: Array<{ id: number; detail: string }> = [];
    for (const p of pending) {
      try {
        const r = await acceptProposal(ctx.workspace.id, p.id, ctx.user.id);
        if (r.campaignId) created++;
        added += r.added; skipped += r.skipped;
        await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "campaign_proposal", entityId: p.id, after: { decision: "accept", bulk: true, ...r } });
      } catch (e) {
        failed.push({ id: p.id, detail: (e as Error).message });
      }
    }
    return { ok: true as const, created, added, skipped, failed };
  }),

  /** Admin: draft a pending proposal again with the model (same people, new name/targeting/copy). */
  redraftProposal: adminWsProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const { redraftProposal } = await import("../../services/campaignProposals");
      try {
        return await redraftProposal(ctx.workspace.id, input.id);
      } catch (e) {
        throw new TRPCError({ code: "NOT_FOUND", message: (e as Error).message || "Proposal not found" });
      }
    }),

  /** Admin: analyse People now and propose campaigns (records pending rows; never creates). */
  generateProposals: adminWsProcedure
    .mutation(async ({ ctx }) => {
      const { generateProposals } = await import("../../services/campaignProposals");
      const r = await generateProposals(ctx.workspace.id, { source: "manual" });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "campaign_proposal", entityId: ctx.workspace.id, after: r });
      return r;
    }),

  /**
   * A CRM Sequence becomes a fixed-copy campaign in the ONE engine (phase 6).
   * Email steps carry over verbatim (subject, body, merge tags); `days` gaps
   * become cumulative day offsets; task/wait steps only contribute their
   * gap. Created as a DRAFT with batch approval and no targeting, so the
   * owner reviews the steps and adds people (or targeting) before it sends.
   */
  createFixedFromSequence: workspaceProcedure
    .input(z.object({ sequenceId: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [seq] = await db.select().from(sequences)
        .where(and(eq(sequences.id, input.sequenceId), eq(sequences.workspaceId, ctx.workspace.id))).limit(1);
      if (!seq) throw new TRPCError({ code: "NOT_FOUND", message: "Sequence not found" });
      const raw = Array.isArray(seq.steps) ? (seq.steps as unknown[]) : [];
      let day = 0;
      const fixedSteps: Array<{ stepIndex: number; day: number; channel: "email"; subject: string; body: string }> = [];
      for (const s of raw) {
        const x = (s ?? {}) as Record<string, unknown>;
        const gap = Number(x.days ?? x.waitDays ?? 0);
        if (Number.isFinite(gap) && gap > 0) day += gap;
        if (x.enabled === false) continue;
        if (x.type !== "email") continue; // task/wait steps: gap only
        fixedSteps.push({
          stepIndex: fixedSteps.length,
          day,
          channel: "email",
          subject: String(x.subject ?? "").slice(0, 240),
          body: String(x.body ?? "").slice(0, 8000),
        });
      }
      if (fixedSteps.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "This sequence has no email steps to convert." });
      const name = `${seq.name}`.slice(0, 190);
      const [row] = await db.insert(areCampaigns).values({
        workspaceId: ctx.workspace.id,
        name,
        description: seq.description ?? `Converted from the sequence "${seq.name}" (phase 6)`,
        autonomyMode: "batch_approval",
        icpOverrides: {},
        prospectSources: ARE_DEFAULT_SOURCES,
        targetProspectCount: 100,
        dailySendCap: 25,
        channelsEnabled: { email: true, linkedin: false },
        // Inert on purpose, not an oversight: this campaign is copyMode "fixed"
        // (below), and runSequenceAgent's fixed branch returns before
        // generateCampaignTemplate is ever reached — so no skeleton is generated
        // and the step count comes from the converted sequence's own steps. Do
        // not "unify" this with the workspace default; it would read as a
        // promise the fixed path never keeps.
        sequenceTemplate: "standard_7step",
        stepGapDays: 7,
        goalType: "reply",
        ownerUserId: ctx.user.id,
        copyMode: "fixed",
        fixedSteps,
      } as never).$returningId();
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "create", entityType: "are_campaign_from_sequence", entityId: row.id, after: { sequenceId: seq.id, steps: fixedSteps.length } });
      return { id: row.id, name, steps: fixedSteps.length };
    }),

  /**
   * Rewrite enrolled sequences whose first step has not gone out, with the
   * workspace's current brand (owner ask 2026-09-24: "CommunityForce only,
   * not-yet-started prospects" — see services/are/rewriteNotStarted.ts).
   * Admin only. DRY RUN BY DEFAULT: returns what would be rewritten, per
   * campaign, and changes nothing; `dryRun: false` starts the background job.
   * Never sends; never moves a scheduled time; skips anyone already started.
   */
  rewriteNotStartedSequences: adminWsProcedure
    .input(z.object({ dryRun: z.boolean().default(true) }).optional())
    .mutation(async ({ ctx, input }) => {
      const { findNotStartedEnrolled, startRewriteNotStarted } = await import("../../services/are/rewriteNotStarted");
      const targets = await findNotStartedEnrolled(ctx.workspace.id);
      const byCampaign: Record<number, number> = {};
      for (const t of targets) byCampaign[t.campaignId] = (byCampaign[t.campaignId] ?? 0) + 1;
      if (input?.dryRun !== false) return { dryRun: true, eligible: targets.length, byCampaign, started: false };
      // A persisted job now (audit F14), so its progress survives a restart.
      const started = await startRewriteNotStarted(ctx.workspace.id, ctx.user.id, targets);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "are_rewrite_not_started", entityId: ctx.workspace.id, after: { eligible: targets.length, byCampaign, started } });
      return { dryRun: false, eligible: targets.length, byCampaign, started };
    }),

  /** Progress of the job above. */
  rewriteNotStartedStatus: workspaceProcedure.query(async ({ ctx }) => {
    const { rewriteJobState } = await import("../../services/are/rewriteNotStarted");
    return rewriteJobState(ctx.workspace.id);
  }),

  setAllAutonomy: adminWsProcedure
    .input(z.object({ mode: z.enum(["full", "batch_approval"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const res = await db.update(areCampaigns)
        .set({ autonomyMode: input.mode } as never)
        // Archived campaigns keep the mode they were archived with (F15).
        .where(and(eq(areCampaigns.workspaceId, ctx.workspace.id), isNull(areCampaigns.archivedAt)));
      await db.insert(workspaceSettings)
        .values({ workspaceId: ctx.workspace.id, areDefaultAutonomyMode: input.mode } as never)
        .onDuplicateKeyUpdate({ set: { areDefaultAutonomyMode: input.mode } as never });
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "are_autonomy_all", entityId: ctx.workspace.id, after: { mode: input.mode, campaignsUpdated: affectedRowsOf(res) } });
      return { ok: true as const, campaignsUpdated: affectedRowsOf(res) };
    }),

  update: workspaceProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(2).max(200).optional(),
        description: z.string().optional(),
        autonomyMode: z.enum(["full", "batch_approval", "review_release"]).optional(),
        // Copy mode (phase 6): per-person AI copy, or one fixed template per step.
        copyMode: z.enum(["per_person", "fixed"]).optional(),
        fixedSteps: z.array(z.object({
          stepIndex: z.number().int().min(0),
          day: z.number().int().min(0).max(365),
          channel: z.enum(["email", "linkedin"]).default("email"),
          subject: z.string().max(240).default(""),
          body: z.string().max(8000).default(""),
        })).max(12).optional(),
        targetProspectCount: z.number().min(1).max(10000).optional(),
        dailySendCap: z.number().min(1).max(500).optional(),
        channelsEnabled: z.any().optional(),
        sequenceTemplate: z.string().optional(),
        stepGapDays: z.number().int().min(MIN_STEP_GAP_DAYS).max(MAX_STEP_GAP_DAYS).optional(),
        sequencePrompt: z.string().max(4000).nullable().optional(),
        promptSubject: z.string().max(2000).nullable().optional(),
        promptBody: z.string().max(4000).nullable().optional(),
        promptSignature: z.string().max(2000).nullable().optional(),
        goalType: z.enum(["meeting_booked", "reply", "opportunity_created"]).optional(),
        icpOverrides: z.any().optional(),
        prospectSources: z.array(z.string()).optional().transform((v) => (v === undefined ? undefined : normalizeSources(v))),
        autoApproveThreshold: z.number().min(0).max(100).nullable().optional(),
        minConfidence: z.number().int().min(0).max(100).nullable().optional(),
        signalToOpportunityEnabled: z.boolean().optional(),
        /** Research (phase 3): which sector and persona the AI writers use; null clears. */
        researchSectorId: z.number().int().nullable().optional(),
        personaId: z.number().int().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { id, ...rest } = input;
      // A fixed-copy campaign with no usable step fails every prospect's
      // sequence (audit 2026-10-20, A47), so it is refused here, whichever of
      // the two fields this save changes.
      if (rest.copyMode !== undefined || rest.fixedSteps !== undefined) {
        let mode: string | null | undefined = rest.copyMode;
        let steps: unknown = rest.fixedSteps;
        if (mode === undefined || steps === undefined) {
          const [cur] = await db
            .select({ copyMode: areCampaigns.copyMode, fixedSteps: areCampaigns.fixedSteps })
            .from(areCampaigns)
            .where(and(eq(areCampaigns.id, id), eq(areCampaigns.workspaceId, ctx.workspace.id)))
            .limit(1);
          mode ??= cur?.copyMode;
          if (steps === undefined) steps = cur?.fixedSteps;
        }
        if (mode === "fixed" && usableFixedSteps(steps) === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: EMPTY_FIXED_COPY });
        }
      }
      /**
       * The cap and the channels (audit 2026-10-20, U11): while outbound is
       * paused, only down and only off; never past the workspace's cap.
       * Lowering is always allowed, even on a cap already above it.
       */
      if (rest.dailySendCap !== undefined || rest.channelsEnabled !== undefined) {
        const [cur] = await db
          .select({ dailySendCap: areCampaigns.dailySendCap, channelsEnabled: areCampaigns.channelsEnabled })
          .from(areCampaigns)
          .where(and(eq(areCampaigns.id, id), eq(areCampaigns.workspaceId, ctx.workspace.id)))
          .limit(1);
        if (!cur) throw new TRPCError({ code: "NOT_FOUND" });
        const refusal = sendIncreaseRefusal(
          cur,
          { dailySendCap: rest.dailySendCap, channelsEnabled: rest.channelsEnabled },
          { outboundPaused: await isOutboundPaused(ctx.workspace.id), workspaceCap: await workspaceAreCap(db, ctx.workspace.id) },
        );
        if (refusal) throw new TRPCError({ code: "PRECONDITION_FAILED", message: refusal });
      }
      const updates: Partial<typeof areCampaigns.$inferInsert> = {};
      if (rest.name !== undefined) updates.name = rest.name;
      if (rest.description !== undefined) updates.description = rest.description;
      if (rest.autonomyMode !== undefined) updates.autonomyMode = rest.autonomyMode;
      if (rest.copyMode !== undefined) updates.copyMode = rest.copyMode;
      if (rest.fixedSteps !== undefined) updates.fixedSteps = rest.fixedSteps;
      if (rest.targetProspectCount !== undefined) updates.targetProspectCount = rest.targetProspectCount;
      if (rest.dailySendCap !== undefined) updates.dailySendCap = rest.dailySendCap;
      if (rest.channelsEnabled !== undefined) updates.channelsEnabled = rest.channelsEnabled;
      // sequenceTemplate, sequencePrompt, promptSubject, and promptBody all feed
      // the LLM prompts that build the cached campaign skeleton. Editing any of
      // them must clear generatedTemplate so the change takes effect on the next
      // generation — otherwise the user edits the prompt and nothing changes (the
      // template generator only runs when generatedTemplate is null).
      // promptSignature is appended AFTER generation, so it doesn't need to bust
      // the cache. sequenceTemplate joined the list on 2026-09-20: it now decides
      // the skeleton's STEP COUNT (shared/areSequenceTemplates.ts), and without a
      // bust the column could be changed and never read again — generateCampaign-
      // Template's force=true branch has no caller.
      let bustTemplate = false;
      // The skeleton is written with the campaign's research, so a new sector
      // or persona means a new skeleton.
      if (rest.researchSectorId !== undefined) {
        if (rest.researchSectorId != null) await assertResearchSectorInWorkspace(db, rest.researchSectorId, ctx.workspace.id);
        updates.researchSectorId = rest.researchSectorId ?? null;
        bustTemplate = true;
      }
      if (rest.personaId !== undefined) {
        if (rest.personaId != null) {
          const [p] = await db.select({ id: personas.id }).from(personas).where(and(eq(personas.id, rest.personaId), eq(personas.workspaceId, ctx.workspace.id))).limit(1);
          if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Persona not found" });
        }
        updates.personaId = rest.personaId ?? null;
        bustTemplate = true;
      }
      if (rest.sequenceTemplate !== undefined) {
        updates.sequenceTemplate = rest.sequenceTemplate;
        bustTemplate = true;
      }
      if (rest.stepGapDays !== undefined) updates.stepGapDays = effectiveStepGapDays(rest.stepGapDays);
      if (rest.sequencePrompt !== undefined) {
        updates.sequencePrompt = rest.sequencePrompt ?? null;
        bustTemplate = true;
      }
      if (rest.promptSubject !== undefined) {
        updates.promptSubject = rest.promptSubject ?? null;
        bustTemplate = true;
      }
      if (rest.promptBody !== undefined) {
        updates.promptBody = rest.promptBody ?? null;
        bustTemplate = true;
      }
      if (rest.promptSignature !== undefined) {
        updates.promptSignature = rest.promptSignature ?? null;
      }
      if (bustTemplate) {
        updates.generatedTemplate = null;
        updates.generatedTemplateAt = null;
      }
      if (rest.goalType !== undefined) updates.goalType = rest.goalType;
      if (rest.icpOverrides !== undefined) updates.icpOverrides = rest.icpOverrides;
      if (rest.prospectSources !== undefined) updates.prospectSources = rest.prospectSources;
      if (rest.autoApproveThreshold !== undefined) updates.autoApproveThreshold = rest.autoApproveThreshold;
      if (rest.minConfidence !== undefined) updates.minConfidence = rest.minConfidence;
      if (rest.signalToOpportunityEnabled !== undefined) updates.signalToOpportunityEnabled = rest.signalToOpportunityEnabled;
      await db
        .update(areCampaigns)
        .set(updates)
        .where(and(eq(areCampaigns.id, id), eq(areCampaigns.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),

  /**
   * What a campaign's daily cap sits inside (U11): the workspace's Revenue
   * Engine cap and what it has sent today across all campaigns, the enabled
   * mailboxes and their daily limits added up, and the pause. Read-only.
   */
  capContext: workspaceProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
    const workspaceCap = await workspaceAreCap(db, ctx.workspace.id);
    const tz = await getWorkspaceTimezone(ctx.workspace.id);
    const left = await areWorkspaceSendsLeft(db, ctx.workspace.id, startOfLocalDay(tz, new Date()));
    const [mb] = await db
      .select({ n: sql<number>`count(*)`, total: sql<number>`sum(${sendingAccounts.dailySendLimit})` })
      .from(sendingAccounts)
      .where(and(eq(sendingAccounts.workspaceId, ctx.workspace.id), eq(sendingAccounts.enabled, true)));
    return {
      workspaceCap,
      workspaceSentToday: Math.max(0, workspaceCap - left.left),
      mailboxes: Number(mb?.n ?? 0),
      mailboxDailyTotal: Number(mb?.total ?? 0),
      outboundPaused: await isOutboundPaused(ctx.workspace.id),
    };
  }),

  /**
   * How many prospects a fit gate of `minConfidence` would reject (audit
   * 2026-10-20, A14). The engine's screen pass rejects, within a tick, every
   * row scored above 0 and below the gate that is not enriched yet
   * (areEngine, "1a. Reject what can never be enriched"), so moving the slider
   * up is a mass rejection. Same predicate, counted, so Settings can say how
   * many before it saves.
   */
  fitGatePreview: workspaceProcedure
    .input(z.object({ id: z.number().int(), minConfidence: z.number().int().min(0).max(100) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(prospectQueue)
        .where(and(
          eq(prospectQueue.campaignId, input.id),
          eq(prospectQueue.workspaceId, ctx.workspace.id),
          inArray(prospectQueue.sequenceStatus, ["pending", "sourcing"]),
          inArray(prospectQueue.enrichmentStatus, ["pending", "enriching"]),
          gt(prospectQueue.icpMatchScore, 0),
          lt(prospectQueue.icpMatchScore, input.minConfidence),
        ));
      return { wouldReject: Number(row?.n ?? 0) };
    }),

  /**
   * Move a campaign's PENDING steps onto its cadence grid (0169): for every
   * in-flight prospect, the k-th step of the ordered sequence is due at
   * first-send + k × stepGapDays (a never-touched prospect keeps its first
   * slot as the anchor); sent rows are untouched; nothing lands in the past.
   * Dry run unless `apply` — the plan says how many rows move and from/to.
   * Owner ask 2026-08-19: the 141 in-flight CommunityForce prospects carried
   * 1–4-day gaps from before the one-week directive.
   */
  respaceSteps: workspaceProcedure
    .input(z.object({ id: z.number(), apply: z.boolean().default(false), gapDays: z.number().int().min(MIN_STEP_GAP_DAYS).max(MAX_STEP_GAP_DAYS).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [campaign] = await db.select().from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id))).limit(1);
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND" });
      const gapDays = effectiveStepGapDays(input.gapDays ?? (campaign as { stepGapDays?: number | null }).stepGapDays);

      const rows = await db
        .select({ id: areExecutionQueue.id, prospectQueueId: areExecutionQueue.prospectQueueId, stepIndex: areExecutionQueue.stepIndex, status: areExecutionQueue.status, scheduledAt: areExecutionQueue.scheduledAt, executedAt: areExecutionQueue.executedAt })
        .from(areExecutionQueue)
        .where(and(eq(areExecutionQueue.workspaceId, ctx.workspace.id), eq(areExecutionQueue.campaignId, input.id)));
      const byProspect = new Map<number, typeof rows>();
      for (const r of rows) { const a = byProspect.get(r.prospectQueueId) ?? []; a.push(r); byProspect.set(r.prospectQueueId, a); }

      // Per-prospect timeline overrides (0170): a campaign respace RE-ANCHORS
      // a custom rhythm, it does not flatten it back onto the uniform grid —
      // clearing an override is the mass timeline editor's explicit call.
      const overrides = new Map<number, number[]>();
      if (byProspect.size > 0) {
        const intel = await db
          .select({ prospectQueueId: prospectIntelligence.prospectQueueId, cadence: prospectIntelligence.cadenceDayOffsets })
          .from(prospectIntelligence)
          .where(and(eq(prospectIntelligence.workspaceId, ctx.workspace.id), inArray(prospectIntelligence.prospectQueueId, Array.from(byProspect.keys()))));
        for (const i of intel) {
          const clean = sanitizeDayOffsets(i.cadence);
          if (clean) overrides.set(i.prospectQueueId, clean);
        }
      }

      const nowMs = Date.now();
      const changes: Array<{ id: number; prospectQueueId: number; stepIndex: number; from: Date; to: Date }> = [];
      let prospectsTouched = 0, prospectsInFlight = 0;
      byProspect.forEach((prows, pq) => {
        if (!prows.some((r) => r.status === "scheduled")) return;
        prospectsInFlight++;
        const plan = planRespaceForProspect(prows, gapDays, nowMs, overrides.get(pq) ?? null);
        if (plan.length) { prospectsTouched++; for (const c of plan) changes.push({ ...c, prospectQueueId: pq }); }
      });
      const times = (arr: Date[]) => arr.length ? { earliest: new Date(Math.min(...arr.map((d) => d.getTime()))).toISOString(), latest: new Date(Math.max(...arr.map((d) => d.getTime()))).toISOString() } : null;
      const plan = {
        campaignId: input.id, gapDays, applied: false,
        prospectsInFlight, prospectsTouched, rowsMoved: changes.length,
        before: times(changes.map((c) => c.from)), after: times(changes.map((c) => c.to)),
        sample: changes.slice(0, 12).map((c) => ({ prospectQueueId: c.prospectQueueId, stepIndex: c.stepIndex, from: c.from.toISOString(), to: c.to.toISOString() })),
      };
      if (!input.apply || changes.length === 0) return plan;
      for (const c of changes) {
        await db.update(areExecutionQueue).set({ scheduledAt: c.to })
          .where(and(eq(areExecutionQueue.id, c.id), eq(areExecutionQueue.workspaceId, ctx.workspace.id), eq(areExecutionQueue.status, "scheduled")));
      }
      if (input.gapDays && input.gapDays !== campaign.stepGapDays) {
        await db.update(areCampaigns).set({ stepGapDays: gapDays } as never).where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id)));
      }
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "are_campaign_respace", entityId: input.id, after: { gapDays, prospectsTouched, rowsMoved: changes.length, before: plan.before, after: plan.after } });
      return { ...plan, applied: true };
    }),

  setStatus: workspaceProcedure
    .input(z.object({
      id: z.number(),
      status: z.enum(["draft", "active", "paused", "completed"]),
      /** Launch even though the workspace's zone is still the UTC default (A31). */
      confirmTimezone: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      if (input.status === "active") {
        // Re-read first, scoped: a campaign that is ALREADY active occupies a
        // slot it is being counted against, so a no-op re-save (or a second
        // click on Start) would fail at exactly the limit and look like a bug.
        const [current] = await db
          .select({ status: areCampaigns.status, startedAt: areCampaigns.startedAt })
          .from(areCampaigns)
          .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id)))
          .limit(1);
        // A first launch only: a campaign that has run before already ran in
        // whatever zone the workspace has, and resuming it is not the moment.
        if (current && !current.startedAt && current.status !== "active" && !input.confirmTimezone) {
          await assertTimezoneChosen(db, ctx.workspace.id);
        }
        if (current && current.status !== "active") {
          const h = await campaignHeadroom(ctx.workspace.id);
          if (!h.hasRoom) throw new TRPCError({ code: "FORBIDDEN", message: campaignCapMessage(h) });
          // Archived is out of service (F15): unarchive first, on purpose.
          const [full] = await db.select().from(areCampaigns)
            .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id))).limit(1);
          if (full?.archivedAt) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This campaign is archived. Unarchive it before activating it." });
          // The pre-flight (F15): refused only for what would make it fail.
          if (full) {
            const { blockers } = await campaignPreflight(db, ctx.workspace.id, full);
            if (blockers.length > 0) throw new TRPCError({ code: "PRECONDITION_FAILED", message: preflightRefusal(blockers) });
          }
        }
      }
      const [prior] = await db.select({ status: areCampaigns.status }).from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id))).limit(1);
      const updates: Partial<typeof areCampaigns.$inferInsert> = { status: input.status };
      if (input.status === "active") updates.startedAt = new Date();
      if (input.status === "completed") updates.completedAt = new Date();
      await db
        .update(areCampaigns)
        .set(updates)
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id)));
      /**
       * Back from pause: steps that fell due while it was paused are moved so
       * each prospect's next one is due now and the rest keep their gaps
       * (audit 2026-10-20, "pause → held, resume → spaced"). The engine ticks
       * only active campaigns, so after a long pause a prospect otherwise had
       * several steps due in the same minute.
       */
      if (input.status === "active" && prior?.status === "paused") {
        await respaceOverdueSteps(db, ctx.workspace.id, input.id);
      }
      return { success: true };
    }),

  /**
   * AI targeting generation — the "runs on its own" setup step. Turns a
   * one-line audience description (e.g. "nonprofit executives at grant-making
   * foundations in the US") into structured discovery targeting so a campaign
   * can be configured with zero manual field entry. Returns the fields; the
   * caller applies them to the wizard / campaign.
   */
  generateTargeting: workspaceProcedure
    .input(z.object({ description: z.string().min(3).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const res = await invokeLLM({
        workspaceId: ctx.workspace.id,
        messages: [
          {
            role: "system",
            content:
              "You are a B2B go-to-market strategist. Convert a plain-English description of a target audience into precise prospecting filters. Return concrete, searchable job titles (include common variants), specific industries, geographies, and intent keywords. Prefer 4-8 titles, 2-5 industries, 1-3 geographies, 2-5 keywords. Use widely-recognised industry names. If a field isn't implied, return an empty array — never invent geographies the user didn't imply.",
          },
          { role: "user", content: `Audience: ${input.description}` },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "campaign_targeting",
            strict: true,
            schema: {
              type: "object",
              properties: {
                targetTitles: { type: "array", items: { type: "string" } },
                targetIndustries: { type: "array", items: { type: "string" } },
                targetGeographies: { type: "array", items: { type: "string" } },
                keywords: { type: "array", items: { type: "string" } },
              },
              required: ["targetTitles", "targetIndustries", "targetGeographies", "keywords"],
              additionalProperties: false,
            },
          },
        },
      });
      const content = contentText(res.choices[0]?.message?.content);
      if (!content) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI returned no targeting" });
      let parsed: {
        targetTitles?: unknown; targetIndustries?: unknown;
        targetGeographies?: unknown; keywords?: unknown;
      };
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "AI targeting was not valid JSON" });
      }
      const clean = (v: unknown): string[] =>
        Array.isArray(v)
          ? Array.from(new Set(v.map((s) => String(s).trim()).filter(Boolean))).slice(0, 12)
          : [];
      return {
        targetTitles: clean(parsed.targetTitles),
        targetIndustries: clean(parsed.targetIndustries),
        targetGeographies: clean(parsed.targetGeographies),
        keywords: clean(parsed.keywords),
      };
    }),

  // approveBatch was removed (audit 2026-10-20, A69): no screen called it, and
  // it approved any row of the campaign whatever its state — rejected,
  // enrolled or finished. Approving goes through are.prospects.approve,
  // bulkApprove and approveAllPending, which check.

  /**
   * How many people an "Approve all" would approve right now: enriched and
   * still pending. The Prospects tab only loads 100 rows, so the button's
   * count must come from the server or it lies on any bigger campaign.
   */
  pendingApprovalCount: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { count: 0 };
      const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(prospectQueue)
        .where(and(
          eq(prospectQueue.campaignId, input.campaignId),
          eq(prospectQueue.workspaceId, ctx.workspace.id),
          eq(prospectQueue.sequenceStatus, "pending"),
          eq(prospectQueue.enrichmentStatus, "complete"),
        ));
      return { count: Number(n) };
    }),

  /**
   * Approve EVERY enriched, still-pending person in the campaign (owner ask
   * 2026-09-08). Server-side on purpose: the bulk procs cap at 200 ids and
   * the tab loads 100 rows, so a client-driven "all" was never all. The
   * COALESCE stamps match `are.prospects.approve` — a row that was already
   * approved keeps its original decision record. Recounts the campaign's
   * denormalised counter from the queue rather than writing a batch size.
   */
  approveAllPending: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // This workspace's campaign (X1.1): the update was scoped, but another's
      // id still wrote an audit row and a recount for that campaign.
      await requireInWorkspace(db, areCampaigns, input.campaignId, ctx.workspace.id, "Campaign");
      const r = await db.update(prospectQueue).set({
        sequenceStatus: "approved",
        approvedAt: sql`COALESCE(${prospectQueue.approvedAt}, NOW())`,
        approvedByUserId: sql`COALESCE(${prospectQueue.approvedByUserId}, ${ctx.user.id})`,
      }).where(and(
        eq(prospectQueue.campaignId, input.campaignId),
        eq(prospectQueue.workspaceId, ctx.workspace.id),
        eq(prospectQueue.sequenceStatus, "pending"),
        eq(prospectQueue.enrichmentStatus, "complete"),
      ));
      const approved = affectedRowsOf(r);
      // The one recount (A50) — "Approved" kept its meaning after Approve all.
      await recountCampaignCounters(db, ctx.workspace.id, input.campaignId);
      await recordAudit({ workspaceId: ctx.workspace.id, actorUserId: ctx.user.id, action: "update", entityType: "are_campaign", entityId: input.campaignId, after: { approveAllPending: approved } });
      // Companies for the newly-approved people (2026-09-15). Fire-and-forget:
      // association never blocks the approval; the engine's sweep catches misses.
      void promoteApprovedProspects(ctx.workspace.id, { campaignId: input.campaignId, limit: 500 });
      return { approved };
    }),

  /**
   * "Why is this campaign stalled?" — one count per gate (F11, owner's audit,
   * High: "Today these are log lines that scroll away").
   *
   * One correction to that premise, found while reading: the log lines do NOT
   * scroll away — `areEngineLogs` persists them for ENGINE_LOG_RETENTION_DAYS
   * with repeat collapsing. F11 is a UI gap, not a data gap, so this is a
   * reader of state the engine already keeps, not new instrumentation.
   *
   * THE DESIGN RULE: every number carries its tense. Seven gates are stored
   * state and can be counted. Two leave no per-row trace at all:
   *
   *   • outside window — due rows stay `scheduled` (areEngine.ts:1503): no
   *     failureReason, no per-row log. So this reports the window's state NOW
   *     and how many steps are waiting on it. It cannot say how many sends the
   *     window blocked yesterday, because nothing recorded that.
   *   • pool spent — when the pool reports every mailbox spent, the engine
   *     RESETS the rows (`status: "scheduled", failureReason: null`,
   *     areEngine.ts:1923-1927) and the only survivor is one dispatch log
   *     line. A per-row count is not recoverable, so this reads that line and
   *     says when it was last seen; the client labels it as the engine's last
   *     word, not a live pool query.
   *
   * Each count is scoped the way the ENGINE scopes it, not the way that reads
   * nicest. `copyHeld` and `noEmail` join on sequenceStatus='approved' because
   * the engine's gates do; `queue.working` excludes 'skipped' because an
   * unfiltered count(*) there once held every campaign at "queue full" forever
   * and killed discovery on all three live campaigns (areEngine.ts:2074-2082).
   * A panel that computes a gate differently from the engine will say "queue
   * full" while the engine is happily discovering, or the reverse.
   */
  stallReasons: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;
      const campId = input.campaignId;
      const [campaign] = await db
        .select({
          status: areCampaigns.status,
          dailySendCap: areCampaigns.dailySendCap,
          targetProspectCount: areCampaigns.targetProspectCount,
          discoveryQueryState: areCampaigns.discoveryQueryState,
        })
        .from(areCampaigns)
        .where(and(eq(areCampaigns.id, campId), eq(areCampaigns.workspaceId, wsId)))
        .limit(1);
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND" });

      const now = new Date();
      const scoped = [eq(prospectQueue.campaignId, campId), eq(prospectQueue.workspaceId, wsId)];
      const num = (r: { n: number } | undefined) => Number(r?.n ?? 0);

      /* ── Block 1: what is stopping sends RIGHT NOW ─────────────────────── */

      const { timezone, window, paused: workspacePaused } = await getWorkspaceSendWindow(wsId, now.getTime());
      // Same two-part answer inSendWindow gives the engine: the pause shuts the
      // window regardless of the hour.
      const windowOpen = !workspacePaused && isWithinSendWindow(now.getTime(), timezone, window);
      // No next opening while outbound is paused: the pause has no end date, so
      // naming an hour would promise a send that is not coming.
      const nextOpen = windowOpen || workspacePaused
        ? null
        : nextSendWindowOpening(now.getTime(), timezone, window);

      // Due = exactly the rows the dispatch page selects (areEngine.ts:1511),
      // without its per-tick limit: scheduled, and past their time. Read NOW —
      // this is not a tally of blocked attempts, because there are none to
      // tally.
      const [due] = await db
        .select({ n: sql<number>`count(*)` })
        .from(areExecutionQueue)
        .where(and(
          eq(areExecutionQueue.campaignId, campId),
          eq(areExecutionQueue.workspaceId, wsId),
          eq(areExecutionQueue.status, "scheduled"),
          lte(areExecutionQueue.scheduledAt, now),
        ));

      const [poolLog] = await db
        .select({
          message: areEngineLogs.message,
          repeatCount: areEngineLogs.repeatCount,
          lastSeenAt: areEngineLogs.lastSeenAt,
          createdAt: areEngineLogs.createdAt,
        })
        .from(areEngineLogs)
        .where(and(
          eq(areEngineLogs.workspaceId, wsId),
          eq(areEngineLogs.campaignId, campId),
          eq(areEngineLogs.phase, "dispatch"),
          like(areEngineLogs.message, `%${POOL_HELD_MARKER}%`),
        ))
        .orderBy(desc(areEngineLogs.createdAt))
        .limit(1);
      const poolSpent = poolLog
        ? {
            reason: poolLog.message.slice(poolLog.message.indexOf(POOL_HELD_MARKER) + POOL_HELD_MARKER.length).trim(),
            // lastSeenAt is written when a line REPEATS (migration 0217), so a
            // line seen once has none — its createdAt is its last sighting.
            lastSeenAt: (poolLog.lastSeenAt ?? poolLog.createdAt).toISOString(),
            repeatCount: poolLog.repeatCount,
          }
        : null;

      /* ── Block 2: why prospects are not moving (stored state) ──────────── */

      // Scoped as areEngine.ts:1375 scopes it, the WORKSPACE's day included:
      // the cap counted from UTC midnight until A31, which for an Eastern
      // workspace restarted the day mid-evening.
      const [sentToday] = await db
        .select({ n: sql<number>`count(*)` })
        .from(areExecutionQueue)
        .where(and(
          eq(areExecutionQueue.campaignId, campId),
          eq(areExecutionQueue.status, "sent"),
          gte(areExecutionQueue.executedAt, startOfLocalDay(await getWorkspaceTimezone(wsId), now)),
        ));

      // THE EMAIL GATE, as the engine counts it (areEngine.ts:805-826): an
      // approved row with a usable sequence that contains an email step, and no
      // address. NOT "every row with no email" — a LinkedIn-only sequence
      // enrolls without one, so counting those would overstate the gate.
      const usableSequence = sql`(JSON_TYPE(${prospectIntelligence.generatedSequence}) = 'ARRAY'
               AND JSON_LENGTH(${prospectIntelligence.generatedSequence}) > 0)`;
      const [noEmail] = await db
        .select({ n: sql<number>`count(*)` })
        .from(prospectQueue)
        .innerJoin(prospectIntelligence, eq(prospectIntelligence.prospectQueueId, prospectQueue.id))
        .where(and(
          ...scoped,
          eq(prospectQueue.sequenceStatus, "approved"),
          isNotNull(prospectIntelligence.generatedSequence),
          usableSequence,
          sql`(${prospectQueue.email} IS NULL OR ${prospectQueue.email} = '')`,
          sql`(JSON_SEARCH(${prospectIntelligence.generatedSequence}, 'one', 'email', NULL, '$[*].channel') IS NOT NULL
               OR COALESCE(JSON_LENGTH(JSON_EXTRACT(${prospectIntelligence.generatedSequence}, '$[*].channel')), 0)
                  < JSON_LENGTH(${prospectIntelligence.generatedSequence}))`,
        ));

      // Enrichment failures, with the engine's own error text rather than a
      // paraphrase. Top three distinct errors; enrichmentError can be null on a
      // failed row, and that groups as its own "no reason recorded" rather than
      // being dropped.
      const [enrichFailed] = await db
        .select({ n: sql<number>`count(*)` })
        .from(prospectQueue)
        .where(and(...scoped, eq(prospectQueue.enrichmentStatus, "failed")));
      const enrichReasons = num(enrichFailed) === 0 ? [] : await db
        .select({ reason: prospectQueue.enrichmentError, n: sql<number>`count(*)` })
        .from(prospectQueue)
        .where(and(...scoped, eq(prospectQueue.enrichmentStatus, "failed")))
        .groupBy(prospectQueue.enrichmentError)
        .orderBy(desc(sql`count(*)`))
        .limit(3);

      // No dossier: approved, and no written sequence to enrol — either no
      // prospect_intelligence row at all or one with no sequence on it. A LEFT
      // JOIN, because the gate is the ABSENCE of the row.
      const [noDossier] = await db
        .select({ n: sql<number>`count(*)` })
        .from(prospectQueue)
        .leftJoin(prospectIntelligence, eq(prospectIntelligence.prospectQueueId, prospectQueue.id))
        .where(and(
          ...scoped,
          eq(prospectQueue.sequenceStatus, "approved"),
          isNull(prospectIntelligence.generatedSequence),
        ));
      // The other half of that gate, and a DIFFERENT fix: a sequence was
      // written and yields no usable steps (areEngine.ts:765-786). Counted
      // apart because "wait for the writer" and "regenerate this" are different
      // instructions, and one number covering both tells the operator to do
      // neither.
      const [unusable] = await db
        .select({ n: sql<number>`count(*)` })
        .from(prospectQueue)
        .innerJoin(prospectIntelligence, eq(prospectIntelligence.prospectQueueId, prospectQueue.id))
        .where(and(
          ...scoped,
          eq(prospectQueue.sequenceStatus, "approved"),
          isNotNull(prospectIntelligence.generatedSequence),
          sql`NOT ${usableSequence}`,
        ));

      // Copy held for a research avoid rule — the engine's own count
      // (areEngine.ts:789-796), approved only. Grouped by the reason text,
      // because "6 held" is a number while "4 for a banned claim, 2 for a
      // competitor mention" is an action.
      const heldScope = [
        ...scoped,
        eq(prospectQueue.sequenceStatus, "approved"),
        isNotNull(prospectIntelligence.copyHoldReason),
      ];
      const [copyHeld] = await db
        .select({ n: sql<number>`count(*)` })
        .from(prospectQueue)
        .innerJoin(prospectIntelligence, eq(prospectIntelligence.prospectQueueId, prospectQueue.id))
        .where(and(...heldScope));
      const heldReasons = num(copyHeld) === 0 ? [] : await db
        .select({ reason: prospectIntelligence.copyHoldReason, n: sql<number>`count(*)` })
        .from(prospectQueue)
        .innerJoin(prospectIntelligence, eq(prospectIntelligence.prospectQueueId, prospectQueue.id))
        .where(and(...heldScope))
        .groupBy(prospectIntelligence.copyHoldReason)
        .orderBy(desc(sql`count(*)`))
        .limit(3);

      // "Paused" is THREE distinct facts, and collapsing them would reproduce
      // exactly the uselessness F11 exists to fix: a campaign can be `active`
      // itself while every prospect is held and the workspace pause is on.
      // Three facts, three different actions.
      const [pausedProspects] = await db
        .select({ n: sql<number>`count(*)` })
        .from(prospectQueue)
        .where(and(...scoped, eq(prospectQueue.sequenceStatus, "paused")));

      // Discovery's own rest state (A25, added with F12 on 2026-10-30). The
      // queue gate below used to say "below target — discovery runs on every
      // tick", which is false while discovery is resting after a run that
      // found nobody new: below target and running are not the same claim.
      const discoveryState = (campaign.discoveryQueryState ?? {}) as { lastRunAt?: number; lastRunNew?: number };
      const restUntilMs = discoveryState.lastRunNew === 0 && discoveryState.lastRunAt
        ? discoveryState.lastRunAt + DISCOVERY_REST_MS
        : null;

      // Queue full, computed the engine's way (areEngine.ts:2074-2082).
      const [queue] = await db
        .select({
          working: sql<number>`sum(case when ${prospectQueue.sequenceStatus} <> 'skipped' then 1 else 0 end)`,
          rejected: sql<number>`sum(case when ${prospectQueue.sequenceStatus} = 'skipped' then 1 else 0 end)`,
          // Staged rows count toward "working" (the engine counts them) but the
          // Prospects list hides them, so "queue full" over a near-empty list
          // read as a lie (audit 2026-10-20, A26). Counted apart, and said.
          staged: sql<number>`sum(case when ${prospectQueue.sequenceStatus} = 'sourcing' then 1 else 0 end)`,
        })
        .from(prospectQueue)
        .where(and(...scoped));
      const working = Number(queue?.working ?? 0);

      const gates = {
        noEmail: num(noEmail),
        enrichmentFailed: {
          count: num(enrichFailed),
          reasons: enrichReasons.map((r) => ({ reason: r.reason, count: Number(r.n) })),
        },
        noDossier: num(noDossier),
        unusableSequence: num(unusable),
        copyHeld: {
          count: num(copyHeld),
          reasons: heldReasons.map((r) => ({ reason: r.reason, count: Number(r.n) })),
        },
        cap: {
          cap: campaign.dailySendCap,
          sentToday: num(sentToday),
          remaining: Math.max(0, campaign.dailySendCap - num(sentToday)),
        },
        paused: {
          workspaceOutbound: workspacePaused,
          campaignStatus: campaign.status,
          prospects: num(pausedProspects),
        },
        queue: {
          working,
          target: campaign.targetProspectCount,
          rejected: Number(queue?.rejected ?? 0),
          /** Of `working`: discovered without an email, staged while one is found, not on the Prospects list. */
          staged: Number(queue?.staged ?? 0),
          full: working >= campaign.targetProspectCount,
          /** Below target does not mean searching: discovery rests after an empty run. */
          discoveryRestingUntil: restUntilMs && restUntilMs > Date.now() ? new Date(restUntilMs).toISOString() : null,
        },
      };

      /**
       * The spec's "with the top reason". Ordered by WHAT IT BLOCKS, not by how
       * big the number is: a blocker that stops the whole campaign comes before
       * one that stops some rows, because releasing six held sequences changes
       * nothing while the workspace pause is on. Null when nothing is blocking,
       * which is itself the answer: this campaign is not stalled.
       */
      const topReason =
        gates.paused.workspaceOutbound ? "workspacePaused"
        : campaign.status !== "active" ? "campaignNotActive"
        : !windowOpen && num(due) > 0 ? "windowClosed"
        : gates.cap.remaining === 0 ? "capUsed"
        : gates.copyHeld.count > 0 ? "copyHeld"
        : gates.noEmail > 0 ? "noEmail"
        : gates.unusableSequence > 0 ? "unusableSequence"
        : gates.noDossier > 0 ? "noDossier"
        : gates.enrichmentFailed.count > 0 ? "enrichmentFailed"
        : gates.paused.prospects > 0 ? "prospectsPaused"
        : gates.queue.full ? "queueFull"
        : null;

      return {
        checkedAt: now.toISOString(),
        timezone,
        sending: {
          windowOpen,
          windowDescription: describeSendWindow(window),
          nextOpenAt: nextOpen == null ? null : new Date(nextOpen).toISOString(),
          dueNow: num(due),
          poolSpent,
          poolLogRetentionDays: ENGINE_LOG_RETENTION_DAYS,
        },
        gates,
        topReason,
      };
    }),

  /**
   * Per-source health for ONE campaign — F12 ("shows which sources earn their
   * cost"), read-only.
   *
   * What this deliberately does NOT do is repeat the workspace back office.
   * `ProspectSourceRegistryCard` (Settings → Data sources) already shows every
   * registry vendor's capability manifest, credential status, circuit state and
   * budget, and Settings → Billing already reports spend per vendor per day.
   * Both are workspace-wide. What has never existed is the campaign-scoped
   * answer: of the sources THIS campaign is set to use, which will actually run
   * on the next tick, which are resting, and what each returned last time. So
   * this adds the four things those surfaces cannot say and links to them for
   * the rest.
   *
   * Three honesty rules it is built on:
   *
   *   1. All seven ARE sources appear, not just the three the registry
   *      instruments. internal / google_business / linkedin / news have no
   *      credential row, no breaker and no ledger — they are hand-written
   *      branches in runDiscovery. Omitting them would answer "which sources
   *      earn their cost" wrongly by leaving four of them out, so they are
   *      listed and marked as not instrumented.
   *   2. A breaker reading is only reported as durable for `table` sources.
   *      Legacy ones (Apollo, QuickEnrich) keep it in a process-local Map, so
   *      the surface says that rather than showing a countdown that a deploy
   *      forgets.
   *   3. Spend is labelled for what it is: a WORKSPACE total for a UTC day.
   *      `spend_ledger` has no campaign column and its `day` is UTC
   *      (`spendDay()` slices an ISO string), so neither a per-campaign figure
   *      nor a workspace-day figure can be derived from it, and this must not
   *      imply otherwise.
   *
   * "Last success or error" is answered as LAST ATTEMPT, honestly labelled:
   * nothing records a per-source success time (`recordSuccess` zeroes the
   * failure count and writes no timestamp), and `lastValidatedAt` is a key
   * check rather than a search. The engine's own discovery summary carries
   * `details.perSource` — `{ raw, new, error?, skipped? }` per source — so that
   * is what is read and that is what it is called.
   */
  sourceHealth: workspaceProcedure
    .input(z.object({ campaignId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const wsId = ctx.workspace.id;
      const [campaign] = await db
        .select({
          prospectSources: areCampaigns.prospectSources,
          discoveryQueryState: areCampaigns.discoveryQueryState,
          targetProspectCount: areCampaigns.targetProspectCount,
        })
        .from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.campaignId), eq(areCampaigns.workspaceId, wsId)))
        .limit(1);
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND" });

      // The campaign's selection read the ENGINE's way, including the rule that
      // an EXPLICIT empty list means "no discovery" while a null or
      // dead-ids-only list falls back to the defaults (shared/areSources).
      // Reading it any other way would show sources that will not run, or hide
      // ones that will.
      const explicitlyNone = discoveryIsOff(campaign.prospectSources);
      const selected = campaignSources(campaign.prospectSources);
      const [wsRow] = await db
        .select({ order: workspaceSettings.areSourceOrder, mask: workspaceSettings.areScraperSources })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, wsId))
        .limit(1);
      // The same resolver the engine calls, so the order shown IS the order
      // that will run — and order is dedup precedence, not decoration.
      const runOrder = resolveSourceOrder(wsRow?.order, wsRow?.mask, selected as AreSourceId[]);
      const mask = (wsRow?.mask && typeof wsRow.mask === "object" ? wsRow.mask : {}) as Record<string, unknown>;

      const state = (campaign.discoveryQueryState ?? {}) as {
        src?: Record<string, { empty: number; nextAt: number | null; held?: boolean }>;
        ok?: Record<string, number>;
        lastRunAt?: number;
        lastRunNew?: number;
      };
      const restUntilMs = state.lastRunNew === 0 && state.lastRunAt ? state.lastRunAt + DISCOVERY_REST_MS : null;

      // The admitted step of the yield (audit 2026-10-20, F12): of the people
      // each source put in this campaign's queue, how many were admitted —
      // left staging ("sourcing") and were not rejected or skipped. All time
      // for the campaign, counted in SQL.
      const queueBySource = await db
        .select({
          sourceType: prospectQueue.sourceType,
          kept: sql<number>`count(*)`,
          admitted: sql<number>`sum(case when ${prospectQueue.sequenceStatus} in ('pending', 'approved', 'enrolled', 'completed', 'replied', 'paused', 'canceled') then 1 else 0 end)`,
        })
        .from(prospectQueue)
        .where(and(eq(prospectQueue.workspaceId, wsId), eq(prospectQueue.campaignId, input.campaignId)))
        .groupBy(prospectQueue.sourceType);
      const yieldOf = (sourceId: string) => {
        const types = QUEUE_TYPES_BY_SOURCE[sourceId] ?? [sourceId];
        const mine = queueBySource.filter((r) => types.includes(String(r.sourceType)));
        return { kept: mine.reduce((a, r) => a + Number(r.kept ?? 0), 0), admitted: mine.reduce((a, r) => a + Number(r.admitted ?? 0), 0) };
      };
      // LinkedIn's allowance is lookups left today on the workspace's accounts:
      // the budget the four hand-written sources had none of (F12).
      const linkedinAccounts = await listUsableAccounts({ workspaceId: wsId, userId: ctx.user.id, isAdmin: true }).catch(() => []);

      // The engine's own per-source breakdown, from the summary line it writes
      // once per discovery call. Matched on a marker pinned to the engine's
      // wording by a guard test — see POOL_HELD_MARKER for why.
      const [summary] = await db
        .select({ details: areEngineLogs.details, createdAt: areEngineLogs.createdAt, lastSeenAt: areEngineLogs.lastSeenAt })
        .from(areEngineLogs)
        .where(and(
          eq(areEngineLogs.workspaceId, wsId),
          eq(areEngineLogs.campaignId, input.campaignId),
          eq(areEngineLogs.phase, "discovery"),
          like(areEngineLogs.message, `${DISCOVERY_SUMMARY_MARKER}%`),
        ))
        .orderBy(desc(areEngineLogs.createdAt))
        .limit(1);
      const lastRun = summary
        ? {
            at: new Date(summary.lastSeenAt ?? summary.createdAt).toISOString(),
            perSource: ((summary.details ?? {}) as {
              perSource?: Record<string, { raw: number; new: number; error?: string; skipped?: string }>;
            }).perSource ?? {},
          }
        : null;

      // Workspace spend for the UTC day, per vendor. Labelled as such on the
      // surface: this ledger has no campaign column.
      const today = spendDay();
      const spendRows = await db
        .select({
          vendor: spendLedger.vendor,
          meter: spendLedger.meter,
          keySource: spendLedger.keySource,
          feature: spendLedger.feature,
          quantity: spendLedger.quantity,
          calls: spendLedger.calls,
        })
        .from(spendLedger)
        .where(and(eq(spendLedger.workspaceId, wsId), eq(spendLedger.day, today)));

      // Capability match is deliberately not asked for (null criteria): the
      // campaign's targeting resolution lives in the engine, and re-deriving it
      // here to show a verdict would be a second, divergent implementation of
      // it. The "can this source filter on X" question is F17's, from the same
      // registry call.
      const described = await describeSources(wsId, null);
      const bySlug = new Map(described.map((d) => [d.slug as string, d]));

      const sources = ARE_SOURCES.map((meta) => {
        const d = bySlug.get(meta.id);
        const rest = state.src?.[meta.id] ?? null;
        // Engines before 2026-11-07 keyed LinkedIn's success by its scrape-job name.
        const attempt = lastRun?.perSource?.[meta.id] ?? (meta.id === "linkedin" ? lastRun?.perSource?.linkedin_people ?? null : null);
        const vendorSpend = spendRows.filter((r) => r.vendor === meta.id);
        const orderIdx = runOrder.indexOf(meta.id as AreSourceId);
        // This source's model tokens on this campaign today, by the feature the
        // engine records them under while the source runs (F12).
        const feature = DISCOVERY_SOURCE_FEATURE(meta.id, input.campaignId);
        const tokenRows = spendRows.filter((r) => r.feature === feature && TOKEN_METERS.includes(r.meter));
        return {
          slug: meta.id,
          label: meta.label,
          /** Will this source run on the next tick, and where in the waterfall? */
          runsAt: orderIdx === -1 ? null : orderIdx,
          selectedOnCampaign: selected.includes(meta.id as AreSourceId),
          enabledInWorkspace: mask[meta.id] !== false,
          /** false = no credential row, no breaker, no ledger for this source. */
          instrumented: d != null,
          key: d
            ? {
                configured: d.credential.configured,
                // Only table-mode sources have a validated status; for a legacy
                // source "configured" is the whole of what is known.
                status: d.credentialMode === "table" ? d.credential.status : null,
                validatedAt: d.credential.lastValidatedAt ? new Date(d.credential.lastValidatedAt).toISOString() : null,
                error: d.credential.validationError ?? null,
              }
            : null,
          breaker: d
            ? {
                open: d.circuit.open,
                failures: d.circuit.failures,
                openUntil: d.circuit.openUntil ? new Date(d.circuit.openUntil).toISOString() : null,
                /** false = process memory, forgotten on deploy (circuit.ts). */
                durable: d.credentialMode === "table",
              }
            : null,
          budget: d
            ? {
                leadsRemaining: d.leadsRemaining,
                buckets: d.budget.map((b) => ({
                  bucket: b.bucket,
                  remaining: b.remaining,
                  limit: b.limit,
                  used: b.used,
                  /** The vendor's own word for where the allowance comes from,
                   *  or null — which the adapters use to mean "tracked
                   *  locally", never "zero". */
                  fundedBy: b.fundedBy ?? null,
                })),
              }
            : null,
          /** Live back-off state (A25), from the campaign's own discovery JSON. */
          rest: rest && rest.nextAt
            ? { emptyRuns: rest.empty, until: new Date(rest.nextAt).toISOString() }
            : null,
          /** That rest is the vendor's own wait, not a run of empty results. */
          heldByVendor: !!rest?.held,
          lastAttempt: attempt
            ? { raw: attempt.raw, kept: attempt.new, error: attempt.error ?? null, skipped: attempt.skipped ?? null }
            : null,
          /** When it last returned people that were saved (F12); null = not since this was recorded. */
          lastSuccessAt: state.ok?.[meta.id] ? new Date(state.ok[meta.id]).toISOString() : null,
          /** Kept into this campaign's queue, and of those admitted, all time (F12). */
          yield: yieldOf(meta.id),
          /** Model tokens this source spent for this campaign today, UTC (F12). */
          tokensToday: tokenRows.reduce((a, r) => a + Number(r.quantity), 0),
          /** Model calls one run of this source can make (shared/spendPreview). */
          aiCallsPerRun: AI_CALLS_PER_SOURCE[meta.id] ?? 0,
          /** LinkedIn lookups left today across the workspace's accounts (F12); null for other sources. */
          lookupsLeftToday: meta.id === "linkedin" ? linkedinAccounts.reduce((a, x) => a + x.remainingToday, 0) : null,
          spendToday: vendorSpend.length === 0 ? null : {
            quantity: vendorSpend.reduce((a, r) => a + Number(r.quantity), 0),
            calls: vendorSpend.reduce((a, r) => a + Number(r.calls), 0),
            meters: vendorSpend.map((r) => ({ meter: r.meter, keySource: r.keySource, quantity: Number(r.quantity), calls: Number(r.calls) })),
          },
        };
      });

      return {
        checkedAt: new Date().toISOString(),
        /** Both labels the surface needs to stay honest about scope. */
        spendScope: "workspace" as const,
        spendDay: today,
        /** The horizon of "no attempt on record" — never transcribed client-side. */
        logRetentionDays: ENGINE_LOG_RETENTION_DAYS,
        discovery: {
          /** null = this campaign never ran discovery, which is not "0 found". */
          lastRunAt: lastRun?.at ?? null,
          lastRunNew: state.lastRunNew ?? null,
          /** The campaign-wide 30-minute rest after a run that found nobody. */
          restingUntil: restUntilMs && restUntilMs > Date.now() ? new Date(restUntilMs).toISOString() : null,
          restWindowMinutes: Math.round(DISCOVERY_REST_MS / 60_000),
          /** Empty, and the engine says so: no source will be called at all. */
          noUsableSources: runOrder.length === 0,
          explicitlyNone,
        },
        sources,
      };
    }),

  /**
   * What activating this campaign needs, and what is missing (F15): sender
   * accounts, the owner's LinkedIn account, a Reoon key, sources, the time
   * zone and the pause. `blockers` are what setStatus refuses on.
   */
  preflight: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [campaign] = await db.select().from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id))).limit(1);
      if (!campaign) throw new TRPCError({ code: "NOT_FOUND" });
      const r = await campaignPreflight(db, ctx.workspace.id, campaign);
      return { ...r, archived: !!campaign.archivedAt, canActivate: r.blockers.length === 0 && !campaign.archivedAt };
    }),

  /**
   * Archive instead of delete (F15): out of the list and out of service, with
   * every prospect, step and reply kept, and undone in one click. An active
   * campaign is paused as it is archived, so archiving only ever sends less.
   */
  archive: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await requireInWorkspace(db, areCampaigns, input.id, ctx.workspace.id, "Campaign");
      // Two claims, not a read then a write (X1.5, at the merge with PLAT
      // 2026-11-07): read-then-write let an activation landing in between
      // leave the campaign archived AND active, still sending. The archive is
      // taken only if not archived yet; the pause then catches whatever is
      // active at that moment, the status in its WHERE.
      const archived = await claimRow(db.update(areCampaigns)
        .set({ archivedAt: new Date() } as never)
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id), isNull(areCampaigns.archivedAt))));
      if (!archived) return { success: true, paused: false };
      const paused = await claimRow(db.update(areCampaigns)
        .set({ status: "paused" as const })
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id), eq(areCampaigns.status, "active"))));
      return { success: true, paused };
    }),

  /** Back from the archive (F15): listed again, as it was archived — never re-activated by this. */
  unarchive: workspaceProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await requireInWorkspace(db, areCampaigns, input.id, ctx.workspace.id, "Campaign");
      await db.update(areCampaigns).set({ archivedAt: null } as never)
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id)));
      return { success: true };
    }),

  /**
   * A copy of a campaign's setup as a new DRAFT (F15): targeting, sources,
   * caps, channels, cadence, copy and prompts. None of its people, steps,
   * counters or discovery progress come along, and nothing runs until the
   * copy is activated. The person cloning owns the copy.
   */
  clone: workspaceProcedure
    .input(z.object({ id: z.number(), name: z.string().trim().min(2).max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const [src] = await db.select().from(areCampaigns)
        .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ctx.workspace.id))).limit(1);
      if (!src) throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      const name = (input.name ?? `Copy of ${src.name}`).slice(0, 200);
      const [row] = await db.insert(areCampaigns).values({
        workspaceId: ctx.workspace.id,
        name,
        description: src.description,
        status: "draft",
        autonomyMode: src.autonomyMode,
        icpProfileId: src.icpProfileId,
        icpOverrides: src.icpOverrides,
        researchSectorId: src.researchSectorId,
        personaId: src.personaId,
        prospectSources: src.prospectSources,
        targetProspectCount: src.targetProspectCount,
        dailySendCap: src.dailySendCap,
        channelsEnabled: src.channelsEnabled,
        sequenceTemplate: src.sequenceTemplate,
        stepGapDays: src.stepGapDays,
        sequencePrompt: src.sequencePrompt,
        promptSubject: src.promptSubject,
        promptBody: src.promptBody,
        promptSignature: src.promptSignature,
        copyMode: src.copyMode,
        fixedSteps: src.fixedSteps,
        goalType: src.goalType,
        autoApproveThreshold: src.autoApproveThreshold,
        minConfidence: src.minConfidence,
        signalToOpportunityEnabled: src.signalToOpportunityEnabled,
        ownerUserId: ctx.user.id,
      } as never).$returningId();
      return { id: row.id, name };
    }),

  /**
   * Delete a campaign: admins only (F15: archive is the everyday way out,
   * and a manager's), audited, in one transaction (audit 2026-10-20, A18). It deleted the campaign row alone, for any member, with
   * no record. Its people stayed claimed by a campaign that no longer existed,
   * so they could never join another, and their scheduled steps stayed on the
   * calendar. Now its unsent steps are stopped and the people still in it are
   * taken out (canceled, with the reason), and the identity index counts only
   * rows whose campaign exists, so they are free to join another. Sent steps,
   * signals and replies are kept: they are those people's history.
   */
  delete: adminWsProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const ws = ctx.workspace.id;
      const reason = "Campaign deleted";
      const affected = affectedRowsOf;
      const done = await db.transaction(async (tx) => {
        const [campaign] = await tx
          .select({ id: areCampaigns.id, name: areCampaigns.name, status: areCampaigns.status })
          .from(areCampaigns)
          .where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ws)))
          .limit(1);
        if (!campaign) throw new TRPCError({ code: "NOT_FOUND" });
        const steps = await tx
          .update(areExecutionQueue)
          .set({ status: "skipped", failureReason: reason, executedAt: new Date() })
          .where(and(
            eq(areExecutionQueue.workspaceId, ws),
            eq(areExecutionQueue.campaignId, input.id),
            inArray(areExecutionQueue.status, ["scheduled", "paused"]),
          ));
        const people = await tx
          .update(prospectQueue)
          .set({ sequenceStatus: "canceled", rejectedAt: new Date(), rejectionReason: reason })
          .where(and(
            eq(prospectQueue.workspaceId, ws),
            eq(prospectQueue.campaignId, input.id),
            inArray(prospectQueue.sequenceStatus, ["pending", "approved", "enrolled", "paused", "sourcing"]),
          ));
        await tx.delete(areCampaigns).where(and(eq(areCampaigns.id, input.id), eq(areCampaigns.workspaceId, ws)));
        return { campaign, stepsStopped: affected(steps), peopleReleased: affected(people) };
      });
      await recordAudit({
        workspaceId: ws, actorUserId: ctx.user.id, action: "delete", entityType: "are_campaign", entityId: input.id,
        before: { name: done.campaign.name, status: done.campaign.status },
        after: { stepsStopped: done.stepsStopped, peopleReleased: done.peopleReleased },
      });
      return { success: true, stepsStopped: done.stepsStopped, peopleReleased: done.peopleReleased };
    }),

  /**
   * Manually run one ARE engine tick now. The engine also runs on a 10-minute
   * cron; this lets an operator drive it on demand and see the per-phase
   * counts (enriched / approved / enrolled / sent / …) come back immediately.
   */
  runEngine: managerProcedure.mutation(async ({ ctx }) => {
    return runAreEngine({ workspaceId: ctx.workspace.id });
  }),
});
