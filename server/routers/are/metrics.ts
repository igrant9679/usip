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
import { z } from "zod";
import { router } from "../../_core/trpc";
import { workspaceProcedure } from "../../_core/workspace";
import {
  getAbVariantStats,
  getReplyMix,
  getSequenceStepStats,
  getSourceYieldStats,
  getStepFunnel,
  MIN_VARIANT_SAMPLE,
} from "../../services/performanceMetrics";

export const metricsRouter = router({
  /** Per-step sequence performance — which step actually books meetings. */
  sequenceSteps: workspaceProcedure
    .input(z.object({ sequenceId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }) =>
      getSequenceStepStats(ctx.workspace.id, input?.sequenceId !== undefined ? { sequenceId: input.sequenceId } : {}),
    ),

  /** Sourcing yield per source, ranked by meetings-per-contacted. */
  sourceYield: workspaceProcedure.query(async ({ ctx }) => getSourceYieldStats(ctx.workspace.id)),

  /**
   * Reply mix across the 8-class taxonomy, scoped to replies to OUR outbound.
   * Also returns the unattributed-inbound count so the excluded volume is
   * visible rather than silently dropped.
   */
  replyMix: workspaceProcedure.query(async ({ ctx }) => getReplyMix(ctx.workspace.id)),

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

  /** Thresholds the UI must respect so it never implies a winner from noise. */
  thresholds: workspaceProcedure.query(async () => ({ minVariantSample: MIN_VARIANT_SAMPLE })),
});
