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
 * Runs detached from the request (runOutsideRequestContext), like the engine
 * that normally writes these sequences: the per-user interactive ceiling of
 * 30 model calls a minute would otherwise fail a bulk pass part-way. Every
 * model call on this path names its workspace explicitly. One prospect at a
 * time; one job per workspace; never sends anything.
 */
import { and, eq, sql } from "drizzle-orm";
import { areExecutionQueue, prospectIntelligence, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { normalizeSequence } from "@shared/areSequenceSteps";
import { runOutsideRequestContext } from "../../_core/requestContext";

export interface NotStartedTarget {
  prospectQueueId: number;
  campaignId: number;
}

export type RewriteOutcome = "rewritten" | "started_meanwhile" | "no_steps" | "failed";

export interface RewriteJobState {
  running: boolean;
  total: number;
  done: number;
  rewritten: number;
  startedMeanwhile: number;
  noSteps: number;
  failed: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
}

const jobs = new Map<number, RewriteJobState>();

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
  await runSequenceAgent(target.prospectQueueId, workspaceId, target.campaignId, { force: true });

  const [intel] = await db
    .select({ seq: prospectIntelligence.generatedSequence })
    .from(prospectIntelligence)
    .where(eq(prospectIntelligence.prospectQueueId, target.prospectQueueId))
    .limit(1);
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

export function rewriteJobState(workspaceId: number): RewriteJobState {
  return jobs.get(workspaceId) ?? {
    running: false, total: 0, done: 0, rewritten: 0, startedMeanwhile: 0, noSteps: 0, failed: 0,
    startedAt: null, finishedAt: null, lastError: null,
  };
}

/** Start the job for these targets. False when one is already running for the workspace. */
export function startRewriteNotStarted(workspaceId: number, targets: NotStartedTarget[]): boolean {
  if (jobs.get(workspaceId)?.running) return false;
  const state: RewriteJobState = {
    running: true, total: targets.length, done: 0, rewritten: 0, startedMeanwhile: 0, noSteps: 0, failed: 0,
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
  };
  jobs.set(workspaceId, state);
  runOutsideRequestContext(() => {
    void (async () => {
      for (const t of targets) {
        try {
          const outcome = await rewriteOneNotStarted(workspaceId, t);
          if (outcome === "rewritten") state.rewritten++;
          else if (outcome === "started_meanwhile") state.startedMeanwhile++;
          else if (outcome === "no_steps") state.noSteps++;
          else state.failed++;
        } catch (e) {
          state.failed++;
          state.lastError = `prospect ${t.prospectQueueId}: ${String((e as Error)?.message ?? e).slice(0, 300)}`;
          console.error(`[RewriteNotStarted] ws ${workspaceId} ${state.lastError}`);
        }
        state.done++;
      }
      state.running = false;
      state.finishedAt = new Date().toISOString();
      console.log(`[RewriteNotStarted] ws ${workspaceId}: ${state.rewritten} rewritten, ${state.startedMeanwhile} started meanwhile, ${state.noSteps} no steps, ${state.failed} failed of ${state.total}`);
    })();
  });
  return true;
}
