/**
 * Voice analyzer — call connect rates and conversation length.
 *
 * Scope is honest about what the voice system currently records: `voice_calls`
 * stores direction, status and duration, but `outcome` is free text, so there is
 * no structured objection or disposition data to cluster. This analyzer
 * therefore reports on CONNECTION and LENGTH only. Script-level advice needs
 * structured dispositions (or transcript analysis) and is deliberately not
 * guessed at from a text blob.
 *
 * Advisory throughout — dialing strategy has no safe automatic patch.
 */
import { getVoiceStats } from "../performanceMetrics";
import { confidenceFromSample, type Analyzer, type Proposal } from "./types";

/** Calls needed in a direction before its connect rate is meaningful. */
const MIN_CALLS = 40;
/** Connect rate below this is worth flagging. */
const LOW_CONNECT_RATE = 15; // percent
/** A "connected" call this short usually means an immediate hang-up. */
const SHORT_CALL_SEC = 20;

export const voiceAnalyzer: Analyzer = {
  module: "voice",
  name: "Voice call analyzer",

  async run(workspaceId: number): Promise<Proposal[]> {
    const stats = await getVoiceStats(workspaceId);
    if (stats.length === 0) return [];

    const proposals: Proposal[] = [];
    for (const s of stats) {
      if (s.calls < MIN_CALLS) continue; // too few dials to judge

      /* Rule 1 — low connect rate. Usually a timing or list-quality problem
         rather than a script problem, so the rationale says which to check. */
      if (s.connectRate < LOW_CONNECT_RATE) {
        proposals.push({
          module: "voice",
          scopeType: "global",
          scopeId: null,
          scopeLabel: `${s.direction} calls`,
          kind: "low_call_connect_rate",
          title: `${s.direction} calls connect only ${s.connectRate.toFixed(1)}% of the time`,
          rationale:
            `${s.connected} connected out of ${s.calls} ${s.direction} calls ` +
            `(${s.noAnswer} no-answer, ${s.failed} failed). At this rate the constraint is almost always ` +
            `dial timing or phone-number quality rather than the script — check when calls are being placed ` +
            `relative to the prospect's timezone, and whether the numbers were verified.`,
          evidence: {
            metric: "connectRate",
            value: s.connectRate,
            calls: s.calls,
            connected: s.connected,
            noAnswer: s.noAnswer,
            failed: s.failed,
            threshold: LOW_CONNECT_RATE,
          },
          sampleSize: s.calls,
          confidence: confidenceFromSample(s.calls),
          currentValue: null,
          proposedValue: null,
          generatedBy: "rules",
        });
      }

      /* Rule 2 — connects that end almost immediately. A distinct failure from
         not connecting at all: the opener is losing them in the first seconds. */
      if (s.connected >= MIN_CALLS / 2 && s.avgDurationSec > 0 && s.avgDurationSec < SHORT_CALL_SEC) {
        proposals.push({
          module: "voice",
          scopeType: "global",
          scopeId: null,
          scopeLabel: `${s.direction} calls`,
          kind: "calls_ending_immediately",
          title: `Connected ${s.direction} calls average only ${s.avgDurationSec}s`,
          rationale:
            `${s.connected} connected calls averaging ${s.avgDurationSec} seconds means people are answering ` +
            `and then leaving straight away — an opener problem, not a targeting one. The first two sentences ` +
            `are what to change.`,
          evidence: {
            metric: "avgDurationSec",
            value: s.avgDurationSec,
            connected: s.connected,
            calls: s.calls,
            threshold: SHORT_CALL_SEC,
          },
          sampleSize: s.connected,
          confidence: confidenceFromSample(s.connected),
          currentValue: null,
          proposedValue: null,
          generatedBy: "rules",
        });
      }
    }

    return proposals;
  },
};
