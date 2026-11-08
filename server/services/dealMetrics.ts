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
import { forecastBuckets } from "@shared/forecastCategory";
import { renewalStageFor } from "@shared/renewalStage";

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
  /** A rep's forecast call (R41), or null: counted by win %. */
  forecastCategory: string | null;
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
    forecastCategory: opportunities.forecastCategory,
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
      forecastCategory: o.forecastCategory ?? null,
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
  /** Open deals in Commit: marked so, or unmarked at ≥ 90% (Forecast page, R41). */
  commit: number;
  /** Open deals in Best case: Commit and Best case, or unmarked at ≥ 50%. */
  bestCase: number;
};

export function openTotals(deals: MetricDeal[]): OpenTotals {
  let count = 0, value = 0, weighted = 0, commit = 0, bestCase = 0;
  for (const d of deals) {
    if (d.status !== "open") continue;
    count++;
    value += d.valueCents;
    weighted += (d.valueCents * d.winProb) / 100;
    const b = forecastBuckets(d.forecastCategory, d.winProb);
    if (b.commit) commit += d.valueCents;
    if (b.bestCase) bestCase += d.valueCents;
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

/* ── The fiscal calendar (audit 2026-10-20, F29 and R41) ───────────────────
 * A workspace's fiscal year starts in the month it sets (workspace_settings.
 * fiscalYearStartMonth, January unless an admin changes it), and its quarters
 * are the three-month runs from there. A fiscal year is named by the calendar
 * year it ends in. With January every function below is the calendar one,
 * which is what every number counted by before. */

/** Months since the fiscal year began, 0–11. */
const fiscalOffset = (m: number, fyStart: number) => (((m - fyStart) % 12) + 12) % 12;

/** The fiscal quarter a calendar month is in: its fiscal year, its number, and its first month. */
export function fiscalQuarterOf(y: number, m: number, fyStart = 1): { fy: number; q: number; start: { y: number; m: number } } {
  const off = fiscalOffset(m, fyStart);
  const fyFirst = addMonths(y, m, -off);
  const last = addMonths(fyFirst.y, fyFirst.m, 11);
  const q = Math.floor(off / 3) + 1;
  return { fy: last.y, q, start: addMonths(fyFirst.y, fyFirst.m, (q - 1) * 3) };
}

/** The first calendar month of fiscal year `fy`. */
export function fiscalYearFirstMonth(fy: number, fyStart = 1): { y: number; m: number } {
  const last = fyStart === 1 ? { y: fy, m: 12 } : { y: fy, m: fyStart - 1 };
  return addMonths(last.y, last.m, -11);
}

/** The first calendar month of quarter `q` of fiscal year `fy`. */
export function fiscalQuarterFirstMonth(fy: number, q: number, fyStart = 1): { y: number; m: number } {
  const first = fiscalYearFirstMonth(fy, fyStart);
  return addMonths(first.y, first.m, (q - 1) * 3);
}

const monthSpan = (s: { y: number; m: number }, n: number, withYears: boolean) => {
  const e = addMonths(s.y, s.m, n - 1);
  return withYears ? `${MONTHS[s.m - 1]} ${s.y}–${MONTHS[e.m - 1]} ${e.y}` : `${MONTHS[s.m - 1]}–${MONTHS[e.m - 1]}`;
};

/** "Q4 2026 (Oct–Dec)" for a calendar year; "Q1 FY2027 (Feb 2026–Apr 2026)" otherwise. */
export function fiscalQuarterLabel(fy: number, q: number, fyStart = 1): string {
  const s = fiscalQuarterFirstMonth(fy, q, fyStart);
  return fyStart === 1 ? `Q${q} ${fy} (${monthSpan(s, 3, false)})` : `Q${q} FY${fy} (${monthSpan(s, 3, true)})`;
}

/** "2026" for a calendar year; "FY2027 (Feb 2026–Jan 2027)" otherwise. */
export function fiscalYearLabel(fy: number, fyStart = 1): string {
  return fyStart === 1 ? String(fy) : `FY${fy} (${monthSpan(fiscalYearFirstMonth(fy, fyStart), 12, true)})`;
}

/* ── The deal board's close-date filter (audit 2026-10-20, U13; CONB) ──────
 * A close date is a calendar day, stored as noon UTC (shared/calendarDate),
 * so a range is a run of days compared by UTC day: from the start of the
 * first day to the start of the day after the last. "Today" is the
 * workspace's day, and "this quarter" its fiscal quarter, as the forecast
 * reads them. */
export const CLOSE_RANGES = ["overdue", "this_month", "this_quarter", "next_90", "none"] as const;
export type CloseRange = (typeof CLOSE_RANGES)[number];

/** A close-date range as instants: on or after `from`, before `before`; or no close date at all. */
export function closeRangeBounds(range: CloseRange, tz: string, now: Date = new Date(), fyStart = 1): { from?: Date; before?: Date; none?: true } {
  if (range === "none") return { none: true };
  const { y, m, day } = zonedYmd(tz, now);
  const dayStart = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm - 1, dd));
  const today = dayStart(y, m, day);
  const plusDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
  if (range === "overdue") return { before: today };
  if (range === "next_90") return { from: today, before: plusDays(today, 90) };
  if (range === "this_month") {
    const next = addMonths(y, m, 1);
    return { from: dayStart(y, m, 1), before: dayStart(next.y, next.m, 1) };
  }
  const q = fiscalQuarterOf(y, m, fyStart).start;
  const after = addMonths(q.y, q.m, 3);
  return { from: dayStart(q.y, q.m, 1), before: dayStart(after.y, after.m, 1) };
}

/** Whether a deal's close date is in a range's bounds (the in-memory twin of the board's SQL). */
export function closeDateIn(closeDate: Date | null, b: { from?: Date; before?: Date; none?: true }): boolean {
  if (b.none) return closeDate == null;
  if (closeDate == null) return false;
  const t = closeDate.getTime();
  return (!b.from || t >= b.from.getTime()) && (!b.before || t < b.before.getTime());
}

/**
 * This month, last month, this fiscal quarter and this fiscal year, in the
 * workspace's zone. `fyStart` 1 (the default) is the calendar year.
 */
export function currentRanges(tz: string, now: Date = new Date(), fyStart = 1) {
  const { y, m } = zonedYmd(tz, now);
  const prev = addMonths(y, m, -1);
  const fq = fiscalQuarterOf(y, m, fyStart);
  const fyFirst = fiscalYearFirstMonth(fq.fy, fyStart);
  const nextQ = addMonths(fq.start.y, fq.start.m, 3);
  const nq = fiscalQuarterOf(nextQ.y, nextQ.m, fyStart);
  return {
    month: monthsRange(tz, y, m, 1),
    prevMonth: monthsRange(tz, prev.y, prev.m, 1),
    quarter: monthsRange(tz, fq.start.y, fq.start.m, 3),
    year: monthsRange(tz, fyFirst.y, fyFirst.m, 12),
    nextQuarter: monthsRange(tz, nextQ.y, nextQ.m, 3),
    quarterLabel: fiscalQuarterLabel(fq.fy, fq.q, fyStart),
    nextQuarterLabel: fiscalQuarterLabel(nq.fy, nq.q, fyStart),
    yearLabel: fiscalYearLabel(fq.fy, fyStart),
    /** The quota keys these periods are stored under ("2026-Q4", "2026-FY"). */
    quarterKey: `${fq.fy}-Q${fq.q}`,
    nextQuarterKey: `${nq.fy}-Q${nq.q}`,
    yearKey: `${fq.fy}-FY`,
  };
}

/**
 * This month so far, and the same stretch of last month. A flow (wins, new
 * leads) compared a few days of this month with the whole of the last, so every
 * month began with a collapse (audit 2026-10-20, G53/G55). The stretch is the
 * same time since each month began, cut at last month's end when that month is
 * shorter. Measured in elapsed time, so across a DST change it is an hour out.
 */
export function monthToDateRanges(tz: string, now: Date = new Date()): { current: Range; previous: Range } {
  const r = currentRanges(tz, now);
  const elapsed = now.getTime() - r.month.start.getTime();
  return {
    current: { start: r.month.start, end: new Date(now.getTime() + 1) },
    previous: { start: r.prevMonth.start, end: new Date(Math.min(r.prevMonth.start.getTime() + elapsed + 1, r.prevMonth.end.getTime())) },
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jan"…"Dec" for a month 1–12, in no machine's locale. */
export const monthLabel = (m: number) => MONTHS[m - 1];

/**
 * The range a quota target measures (R17). The period names a month
 * ("2026-11"), a quarter ("2026-Q4") or a year ("2026-FY"); the period TYPE
 * decides how much of the calendar around it counts — a quarterly target
 * stored under a month (as they were before this) measures that month's
 * quarter, an annual one the whole year.
 *
 * Quarters and years are the workspace's fiscal ones (F29): "2027-Q1" is the
 * first quarter of FY2027 and "2027-FY" the whole of it. With a January start
 * (the default) these are calendar quarters and years, as before.
 */
export function quotaPeriodRange(
  tz: string,
  period: string,
  periodType: "monthly" | "quarterly" | "annual" | string | null | undefined,
  fyStart = 1,
): Range & { label: string } {
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  const mm = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  const fy = /^(\d{4})-FY$/.exec(period);
  if (!q && !mm && !fy) throw new Error(`Not a quota period: ${period}`);
  const y = Number((q ?? mm ?? fy)![1]);
  const type = periodType === "annual" || fy ? "annual" : periodType === "quarterly" || q ? "quarterly" : "monthly";
  if (type === "annual") {
    // A year key names the fiscal year; a month names the fiscal year it is in.
    const fiscalYear = fy ? y : q ? y : fiscalQuarterOf(y, Number(mm![2]), fyStart).fy;
    const s = fiscalYearFirstMonth(fiscalYear, fyStart);
    return { ...monthsRange(tz, s.y, s.m, 12), label: fiscalYearLabel(fiscalYear, fyStart) };
  }
  if (type === "quarterly") {
    const fq = q ? { fy: y, q: Number(q[2]) } : fiscalQuarterOf(y, Number(mm![2]), fyStart);
    const s = fiscalQuarterFirstMonth(fq.fy, fq.q, fyStart);
    return { ...monthsRange(tz, s.y, s.m, 3), label: fiscalQuarterLabel(fq.fy, fq.q, fyStart) };
  }
  const m = Number(mm![2]);
  return { ...monthsRange(tz, y, m, 1), label: `${MONTHS[m - 1]} ${y}` };
}

/**
 * Quota pacing (F29): closed against the target, and closed plus Commit, set
 * against how much of the period has gone. `expectedToDate` is the target
 * times the time elapsed; a rep "ahead" has closed more than that already, "on
 * track" will reach the target if their Commit closes, "behind" will not.
 */
export function quotaPacing(o: { target: number; closed: number; commit: number; range: Range; now?: Date }) {
  const now = (o.now ?? new Date()).getTime();
  const span = o.range.end.getTime() - o.range.start.getTime();
  const elapsed = span > 0 ? Math.max(0, Math.min(1, (now - o.range.start.getTime()) / span)) : 1;
  const target = Math.max(0, o.target);
  const expectedToDate = Math.round(target * elapsed * 100) / 100;
  const projected = Math.round((o.closed + o.commit) * 100) / 100;
  const pct = (v: number) => (target > 0 ? Math.round((v / target) * 100) : null);
  const status: "no_target" | "attained" | "ahead" | "on_track" | "behind" =
    target <= 0 ? "no_target"
      : o.closed >= target ? "attained"
      : o.closed >= expectedToDate ? "ahead"
      : projected >= target ? "on_track"
      : "behind";
  return {
    target, closed: o.closed, commit: o.commit, projected, expectedToDate,
    elapsedPct: Math.round(elapsed * 100),
    attainmentPct: pct(o.closed),
    projectedPct: pct(projected),
    status,
  };
}

/** "YYYY-MM" an open deal is expected to close in, or null with no date. */
export const closeMonthKey = (d: MetricDeal) => calendarMonthKey(d.closeDate);

/* ── Customer revenue (audit 2026-10-20, U26 and F36) ───────────────────── */

export type CustomerRevenueRow = {
  arr: unknown;
  renewalStage: string;
  contractEnd: Date | string | null;
  /** When the customer churned (recorded by cs.recordChurn), else null. */
  churnedAt?: Date | string | null;
};

/**
 * ARR, the one way (U26, F36): the Customers KPIs and the company page read
 * this, and Record renewal / Record churn change the rows it sums. A churned
 * customer is not ARR (R58) — their stored arr is the ARR that churned, and
 * counts in `churnedArr` when they churned inside `range` (by churnedAt, or by
 * the contract's end for a churn recorded before 0402). Summed in cents.
 */
export function customerArrTotals(
  rows: CustomerRevenueRow[],
  opts: { now?: Date; range?: Range } = {},
): { arr: number; customers: number; churnedArr: number; churned: number } {
  let arr = 0, customers = 0, churnedArr = 0, churned = 0;
  for (const c of rows) {
    const cents = Math.round(Number(c.arr ?? 0) * 100) || 0;
    const stage = renewalStageFor({ current: c.renewalStage, contractEnd: c.contractEnd, now: opts.now });
    if (stage !== "churned") { arr += cents; customers++; continue; }
    const at = toDate(c.churnedAt) ?? toDate(c.contractEnd);
    if (!opts.range || inRange(at, opts.range)) { churnedArr += cents; churned++; }
  }
  return { arr: dollars(arr), customers, churnedArr: dollars(churnedArr), churned };
}
