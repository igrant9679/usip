/**
 * Date buckets for the report builder (audit 2026-10-20, F45; G54 found that
 * grouping on a date made one group per row, and grouping on one was then
 * refused). A date column can now be grouped by day, week or month, cut in
 * the WORKSPACE's time zone: an Eastern evening belongs to that evening's day,
 * and a week starts on Monday there.
 *
 * The server pre-aggregates in SQL by short UTC slots (an hour, or a quarter
 * hour for a zone on a :30/:45 offset), so a bucket never splits a slot, and
 * folds the slots into buckets here. A CALENDAR date (a deal's close date,
 * stored as noon UTC, @shared/calendarDate) is bucketed by its own day, not
 * shifted into a zone.
 *
 * Pure, so the rule is tested directly.
 */

export type ReportBucket = "day" | "week" | "month";
export const REPORT_BUCKETS: readonly ReportBucket[] = ["day", "week", "month"];

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function zoneOrUtc(tz: string): string {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "UTC"; }
}

/** The (y, m, d) an instant falls on: in `tz`, or by its UTC parts for a calendar date. */
function ymdOf(ms: number, tz: string, calendar: boolean): { y: number; m: number; d: number } {
  if (calendar) {
    const dt = new Date(ms);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: zoneOrUtc(tz) }).format(new Date(ms)).split("-").map(Number);
  return { y, m, d };
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** The bucket an instant falls in: "YYYY-MM-DD" for a day or the Monday of its week, "YYYY-MM" for a month. */
export function bucketKey(ms: number, bucket: ReportBucket, tz: string, calendar = false): string {
  const { y, m, d } = ymdOf(ms, tz, calendar);
  if (bucket === "month") return `${y}-${pad(m)}`;
  if (bucket === "day") return dayKey(y, m, d);
  // Monday-start weeks, by calendar arithmetic on the local date (DST-proof).
  const local = Date.UTC(y, m - 1, d);
  const dow = new Date(local).getUTCDay(); // 0 Sun … 6 Sat
  const monday = new Date(local - ((dow + 6) % 7) * DAY_MS);
  return dayKey(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

/** The bucket after `key`. */
export function nextBucket(key: string, bucket: ReportBucket): string {
  const [y, m, d] = key.split("-").map(Number);
  if (bucket === "month") return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  const next = new Date(Date.UTC(y, m - 1, d) + (bucket === "week" ? 7 : 1) * DAY_MS);
  return dayKey(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** "Nov 3, 2026" · "Week of Nov 2, 2026" · "Nov 2026". */
export function bucketLabel(key: string, bucket: ReportBucket): string {
  const [y, m, d] = key.split("-").map(Number);
  if (bucket === "month") return `${MONTHS[m - 1]} ${y}`;
  const day = `${MONTHS[m - 1]} ${d}, ${y}`;
  return bucket === "week" ? `Week of ${day}` : day;
}

/** The SQL slot length, in seconds: an hour, or a quarter hour when the zone is ever off a whole hour. */
export function slotSecondsFor(tz: string, nowMs: number = Date.now()): number {
  const zone = zoneOrUtc(tz);
  for (const at of [nowMs, nowMs - 182 * DAY_MS]) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at));
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"));
    const offsetMin = Math.round((wall - Math.floor(at / 60_000) * 60_000) / 60_000);
    if (offsetMin % 60 !== 0) return 900;
  }
  return 3600;
}

export type ReportSlot = {
  /** Slot index: floor(unix seconds / slotSeconds); null for rows with no date. */
  slot: number | null;
  /** Rows in the slot. */
  n: number;
  /** Sum of the aggregated field (null when it has no values). */
  sum: number | null;
  /** How many rows had a value for that field (an average divides by this). */
  valued: number;
};

export type ReportBucketRow = { key: string; label: string; n: number; sum: number; valued: number };

/** Most buckets a zero-filled series may hold: about three years of days. */
export const MAX_BUCKETS = 1100;

/**
 * Fold SQL slots into buckets, oldest first, zero-filled between the first and
 * the last so a chart's axis is continuous. Rows with no date come last as
 * "(no date)". A slot never straddles a bucket edge: buckets start on local
 * midnights, which fall on slot boundaries for the slot length chosen above.
 */
export function foldSlots(slots: ReportSlot[], bucket: ReportBucket, tz: string, slotSeconds: number, calendar = false): ReportBucketRow[] {
  const by = new Map<string, { n: number; sum: number; valued: number }>();
  let empty: { n: number; sum: number; valued: number } | null = null;
  for (const s of slots) {
    const acc = { n: Number(s.n) || 0, sum: Number(s.sum ?? 0) || 0, valued: Number(s.valued) || 0 };
    if (s.slot == null || !Number.isFinite(Number(s.slot))) {
      empty = empty ? { n: empty.n + acc.n, sum: empty.sum + acc.sum, valued: empty.valued + acc.valued } : acc;
      continue;
    }
    const key = bucketKey(Number(s.slot) * slotSeconds * 1000, bucket, tz, calendar);
    const cur = by.get(key) ?? { n: 0, sum: 0, valued: 0 };
    by.set(key, { n: cur.n + acc.n, sum: cur.sum + acc.sum, valued: cur.valued + acc.valued });
  }
  const keys = Array.from(by.keys()).sort();
  const out: ReportBucketRow[] = [];
  if (keys.length) {
    const last = keys[keys.length - 1]!;
    for (let k = keys[0]!; out.length < MAX_BUCKETS; k = nextBucket(k, bucket)) {
      const v = by.get(k) ?? { n: 0, sum: 0, valued: 0 };
      out.push({ key: k, label: bucketLabel(k, bucket), ...v });
      if (k >= last) break;
    }
  }
  if (empty) out.push({ key: "", label: "(no date)", ...empty });
  return out;
}
