/**
 * SDR analyzer — per-rep outbound performance, for coaching.
 *
 * Handled more carefully than the other analyzers, for two reasons:
 *
 * 1. Small-sample unfairness. Per-rep splitting multiplies the sample-size
 *    problem: a rep with 40 sends and one unlucky week can look "worse" than a
 *    colleague purely by noise. The gate here is therefore HIGHER than
 *    elsewhere, and a rep is only compared against the team when both sides
 *    have real volume.
 * 2. These proposals are about PEOPLE. Every one is advisory, framed as "this
 *    rep's copy is worth reviewing together", never as a verdict on the person,
 *    and never auto-applied — there is no patch that fixes how someone writes.
 */
import { getRepPerformance } from "../performanceMetrics";
import { confidenceFromSample, type Analyzer, type Proposal } from "./types";

/** Sends a rep needs before their reply rate is discussed at all. */
const MIN_REP_SENDS = 50;
/** Team sends needed before a team average is a fair yardstick. */
const MIN_TEAM_SENDS = 150;
/** How far below the team a rep must sit before it's worth raising (relative). */
const UNDERPERFORM_RATIO = 0.5;

export const sdrAnalyzer: Analyzer = {
  module: "sdr_coaching",
  name: "Rep outbound coaching analyzer",

  async run(workspaceId: number): Promise<Proposal[]> {
    const reps = await getRepPerformance(workspaceId);
    if (reps.length < 2) return []; // nothing to compare against; stay quiet

    const judgeable = reps.filter((r) => r.sent >= MIN_REP_SENDS);
    const teamSent = reps.reduce((n, r) => n + r.sent, 0);
    const teamReplies = reps.reduce((n, r) => n + r.replies, 0);
    if (judgeable.length < 2 || teamSent < MIN_TEAM_SENDS) return [];

    const teamRate = teamSent > 0 ? (teamReplies / teamSent) * 100 : 0;
    if (teamRate <= 0) return []; // no team signal to compare against

    const proposals: Proposal[] = [];
    const best = [...judgeable].sort((a, b) => b.replyRate - a.replyRate)[0];

    for (const rep of judgeable) {
      if (rep.replyRate >= teamRate * UNDERPERFORM_RATIO) continue;
      proposals.push({
        module: "sdr_coaching",
        scopeType: "global",
        scopeId: null,
        // No name lookup here: the UI resolves the user, and storing a name
        // would go stale. userId lives in evidence.
        scopeLabel: `Rep #${rep.userId}`,
        kind: "rep_reply_rate_below_team",
        title: `Rep #${rep.userId} replies at ${rep.replyRate.toFixed(1)}% vs ${teamRate.toFixed(1)}% team average`,
        rationale:
          `${rep.replies} repl(ies) from ${rep.sent} sends (${rep.replyRate.toFixed(1)}%), against a team ` +
          `average of ${teamRate.toFixed(1)}% over ${teamSent} sends. Worth reviewing their opening lines and ` +
          `asks together` +
          (best && best.userId !== rep.userId
            ? ` — rep #${best.userId} is achieving ${best.replyRate.toFixed(1)}% on the same audience, so their ` +
              `templates are the obvious place to start.`
            : ".") +
          ` Treat as a prompt for a conversation, not a performance conclusion: ${rep.sent} sends is enough to ` +
          `notice a gap, not enough to explain it.`,
        evidence: {
          metric: "replyRate",
          rep: { userId: rep.userId, sent: rep.sent, replies: rep.replies, replyRate: rep.replyRate },
          team: { sent: teamSent, replies: teamReplies, replyRate: Number(teamRate.toFixed(1)) },
          bestRep: best ? { userId: best.userId, replyRate: best.replyRate } : null,
        },
        sampleSize: rep.sent,
        confidence: confidenceFromSample(rep.sent),
        currentValue: null,
        proposedValue: null, // coaching is never an automatic change
        generatedBy: "rules",
      });
    }

    return proposals;
  },
};
