/**
 * Calendar dates — a day on the calendar, not an instant (audit 2026-10-20,
 * Phase 2: R16, R29).
 *
 * 🔴 THE BUG. A date input yields "2026-11-14". `new Date("2026-11-14")` is
 * MIDNIGHT UTC, which in every zone west of Greenwich is the evening of the
 * 13th — so a close date picked as the 14th displayed, bucketed and alerted as
 * the 13th, and a deal closing on the 1st of a month counted in the month
 * before.
 *
 * A calendar date is stored as NOON UTC of that day. Noon is 12+ hours from
 * either midnight, so the day is the same in every zone from UTC−12 to UTC+11,
 * and reading it back with UTC parts gives exactly the day that was picked —
 * including for the dates already stored at UTC midnight, whose UTC day is
 * also the day that was meant.
 *
 * Shared by the server (writes, metrics) and the client (inputs, display).
 */

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-11-14" → the stored instant (noon UTC). Null for anything else. */
export function calendarDateToStored(day: string | null | undefined): Date | null {
  if (!day) return null;
  const m = ISO_DAY.exec(day.trim().slice(0, 10));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const out = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  // 2026-02-31 rolls into March in Date.UTC; refuse it instead.
  if (out.getUTCFullYear() !== y || out.getUTCMonth() !== mo - 1 || out.getUTCDate() !== d) return null;
  return out;
}

/**
 * A stored calendar date (or a client-sent value) → "YYYY-MM-DD", read with
 * UTC parts. Accepts a Date, an ISO string, or a bare "YYYY-MM-DD".
 */
export function storedToCalendarDate(value: Date | string | null | undefined): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "string" && ISO_DAY.test(value.trim())) return value.trim();
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Whatever a client sent for a calendar-date field → the stored instant.
 * "YYYY-MM-DD" is the contract; a full ISO timestamp (older clients) keeps the
 * calendar day it names in UTC. Null clears the field; garbage is null too.
 */
export function normalizeCalendarDate(value: Date | string | null | undefined): Date | null {
  const day = storedToCalendarDate(value);
  return day ? calendarDateToStored(day) : null;
}

/** "YYYY-MM" of a stored calendar date. */
export function calendarMonthKey(value: Date | string | null | undefined): string | null {
  return storedToCalendarDate(value)?.slice(0, 7) ?? null;
}

/** A stored calendar date for display: "Nov 14, 2026" (the viewer's locale when none is given). */
export function formatCalendarDate(value: Date | string | null | undefined, locale?: string): string {
  const day = storedToCalendarDate(value);
  if (!day) return "—";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, {
    timeZone: "UTC", month: "short", day: "numeric", year: "numeric",
  });
}
