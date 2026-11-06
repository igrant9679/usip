/**
 * Email Analytics' daily series, on the workspace's days (audit 2026-10-20,
 * O42). The buckets were UTC days, so for an Eastern workspace every open
 * after 7 or 8 PM landed on tomorrow, and the x-axis ran a day ahead in the
 * evening.
 */
import { safeTimezone } from "@shared/availability";

const DAY_MS = 86_400_000;

/** The calendar day ("YYYY-MM-DD") an instant falls on in `tz`. */
export function dayIn(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: safeTimezone(tz) }).format(new Date(ms));
}

/** The last `days` calendar days in `tz`, oldest first, ending today: calendar arithmetic, so a DST change neither skips nor repeats a day. */
export function lastDays(days: number, tz: string, nowMs: number): string[] {
  const [y, m, d] = dayIn(nowMs, tz).split("-").map(Number);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return out;
}

/** An instant safely early enough to cover `days` workspace days in any zone (UTC−12 to +14), for the SQL bound. */
export function seriesSince(days: number, nowMs: number): Date {
  return new Date(nowMs - (days + 1) * DAY_MS);
}

const toMs = (v: Date | string | number | null | undefined): number =>
  v instanceof Date ? v.getTime() : typeof v === "number" ? v : v ? new Date(v).getTime() : NaN;

export type SeriesPoint = { date: string; opens: number; clicks: number; bounces: number };

/** Opens, clicks and bounces per workspace day over the last `days` days, zero-filled. */
export function trackingSeries(
  events: Array<{ type: string; createdAt: Date | string | number | null }>,
  bounces: Array<{ bouncedAt: Date | string | number | null }>,
  days: number,
  tz: string,
  nowMs: number,
): SeriesPoint[] {
  const keys = lastDays(days, tz, nowMs);
  const byDay = new Map(keys.map((k) => [k, { date: k, opens: 0, clicks: 0, bounces: 0 }]));
  for (const ev of events) {
    const ms = toMs(ev.createdAt);
    const p = Number.isFinite(ms) ? byDay.get(dayIn(ms, tz)) : undefined;
    if (!p) continue;
    if (ev.type === "open") p.opens++;
    else if (ev.type === "click") p.clicks++;
  }
  for (const b of bounces) {
    const ms = toMs(b.bouncedAt);
    const p = Number.isFinite(ms) ? byDay.get(dayIn(ms, tz)) : undefined;
    if (p) p.bounces++;
  }
  return keys.map((k) => byDay.get(k)!);
}
