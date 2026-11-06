/**
 * The words a dashboard chart says (audit 2026-10-20, G64).
 *
 * The chart widgets drew SVG and nothing else, so a screen reader met an
 * unlabelled graphic and the numbers were reachable only by hovering. Each
 * drawn chart now carries a one-line summary (its accessible name) and a
 * visually hidden table of what it plots, built here from the same resolved
 * widget data the chart is drawn from.
 */

export type ChartText = { summary: string; columns: string[]; rows: (string | number)[][] };

const KIND: Record<string, string> = {
  line: "Line chart", bar: "Bar chart", stacked_bar: "Stacked bar chart", area: "Area chart",
  pie: "Pie chart", donut: "Donut chart", scatter: "Scatter chart", heatmap: "Activity heatmap", gauge: "Gauge",
};

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Null for a type that is already text (funnel, single value) or has nothing to say. */
export function chartText(data: any): ChartText | null {
  const type = String(data?.type ?? "");
  const kind = KIND[type];
  if (!kind) return null;
  const series: any[] = Array.isArray(data?.series) ? data.series : [];

  if (type === "gauge") {
    const v = num(data?.value);
    const shown = data?.format === "percent" || data?.format == null ? `${v}%` : String(v);
    return { summary: `${kind}: ${shown}`, columns: ["Value"], rows: [[shown]] };
  }
  if (series.length === 0) return null;

  if (type === "pie" || type === "donut") {
    const total = series.reduce((s, d) => s + num(d.value), 0);
    const top = series.reduce((a, b) => (num(b.value) > num(a.value) ? b : a), series[0]);
    const pct = total > 0 ? Math.round((num(top.value) / total) * 100) : 0;
    return {
      summary: `${kind}, ${plural(series.length, "slice")}, total ${total}; largest ${top.name} (${pct}%)`,
      columns: ["Name", "Value"],
      rows: series.map((d) => [String(d.name ?? ""), num(d.value)]),
    };
  }
  if (type === "scatter") {
    return {
      summary: `${kind}, ${plural(series.length, "deal")} by days in stage and value`,
      columns: ["Deal", "Stage", "Days in stage", "Value"],
      rows: series.map((d) => [String(d.name ?? ""), String(d.stage ?? ""), num(d.x), num(d.y)]),
    };
  }
  if (type === "heatmap") {
    const busy = series.filter((d) => num(d.count) > 0);
    const total = busy.reduce((s, d) => s + num(d.count), 0);
    return {
      summary: `${kind}, ${plural(total, "activity", "activities")} across ${plural(busy.length, "hour slot")}`,
      columns: ["Day", "Hour", "Activities"],
      rows: busy.map((d) => [String(d.day ?? ""), `${num(d.hour)}:00`, num(d.count)]),
    };
  }
  // line, bar, stacked_bar, area: one row per label, one column per series key.
  const keys: string[] = Array.isArray(data?.keys) && data.keys.length ? data.keys : ["value"];
  const first = series.map((d) => num(d[keys[0]!]));
  const range = `from ${Math.min(...first)} to ${Math.max(...first)}`;
  return {
    summary: `${kind}, ${plural(series.length, "point")}${keys.length > 1 ? ` in ${keys.length} series` : ""}, ${keys.length > 1 ? `${keys[0]} ` : ""}${range}`,
    columns: ["Label", ...keys.map((k) => (k === "value" ? "Value" : k))],
    rows: series.map((d) => [String(d.label ?? ""), ...keys.map((k) => num(d[k]))]),
  };
}
