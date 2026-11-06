/**
 * ReportInsights — the charts and stat tiles above a report's results table
 * (/reports). Its own file so tests can render it.
 */
import { DashboardChartRenderer } from "@/components/usip/DashboardChartRenderer";
import { reportChartSeries } from "@/lib/reportChart";

export function ReportInsights({ result, viz, accent }: { result: any; viz: string; accent: string }) {
  if (!result || result.rows.length === 0) return null;

  const Tile = ({ label, value }: { label: string; value: string | number }) => (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-sm" style={{ borderLeft: `3px solid ${accent}` }}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-[17px] font-semibold tabular-nums" style={{ color: accent }}>{value}</div>
    </div>
  );
  const fmtN = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1 }));

  /* grouped: chart of group → aggregate + tiles */
  if (result.grouped) {
    const series = result.rows.map((r: any) => ({ label: String(r.group), value: Number(r.agg) || 0 }));
    const total = series.reduce((s: number, x: any) => s + x.value, 0);
    const top = [...series].sort((a: any, b: any) => b.value - a.value)[0];
    const aggLabel = result.columns[1]?.label ?? "Value";
    // An average doesn't add up across groups, so it gets no total or share.
    const additive = !/^Avg /.test(aggLabel);
    return (
      <div className="space-y-3 border-b border-border/70 px-4 py-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="Groups" value={result.rows.length} />
          {additive && <Tile label={`Total ${aggLabel.toLowerCase()}`} value={fmtN(total)} />}
          <Tile label="Top group" value={top ? String(top.label).slice(0, 18) : "—"} />
          {additive && <Tile label="Top share" value={top && total > 0 ? `${Math.round((top.value / total) * 100)}%` : "—"} />}
        </div>
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <DashboardChartRenderer data={{ type: viz, series: reportChartSeries(viz, series) }} height={300} />
        </div>
      </div>
    );
  }

  /* flat: rows-per-day trend when a date column exists + numeric sums */
  const dateCol = result.columns.find((c: any) => c.kind === "date");
  const numCols = result.columns.filter((c: any) => c.kind === "number").slice(0, 2);
  const tiles = [
    <Tile key="rows" label="Rows" value={result.rows.length} />,
    ...numCols.map((c: any) => (
      <Tile key={c.key} label={`Sum ${c.label.toLowerCase()}`} value={fmtN(result.rows.reduce((s: number, r: any) => s + (Number(r[c.key]) || 0), 0))} />
    )),
  ];
  let trend: { label: string; value: number }[] | null = null;
  if (dateCol) {
    const byDay = new Map<string, number>();
    for (const r of result.rows) {
      const v = r[dateCol.key];
      if (!v) continue;
      const d = new Date(v as string);
      if (Number.isNaN(d.getTime())) continue;
      const k = d.toISOString().slice(0, 10);
      byDay.set(k, (byDay.get(k) ?? 0) + 1);
    }
    if (byDay.size >= 2) {
      trend = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-30)
        .map(([k, n]) => ({ label: k.slice(5), value: n }));
    }
  }
  return (
    <div className="space-y-3 border-b border-border/70 px-4 py-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{tiles}</div>
      {trend && (
        <div className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Rows per day · {dateCol.label}
          </div>
          <DashboardChartRenderer data={{ type: "area", series: trend }} height={200} />
        </div>
      )}
    </div>
  );
}
