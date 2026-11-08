/**
 * ARE — Metrics Router (Phase 1 of the continuous-optimisation layer)
 *
 * Read-only exposure of services/performanceMetrics for the "What's Working"
 * surface at /are/performance. Deliberately contains NO analysis and NO AI: the
 * numbers get proven correct here first, so that when the later phases start
 * proposing (and auto-applying) tweaks, they reason over a measurement layer
 * that has already been reviewed.
 *
 * Every procedure is workspace-scoped and derives from source-of-truth rows —
 * there is nothing to keep in sync and nothing that can drift.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";
import { getWorkspaceTimezone } from "../../services/workspaceTimezone";
import { wallTimeToUtcMs } from "@shared/availability";
import {
  getAbVariantStats,
  getAreStepStats,
  getReplyMix,
  getRevenueFunnel,
  getSequenceStepStats,
  getSourceYieldStats,
  getStepFunnel,
  MIN_VARIANT_SAMPLE,
  type MetricsScope,
} from "../../services/performanceMetrics";

/**
 * What's Working's filters (audit 2026-10-20, F20): a campaign, and a range of
 * the workspace's own days, "from" and "to" both included. Days are read in
 * the workspace's zone, as the dashboards' are (PR #26), so a day means the
 * customer's day, not UTC's.
 */
const scopeInput = z.object({
  campaignId: z.number().int().positive().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).optional();
type ScopeInput = z.infer<typeof scopeInput>;

/** [since, until) for the days named, in `tz`; until is the start of the day after "to". */
export function dayRangeInZone(tz: string, from?: string, to?: string): { since?: Date; until?: Date } {
  const at = (ymd: string, plusDays: number) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(wallTimeToUtcMs(tz, y, m, d + plusDays, 0));
  };
  const since = from ? at(from, 0) : undefined;
  const until = to ? at(to, 1) : undefined;
  if (since && until && since >= until) throw new TRPCError({ code: "BAD_REQUEST", message: "The start date is after the end date." });
  return { since, until };
}

async function scopeOf(workspaceId: number, input: ScopeInput): Promise<MetricsScope> {
  if (!input) return {};
  const range = input.from || input.to ? dayRangeInZone(await getWorkspaceTimezone(workspaceId), input.from, input.to) : {};
  return { ...(input.campaignId ? { campaignId: input.campaignId } : {}), ...range };
}

export const metricsRouter = router({
  /**
   * The Revenue Engine's per-step performance, from its own sends (audit
   * 2026-10-20, A22): what What's Working reports as the engine's steps.
   */
  areSteps: workspaceProcedure
    .input(scopeInput)
    .query(async ({ ctx, input }) => getAreStepStats(ctx.workspace.id, await scopeOf(ctx.workspace.id, input))),

  /** Per-step CRM Sequence performance (email_drafts) — the Sequences product, not the engine. */
  sequenceSteps: workspaceProcedure
    // The date range applies; a campaign does not (a CRM Sequence is not a campaign).
    .input(z.object({ sequenceId: z.number().int().optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const range = input?.from || input?.to ? dayRangeInZone(await getWorkspaceTimezone(ctx.workspace.id), input?.from, input?.to) : {};
      return getSequenceStepStats(ctx.workspace.id, { ...(input?.sequenceId !== undefined ? { sequenceId: input.sequenceId } : {}), ...range });
    }),

  /** Sourcing yield per source, ranked by meetings-per-contacted. */
  sourceYield: workspaceProcedure
    .input(scopeInput)
    .query(async ({ ctx, input }) => getSourceYieldStats(ctx.workspace.id, await scopeOf(ctx.workspace.id, input))),

  /**
   * Reply mix across the 8-class taxonomy, scoped to replies to OUR outbound.
   * Also returns the unattributed-inbound count so the excluded volume is
   * visible rather than silently dropped.
   */
  replyMix: workspaceProcedure
    .input(scopeInput)
    .query(async ({ ctx, input }) => getReplyMix(ctx.workspace.id, await scopeOf(ctx.workspace.id, input))),

  /** A/B variant performance for one campaign (same data the campaign tab shows). */
  abVariants: workspaceProcedure
    .input(z.object({ campaignId: z.number().int() }))
    .query(async ({ ctx, input }) => getAbVariantStats(ctx.workspace.id, input.campaignId)),

  /**
   * The step funnel, as Sankey nodes and links — how prospects actually moved
   * through the sequence. Reads the same two tables abVariants does, so the
   * chart and the step cards cannot disagree about what happened.
   */
  stepFunnel: workspaceProcedure
    .input(z.object({ campaignId: z.number().int() }))
    .query(async ({ ctx, input }) => getStepFunnel(ctx.workspace.id, input.campaignId)),

  /**
   * The five-band revenue funnel behind /v2/analytics. ONE population
   * (prospect_queue), all time. With campaignId set it reconciles band for
   * band with stepFunnel above — both read are_execution_queue and
   * are_signal_log — which is why it lives beside it rather than in a router
   * of its own.
   */
  revenueFunnel: workspaceProcedure
    .input(z.object({ campaignId: z.number().int().nullable().default(null) }).optional())
    .query(async ({ ctx, input }) => getRevenueFunnel(ctx.workspace.id, { campaignId: input?.campaignId ?? null })),

  /** Thresholds the UI must respect so it never implies a winner from noise. */
  thresholds: workspaceProcedure.query(async () => ({ minVariantSample: MIN_VARIANT_SAMPLE })),
});
