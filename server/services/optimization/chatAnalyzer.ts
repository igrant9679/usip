/**
 * Chat analyzer — reads the inbound chat funnel and proposes what to change.
 *
 * ADVISORY ONLY. Every proposal has `proposedValue: null`, so nothing here can
 * be auto-applied. The fixes it points at — persona wording, which facts the
 * agent knows, where the widget is installed — are judgement calls a human
 * should make, and a machine-applicable patch would imply otherwise.
 *
 * The gates below matter more than the rules. The outbound side of this product
 * already demonstrates the failure mode: five analyzers producing confident
 * advice about almost no data. A chat with eight conversations has nothing to
 * say, and saying nothing is the correct output — the tests assert exactly that.
 */
import type { Analyzer, Proposal } from "./types";
import { getChatFunnelStats } from "../performanceMetrics";

/** Below this, the funnel is anecdote. Nothing is proposed at all. */
export const MIN_CHAT_SAMPLE = 30;
/** "high" confidence needs a sample no chat widget reaches quickly. */
export const HIGH_CONFIDENCE_SAMPLE = 200;
/** Engaged visitors who give an email, below which capture is the bottleneck. */
export const WEAK_EMAIL_RATE = 25;
/** Qualified visitors who book, below which the offer is the bottleneck. */
export const WEAK_BOOKING_RATE = 20;
/** Sessions that never got past the greeting, above which the opener is wrong. */
export const WEAK_ENGAGEMENT_RATE = 40;

function confidenceFor(sample: number): "low" | "medium" | "high" {
  if (sample >= HIGH_CONFIDENCE_SAMPLE) return "high";
  if (sample >= MIN_CHAT_SAMPLE * 2) return "medium";
  return "low";
}

export const chatAnalyzer: Analyzer = {
  module: "messaging",
  name: "Inbound chat funnel",

  async run(workspaceId: number): Promise<Proposal[]> {
    const f = await getChatFunnelStats(workspaceId);

    // The whole point of the gate: an anecdote is not evidence.
    if (f.sessions < MIN_CHAT_SAMPLE) return [];

    const out: Proposal[] = [];
    const confidence = confidenceFor(f.sessions);

    // 1. They arrive and say nothing — the opening line is the problem.
    if (f.engagedRate < WEAK_ENGAGEMENT_RATE && f.sessions - f.engaged > 0) {
      out.push({
        module: "messaging",
        scopeType: "global",
        scopeId: null,
        scopeLabel: "Inbound chat",
        kind: "chat_opening_line",
        title: "Most visitors open the chat and then say nothing",
        rationale:
          `Only ${f.engagedRate}% of ${f.sessions} conversations got past the greeting. ` +
          `That is an opening-line problem, not a qualification one — they never got far enough to be qualified.`,
        evidence: { sessions: f.sessions, engaged: f.engaged, engagedRate: f.engagedRate },
        sampleSize: f.sessions,
        confidence,
        currentValue: null,
        proposedValue: null,
        generatedBy: "rules",
      });
    }

    // 2. They talk but never hand over an email — the hard prerequisite.
    if (f.engaged >= MIN_CHAT_SAMPLE && f.emailRate < WEAK_EMAIL_RATE) {
      out.push({
        module: "messaging",
        scopeType: "global",
        scopeId: null,
        scopeLabel: "Inbound chat",
        kind: "chat_email_capture",
        title: "Visitors engage but do not give an email",
        rationale:
          `${f.emailRate}% of ${f.engaged} engaged visitors gave an email. ` +
          `An email is a hard prerequisite for booking, so this ceiling caps every meeting the chat can produce. ` +
          `Usually the ask arrives before the visitor has been given a reason to care.`,
        evidence: {
          engaged: f.engaged,
          emailCaptured: f.emailCaptured,
          emailRate: f.emailRate,
          medianMessagesToEmail: f.medianMessagesToEmail,
        },
        sampleSize: f.engaged,
        confidence,
        currentValue: null,
        proposedValue: null,
        generatedBy: "rules",
      });
    }

    // 3. Qualified and still not booking — the offer, or the calendar.
    if (f.qualified >= MIN_CHAT_SAMPLE && f.meetingRate < WEAK_BOOKING_RATE) {
      out.push({
        module: "messaging",
        scopeType: "global",
        scopeId: null,
        scopeLabel: "Inbound chat",
        kind: "chat_booking_conversion",
        title: "Qualified visitors are not booking",
        rationale:
          `${f.meetingRate}% of ${f.qualified} qualified visitors booked. ` +
          `They cleared the bar and still walked, so check the offered slots are sensible in the visitor's timezone ` +
          `and that the agent is offering the meeting rather than waiting to be asked.`,
        evidence: { qualified: f.qualified, meetings: f.meetings, meetingRate: f.meetingRate },
        sampleSize: f.qualified,
        confidence,
        currentValue: null,
        proposedValue: null,
        generatedBy: "rules",
      });
    }

    return out;
  },
};
