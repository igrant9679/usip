/**
 * A dashboard's date presets, as calendar days in the workspace's time zone.
 *
 * 🔴 THE BUG. This lived in the filter bar as `from.setDate(from.getDate() - 6)`
 * on the browser's clock, written out with `toISOString().slice(0, 10)`: the
 * count ran in the browser's zone and the label came from UTC. Those two agree
 * until a clock change falls inside the range. Then the offset that separates
 * them differs at the two ends, and for the hour each evening that one end has
 * crossed UTC midnight and the other has not, "Last 7 days" spanned 8 dates
 * after the autumn change and 6 after the spring one. "Today" was also tomorrow
 * from 7pm in New York, and "Year to date" began on 31 December east of UTC.
 *
 * Here the zone is an argument, so no answer depends on the machine, and the
 * count is done on the date itself: Date.UTC on a calendar day has no clock
 * changes in it to step over.
 *
 * Shared because the browser picks the days and the tests must run the real
 * thing rather than a copy. The server reads the days back in the same zone
 * (server/services/calendarDeadline dayRangeBounds).
 */
import { zonedDayKey } from "./availability";

/** How many days before today each rolling preset starts; today is the last of them. */
const DAYS_BEFORE_TODAY: Record<string, number> = { "7d": 6, "30d": 29, "90d": 89 };

export function resolvePresetDates(
  preset: string,
  tz: string,
  now: Date = new Date(),
): { dateFrom?: string; dateTo?: string } {
  const dateTo = zonedDayKey(tz, now.getTime());
  const [y, m, d] = dateTo.split("-").map(Number) as [number, number, number];
  if (preset === "today") return { dateFrom: dateTo, dateTo };
  if (preset === "ytd") return { dateFrom: `${dateTo.slice(0, 4)}-01-01`, dateTo };
  const back = DAYS_BEFORE_TODAY[preset];
  if (back === undefined) return {};
  return { dateFrom: new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10), dateTo };
}
