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

  const run = (() => {
    if (running) {
      skippedCount++;
      console.warn(
        `[Cron] ${name}: previous run still in flight — skipping this tick ` +
        `(${skippedCount} skipped so far). If this repeats, the interval is shorter than the work.`,
      );
      return;
    }
    running = true;
    // `finally` rather than clearing in both branches: if the task throws
    // synchronously or rejects, the flag MUST still clear or the engine is
    // wedged off until the next deploy — a far worse failure than an overlap.
    Promise.resolve()
      .then(task)
      .catch((e) => console.error(`[Cron] ${name} failed:`, e))
      .finally(() => {
        running = false;
      });
  }) as GuardedRunner;

  run.isRunning = () => running;
  run.skipped = () => skippedCount;
  return run;
}
