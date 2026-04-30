/**
 * DashboardChartRenderer — renders any of 11 chart types from resolved widget data.
 *
 * Supported types:
 *   line, bar, stacked_bar, area, pie, donut, funnel, scatter,
 *   heatmap, gauge, single_value
 *
 * Each renderer receives the raw `data` object from resolveWidget and renders
 * the appropriate recharts chart. All charts are wrapped in ResponsiveContainer.
 */
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Funnel,
  FunnelChart,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/* ─── Shared palette ─────────────────────────────────────────────────────── */
const PALETTE = [
  "#14B89A", "#3B82F6", "#F59E0B", "#EF4444", "#8B5CF6",
  "#EC4899", "#10B981", "#F97316", "#06B6D4", "#84CC16",
];

const STAGE_PALETTE: Record<string, string> = {
  discovery: "#3B82F6",
  qualified: "#8B5CF6",
  proposal: "#F59E0B",
  negotiation: "#F97316",
  won: "#22C55E",
  lost: "#EF4444",
};

/* ─── Shared tooltip style ───────────────────────────────────────────────── */
const tooltipStyle = {
  contentStyle: {
    fontSize: 11,
    padding: "4px 8px",
    borderRadius: 6,
    border: "1px solid hsl(var(--border))",
    background: "hsl(var(--card))",
    color: "hsl(var(--card-foreground))",
  },
};

/* ─── Format helpers ─────────────────────────────────────────────────────── */
function fmtCurrency(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toLocaleString()}`;
}

function fmtNumber(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return v.toLocaleString();
}

/* ─── Axis tick styles ───────────────────────────────────────────────────── */
const axisTick = { fontSize: 10, fill: "hsl(var(--muted-foreground))" };

/* ═══════════════════════════════════════════════════════════════════════════
   LINE CHART
═══════════════════════════════════════════════════════════════════════════ */
function LineChartWidget({ data, height = 160 }: { data: any; height?: number }) {
  const series = data.series ?? [];
  const keys = data.keys as string[] | undefined;
  if (series.length === 0) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={series} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tick={axisTick} />
        <YAxis tick={axisTick} tickFormatter={fmtNumber} />
        <Tooltip {...tooltipStyle} />
        {keys ? (
          keys.map((k, i) => (
            <Line key={k} type="monotone" dataKey={k} stroke={PALETTE[i % PALETTE.length]} dot={false} strokeWidth={2} name={k} />
          ))
        ) : (
          <Line type="monotone" dataKey="value" stroke={PALETTE[0]} dot={false} strokeWidth={2} name="Value" />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   BAR CHART
═══════════════════════════════════════════════════════════════════════════ */
function BarChartWidget({ data, height = 160 }: { data: any; height?: number }) {
  const series = data.series ?? [];
  const keys = data.keys as string[] | undefined;
  if (series.length === 0) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={series} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tick={axisTick} />
        <YAxis tick={axisTick} tickFormatter={fmtNumber} />
        <Tooltip {...tooltipStyle} />
        {keys ? (
          keys.map((k, i) => (
            <Bar key={k} dataKey={k} fill={PALETTE[i % PALETTE.length]} name={k} radius={[2, 2, 0, 0]} />
          ))
        ) : (
          <Bar dataKey="value" fill={PALETTE[0]} radius={[2, 2, 0, 0]} />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   STACKED BAR CHART
═══════════════════════════════════════════════════════════════════════════ */
function StackedBarChartWidget({ data, height = 160 }: { data: any; height?: number }) {
  const series = data.series ?? [];
  const keys = (data.keys as string[]) ?? ["value"];
  if (series.length === 0) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={series} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tick={axisTick} />
        <YAxis tick={axisTick} tickFormatter={fmtNumber} />
        <Tooltip {...tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 10 }} />
        {keys.map((k, i) => (
          <Bar key={k} dataKey={k} stackId="a" fill={PALETTE[i % PALETTE.length]} name={k} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   AREA CHART
═══════════════════════════════════════════════════════════════════════════ */
function AreaChartWidget({ data, height = 160 }: { data: any; height?: number }) {
  const series = data.series ?? [];
  const keys = data.keys as string[] | undefined;
  if (series.length === 0) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={series} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <defs>
          {(keys ?? ["value"]).map((k, i) => (
            <linearGradient key={k} id={`grad-${k}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0.3} />
              <stop offset="95%" stopColor={PALETTE[i % PALETTE.length]} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tick={axisTick} />
        <YAxis tick={axisTick} tickFormatter={fmtNumber} />
        <Tooltip {...tooltipStyle} />
        {keys ? (
          keys.map((k, i) => (
            <Area key={k} type="monotone" dataKey={k} stroke={PALETTE[i % PALETTE.length]} fill={`url(#grad-${k})`} strokeWidth={2} name={k} />
          ))
        ) : (
          <Area type="monotone" dataKey="value" stroke={PALETTE[0]} fill="url(#grad-value)" strokeWidth={2} name="Value" />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   PIE CHART
═══════════════════════════════════════════════════════════════════════════ */
function PieChartWidget({ data, height = 180 }: { data: any; height?: number }) {
  const series = (data.series ?? []) as Array<{ name: string; value: number }>;
  if (series.length === 0) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={series} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius="70%" label={({ name, percent }) => `${name} ${Math.round(percent * 100)}%`} labelLine={false}>
          {series.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
        </Pie>
        <Tooltip {...tooltipStyle} />
      </PieChart>
    </ResponsiveContainer>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   DONUT CHART
═══════════════════════════════════════════════════════════════════════════ */
function DonutChartWidget({ data, height = 180 }: { data: any; height?: number }) {
  const series = (data.series ?? []) as Array<{ name: string; value: number }>;
  if (series.length === 0) return <EmptyChart />;
  const total = series.reduce((s, d) => s + d.value, 0);
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie data={series} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius="50%" outerRadius="70%">
            {series.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
          </Pie>
          <Tooltip {...tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 10 }} />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className="text-xs font-mono font-semibold text-muted-foreground">{fmtNumber(total)}</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   FUNNEL CHART
═══════════════════════════════════════════════════════════════════════════ */
function FunnelChartWidget({ data, height = 180 }: { data: any; height?: number }) {
  const series = (data.series ?? []) as Array<{ stage: string; count: number; value: number }>;
  if (series.length === 0) return <EmptyChart />;
  const maxCount = Math.max(...series.map((s) => s.count), 1);
  return (
    <ul className="space-y-1.5 text-xs">
      {series.map((s, i) => (
        <li key={s.stage} className="flex items-center gap-2">
          <span className="capitalize w-24 text-muted-foreground shrink-0">{s.stage}</span>
          <div className="flex-1 h-2.5 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${(s.count / maxCount) * 100}%`, background: PALETTE[i % PALETTE.length] }}
            />
          </div>
          <span className="font-mono tabular-nums w-8 text-right shrink-0">{s.count}</span>
          <span className="font-mono tabular-nums w-16 text-right text-muted-foreground shrink-0">{fmtCurrency(s.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCATTER CHART
═══════════════════════════════════════════════════════════════════════════ */
function ScatterChartWidget({ data, height = 160 }: { data: any; height?: number }) {
  const series = (data.series ?? []) as Array<{ x: number; y: number; name: string; stage: string }>;
  if (series.length === 0) return <EmptyChart />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="x" type="number" name="Days in Stage" tick={axisTick} label={{ value: "Days", position: "insideBottom", offset: -2, fontSize: 9 }} />
        <YAxis dataKey="y" type="number" name="Value" tick={axisTick} tickFormatter={fmtNumber} />
        <Tooltip
          {...tooltipStyle}
          cursor={{ strokeDasharray: "3 3" }}
          content={({ payload }) => {
            if (!payload?.length) return null;
            const d = payload[0]?.payload as any;
            return (
              <div style={tooltipStyle.contentStyle} className="text-xs">
                <div className="font-medium truncate max-w-[140px]">{d.name}</div>
                <div>Days: {d.x} | Value: {fmtCurrency(d.y)}</div>
                <div className="capitalize text-muted-foreground">{d.stage}</div>
              </div>
            );
          }}
        />
        <Scatter
          data={series}
          fill={PALETTE[0]}
          opacity={0.7}
        >
          {series.map((s, i) => (
            <Cell key={i} fill={STAGE_PALETTE[s.stage] ?? PALETTE[i % PALETTE.length]} />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   HEATMAP (activity by day × hour, rendered as a CSS grid)
═══════════════════════════════════════════════════════════════════════════ */
function HeatmapWidget({ data }: { data: any }) {
  const series = (data.series ?? []) as Array<{ day: string; hour: number; count: number }>;
  if (series.length === 0) return <EmptyChart />;
  const maxCount = Math.max(...series.map((s) => s.count), 1);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const lookup = new Map(series.map((s) => [`${s.day}-${s.hour}`, s.count]));

  return (
    <div className="overflow-x-auto">
      <div className="text-[9px] text-muted-foreground mb-1 flex gap-0.5 pl-6">
        {hours.filter((h) => h % 4 === 0).map((h) => (
          <span key={h} className="w-4 text-center">{h}h</span>
        ))}
      </div>
      {days.map((day) => (
        <div key={day} className="flex items-center gap-0.5 mb-0.5">
          <span className="text-[9px] text-muted-foreground w-6 shrink-0">{day}</span>
          {hours.map((h) => {
            const count = lookup.get(`${day}-${h}`) ?? 0;
            const intensity = count / maxCount;
            return (
              <div
                key={h}
                className="w-3 h-3 rounded-sm"
                title={`${day} ${h}:00 — ${count} activities`}
                style={{
                  background: count === 0
                    ? "hsl(var(--secondary))"
                    : `rgba(20, 184, 154, ${0.15 + intensity * 0.85})`,
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   GAUGE (radial bar showing a single percentage)
═══════════════════════════════════════════════════════════════════════════ */
function GaugeWidget({ data }: { data: any }) {
  const value = Number(data.value ?? 0);
  const format = data.format ?? "percent";
  const displayValue = format === "currency" ? fmtCurrency(value) : format === "percent" ? `${value}%` : fmtNumber(value);
  const pct = format === "percent" ? Math.min(100, value) : 75; // default arc fill for non-percent
  const gaugeData = [
    { name: "Value", value: pct, fill: "#14B89A" },
    { name: "Remaining", value: 100 - pct, fill: "hsl(var(--secondary))" },
  ];
  return (
    <div className="flex flex-col items-center">
      <ResponsiveContainer width="100%" height={120}>
        <RadialBarChart cx="50%" cy="80%" innerRadius="60%" outerRadius="90%" startAngle={180} endAngle={0} data={gaugeData}>
          <RadialBar dataKey="value" cornerRadius={4} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="-mt-8 text-center">
        <div className="text-2xl font-mono font-bold tabular-nums">{displayValue}</div>
        {data.breakdown && (
          <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
            <span>Calls: {data.breakdown.calls}</span>
            <span>Emails: {data.breakdown.emails}</span>
            <span>Meetings: {data.breakdown.meetings}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   SINGLE VALUE (large KPI number with optional sub-label)
═══════════════════════════════════════════════════════════════════════════ */
function SingleValueWidget({ data }: { data: any }) {
  const value = Number(data.value ?? 0);
  const format = data.format ?? "number";
  const displayValue = format === "currency" ? fmtCurrency(value)
    : format === "percent" ? `${value}%`
    : format === "days" ? `${value}d`
    : fmtNumber(value);
  return (
    <div className="flex flex-col items-center justify-center py-4 gap-1">
      <div className="text-4xl font-mono font-bold tabular-nums text-foreground">{displayValue}</div>
      {data.breakdown && (
        <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
          <span>📞 {data.breakdown.calls}</span>
          <span>✉️ {data.breakdown.emails}</span>
          <span>🤝 {data.breakdown.meetings}</span>
        </div>
      )}
    </div>
  );
}

/* ─── Empty state ────────────────────────────────────────────────────────── */
function EmptyChart() {
  return (
    <div className="h-24 flex items-center justify-center text-xs text-muted-foreground">
      No data available
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN RENDERER — dispatches to the correct chart component
═══════════════════════════════════════════════════════════════════════════ */
export interface DashboardChartRendererProps {
  /** The resolved widget data from resolveWidget */
  data: any;
  /** Override height in pixels (default varies by chart type) */
  height?: number;
}

export function DashboardChartRenderer({ data, height }: DashboardChartRendererProps) {
  if (!data) return <EmptyChart />;
  const type = data.type as string;

  switch (type) {
    case "line":
      return <LineChartWidget data={data} height={height} />;
    case "bar":
      return <BarChartWidget data={data} height={height} />;
    case "stacked_bar":
      return <StackedBarChartWidget data={data} height={height} />;
    case "area":
      return <AreaChartWidget data={data} height={height} />;
    case "pie":
      return <PieChartWidget data={data} height={height} />;
    case "donut":
      return <DonutChartWidget data={data} height={height} />;
    case "funnel":
    case "pipeline_stage":
      return <FunnelChartWidget data={data} height={height} />;
    case "scatter":
      return <ScatterChartWidget data={data} height={height} />;
    case "heatmap":
      return <HeatmapWidget data={data} />;
    case "gauge":
      return <GaugeWidget data={data} />;
    case "single_value":
      return <SingleValueWidget data={data} />;
    default:
      return <EmptyChart />;
  }
}
