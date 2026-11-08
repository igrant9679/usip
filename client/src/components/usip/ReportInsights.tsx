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
    // Over every group when the server says (F45), not just this page's.
    const total = result.totals?.agg != null ? Number(result.totals.agg) : series.reduce((s: number, x: any) => s + x.value, 0);
    const top = [...series].sort((a: any, b: any) => b.value - a.value)[0];
    const aggLabel = result.columns[1]?.label ?? "Value";
    // An average doesn't add up across groups, so it gets no total or share.
    const additive = !/^Avg /.test(aggLabel);
    return (
      <div className="space-y-3 border-b border-border/70 px-4 py-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="Groups" value={(result.total ?? result.rows.length).toLocaleString()} />
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

  /* flat: rows and each number column's total, over every matching row (F45) */
  const dateCol = result.columns.find((c: any) => c.kind === "date");
  const numCols = result.columns.filter((c: any) => c.kind === "number" && (!result.totals || c.key in result.totals)).slice(0, 3);
  const tiles = [
    <Tile key="rows" label="Rows" value={(result.total ?? result.rows.length).toLocaleString()} />,
    ...numCols.map((c: any) => {
      const avg = result.totalKinds?.[c.key] === "avg";
      const v = result.totals && c.key in result.totals
        ? Number(result.totals[c.key] ?? 0)
        : result.rows.reduce((s: number, r: any) => s + (Number(r[c.key]) || 0), 0);
      return <Tile key={c.key} label={`${avg ? "Avg" : "Sum"} ${c.label.toLowerCase()}`} value={fmtN(v)} />;
    }),
  ];
  // The per-day chart that sat here counted this PAGE's rows by UTC day. A
  // date grouped by day, week or month is the real chart, in the workspace's zone.
  return (
    <div className="space-y-3 border-b border-border/70 px-4 py-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{tiles}</div>
      {dateCol && (
        <p className="text-[11.5px] text-muted-foreground">To chart this over time, group by {dateCol.label.toLowerCase()} by day, week or month.</p>
      )}
    </div>
  );
}
