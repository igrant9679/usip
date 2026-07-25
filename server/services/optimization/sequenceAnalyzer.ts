/**
 * Sequence analyzer — proposes cadence/step changes from measured step outcomes.
 *
 * Reads the Phase 1 metrics (services/performanceMetrics), never raw tables, so
 * the numbers it reasons over are exactly the ones the "What's Working" page
 * shows a human. If the two ever disagree, that's a bug in one module, not two
 * competing truths.
 *
 * Rules are deterministic on purpose. For proposals that may later be applied
 * automatically, a threshold a human can audit ("0 replies in 30+ sends") beats
 * an LLM's opinion — it is reproducible, explainable, and cannot hallucinate a
 * subject line into your outbound. An LLM analyzer can be added behind the same
 * Analyzer interface for the genuinely generative work (rewriting copy); it is
 * deliberately NOT used for threshold decisions.
 */
import { getSequenceStepStats, type SequenceStepStats } from "../performanceMetrics";
import {
  confidenceFromSample,
  MIN_STEP_SAMPLE,
  type Analyzer,
  type Proposal,
} from "./types";

/** A step this dead gets a retire proposal (no replies at all, decent volume). */
const DEAD_STEP_MIN_SENDS = MIN_STEP_SAMPLE;

/**
 * How much better the best step must be than a candidate before we suggest
 * reordering. A step is only "underperforming" relative to a real alternative.
 */
const MEANINGFUL_REPLY_GAP = 2.0; // percentage points

export const sequenceAnalyzer: Analyzer = {
  module: "sequences",
  name: "Sequence step analyzer",

  async run(workspaceId: number): Promise<Proposal[]> {
    const steps = await getSequenceStepStats(workspaceId);
    if (steps.length === 0) return [];

    const proposals: Proposal[] = [];
    const bySequence = new Map<number, SequenceStepStats[]>();
    for (const s of steps) {
      const list = bySequence.get(s.sequenceId) ?? [];
      list.push(s);
      bySequence.set(s.sequenceId, list);
    }

    for (const [sequenceId, rows] of bySequence) {
      // Only steps with enough volume can be judged at all.
      const judgeable = rows.filter((r) => r.sent >= DEAD_STEP_MIN_SENDS);
      if (judgeable.length === 0) continue; // correct output: say nothing

      /* Rule 1 — a step with real volume and ZERO replies is dead weight.
         Every send costs sender reputation, so this is worth flagging even
         though the fix (remove or rewrite) needs a human decision. */
      for (const r of judgeable) {
        if (r.replies === 0) {
          proposals.push({
            module: "sequences",
            scopeType: "step",
            scopeId: r.sequenceId,
            scopeLabel: `Sequence ${r.sequenceId} · step ${r.stepIndex + 1}`,
            kind: "retire_dead_step",
            title: `Step ${r.stepIndex + 1} of sequence ${r.sequenceId} has never earned a reply`,
            rationale:
              `${r.sent} emails sent from this step and 0 replies. Every send spends sender ` +
              `reputation, so a step with no measurable return is worth rewriting or removing. ` +
              `Review the copy before removing it — a dead step can also mean a broken merge ` +
              `field or a subject line that reads as bulk mail.`,
            evidence: {
              metric: "replies",
              value: 0,
              sent: r.sent,
              opens: r.opens,
              openRate: r.openRate,
              threshold: `>= ${DEAD_STEP_MIN_SENDS} sends with 0 replies`,
            },
            sampleSize: r.sent,
            confidence: confidenceFromSample(r.sent),
            currentValue: { stepIndex: r.stepIndex, enabled: true },
            // Applying = disable the step. Reversible, and the diff is obvious.
            proposedValue: { stepIndex: r.stepIndex, enabled: false },
            generatedBy: "rules",
          });
        }
      }

      /* Rule 2 — surface the best step so its pattern can be copied. Advisory
         by nature (no code change to apply), so proposedValue is null rather
         than a patch that pretends to be applicable. */
      const ranked = [...judgeable].sort((a, b) => b.replyRate - a.replyRate);
      const best = ranked[0];
      const worst = ranked[ranked.length - 1];
      if (best && worst && best !== worst && best.replyRate - worst.replyRate >= MEANINGFUL_REPLY_GAP) {
        proposals.push({
          module: "sequences",
          scopeType: "sequence",
          scopeId: sequenceId,
          scopeLabel: `Sequence ${sequenceId}`,
          kind: "copy_winning_step_pattern",
          title: `Step ${best.stepIndex + 1} outperforms step ${worst.stepIndex + 1} by ${(best.replyRate - worst.replyRate).toFixed(1)} pts`,
          rationale:
            `Step ${best.stepIndex + 1} replies at ${best.replyRate.toFixed(1)}% (${best.replies}/${best.sent}) ` +
            `while step ${worst.stepIndex + 1} replies at ${worst.replyRate.toFixed(1)}% (${worst.replies}/${worst.sent}). ` +
            `Rework the weaker step toward what the stronger one does — same angle, same length, same ask.`,
          evidence: {
            metric: "replyRate",
            best: { stepIndex: best.stepIndex, replyRate: best.replyRate, sent: best.sent },
            worst: { stepIndex: worst.stepIndex, replyRate: worst.replyRate, sent: worst.sent },
            gapPts: Number((best.replyRate - worst.replyRate).toFixed(1)),
          },
          sampleSize: Math.min(best.sent, worst.sent),
          confidence: confidenceFromSample(Math.min(best.sent, worst.sent)),
          currentValue: null,
          proposedValue: null, // advisory: rewriting copy is a human/LLM task
          generatedBy: "rules",
        });
      }
    }

    return proposals;
  },
};
