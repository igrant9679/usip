/**
 * Persisted background jobs (audit 2026-10-20, Phase 3: A37, P11).
 *
 * 🔴 THE GAP. Bulk AI actions ran inside the request, or in a promise the
 * request left behind: progress lived in memory, a restart lost the run, and
 * every model call counted against the clicking user's 30-a-minute ceiling,
 * so a 50-row "Generate sequences" failed part-way. "Recompute all" scored
 * every lead in one request, and a second click ran it all again.
 *
 * Now such work is a row in bulk_jobs that a worker drains in slices:
 *
 *   enqueueJob   writes the row (one active job per workspace and kind when
 *                asked: a second click gets the running job back)
 *   tickJobs     claims the oldest due job with a conditional UPDATE, runs one
 *                slice of its kind's `step` from the saved cursor, and saves
 *                the cursor, counts and failures. A worker that dies leaves a
 *                stale heartbeat, and the next tick picks the job up again
 *                from its last cursor.
 *   cancelJob    stops a job between slices.
 *
 * A job runs as a background engine does: outside any request, so the
 * per-user burst ceiling (an interactive control) does not apply, while the
 * workspace's monthly AI budget still does. Work is sequential, one item at a
 * time, which is its own pacing.
 */
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { bulkJobs, users } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { runWithRequestContext } from "../../_core/requestContext";

export type BulkJob = typeof bulkJobs.$inferSelect;
export type JobFailure = { id: number | string; error: string };

export type StepResult = {
  /** Where the next slice starts. */
  cursor: number;
  /** Items finished in this slice (successes). */
  done: number;
  failures: JobFailure[];
  /** True when nothing is left. */
  finished: boolean;
  /** A line for the progress card ("Scored 40 of 120"). */
  message?: string;
};

export interface JobKind<P = unknown> {
  /** Process from `job.resumeFrom` until about `budgetMs` has passed, then say where it got to. */
  step(job: BulkJob, payload: P, budgetMs: number): Promise<StepResult>;
  /** Once, when the job ends: the audit row, the log line. */
  finish?(job: BulkJob, payload: P, outcome: "done" | "failed" | "canceled"): Promise<void>;
}

const kinds = new Map<string, JobKind<any>>();

export function registerJobKind<P>(kind: string, handler: JobKind<P>): void {
  kinds.set(kind, handler as JobKind<any>);
}

/** A running job whose heartbeat is older than this lost its worker. */
export const JOB_STALE_MS = 3 * 60 * 1000;
/** How long one slice may run before it saves its place. */
export const JOB_SLICE_MS = 20_000;
/** Failures kept on the row; the count keeps going. */
const MAX_FAILURES_KEPT = 200;

const ACTIVE = ["queued", "running"];

export async function enqueueJob(opts: {
  workspaceId: number;
  userId: number | null;
  kind: string;
  payload: unknown;
  total: number;
  /** Return the job already queued or running for this workspace and kind instead of adding another. */
  oneAtATime?: boolean;
}): Promise<{ job: BulkJob; existing: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  if (!kinds.has(opts.kind)) throw new Error(`Unknown job kind ${opts.kind}`);
  if (opts.oneAtATime) {
    const [active] = await db
      .select()
      .from(bulkJobs)
      .where(and(eq(bulkJobs.workspaceId, opts.workspaceId), eq(bulkJobs.kind, opts.kind), inArray(bulkJobs.status, ACTIVE)))
      .limit(1);
    if (active) return { job: active, existing: true };
  }
  const [ins] = await db
    .insert(bulkJobs)
    .values({
      workspaceId: opts.workspaceId,
      userId: opts.userId,
      kind: opts.kind,
      status: "queued",
      total: opts.total,
      done: 0,
      failed: 0,
      resumeFrom: 0,
      payload: opts.payload as never,
    })
    .$returningId();
  const [job] = await db.select().from(bulkJobs).where(eq(bulkJobs.id, ins.id)).limit(1);
  // The worker's 15-second tick (_core/index.ts) starts it.
  return { job, existing: false };
}

/**
 * Claim the oldest queued job, or a running one whose worker died. Only kinds
 * this process has registered: a job claimed before its module loaded would
 * otherwise fail as "no worker".
 */
async function claimNext(): Promise<BulkJob | null> {
  const db = await getDb();
  if (!db || kinds.size === 0) return null;
  const staleBefore = new Date(Date.now() - JOB_STALE_MS);
  const active = await db
    .select()
    .from(bulkJobs)
    .where(and(inArray(bulkJobs.kind, Array.from(kinds.keys())), inArray(bulkJobs.status, ACTIVE)))
    .orderBy(asc(bulkJobs.id));
  // Queued, or running with a heartbeat older than JOB_STALE_MS (or none).
  const due = active
    .filter((j) => j.status === "queued" || !j.heartbeatAt || new Date(j.heartbeatAt).getTime() < staleBefore.getTime())
    .slice(0, 5);
  for (const job of due) {
    // The claim is the conditional UPDATE: two workers, one winner.
    const [res] = await db
      .update(bulkJobs)
      .set({ status: "running", heartbeatAt: new Date(), startedAt: job.startedAt ?? new Date() })
      .where(
        and(
          eq(bulkJobs.id, job.id),
          eq(bulkJobs.status, job.status),
          // A stale running job: only if nobody touched its heartbeat since we read it.
          ...(job.status === "queued" ? [] : [job.heartbeatAt ? eq(bulkJobs.heartbeatAt, job.heartbeatAt) : isNull(bulkJobs.heartbeatAt)]),
        ),
      );
    if (Number((res as { affectedRows?: number })?.affectedRows ?? 0) === 1) {
      return { ...job, status: "running" };
    }
  }
  return null;
}

let ticking = false;

/**
 * Run due jobs, one slice each, until none is due or `budgetMs` is spent.
 * Returns how many slices ran. Re-entrant calls return at once.
 */
export async function tickJobs(budgetMs = 60_000): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  const until = Date.now() + budgetMs;
  let slices = 0;
  try {
    while (Date.now() < until) {
      const job = await claimNext();
      if (!job) break;
      await runSlice(job);
      slices++;
    }
  } finally {
    ticking = false;
  }
  return slices;
}

async function runSlice(job: BulkJob): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const kind = kinds.get(job.kind);
  const payload = (job.payload ?? {}) as unknown;
  if (!kind) {
    await db.update(bulkJobs).set({ status: "failed", message: `No worker for job kind ${job.kind}`, finishedAt: new Date() })
      .where(eq(bulkJobs.id, job.id));
    return;
  }
  let step: StepResult;
  try {
    // Background work: the per-user burst ceiling (an interactive control)
    // is skipped even where a step runs procedures as the person who started
    // the job; the workspace's monthly budget still applies to every call.
    step = await runWithRequestContext({ feature: `job ${job.kind}`, background: true }, () => kind.step(job, payload, JOB_SLICE_MS));
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await db.update(bulkJobs).set({ status: "failed", message, finishedAt: new Date() })
      .where(and(eq(bulkJobs.id, job.id), eq(bulkJobs.status, "running")));
    await kind.finish?.({ ...job, status: "failed", message }, payload, "failed").catch(() => {});
    return;
  }
  const failures = [...((job.failures as JobFailure[] | null) ?? []), ...step.failures].slice(-MAX_FAILURES_KEPT);
  const next = {
    resumeFrom: step.cursor,
    done: job.done + step.done,
    failed: job.failed + step.failures.length,
    failures: failures as never,
    message: step.message?.slice(0, 500) ?? job.message,
    heartbeatAt: new Date(),
    // Unfinished: back in the queue, so the next claim (this tick or the next)
    // carries on from resumeFrom and other jobs get their turn in between.
    status: step.finished ? "done" : "queued",
    ...(step.finished ? { finishedAt: new Date() } : {}),
  };
  // Only a job still running takes the slice's result: one canceled while
  // the slice ran stays canceled.
  const [res] = await db.update(bulkJobs).set(next).where(and(eq(bulkJobs.id, job.id), eq(bulkJobs.status, "running")));
  const saved = Number((res as { affectedRows?: number })?.affectedRows ?? 0) === 1;
  if (saved && step.finished) {
    await kind.finish?.({ ...job, ...next, status: "done" } as BulkJob, payload, "done").catch((e) => console.error(`[jobs] finish ${job.kind} failed:`, e));
  } else if (!saved) {
    const [now] = await db.select().from(bulkJobs).where(eq(bulkJobs.id, job.id)).limit(1);
    if (now?.status === "canceled") await kind.finish?.(now, payload, "canceled").catch(() => {});
  }
}

/** Stop a queued or running job; a running slice finishes its current item first. */
export async function cancelJob(workspaceId: number, jobId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [res] = await db
    .update(bulkJobs)
    .set({ status: "canceled", finishedAt: new Date(), message: "Canceled" })
    .where(and(eq(bulkJobs.id, jobId), eq(bulkJobs.workspaceId, workspaceId), inArray(bulkJobs.status, ACTIVE)));
  return Number((res as { affectedRows?: number })?.affectedRows ?? 0) === 1;
}

/** A job as the progress card shows it. */
export async function getJob(workspaceId: number, jobId: number) {
  const db = await getDb();
  if (!db) return null;
  const [job] = await db.select().from(bulkJobs).where(and(eq(bulkJobs.id, jobId), eq(bulkJobs.workspaceId, workspaceId))).limit(1);
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    total: job.total,
    done: job.done,
    failed: job.failed,
    failures: ((job.failures as JobFailure[] | null) ?? []).slice(-20),
    message: job.message,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

/** The workspace's active job of a kind, if any (to show "already running"). */
export async function activeJob(workspaceId: number, kind: string) {
  const db = await getDb();
  if (!db) return null;
  const [job] = await db
    .select({ id: bulkJobs.id })
    .from(bulkJobs)
    .where(and(eq(bulkJobs.workspaceId, workspaceId), eq(bulkJobs.kind, kind), inArray(bulkJobs.status, ACTIVE)))
    .limit(1);
  return job ? getJob(workspaceId, job.id) : null;
}

/** A queued or running job of this kind whose payload matches, if any (a second click gets it back). */
export async function findActiveJob<P>(workspaceId: number, kind: string, matches: (payload: P) => boolean): Promise<BulkJob | null> {
  const db = await getDb();
  if (!db) return null;
  const active = await db
    .select()
    .from(bulkJobs)
    .where(and(eq(bulkJobs.workspaceId, workspaceId), eq(bulkJobs.kind, kind), inArray(bulkJobs.status, ACTIVE)));
  return active.find((j) => matches((j.payload ?? {}) as P)) ?? null;
}

/**
 * A tRPC caller context for the person who started a job, for job kinds that
 * run each item through the same procedure a button runs. Membership, role
 * and archive checks apply again at run time: someone removed from the
 * workspace since does not keep acting in it.
 */
export async function callerContextFor(job: BulkJob): Promise<unknown> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [user] = job.userId ? await db.select().from(users).where(eq(users.id, job.userId)).limit(1) : [];
  if (!user) throw new Error("The person who started this job is no longer a user.");
  return {
    user,
    req: { protocol: "https", headers: { "x-workspace-id": String(job.workspaceId) }, socket: { remoteAddress: "127.0.0.1" } },
    res: { clearCookie() {}, cookie() {} },
  };
}

/** Test seam: the in-process re-entrancy guard. */
export function __resetJobRunnerForTests(): void {
  ticking = false;
}
