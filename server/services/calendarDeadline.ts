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
import { safeTimezone, wallTimeToUtcMs } from "@shared/availability";

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The last millisecond of `day` in `tz`. Null for anything but "YYYY-MM-DD". */
export function endOfLocalDay(day: string, tz: string): Date | null {
  const m = ISO_DAY.exec(day.trim());
  if (!m || !calendarDateToStored(day)) return null;
  // Midnight starting the next day, minus 1ms (wallTimeToUtcMs rolls d + 1 over a month end).
  return new Date(wallTimeToUtcMs(safeTimezone(tz), Number(m[1]), Number(m[2]), Number(m[3]) + 1, 0) - 1);
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

/** A calendar day from a client: "YYYY-MM-DD" is stored at noon UTC; an instant is kept. */
export function calendarDayFrom(value: string | Date | null | undefined): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (ISO_DAY.test(value.trim())) return calendarDateToStored(value);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
