/**
 * The "YYYY-MM-DD" a stored DEADLINE falls on, in the viewer's own zone
 * (audit 2026-10-20, R29).
 *
 * A deadline picked as a day is stored as the end of that day in the
 * workspace's zone (server/services/calendarDeadline). Reading it back with
 * `toISOString().slice(0, 10)` takes the UTC day, which east of UTC — and for
 * an end-of-day instant, west of it too — is the next day: edit a proposal
 * and its expiry moved forward one day. The viewer's local day is the day
 * they picked. (Calendar days — milestones, close dates — use
 * shared/calendarDate, which reads UTC parts.)
 */
export function localDayOf(value: Date | string | number | null | undefined): string {
  if (value == null || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today, as the viewer's local "YYYY-MM-DD" (for a date input's min). */
export const todayLocal = () => localDayOf(new Date());
