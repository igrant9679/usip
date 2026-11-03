/**
 * Which day a date input means (audit 2026-10-20, R29).
 *
 * A deadline picked as a day is stored as the end of that day in the WORKSPACE's
 * zone (server/services/calendarDeadline), so that is the zone it reads back in.
 * `toISOString().slice(0, 10)` took the UTC day, and the viewer's own day was no
 * better: for anyone east of the workspace, the end of the 14th is already the
 * 15th, so every save of a proposal moved its expiry forward a day, whatever
 * else was being edited. (Calendar days — milestones, close dates — use
 * shared/calendarDate, which reads UTC parts.)
 */
import { zonedDayKey } from "@shared/availability";

/** The "YYYY-MM-DD" a stored deadline falls on in the workspace's zone. */
export function deadlineDayOf(value: Date | string | number | null | undefined, tz: string): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return zonedDayKey(tz, d.getTime());
}

/**
 * The default new expiry for an extension: a week past the later of today and
 * the current expiry (audit 2026-10-20, R68). A week past an expiry already
 * gone defaulted to a date in the past. Counted in days: seven times 24 hours
 * from the end of a day lands on the eighth day across a spring clock change.
 */
export function extendedExpiry(expiresAt: Date | string | null | undefined, tz: string, now: number = Date.now()): string {
  const base = Math.max(now, expiresAt ? new Date(expiresAt).getTime() : 0);
  const [y, m, d] = zonedDayKey(tz, base).split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
}

/** Today on the viewer's own clock, for what is theirs: the name of a file they download. */
export function todayLocal(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
