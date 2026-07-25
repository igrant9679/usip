/**
 * Sourcing analyzer — proposes where prospecting effort should go, judged on
 * MEETINGS rather than volume.
 *
 * The bias this corrects: every existing surface ranks sources by how many
 * prospects they found, so the loudest source looks like the best one. A source
 * that returns 500 contacts and books nothing is worse than one that returns 20
 * and books three, and effort should follow the second.
 *
 * Deterministic thresholds (see sequenceAnalyzer for why rules, not an LLM,
 * decide anything that may later auto-apply).
 */
import { getSourceYieldStats, type SourceYieldStats } from "../performanceMetrics";
import {
  confidenceFromSample,
  MIN_SOURCE_SAMPLE,
  type Analyzer,
  type Proposal,
} from "./types";

/** A source contacted this much with no meetings is a candidate to deprioritise. */
const MIN_CONTACTED_TO_JUDGE = MIN_SOURCE_SAMPLE;

/** Reply-rate gap (pts) that makes one source meaningfully better than another. */
const MEANINGFUL_GAP = 3.0;

export const sourceAnalyzer: Analyzer = {
  module: "sourcing",
  name: "Prospect source analyzer",

  async run(workspaceId: number): Promise<Proposal[]> {
    const sources = await getSourceYieldStats(workspaceId);
    if (sources.length === 0) return [];

    const proposals: Proposal[] = [];
    const judgeable = sources.filter((s) => s.contacted >= MIN_CONTACTED_TO_JUDGE);
    if (judgeable.length === 0) return []; // nothing has been contacted enough to judge

    /* Rule 1 — a source with real outreach volume and no meetings booked.
       Deliberately keyed on meetings, not replies: replies are an intermediate
       signal and a source can generate polite noise indefinitely. */
    for (const s of judgeable) {
      if (s.meetings === 0) {
        proposals.push({
          module: "sourcing",
          scopeType: "source",
          scopeId: null, // sourceType is an enum, not a row id
          scopeLabel: s.sourceType,
          kind: "deprioritise_unproductive_source",
          title: `${s.sourceType} has produced no meetings from ${s.contacted} contacted`,
          rationale:
            `${s.discovered} prospects found, ${s.contacted} contacted, ${s.replied} replied, ` +
            `0 meetings booked. Sourcing effort is better spent where meetings actually come from. ` +
            `Check ICP fit before dropping it entirely — an average ICP score of ${s.avgIcpScore} ` +
            `suggests ${s.avgIcpScore < 50 ? "the targeting filters for this source may be too loose" : "the targeting is reasonable and the messaging may be the problem"}.`,
          evidence: {
            metric: "meetings",
            value: 0,
            discovered: s.discovered,
            contacted: s.contacted,
            replied: s.replied,
            replyRate: s.replyRate,
            avgIcpScore: s.avgIcpScore,
            threshold: `>= ${MIN_CONTACTED_TO_JUDGE} contacted with 0 meetings`,
          },
          sampleSize: s.contacted,
          confidence: confidenceFromSample(s.contacted),
          currentValue: { sourceType: s.sourceType, enabled: true },
          proposedValue: { sourceType: s.sourceType, enabled: false },
          generatedBy: "rules",
        });
      }
    }

    /* Rule 2 — concentrate effort on the best performer, when there is a real
       alternative to compare against. Ranked by meeting rate, falling back to
       reply rate only to break ties between sources that have booked nothing. */
    if (judgeable.length >= 2) {
      const ranked = [...judgeable].sort(
        (a, b) => b.meetingRate - a.meetingRate || b.replyRate - a.replyRate,
      );
      const best = ranked[0];
      const rest = ranked.slice(1);
      const betterOnMeetings = best.meetingRate > 0 && best.meetingRate > (rest[0]?.meetingRate ?? 0);
      const betterOnReplies = best.replyRate - (rest[0]?.replyRate ?? 0) >= MEANINGFUL_GAP;
      if (betterOnMeetings || betterOnReplies) {
        proposals.push({
          module: "sourcing",
          scopeType: "source",
          scopeId: null,
          scopeLabel: best.sourceType,
          kind: "increase_best_source_share",
          title: `${best.sourceType} is your most productive source — shift more sourcing to it`,
          rationale:
            `${best.sourceType}: ${best.meetings} meeting(s) and ${best.replied} repl(ies) from ` +
            `${best.contacted} contacted (${best.meetingRate.toFixed(1)}% meeting rate, ` +
            `${best.replyRate.toFixed(1)}% reply rate) — ahead of ${rest.length} other judged source(s). ` +
            `Raising its share of discovery should raise meetings booked per prospect sourced.`,
          evidence: {
            metric: betterOnMeetings ? "meetingRate" : "replyRate",
            best: {
              sourceType: best.sourceType,
              meetingRate: best.meetingRate,
              replyRate: best.replyRate,
              contacted: best.contacted,
            },
            comparedTo: rest.map((r) => ({
              sourceType: r.sourceType,
              meetingRate: r.meetingRate,
              replyRate: r.replyRate,
              contacted: r.contacted,
            })),
          },
          sampleSize: best.contacted,
          confidence: confidenceFromSample(best.contacted),
          currentValue: null,
          // Advisory until source weighting is a real, settable field.
          proposedValue: null,
          generatedBy: "rules",
        });
      }
    }

    return proposals;
  },
};

/** Exported for tests: the ranking rule, isolated from any DB access. */
export function rankSources(sources: SourceYieldStats[]): SourceYieldStats[] {
  return [...sources].sort((a, b) => b.meetingRate - a.meetingRate || b.replyRate - a.replyRate);
}
