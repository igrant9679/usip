/**
 * dealMetrics.ts — the one place deal numbers are computed (audit 2026-10-20,
 * Phase 2: R16, R17, R19, R39, R83).
 *
 * 🔴 THE BUG. Five screens each did their own arithmetic on the same deals and
 * disagreed: the Dashboard counted "won this month" by updatedAt, so editing an
 * old win's notes moved it into this month; Quota did the same, and measured a
 * quarterly target against one month; the Pipeline forecast summed won deals
 * into "Total pipeline"; the Forecast page bucketed wins by the EXPECTED close
 * date; the Deals header and the board columns used different win %s; and
 * month buckets were cut in the server's zone (UTC), not the workspace's.
 *
 * Now every revenue number reads loadMetricDeals:
 *   • a deal is open, won or lost by the stage FLAGS of its own pipeline
 *     (stageResolver — the same answer the stage-change service gives);
 *   • open deals are weighted by the deal's own win %; won and lost deals are
 *     never pipeline;
 *   • a win counts in the period of wonAt (a loss, lostAt) — an instant, cut
 *     in the workspace's time zone;
 *   • an expected close date is a CALENDAR date (shared/calendarDate) and
 *     buckets by its own month.
 * Totals are summed in cents so they agree to the cent on every screen.
 */
import { and, eq } from "drizzle-orm";
import { calendarMonthKey } from "@shared/calendarDate";
import { opportunities } from "../../drizzle/schema";
import type { getDb } from "../db";
import { stageResolver } from "../_core/stageSemantics";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type DealStatus = "open" | "won" | "lost";

export type MetricDeal = {
  id: number;
  name: string;
  ownerUserId: number | null;
  pipelineId: number | null;
  stage: string;
  status: DealStatus;
  /** In cents. */
  valueCents: number;
  /** The deal's own win % for an open deal; 100 won, 0 lost. */
  winProb: number;
  /** Expected close date — a calendar date. */
  closeDate: Date | null;
  /** When it was won (won deals only). */
  wonAt: Date | null;
  /** When it was lost (lost deals only). */
  lostAt: Date | null;
  createdAt: Date | null;
};

const toDate = (v: unknown): Date | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Every deal in the workspace (optionally one owner's), classified. A closed
 * deal from before migration 0211 that the backfill has not reached yet falls
 * back to when it entered its stage, then to its last update.
 */
export async function loadMetricDeals(
  db: Db,
  workspaceId: number,
  opts: { ownerUserId?: number | null } = {},
): Promise<MetricDeal[]> {
  const where = opts.ownerUserId != null
    ? and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.ownerUserId, opts.ownerUserId))
    : eq(opportunities.workspaceId, workspaceId);
  const rows = await db.select({
    id: opportunities.id,
    name: opportunities.name,
    ownerUserId: opportunities.ownerUserId,
    pipelineId: opportunities.pipelineId,
    stage: opportunities.stage,
    value: opportunities.value,
    winProb: opportunities.winProb,
    closeDate: opportunities.closeDate,
    stageEnteredAt: opportunities.stageEnteredAt,
    wonAt: opportunities.wonAt,
    lostAt: opportunities.lostAt,
    createdAt: opportunities.createdAt,
    updatedAt: opportunities.updatedAt,
  }).from(opportunities).where(where);
  const stages = await stageResolver(db, workspaceId);
  return rows.map((o) => {
    const meta = stages.resolve(o.pipelineId ?? null, o.stage);
    const status: DealStatus = meta.isWon ? "won" : meta.isLost ? "lost" : "open";
    const closedAt = toDate(status === "won" ? o.wonAt : o.lostAt) ?? toDate(o.stageEnteredAt) ?? toDate(o.updatedAt);
    const prob = Math.max(0, Math.min(100, Math.round(Number(o.winProb ?? 0))));
    return {
      id: o.id,
      name: o.name,
      ownerUserId: o.ownerUserId ?? null,
      pipelineId: o.pipelineId ?? null,
      stage: o.stage,
      status,
      valueCents: Math.round(Number(o.value ?? 0) * 100) || 0,
      winProb: status === "won" ? 100 : status === "lost" ? 0 : prob,
      closeDate: toDate(o.closeDate),
      wonAt: status === "won" ? closedAt : null,
      lostAt: status === "lost" ? closedAt : null,
      createdAt: toDate(o.createdAt),
    };
  });
}

/* ── Money ──────────────────────────────────────────────────────────────── */

/** Cents → dollars, rounded to the cent (weighted sums carry fractions). */
export const dollars = (cents: number) => Math.round(cents) / 100;

export type OpenTotals = {
  count: number;
  value: number;
  weighted: number;
  /** Open deals at ≥ 90% (Forecast page). */
  commit: number;
  /** Open deals at ≥ 50%. */
  bestCase: number;
};

export function openTotals(deals: MetricDeal[]): OpenTotals {
  let count = 0, value = 0, weighted = 0, commit = 0, bestCase = 0;
  for (const d of deals) {
    if (d.status !== "open") continue;
    count++;
    value += d.valueCents;
    weighted += (d.valueCents * d.winProb) / 100;
    if (d.winProb >= 90) commit += d.valueCents;
    if (d.winProb >= 50) bestCase += d.valueCents;
  }
  return { count, value: dollars(value), weighted: dollars(weighted), commit: dollars(commit), bestCase: dollars(bestCase) };
}

/** Won (or lost) deals whose close instant falls in the range. */
export function closedIn(deals: MetricDeal[], status: "won" | "lost", range?: Range): { count: number; value: number } {
  let count = 0, value = 0;
  for (const d of deals) {
    if (d.status !== status) continue;
    const at = status === "won" ? d.wonAt : d.lostAt;
    if (range && !inRange(at, range)) continue;
    count++;
    value += d.valueCents;
  }
  return { count, value: dollars(value) };
}

/* ── Periods, in the workspace's time zone ──────────────────────────────── */

/** [start, end) */
export type Range = { start: Date; end: Date };

export const inRange = (d: Date | null | undefined, r: Range) => !!d && d >= r.start && d < r.end;

/** Local wall-clock minus UTC at `at`, in ms. A bad zone reads as UTC. */
function tzOffsetMs(tz: string, at: number): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC", hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(at));
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
    return wall - Math.floor(at / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** The calendar day `d` falls on in `tz`. Month is 1–12. */
export function zonedYmd(tz: string, d: Date): { y: number; m: number; day: number } {
  const local = new Date(d.getTime() + tzOffsetMs(tz, d.getTime()));
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, day: local.getUTCDate() };
}

/** The instant local midnight began on that calendar day in `tz`. */
export function zonedMidnight(tz: string, y: number, m: number, day = 1): Date {
  const guess = Date.UTC(y, m - 1, day);
  let t = guess - tzOffsetMs(tz, guess);
  // Second pass: the offset at the answer, which differs from the guess's when
  // a DST change falls between them.
  t = guess - tzOffsetMs(tz, t);
  return new Date(t);
}

/** Month arithmetic from day 1, so the 29th–31st never skip a month (R83). */
export function addMonths(y: number, m: number, n: number): { y: number; m: number } {
  const i = y * 12 + (m - 1) + n;
  return { y: Math.floor(i / 12), m: (i % 12) + 1 };
}

export function monthsRange(tz: string, y: number, m: number, months: number): Range {
  const e = addMonths(y, m, months);
  return { start: zonedMidnight(tz, y, m), end: zonedMidnight(tz, e.y, e.m) };
}

export const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/** "YYYY-MM" of an instant, in the workspace's zone. */
export function instantMonthKey(tz: string, d: Date): string {
  const { y, m } = zonedYmd(tz, d);
  return monthKey(y, m);
}

export function currentRanges(tz: string, now: Date = new Date()) {
  const { y, m } = zonedYmd(tz, now);
  const prev = addMonths(y, m, -1);
  const qm = Math.floor((m - 1) / 3) * 3 + 1;
  return {
    month: monthsRange(tz, y, m, 1),
    prevMonth: monthsRange(tz, prev.y, prev.m, 1),
    quarter: monthsRange(tz, y, qm, 3),
    year: monthsRange(tz, y, 1, 12),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The range a quota target measures (R17). The period names a month
 * ("2026-11"), a quarter ("2026-Q4") or a year ("2026-FY"); the period TYPE
 * decides how much of the calendar around it counts — a quarterly target
 * stored under a month (as they were before this) measures that month's
 * quarter, an annual one the whole year.
 */
export function quotaPeriodRange(
  tz: string,
  period: string,
  periodType: "monthly" | "quarterly" | "annual" | string | null | undefined,
): Range & { label: string } {
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  const mm = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  const fy = /^(\d{4})-FY$/.exec(period);
  if (!q && !mm && !fy) throw new Error(`Not a quota period: ${period}`);
  const y = Number((q ?? mm ?? fy)![1]);
  const m = q ? (Number(q[2]) - 1) * 3 + 1 : mm ? Number(mm[2]) : 1;
  const type = periodType === "annual" || fy ? "annual" : periodType === "quarterly" || q ? "quarterly" : "monthly";
  if (type === "annual") return { ...monthsRange(tz, y, 1, 12), label: String(y) };
  if (type === "quarterly") {
    const qm = Math.floor((m - 1) / 3) * 3 + 1;
    return { ...monthsRange(tz, y, qm, 3), label: `Q${(qm + 2) / 3} ${y} (${MONTHS[qm - 1]}–${MONTHS[qm + 1]})` };
  }
  return { ...monthsRange(tz, y, m, 1), label: `${MONTHS[m - 1]} ${y}` };
}

/** "YYYY-MM" an open deal is expected to close in, or null with no date. */
export const closeMonthKey = (d: MetricDeal) => calendarMonthKey(d.closeDate);
