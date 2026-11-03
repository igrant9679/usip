/**
 * Dates a person picks as a DAY (audit 2026-10-20, R29).
 *
 * A date input yields "2026-11-14", and every server path did
 * `new Date("2026-11-14")` — midnight UTC, which west of Greenwich is the
 * evening before. A task due "today" was overdue the moment it was made, and a
 * proposal set to expire on the 14th expired on the evening of the 13th.
 *
 * Two kinds of day, two readings:
 *   • a DEADLINE (a task's due date, a proposal's expiry, an RFP deadline)
 *     lasts the whole day: it is stored as the last millisecond of that day in
 *     the workspace's time zone;
 *   • a DAY ON THE CALENDAR (a QBR, a milestone, an amendment's effective
 *     date) is stored as noon UTC of that day — shared/calendarDate.
 * A full timestamp (a client that already sent an instant) is kept as given.
 */
import { calendarDateToStored } from "@shared/calendarDate";
import { safeTimezone, wallTimeToUtcMs, zonedDayKey } from "@shared/availability";

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The instant a day begins in `tz`. Havana and Santiago spring forward AT
 * midnight, so that day has no 00:00, and wallTimeToUtcMs lands an hour short of
 * it, still on the day before. The day begins where the gap ends.
 */
function dayStartMs(tz: string, y: number, m: number, d: number): number {
  const start = wallTimeToUtcMs(tz, y, m, d, 0);
  const day = new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  return zonedDayKey(tz, start) === day ? start : start + 3_600_000;
}

/** The last millisecond of `day` in `tz`. Null for anything but "YYYY-MM-DD". */
export function endOfLocalDay(day: string, tz: string): Date | null {
  const m = ISO_DAY.exec(day.trim());
  if (!m || !calendarDateToStored(day)) return null;
  // The start of the next day, minus 1ms (Date.UTC rolls d + 1 over a month end).
  return new Date(dayStartMs(safeTimezone(tz), Number(m[1]), Number(m[2]), Number(m[3]) + 1) - 1);
}

/** A deadline from a client: a day lasts to its end in the workspace's zone; an instant is kept. */
export function deadlineFrom(value: string | Date | null | undefined, tz: string): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const day = endOfLocalDay(value, tz);
  if (day) return day;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The first millisecond of `day` in `tz`. Null for anything but "YYYY-MM-DD". */
export function startOfCalendarDay(day: string, tz: string): Date | null {
  const m = ISO_DAY.exec(day.trim());
  if (!m || !calendarDateToStored(day)) return null;
  return new Date(dayStartMs(safeTimezone(tz), Number(m[1]), Number(m[2]), Number(m[3])));
}

/**
 * The instants a range picked as DAYS covers (a dashboard's "Last 7 days", two
 * date inputs): from the start of the first day to the end of the last, in the
 * workspace's zone. Either end may be missing, and one that cannot be read is no
 * bound at all rather than an Invalid Date in a query. An instant is kept.
 */
export function dayRangeBounds(
  from: string | null | undefined,
  to: string | null | undefined,
  tz: string,
): { from: Date | null; to: Date | null } {
  let start: Date | null = null;
  if (from) {
    const instant = startOfCalendarDay(from, tz) ?? new Date(from);
    start = Number.isNaN(instant.getTime()) ? null : instant;
  }
  return { from: start, to: deadlineFrom(to, tz) };
}

/** A calendar day from a client: "YYYY-MM-DD" is stored at noon UTC; an instant is kept. */
export function calendarDayFrom(value: string | Date | null | undefined): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (ISO_DAY.test(value.trim())) return calendarDateToStored(value);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
