/**
 * The forecast a team runs a forecast call on (audit 2026-10-20, F29, R41).
 *
 * The Forecast page was win-probability buckets per rep over every open deal,
 * whatever its close date, in calendar quarters, in dollars. Now, for one
 * period — this fiscal quarter, the next, or this fiscal year:
 *
 *   Closed      won inside the period (by wonAt);
 *   Commit / Best case / Pipeline / Omitted
 *               open deals expected to close inside it (by close date), in
 *               the category the rep (or a manager overriding them) set, or
 *               the old win % rule when none is set; in the current quarter,
 *               an open deal whose close date has already passed is counted
 *               too, marked overdue, because it is still expected now;
 *   No close date
 *               open deals with no date, shown apart so none disappear.
 *
 * Every figure is computed from loadMetricDeals in services/dealMetrics — the
 * one source for deal numbers — and the period from the workspace's fiscal
 * calendar. Quota pacing reads the same totals: closed and Commit against the
 * target, set against the time gone (dealMetrics.quotaPacing).
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { opportunityForecastChanges, quotaTargets, workspaceMembers } from "../../drizzle/schema";
import type { getDb } from "../db";
import { storedToCalendarDate } from "@shared/calendarDate";
import { type ForecastCategory } from "@shared/forecastCategory";
import { currentRanges, dollars, inRange, loadMetricDeals, monthKey, quotaPacing, zonedYmd, addMonths, type MetricDeal, type Range } from "./dealMetrics";
import { getRevenueSettings } from "./workspaceRevenue";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export const FORECAST_PERIODS = ["quarter", "next_quarter", "year"] as const;
export type ForecastPeriodKind = (typeof FORECAST_PERIODS)[number];

/** The category an open deal is counted in: the one set, else the win % rule. */
export function effectiveCategory(category: string | null | undefined, winProb: number): ForecastCategory {
  if (category === "commit" || category === "best_case" || category === "pipeline" || category === "omitted") return category;
  return winProb >= 90 ? "commit" : winProb >= 50 ? "best_case" : "pipeline";
}

export type ForecastPeriod = {
  kind: ForecastPeriodKind;
  label: string;
  range: Range;
  /** The quota key the period is stored under: "2026-Q4", "2026-FY". */
  quotaKey: string;
  /** "YYYY-MM" of each month in it, for monthly targets. */
  monthKeys: string[];
  /** For a year, its four quarter keys. */
  quarterKeys: string[];
  yearKey: string;
  /** Whether today falls inside it. */
  current: boolean;
};

export function forecastPeriod(kind: ForecastPeriodKind, tz: string, fyStart: number, now: Date = new Date()): ForecastPeriod {
  const r = currentRanges(tz, now, fyStart);
  const range = kind === "year" ? r.year : kind === "next_quarter" ? r.nextQuarter : r.quarter;
  const months = kind === "year" ? 12 : 3;
  const first = zonedYmd(tz, new Date(range.start.getTime() + 12 * 3_600_000));
  const monthKeys = Array.from({ length: months }, (_, i) => { const a = addMonths(first.y, first.m, i); return monthKey(a.y, a.m); });
  const fy = r.yearKey.slice(0, 4);
  const nextFy = r.nextQuarterKey.slice(0, 4);
  return {
    kind,
    label: kind === "year" ? r.yearLabel : kind === "next_quarter" ? r.nextQuarterLabel : r.quarterLabel,
    range,
    quotaKey: kind === "year" ? r.yearKey : kind === "next_quarter" ? r.nextQuarterKey : r.quarterKey,
    monthKeys,
    quarterKeys: kind === "year" ? [1, 2, 3, 4].map((q) => `${fy}-Q${q}`) : [],
    yearKey: kind === "next_quarter" ? `${nextFy}-FY` : r.yearKey,
    current: kind !== "next_quarter",
  };
}

type Bucket = { closed: number; commit: number; bestCase: number; pipeline: number; omitted: number; noCloseDate: number; overdue: number; deals: number };
const emptyBucket = (): Bucket => ({ closed: 0, commit: 0, bestCase: 0, pipeline: 0, omitted: 0, noCloseDate: 0, overdue: 0, deals: 0 });
const toDollars = (b: Bucket) => ({ ...b, closed: dollars(b.closed), commit: dollars(b.commit), bestCase: dollars(b.bestCase), pipeline: dollars(b.pipeline), omitted: dollars(b.omitted), noCloseDate: dollars(b.noCloseDate), overdue: dollars(b.overdue) });

export type ForecastDeal = {
  id: number; name: string; ownerUserId: number | null; stage: string; value: number; winProb: number;
  closeDate: string | null; category: ForecastCategory | "closed"; setCategory: string | null; overdue: boolean;
  lastChange: { by: number | null; at: Date | null; from: string | null; to: string | null; isOverride: boolean } | null;
};

/** Which period a deal counts in, and as what; null when it is not in this period. */
function classify(d: MetricDeal, period: ForecastPeriod, startDay: string, endDay: string, todayDay: string): { cat: ForecastCategory | "closed" | "no_date"; overdue: boolean } | null {
  if (d.status === "won") return inRange(d.wonAt, period.range) ? { cat: "closed", overdue: false } : null;
  if (d.status !== "open") return null;
  const day = storedToCalendarDate(d.closeDate);
  const cat = effectiveCategory(d.forecastCategory, d.winProb);
  if (!day) return { cat: "no_date", overdue: false };
  if (day >= startDay && day < endDay) return { cat, overdue: period.current && day < todayDay };
  // Past due and still open: expected now, so in the current quarter (or year).
  if (period.current && day < startDay) return { cat, overdue: true };
  return null;
}

const ymdKey = (p: { y: number; m: number; day: number }) => `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;

export async function buildForecastCall(db: Db, opts: {
  workspaceId: number;
  /** null: every owner (a manager's view). */
  ownerUserId: number | null;
  kind: ForecastPeriodKind;
  now?: Date;
  /** Cap on the deal list returned (the totals count every deal). */
  dealLimit?: number;
}) {
  const now = opts.now ?? new Date();
  const s = await getRevenueSettings(opts.workspaceId);
  const period = forecastPeriod(opts.kind, s.timezone, s.fiscalYearStartMonth, now);
  const startDay = ymdKey(zonedYmd(s.timezone, period.range.start));
  const endDay = ymdKey(zonedYmd(s.timezone, period.range.end));
  const todayDay = ymdKey(zonedYmd(s.timezone, now));
  const deals = await loadMetricDeals(db, opts.workspaceId, opts.ownerUserId != null ? { ownerUserId: opts.ownerUserId } : {});

  const byRep = new Map<string, { ownerUserId: number | null; b: Bucket }>();
  const total = emptyBucket();
  const listed: Array<{ d: MetricDeal; cat: ForecastCategory | "closed"; overdue: boolean }> = [];
  for (const d of deals) {
    const c = classify(d, period, startDay, endDay, todayDay);
    if (!c) continue;
    const key = String(d.ownerUserId ?? "unassigned");
    if (!byRep.has(key)) byRep.set(key, { ownerUserId: d.ownerUserId, b: emptyBucket() });
    for (const b of [byRep.get(key)!.b, total]) {
      b.deals++;
      if (c.cat === "no_date") { b.noCloseDate += d.valueCents; continue; }
      if (c.overdue) b.overdue += d.valueCents;
      if (c.cat === "closed") b.closed += d.valueCents;
      else if (c.cat === "commit") { b.commit += d.valueCents; b.bestCase += d.valueCents; }
      else if (c.cat === "best_case") b.bestCase += d.valueCents;
      else if (c.cat === "pipeline") b.pipeline += d.valueCents;
      else b.omitted += d.valueCents;
    }
    if (c.cat !== "no_date") listed.push({ d, cat: c.cat, overdue: c.overdue });
  }

  // The deals behind the numbers, biggest first, with each one's last
  // category change (who, when, from what, and whether it overrode the owner).
  listed.sort((a, b) => b.d.valueCents - a.d.valueCents || a.d.id - b.d.id);
  const shown = listed.slice(0, opts.dealLimit ?? 500);
  const changes = shown.length === 0 ? [] : await db.select().from(opportunityForecastChanges)
    .where(and(eq(opportunityForecastChanges.workspaceId, opts.workspaceId), inArray(opportunityForecastChanges.opportunityId, shown.map((x) => x.d.id))))
    .orderBy(desc(opportunityForecastChanges.createdAt), desc(opportunityForecastChanges.id));
  const last = new Map<number, (typeof changes)[number]>();
  for (const ch of changes) if (!last.has(ch.opportunityId)) last.set(ch.opportunityId, ch);

  const dealsOut: ForecastDeal[] = shown.map(({ d, cat, overdue }) => {
    const ch = last.get(d.id);
    return {
      id: d.id, name: d.name, ownerUserId: d.ownerUserId, stage: d.stage, value: dollars(d.valueCents), winProb: d.winProb,
      closeDate: storedToCalendarDate(d.closeDate), category: cat, setCategory: d.forecastCategory, overdue,
      lastChange: ch ? { by: ch.changedByUserId ?? null, at: ch.createdAt ?? null, from: ch.fromCategory ?? null, to: ch.toCategory ?? null, isOverride: !!ch.isOverride } : null,
    };
  });

  return {
    period: { kind: period.kind, label: period.label, start: period.range.start, end: period.range.end, quotaKey: period.quotaKey },
    currency: s.currency,
    fiscalYearStartMonth: s.fiscalYearStartMonth,
    reps: Array.from(byRep.values()).map((r) => ({ ownerUserId: r.ownerUserId, ...toDollars(r.b) })),
    totals: toDollars(total),
    deals: dealsOut,
    dealsTotal: listed.length,
  };
}

/**
 * Record a change of a deal's forecast category (F29): who, when, from what,
 * and whether it overrode the deal's owner — someone other than the owner
 * setting it is a manager's override of the rep's call. Best-effort: the
 * category is already saved, and a lost history row must not undo it.
 */
export async function recordForecastChange(db: Db, c: {
  workspaceId: number; opportunityId: number; from: string | null; to: string | null;
  actorUserId: number; ownerUserId: number | null; note?: string | null;
}): Promise<void> {
  if ((c.from ?? null) === (c.to ?? null)) return;
  try {
    await db.insert(opportunityForecastChanges).values({
      workspaceId: c.workspaceId,
      opportunityId: c.opportunityId,
      fromCategory: c.from ?? null,
      toCategory: c.to ?? null,
      changedByUserId: c.actorUserId,
      ownerUserId: c.ownerUserId,
      isOverride: c.ownerUserId != null && c.ownerUserId !== c.actorUserId,
      note: c.note?.trim().slice(0, 500) || null,
    });
  } catch (e) {
    console.warn(`[forecast] history insert failed for opportunity ${c.opportunityId}:`, e);
  }
}

type TargetRow = { userId: number; period: string; periodType: string; revenueTarget: string | number | null };

/** A rep's revenue target for the period, from whichever targets cover it. */
export function targetForPeriod(rows: TargetRow[], userId: number, p: ForecastPeriod): number {
  const mine = rows.filter((r) => r.userId === userId);
  const val = (r: TargetRow) => Number(r.revenueTarget ?? 0) || 0;
  const sum = (rs: TargetRow[]) => rs.reduce((s, r) => s + val(r), 0);
  const exact = mine.filter((r) => r.period === p.quotaKey);
  if (exact.length) return sum(exact);
  if (p.kind === "year") {
    const qs = mine.filter((r) => p.quarterKeys.includes(r.period));
    if (qs.length) return sum(qs);
    const ms = mine.filter((r) => r.periodType === "monthly" && p.monthKeys.includes(r.period));
    return sum(ms);
  }
  // A quarterly target stored under one of its months (before R17) counts.
  const legacyQ = mine.filter((r) => r.periodType === "quarterly" && p.monthKeys.includes(r.period));
  if (legacyQ.length) return sum(legacyQ.slice(0, 1));
  const ms = mine.filter((r) => r.periodType === "monthly" && p.monthKeys.includes(r.period));
  if (ms.length) return sum(ms);
  const annual = mine.filter((r) => r.period === p.yearKey);
  return annual.length ? Math.round((sum(annual) / 4) * 100) / 100 : 0;
}

/**
 * Quota pacing per rep for the period (F29): the active members given (or
 * every active member, for a manager's team view) who have a target or a deal
 * in the period, with the team's total.
 */
export async function quotaPacingRows(db: Db, opts: { workspaceId: number; userIds: number[] | null; kind: ForecastPeriodKind; now?: Date }) {
  const now = opts.now ?? new Date();
  const s = await getRevenueSettings(opts.workspaceId);
  const period = forecastPeriod(opts.kind, s.timezone, s.fiscalYearStartMonth, now);
  const fc = await buildForecastCall(db, { workspaceId: opts.workspaceId, ownerUserId: opts.userIds?.length === 1 ? opts.userIds[0] : null, kind: opts.kind, now, dealLimit: 0 });
  const members = await db.select({ userId: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, opts.workspaceId), isNull(workspaceMembers.deactivatedAt)));
  const active = new Set(members.map((m) => m.userId));
  const targets = (await db.select({ userId: quotaTargets.userId, period: quotaTargets.period, periodType: quotaTargets.periodType, revenueTarget: quotaTargets.revenueTarget })
    .from(quotaTargets).where(eq(quotaTargets.workspaceId, opts.workspaceId))) as TargetRow[];
  const ids = new Set<number>();
  for (const t of targets) if (targetForPeriod(targets, t.userId, period) > 0) ids.add(t.userId);
  for (const r of fc.reps) if (r.ownerUserId != null) ids.add(r.ownerUserId);
  const wanted = Array.from(ids).filter((id) => active.has(id) && (opts.userIds == null || opts.userIds.includes(id))).sort((a, b) => a - b);
  const rows = wanted.map((userId) => {
    const rep = fc.reps.find((r) => r.ownerUserId === userId);
    return { userId, ...quotaPacing({ target: targetForPeriod(targets, userId, period), closed: rep?.closed ?? 0, commit: rep?.commit ?? 0, range: period.range, now }) };
  });
  const team = quotaPacing({
    target: rows.reduce((t, r) => t + r.target, 0),
    closed: rows.reduce((t, r) => t + r.closed, 0),
    commit: rows.reduce((t, r) => t + r.commit, 0),
    range: period.range, now,
  });
  return { period: { kind: period.kind, label: period.label, start: period.range.start, end: period.range.end }, currency: s.currency, rows, team };
}
