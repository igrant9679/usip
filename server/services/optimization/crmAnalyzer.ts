/**
 * CRM analyzer — reads closed-deal outcomes and pipeline shape.
 *
 * All proposals here are ADVISORY (proposedValue null). Unlike retiring a dead
 * sequence step, "your deals die at proposal stage" has no correct automatic
 * action — the fix is a human changing how they sell. Emitting an applicable
 * patch would be pretending.
 */
import { getWinLossStats } from "../performanceMetrics";
import { confidenceFromSample, type Analyzer, type Proposal } from "./types";

/** Closed deals needed before win-rate or loss-pattern talk means anything. */
const MIN_CLOSED = 10;
/** A lost-reason cluster this dominant is worth naming. */
const REASON_SHARE_THRESHOLD = 30; // percent
/** Share of open pipeline sitting in one stage that suggests a bottleneck. */
const BOTTLENECK_SHARE = 50; // percent

export const crmAnalyzer: Analyzer = {
  module: "crm",
  name: "Win/loss and pipeline analyzer",

  async run(workspaceId: number): Promise<Proposal[]> {
    const s = await getWinLossStats(workspaceId);
    const closed = s.won + s.lost;
    const proposals: Proposal[] = [];

    /* Rule 1 — a dominant loss reason. The single most actionable thing closed-
       lost data can tell you, and it needs no ML to find. */
    if (closed >= MIN_CLOSED) {
      const top = s.lostReasons.filter((r) => r.reason !== "not recorded")[0];
      if (top && top.share >= REASON_SHARE_THRESHOLD) {
        proposals.push({
          module: "crm",
          scopeType: "global",
          scopeId: null,
          scopeLabel: "Closed-lost deals",
          kind: "dominant_loss_reason",
          title: `${top.share.toFixed(0)}% of lost deals cite "${top.reason}"`,
          rationale:
            `${top.count} of ${s.lost} lost deals were lost to "${top.reason}". A single reason at this ` +
            `share is usually addressable upstream — in qualification criteria, in the ICP, or in how the ` +
            `objection is handled early rather than at proposal stage. Win rate is currently ` +
            `${s.winRate.toFixed(1)}% across ${closed} closed deals.`,
          evidence: {
            metric: "lostReasonShare",
            reason: top.reason,
            count: top.count,
            share: top.share,
            lost: s.lost,
            won: s.won,
            winRate: s.winRate,
          },
          sampleSize: closed,
          confidence: confidenceFromSample(closed),
          currentValue: null,
          proposedValue: null, // no correct automatic action
          generatedBy: "rules",
        });
      }

      /* Rule 2 — losses with no reason recorded at all. Cheap to fix, and it
         un-blocks every future loss analysis. */
      const unrecorded = s.lostReasons.find((r) => r.reason === "not recorded");
      if (unrecorded && unrecorded.share >= REASON_SHARE_THRESHOLD) {
        proposals.push({
          module: "crm",
          scopeType: "global",
          scopeId: null,
          scopeLabel: "Closed-lost deals",
          kind: "missing_loss_reasons",
          title: `${unrecorded.share.toFixed(0)}% of lost deals have no reason recorded`,
          rationale:
            `${unrecorded.count} of ${s.lost} lost deals were closed without a loss reason, so they teach ` +
            `nothing — not the ICP, not the messaging, not the qualification criteria. Requiring a reason on ` +
            `close-lost is the cheapest analytics improvement available here.`,
          evidence: { metric: "missingLossReasonShare", count: unrecorded.count, share: unrecorded.share, lost: s.lost },
          sampleSize: s.lost,
          confidence: confidenceFromSample(s.lost),
          currentValue: null,
          proposedValue: null,
          generatedBy: "rules",
        });
      }
    }

    /* Rule 3 — a stage holding most of the open pipeline. Reported only with
       enough open deals that the concentration isn't just small numbers. */
    if (s.open >= MIN_CLOSED) {
      const top = s.openByStage[0];
      if (top) {
        const share = (top.count / s.open) * 100;
        if (share >= BOTTLENECK_SHARE) {
          proposals.push({
            module: "crm",
            scopeType: "global",
            scopeId: null,
            scopeLabel: `Stage: ${top.stage}`,
            kind: "pipeline_bottleneck",
            title: `${share.toFixed(0)}% of open pipeline is stuck in "${top.stage}"`,
            rationale:
              `${top.count} of ${s.open} open deals sit in "${top.stage}". A stage holding this much of the ` +
              `pipeline is usually where deals go to die rather than where they are actively worked — check ` +
              `whether the exit criteria for this stage are actually defined and being enforced.`,
            evidence: { metric: "openStageShare", stage: top.stage, count: top.count, open: s.open, share: Math.round(share) },
            sampleSize: s.open,
            confidence: confidenceFromSample(s.open),
            currentValue: null,
            proposedValue: null,
            generatedBy: "rules",
          });
        }
      }
    }

    return proposals;
  },
};
