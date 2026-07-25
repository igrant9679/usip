/**
 * Attribution — did the system's own advice actually help?
 *
 * Without this, a self-optimising product is just a confident one. Every applied
 * change records a metric snapshot; later this pass measures what happened since
 * and, if outbound got WORSE, reverts the change automatically.
 *
 * Windowing trick: rather than adding date-filtered variants of every metric
 * query, we snapshot CUMULATIVE totals at apply time and difference them later.
 * `postSent = now.sent - baseline.sent` is the post-change window by
 * construction — no new SQL, and it cannot drift out of step with the numbers
 * the "What's Working" page shows.
 *
 * Two guards against reverting on noise, which would be worse than never
 * reverting at all:
 *   • GRACE_DAYS must pass before a change is judged.
 *   • MIN_POST_SAMPLE sends must have happened since. Below that the pass says
 *     "not yet" and leaves the change in place.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../../db";
import { optimizationRecommendations, workspaces } from "../../../drizzle/schema";
import { getSequenceStepStats, getSourceYieldStats, rate } from "../performanceMetrics";
import { revertRecommendation } from "./apply";

/** Days to wait after applying before judging the result. */
export const GRACE_DAYS = 3;
/** Sends required in the post-change window before a verdict is allowed. */
export const MIN_POST_SAMPLE = 30;
/**
 * How much worse the reply rate must get to trigger an automatic revert.
 * Relative: a drop from 10% to 7.9% trips it; 10% to 8.5% does not. Set wide
 * enough that ordinary week-to-week variation doesn't cause thrash.
 */
export const REVERT_TOLERANCE = 0.2;

export interface MetricSnapshot {
  capturedAt: string;
  sent: number;
  replies: number;
  meetings: number;
  replyRate: number;
  meetingRate: number;
}

/**
 * Cumulative outbound totals for a workspace: sequence sends plus ARE campaign
 * sends. Deliberately the same source functions the dashboard uses.
 */
export async function snapshotMetrics(workspaceId: number): Promise<MetricSnapshot> {
  const [steps, sources] = await Promise.all([
    getSequenceStepStats(workspaceId),
    getSourceYieldStats(workspaceId),
  ]);
  const seqSent = steps.reduce((n, r) => n + r.sent, 0);
  const seqReplies = steps.reduce((n, r) => n + r.replies, 0);
  const seqMeetings = steps.reduce((n, r) => n + r.meetings, 0);
  const areSent = sources.reduce((n, r) => n + r.contacted, 0);
  const areReplies = sources.reduce((n, r) => n + r.replied, 0);
  const areMeetings = sources.reduce((n, r) => n + r.meetings, 0);

  const sent = seqSent + areSent;
  const replies = seqReplies + areReplies;
  const meetings = seqMeetings + areMeetings;
  return {
    capturedAt: new Date().toISOString(),
    sent,
    replies,
    meetings,
    replyRate: rate(replies, sent),
    meetingRate: rate(meetings, sent),
  };
}

export interface Evaluation {
  verdict: "improved" | "unchanged" | "degraded" | "insufficient_data";
  postSent: number;
  postReplies: number;
  postMeetings: number;
  postReplyRate: number;
  baselineReplyRate: number;
  evaluatedAt: string;
  note: string;
}

/**
 * Compare a baseline against current totals. Pure, so the verdict rules are
 * testable without a database.
 */
export function evaluate(baseline: MetricSnapshot, now: MetricSnapshot): Evaluation {
  const postSent = Math.max(0, now.sent - baseline.sent);
  const postReplies = Math.max(0, now.replies - baseline.replies);
  const postMeetings = Math.max(0, now.meetings - baseline.meetings);
  const postReplyRate = rate(postReplies, postSent);
  const base = baseline.replyRate;
  const common = {
    postSent, postReplies, postMeetings, postReplyRate,
    baselineReplyRate: base,
    evaluatedAt: new Date().toISOString(),
  };

  if (postSent < MIN_POST_SAMPLE) {
    return {
      ...common,
      verdict: "insufficient_data",
      note: `Only ${postSent} send(s) since the change — need ${MIN_POST_SAMPLE} before judging.`,
    };
  }
  // A change that produced meetings where the baseline had none is a win even
  // if the reply rate wobbled — meetings are the goal, replies are a proxy.
  if (postMeetings > 0 && baseline.meetings === 0) {
    return { ...common, verdict: "improved", note: `${postMeetings} meeting(s) booked since the change.` };
  }
  if (base <= 0) {
    // Nothing to get worse than; any replies at all are an improvement.
    return {
      ...common,
      verdict: postReplies > 0 ? "improved" : "unchanged",
      note: postReplies > 0
        ? `${postReplies} repl(ies) since the change, from a baseline of none.`
        : "Still no replies; the change neither helped nor hurt.",
    };
  }
  if (postReplyRate < base * (1 - REVERT_TOLERANCE)) {
    return {
      ...common,
      verdict: "degraded",
      note: `Reply rate fell from ${base.toFixed(1)}% to ${postReplyRate.toFixed(1)}% over ${postSent} sends.`,
    };
  }
  if (postReplyRate > base) {
    return { ...common, verdict: "improved", note: `Reply rate rose from ${base.toFixed(1)}% to ${postReplyRate.toFixed(1)}%.` };
  }
  return { ...common, verdict: "unchanged", note: `Reply rate held near ${base.toFixed(1)}%.` };
}

/**
 * Evaluate every applied recommendation past its grace period, writing the
 * verdict onto the row and auto-reverting anything that made things worse.
 */
export async function runAttributionPass(): Promise<{ evaluated: number; reverted: number }> {
  const db = await getDb();
  if (!db) return { evaluated: 0, reverted: 0 };

  const wsRows = await db.select({ id: workspaces.id }).from(workspaces);
  let evaluated = 0;
  let reverted = 0;

  for (const ws of wsRows) {
    let applied: any[] = [];
    try {
      applied = await db
        .select()
        .from(optimizationRecommendations)
        .where(and(
          eq(optimizationRecommendations.workspaceId, ws.id),
          eq(optimizationRecommendations.status, "applied" as never),
          isNotNull(optimizationRecommendations.appliedAt),
        ));
    } catch (e) {
      console.error(`[Attribution] ws ${ws.id} load failed:`, (e as Error).message);
      continue;
    }
    if (applied.length === 0) continue;

    // One snapshot per workspace, reused for every recommendation in it.
    let now: MetricSnapshot;
    try {
      now = await snapshotMetrics(ws.id);
    } catch (e) {
      console.error(`[Attribution] ws ${ws.id} snapshot failed:`, (e as Error).message);
      continue;
    }

    for (const rec of applied) {
      try {
        const delta = (rec.resultDelta ?? {}) as Record<string, any>;
        const baseline = delta.baseline as MetricSnapshot | undefined;
        if (!baseline) continue; // applied before baselines existed — nothing to compare

        const appliedAt = rec.appliedAt ? new Date(rec.appliedAt).getTime() : 0;
        if (!appliedAt || Date.now() - appliedAt < GRACE_DAYS * 86400000) continue;

        const evaluation = evaluate(baseline, now);
        await db
          .update(optimizationRecommendations)
          .set({ resultDelta: { ...delta, evaluation } } as never)
          .where(eq(optimizationRecommendations.id, rec.id));
        evaluated++;

        if (evaluation.verdict === "degraded") {
          const out = await revertRecommendation(ws.id, { ...rec, resultDelta: { ...delta, evaluation } }, evaluation.note);
          if (out.ok) {
            reverted++;
            console.log(`[Attribution] ws ${ws.id} auto-reverted rec ${rec.id}: ${evaluation.note}`);
          } else {
            console.error(`[Attribution] ws ${ws.id} revert of rec ${rec.id} failed: ${out.detail}`);
          }
        }
      } catch (e) {
        console.error(`[Attribution] ws ${ws.id} rec ${rec.id} failed:`, (e as Error).message);
      }
    }
  }

  return { evaluated, reverted };
}
