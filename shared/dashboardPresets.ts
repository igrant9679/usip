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

/** The filters on the bar, as far as a widget is concerned. */
export type WidgetFilters = { dateFrom?: string; dateTo?: string; ownerUserId?: number; stage?: string; source?: string };

/**
 * What the filter bar sends a widget. "All time" means no dates, and it means
 * nothing else: it used to send no filters at all, so Owner, Stage and Source did
 * nothing until a date preset was picked. An unset filter is left out, so it can't
 * blank a filter saved on the widget itself.
 */
export function widgetFilters(f: WidgetFilters & { preset: string }): WidgetFilters | undefined {
  const out: WidgetFilters = {};
  if (f.preset !== "all") {
    if (f.dateFrom) out.dateFrom = f.dateFrom;
    if (f.dateTo) out.dateTo = f.dateTo;
  }
  if (f.ownerUserId) out.ownerUserId = f.ownerUserId;
  if (f.stage) out.stage = f.stage;
  if (f.source) out.source = f.source;
  return Object.keys(out).length ? out : undefined;
}

const ACTIVITY_KPIS = new Set(["activity_counts", "meetings_booked"]);

/**
 * The active filters this widget can't apply, by name, so it can say so rather
 * than show a number that only looks filtered. Deals have an owner, a stage and
 * (through the lead they came from) a source. Activities have a date and a person,
 * and no stage or source. Email health and the proposal funnel read other things
 * entirely, and a comparison sets its own two periods.
 */
export function filtersNotApplied(widget: { type: string; config?: unknown }, f: WidgetFilters): string[] {
  const metric = (widget.config as { metric?: string } | null | undefined)?.metric ?? "";
  const active = [
    ["Dates", !!(f.dateFrom || f.dateTo)],
    ["Owner", !!f.ownerUserId],
    ["Stage", !!f.stage],
    ["Source", !!f.source],
  ] as const;
  const isActivity = widget.type === "activity_feed" || widget.type === "heatmap"
    || (["kpi", "single_value", "gauge"].includes(widget.type) && ACTIVITY_KPIS.has(metric))
    || (["bar", "line", "area", "stacked_bar"].includes(widget.type) && metric === "activities");
  const unsupported = widget.type === "email_health" || widget.type === "proposal_expiry_funnel"
    ? ["Dates", "Owner", "Stage", "Source"]
    : widget.type === "comparison" ? ["Dates", "Stage"]
    : isActivity ? ["Stage", "Source"] : [];
  return active.filter(([name, on]) => on && unsupported.includes(name)).map(([name]) => name);
}
