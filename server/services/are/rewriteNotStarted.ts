/**
 * rewriteNotStarted.ts — rewrite ENROLLED Revenue Engine sequences whose
 * first step has not gone out yet, with the workspace's current brand.
 *
 * Owner ask 2026-09-24, after CommunityForce's brand profile was rewritten
 * around Discover / Raise / Run / Prove: "CommunityForce only, not-yet-started
 * prospects". Enrolment snapshots each step's copy into
 * are_execution_queue.messageContent, so regenerating the stored sequence
 * alone would change nothing that sends. This regenerates the sequence and
 * then replaces the content of that prospect's still-scheduled rows, step for
 * step, keeping every scheduledAt — the cadence the prospect is on does not
 * move.
 *
 * "Not started" is strict: the prospect is enrolled and EVERY one of its
 * queue rows is still `scheduled` — nothing sent, failed, skipped or paused
 * (a paused row means a reply or an out-of-office, which is a conversation,
 * not a queue). A prospect mid-sequence is left alone on purpose: fresh
 * follow-ups written against a first email they never received would not
 * read as one conversation.
 *
 * The check is repeated immediately before the queue is touched, and each
 * row update is itself conditional on `status = 'scheduled'`: dispatch runs
 * every few minutes and may send step 0 while the model is writing. If it
 * did, that prospect's queue is left exactly as it was.
 *
 * Runs as a persisted background job (services/jobs/runner, kind
 * REWRITE_NOT_STARTED_JOB; audit 2026-10-20, F14): its progress and each
 * prospect's outcome are stored on the job row, a restart picks it up from the
 * last prospect done, and a second start while one is queued or running gets
 * that one back. It ran in an in-memory loop, whose progress a restart lost
 * part-way. The runner runs outside any request, like the engine that
 * normally writes these sequences, so the per-user interactive ceiling of 30
 * model calls a minute does not fail a bulk pass part-way. Every model call on
 * this path names its workspace explicitly. One prospect at a time; never
 * sends anything.
 */
import { and, eq, sql } from "drizzle-orm";
import { areExecutionQueue, prospectIntelligence, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { normalizeSequence } from "@shared/areSequenceSteps";
import { activeJob, enqueueJob, kickJobs, registerJobKind } from "../jobs/runner";
import { bulkJobs } from "../../../drizzle/schema";
import { desc } from "drizzle-orm";

export interface NotStartedTarget {
  prospectQueueId: number;
  campaignId: number;
}

export type RewriteOutcome = "rewritten" | "started_meanwhile" | "no_steps" | "held" | "failed";

export interface RewriteJobState {
  running: boolean;
  total: number;
  done: number;
  rewritten: number;
  startedMeanwhile: number;
  noSteps: number;
  /** New copy broke a research avoid rule, so the prospect kept its old sends (A13). */
  held: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

/** The persisted job's kind (F14). */
export const REWRITE_NOT_STARTED_JOB = "are.rewriteNotStarted";
type RewritePayload = { targets: NotStartedTarget[] };

/**
 * A prospect not rewritten is kept on the job's outcome list as
 * "<outcome>: <why>", so the progress card can say what happened to each one.
 * A rewritten one counts as done.
 */
const OUTCOME_TEXT: Record<Exclude<RewriteOutcome, "rewritten">, string> = {
  started_meanwhile: "started_meanwhile: a step went out while the copy was written, so the queue was left as it was",
  no_steps: "no_steps: the new sequence had no usable steps",
  held: "held: the new copy breaks a research avoid rule, so the old sends stay",
  failed: "failed: the rewrite failed",
};

/** Enrolled prospects in this workspace whose queue rows are ALL still scheduled. */
export async function findNotStartedEnrolled(workspaceId: number): Promise<NotStartedTarget[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({ prospectQueueId: prospectQueue.id, campaignId: prospectQueue.campaignId })
    .from(prospectQueue)
    .where(and(
      eq(prospectQueue.workspaceId, workspaceId),
      eq(prospectQueue.sequenceStatus, "enrolled"),
      sql`EXISTS (SELECT 1 FROM \`are_execution_queue\` e WHERE e.\`prospectQueueId\` = ${prospectQueue.id} AND e.\`status\` = 'scheduled')`,
      sql`NOT EXISTS (SELECT 1 FROM \`are_execution_queue\` e WHERE e.\`prospectQueueId\` = ${prospectQueue.id} AND e.\`status\` <> 'scheduled')`,
    ))
    .orderBy(prospectQueue.id);
  return rows
    .filter((r) => r.campaignId != null)
    .map((r) => ({ prospectQueueId: r.prospectQueueId, campaignId: Number(r.campaignId) }));
}

/** Regenerate one prospect's sequence and re-snapshot its still-scheduled rows. */
export async function rewriteOneNotStarted(
  workspaceId: number,
  target: NotStartedTarget,
): Promise<RewriteOutcome> {
  const db = await getDb();
  if (!db) return "failed";
  const { runSequenceAgent } = await import("../../routers/are/prospects");
  /**
   * Draft, and commit only clean copy (audit 2026-10-20, A13). This copies the
   * new sequence straight into scheduled sends, past the enrolment gate that
   * holds copy breaking a research avoid rule — so held copy went out. Now the
   * agent does not save copy that breaks a rule, the prospect keeps the
   * sequence and the sends it had, and the job counts it as held. The hold is
   * read again below as well: a row released or held since must be honoured.
   */
  const drafted = await runSequenceAgent(target.prospectQueueId, workspaceId, target.campaignId, { force: true, onlyIfClean: true });
  if (drafted.held) return "held";

  const [intel] = await db
    .select({ seq: prospectIntelligence.generatedSequence, hold: prospectIntelligence.copyHoldReason })
    .from(prospectIntelligence)
    .where(and(eq(prospectIntelligence.prospectQueueId, target.prospectQueueId), eq(prospectIntelligence.workspaceId, workspaceId)))
    .limit(1);
  if (intel?.hold) return "held";
  const steps = normalizeSequence(intel?.seq);
  if (steps.length === 0) return "no_steps";
  const byIndex = new Map(steps.map((s) => [s.stepIndex, s] as const));

  // Re-check immediately before touching the queue: dispatch may have sent
  // step 0 while the model was writing.
  const rows = await db
    .select({ id: areExecutionQueue.id, stepIndex: areExecutionQueue.stepIndex, status: areExecutionQueue.status })
    .from(areExecutionQueue)
    .where(and(
      eq(areExecutionQueue.workspaceId, workspaceId),
      eq(areExecutionQueue.prospectQueueId, target.prospectQueueId),
    ));
  if (rows.length === 0 || rows.some((r) => r.status !== "scheduled")) return "started_meanwhile";

  let replaced = 0;
  for (const r of rows) {
    const s = byIndex.get(r.stepIndex);
    if (!s) continue;
    // The same shape enrolment writes (areEngine enrollApprovedForCampaign),
    // and only while the row is still waiting. scheduledAt is not touched.
    await db.update(areExecutionQueue)
      .set({ messageContent: { subject: s.subject, body: s.body, variantKey: s.variantKey } } as never)
      .where(and(
        eq(areExecutionQueue.id, r.id),
        eq(areExecutionQueue.workspaceId, workspaceId),
        eq(areExecutionQueue.status, "scheduled"),
      ));
    replaced++;
  }
  return replaced > 0 ? "rewritten" : "no_steps";
}

registerJobKind<RewritePayload>(REWRITE_NOT_STARTED_JOB, {
  async step(job, payload, budgetMs) {
    const until = Date.now() + budgetMs;
    const targets = payload.targets ?? [];
    let i = job.resumeFrom;
    let done = 0;
    const failures: Array<{ id: number; error: string }> = [];
    while (i < targets.length && Date.now() < until) {
      const t = targets[i];
      try {
        const outcome = await rewriteOneNotStarted(job.workspaceId, t);
        if (outcome === "rewritten") done++;
        else failures.push({ id: t.prospectQueueId, error: OUTCOME_TEXT[outcome] });
      } catch (e) {
        failures.push({ id: t.prospectQueueId, error: `failed: ${String((e as Error)?.message ?? e).slice(0, 180)}` });
      }
      i++;
    }
    return { cursor: i, done, failures, finished: i >= targets.length, message: `Rewriting not-started sequences: ${i} of ${targets.length}` };
  },
  async finish(job, _payload, outcome) {
    console.log(`[RewriteNotStarted] ws ${job.workspaceId}: job ${job.id} ${outcome} — ${job.done} rewritten, ${job.failed} not, of ${job.total}`);
  },
});

/** Counts by outcome, from a job's stored outcome list. */
function countOutcomes(failures: Array<{ error: string }>) {
  const c = { startedMeanwhile: 0, noSteps: 0, held: 0, failed: 0 };
  for (const f of failures) {
    if (f.error.startsWith("started_meanwhile:")) c.startedMeanwhile++;
    else if (f.error.startsWith("no_steps:")) c.noSteps++;
    else if (f.error.startsWith("held:")) c.held++;
    else c.failed++;
  }
  return c;
}

/** The workspace's latest rewrite job, as the status endpoint shows it. Read from the job row, so a restart loses nothing. */
export async function rewriteJobState(workspaceId: number): Promise<RewriteJobState & { jobId: number | null; outcomes: Array<{ prospectQueueId: number; outcome: string }> }> {
  const empty = {
    running: false, total: 0, done: 0, rewritten: 0, startedMeanwhile: 0, noSteps: 0, held: 0, failed: 0,
    startedAt: null, finishedAt: null, lastError: null, jobId: null, outcomes: [],
  };
  const db = await getDb();
  if (!db) return empty;
  const [job] = await db.select().from(bulkJobs)
    .where(and(eq(bulkJobs.workspaceId, workspaceId), eq(bulkJobs.kind, REWRITE_NOT_STARTED_JOB)))
    .orderBy(desc(bulkJobs.id)).limit(1);
  if (!job) return empty;
  const failures = ((job.failures as Array<{ id: number; error: string }> | null) ?? []);
  const c = countOutcomes(failures);
  const lastFailed = failures.filter((f) => f.error.startsWith("failed:")).pop();
  return {
    running: job.status === "queued" || job.status === "running",
    total: job.total,
    done: job.done + job.failed,
    rewritten: job.done,
    ...c,
    // The stored list keeps the latest 200; the count of the rest is the job's.
    failed: c.failed + Math.max(0, job.failed - failures.length),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
    lastError: lastFailed ? `prospect ${lastFailed.id}: ${lastFailed.error}` : (job.status === "failed" ? job.message : null),
    jobId: job.id,
    outcomes: failures.map((f) => ({ prospectQueueId: Number(f.id), outcome: f.error })),
  };
}

/**
 * Start the job for these targets (F14): a persisted job, started at once
 * through the runner's kick. False when one is already queued or running for
 * the workspace.
 */
export async function startRewriteNotStarted(workspaceId: number, userId: number | null, targets: NotStartedTarget[]): Promise<boolean> {
  if (await activeJob(workspaceId, REWRITE_NOT_STARTED_JOB)) return false;
  const { existing } = await enqueueJob({
    workspaceId, userId, kind: REWRITE_NOT_STARTED_JOB, payload: { targets } satisfies RewritePayload, total: targets.length, oneAtATime: true,
  });
  if (existing) return false;
  kickJobs();
  return true;
}
