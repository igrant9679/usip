/**
 * Slow-query logging (audit 2026-10-20, F49).
 *
 * Nothing timed a query, so a screen that got slow was found by a customer.
 * The database pool's query and execute are wrapped once (db.ts): a query
 * that takes longer than SLOW_QUERY_MS (default 500) is counted, and a sample
 * of them (SLOW_QUERY_SAMPLE, default 0.2) is logged and kept, newest first,
 * for the admin engine status page.
 *
 * What is kept is the statement's text with its literals blanked, never its
 * bound values: drizzle sends values separately, and a quoted string or long
 * number written into raw SQL is replaced, so a name or an address does not
 * reach a log. A query inside a transaction runs on a checked-out connection,
 * not the pool, and is not timed: a known gap, and a small share of traffic.
 */

const DEFAULT_THRESHOLD_MS = 500;
const DEFAULT_SAMPLE = 0.2;
const KEEP = 50;

export interface SlowQuerySample {
  at: Date;
  ms: number;
  sql: string;
}

const state = {
  slow: 0,
  slowestMs: 0,
  since: new Date(),
  samples: [] as SlowQuerySample[],
};

export function slowQueryThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SLOW_QUERY_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD_MS;
}

export function slowQuerySampleRate(env: NodeJS.ProcessEnv = process.env): number {
  if (env.SLOW_QUERY_SAMPLE === undefined || env.SLOW_QUERY_SAMPLE === "") return DEFAULT_SAMPLE;
  const n = Number(env.SLOW_QUERY_SAMPLE);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_SAMPLE;
}

/** The statement with its literals blanked and its whitespace collapsed, cut at 400 characters. */
export function querySignature(sql: string): string {
  return sql
    .replace(/'(?:[^'\\]|\\.)*'/g, "'?'")
    .replace(/"(?:[^"\\]|\\.)*"/g, '"?"')
    .replace(/\b\d{4,}\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/** Note one finished query. `random` is injectable for tests. */
export function noteQuery(sql: string, ms: number, random: () => number = Math.random, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!(ms >= slowQueryThresholdMs(env))) return false;
  state.slow++;
  if (ms > state.slowestMs) state.slowestMs = ms;
  if (random() >= slowQuerySampleRate(env)) return false;
  const sample = { at: new Date(), ms: Math.round(ms), sql: querySignature(sql) };
  state.samples.unshift(sample);
  if (state.samples.length > KEEP) state.samples.length = KEEP;
  console.warn(`[SlowQuery] ${sample.ms} ms: ${sample.sql}`);
  return true;
}

export function slowQueryStats() {
  return {
    thresholdMs: slowQueryThresholdMs(),
    sampleRate: slowQuerySampleRate(),
    since: state.since,
    slow: state.slow,
    slowestMs: Math.round(state.slowestMs),
    samples: state.samples.slice(),
  };
}

/** For tests. */
export function resetSlowQueryStats(): void {
  state.slow = 0;
  state.slowestMs = 0;
  state.since = new Date();
  state.samples = [];
}

type Callback = (err: unknown, ...rest: unknown[]) => void;
type Queryable = Record<"query" | "execute", (...args: unknown[]) => unknown>;

/**
 * Time every query and execute the mysql2 pool runs. Each call's callback is
 * wrapped; a call without one (a streaming query) is passed through untimed.
 */
export function instrumentPool(pool: Queryable, now: () => number = () => performance.now()): void {
  if (!pool || (pool as { __timed?: boolean }).__timed) return;
  for (const method of ["query", "execute"] as const) {
    const original = pool[method];
    if (typeof original !== "function") continue;
    pool[method] = function timed(this: unknown, ...args: unknown[]) {
      const at = args.length - 1;
      if (at < 0 || typeof args[at] !== "function") return original.apply(pool, args);
      const done = args[at] as Callback;
      const first = args[0] as string | { sql?: string } | undefined;
      const sql = typeof first === "string" ? first : typeof first?.sql === "string" ? first.sql : "";
      const started = now();
      args[at] = (err: unknown, ...rest: unknown[]) => {
        try { noteQuery(sql, now() - started); } catch { /* logging must never fail a query */ }
        done(err, ...rest);
      };
      return original.apply(pool, args);
    };
  }
  (pool as { __timed?: boolean }).__timed = true;
}
