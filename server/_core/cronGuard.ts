/**
 * Overlap protection for the interval-driven engines.
 *
 * Every engine here is scheduled with `setInterval(fn, N)`, which does not wait
 * for the previous run. Nothing guarded that, and the intervals are optimistic
 * rather than enforced — the ARE comment literally says 3 minutes gives "each
 * tick room to finish", which is an assumption about work that does serial LLM
 * enrichment for five prospects, generates three sequences and scrapes the web
 * before it sends anything.
 *
 * When a tick overruns, the consequences are not cosmetic:
 *
 *  - **Send caps double.** Two overlapping ARE ticks each read the same
 *    "sent today" count, each compute the same `remaining`, and each dispatch
 *    up to that many. The daily cap exists to protect sender reputation, and
 *    two runs quietly spend it twice.
 *  - **Paid work repeats.** Both ticks pick the same prospects to enrich, so
 *    the same LLM and enrichment credits are spent for one result.
 *
 * Skipping is the right response, not queueing: these engines are idempotent
 * across ticks by design — whatever a skipped tick would have done, the next
 * one picks up. A queue would just move the overrun into a growing backlog.
 *
 * The skip is logged. An engine that silently does half as much as its schedule
 * implies is exactly the kind of thing that is impossible to diagnose later.
 */

import { mergeRequestContext } from "./requestContext";

/**
 * What each guarded engine did since this process started (audit 2026-10-20,
 * F49): the admin engine status page reads it. Every engine scheduled through
 * guardOverlap is listed from the moment it is wired, so one that has never
 * ticked shows as never run rather than not at all.
 */
export interface EngineRunStatus {
  name: string;
  running: boolean;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  skipped: number;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastDurationMs: number | null;
  lastOkAt: Date | null;
  /** The last failure's message, cut at 300 characters. */
  lastError: string | null;
}

const ENGINE_STATUS = new Map<string, EngineRunStatus>();

export function engineRunStatuses(): EngineRunStatus[] {
  return Array.from(ENGINE_STATUS.values()).map((s) => ({ ...s }));
}

function statusFor(name: string): EngineRunStatus {
  let s = ENGINE_STATUS.get(name);
  if (!s) {
    s = { name, running: false, runs: 0, failures: 0, consecutiveFailures: 0, skipped: 0, lastStartedAt: null, lastFinishedAt: null, lastDurationMs: null, lastOkAt: null, lastError: null };
    ENGINE_STATUS.set(name, s);
  }
  return s;
}

export interface GuardedRunner {
  (): void;
  /** True while a run is in flight. Exposed for tests and diagnostics. */
  isRunning: () => boolean;
  /** How many ticks have been skipped because a run was still going. */
  skipped: () => number;
}

/**
 * Wrap an async task so overlapping ticks are skipped rather than run
 * concurrently. The returned function is fire-and-forget, matching how the
 * schedulers call it, and never rejects.
 */
export function guardOverlap(name: string, task: () => Promise<unknown>): GuardedRunner {
  let running = false;
  let skippedCount = 0;
  const status = statusFor(name);

  const run = (() => {
    if (running) {
      skippedCount++;
      status.skipped++;
      console.warn(
        `[Cron] ${name}: previous run still in flight — skipping this tick ` +
        `(${skippedCount} skipped so far). If this repeats, the interval is shorter than the work.`,
      );
      return;
    }
    running = true;
    const started = Date.now();
    status.running = true;
    status.lastStartedAt = new Date(started);
    // `finally` rather than clearing in both branches: if the task throws
    // synchronously or rejects, the flag MUST still clear or the engine is
    // wedged off until the next deploy — a far worse failure than an overlap.
    // Named for the spend report (services/spend): a paid call the job makes
    // without naming itself is recorded as `cron <name>`, not "background".
    Promise.resolve()
      .then(() => mergeRequestContext({ feature: `cron ${name}` }, task))
      .then(() => {
        status.runs++;
        status.consecutiveFailures = 0;
        status.lastOkAt = new Date();
      })
      .catch((e) => {
        status.runs++;
        status.failures++;
        status.consecutiveFailures++;
        status.lastError = String((e as Error)?.message ?? e).slice(0, 300);
        console.error(`[Cron] ${name} failed:`, e);
      })
      .finally(() => {
        running = false;
        status.running = false;
        status.lastFinishedAt = new Date();
        status.lastDurationMs = Date.now() - started;
      });
  }) as GuardedRunner;

  run.isRunning = () => running;
  run.skipped = () => skippedCount;
  return run;
}
