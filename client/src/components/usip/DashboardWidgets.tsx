/**
 * DashboardWidgets — specialised display components for non-chart widget types.
 *
 * Exported components:
 *   LeaderboardWidget, ActivityFeedWidget, GoalProgressWidget,
 *   ComparisonWidget, PipelineStageWidget, RepPerformanceWidget,
 *   EmailHealthWidget, KpiCardWidget, TableWidget
 *
 * Each component accepts the raw `data` object returned by resolveWidget.
 */
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  ArrowDown,
  ArrowUp,
  Calendar,
  Mail,
  Minus,
  Phone,
  Trophy,
  Users,
  Video,
} from "lucide-react";

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
function fmtValue(v: number, format?: string) {
  if (format === "currency") return fmtCurrency(v);
  if (format === "percent") return `${v}%`;
  if (format === "days") return `${v}d`;
  return fmtNumber(v);
}
function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/* ─── Rank medal colours ─────────────────────────────────────────────────── */
const MEDAL = ["#FFD700", "#C0C0C0", "#CD7F32"];

/* ═══════════════════════════════════════════════════════════════════════════
   KPI CARD (type = kpi)
═══════════════════════════════════════════════════════════════════════════ */
export function KpiCardWidget({ data }: { data: any }) {
  const value = Number(data.value ?? 0);
  const displayValue = fmtValue(value, data.format);
  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="text-3xl font-mono font-bold tabular-nums text-foreground leading-none">
        {displayValue}
      </div>
      {data.breakdown && (
        <div className="flex gap-3 mt-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{data.breakdown.calls}</span>
          <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{data.breakdown.emails}</span>
          <span className="flex items-center gap-1"><Video className="h-3 w-3" />{data.breakdown.meetings}</span>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   LEADERBOARD
═══════════════════════════════════════════════════════════════════════════ */
export function LeaderboardWidget({ data }: { data: any }) {
  const rows = (data.rows ?? []) as Array<{
    rank: number; name: string; count: number; value: number;
  }>;
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground py-4 text-center">No data</p>;
  }
  const maxValue = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ol className="space-y-2 text-xs">
      {rows.map((r) => (
        <li key={r.rank} className="flex items-center gap-2">
          <span
            className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
            style={{ background: MEDAL[r.rank - 1] ?? "hsl(var(--secondary))", color: r.rank <= 3 ? "#000" : "hsl(var(--foreground))" }}
          >
            {r.rank <= 3 ? <Trophy className="h-2.5 w-2.5" /> : r.rank}
          </span>
          <span className="flex-1 truncate font-medium">{r.name}</span>
          <div className="w-24 h-1.5 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full" style={{ width: `${(r.value / maxValue) * 100}%` }} />
          </div>
          <span className="font-mono tabular-nums w-14 text-right text-muted-foreground">{fmtCurrency(r.value)}</span>
          <span className="font-mono tabular-nums w-6 text-right">{r.count}</span>
        </li>
      ))}
    </ol>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   ACTIVITY FEED
═══════════════════════════════════════════════════════════════════════════ */
const ACTIVITY_ICON: Record<string, React.ReactNode> = {
  call: <Phone className="h-3 w-3 text-blue-400" />,
  email: <Mail className="h-3 w-3 text-emerald-400" />,
  meeting: <Video className="h-3 w-3 text-purple-400" />,
};

export function ActivityFeedWidget({ data }: { data: any }) {
  const items = (data.items ?? []) as Array<{
    id: number; type: string; subject: string;
    relatedType: string; relatedId: number; occurredAt: string;
  }>;
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground py-4 text-center">No recent activity</p>;
  }
  return (
    <ul className="space-y-2 text-xs">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0">{ACTIVITY_ICON[item.type] ?? <Calendar className="h-3 w-3 text-muted-foreground" />}</span>
          <span className="flex-1 truncate capitalize">{item.subject}</span>
          <span className="text-muted-foreground shrink-0 tabular-nums">{relativeTime(item.occurredAt)}</span>
        </li>
      ))}
    </ul>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   GOAL PROGRESS BAR
═══════════════════════════════════════════════════════════════════════════ */
export function GoalProgressWidget({ data }: { data: any }) {
  const current = Number(data.current ?? 0);
  const target = Number(data.target ?? 1);
  const pct = Math.min(100, data.pct ?? Math.round((current / target) * 100));
  const color = pct >= 100 ? "bg-emerald-500" : pct >= 70 ? "bg-primary" : pct >= 40 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Current: <span className="font-mono font-semibold text-foreground">{fmtCurrency(current)}</span></span>
        <span>Target: <span className="font-mono font-semibold text-foreground">{fmtCurrency(target)}</span></span>
      </div>
      <div className="relative h-4 bg-secondary rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
        <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-white mix-blend-difference">
          {pct}%
        </span>
      </div>
      <div className="text-xs text-muted-foreground text-center">
        {pct >= 100 ? "🎉 Goal achieved!" : `${fmtCurrency(target - current)} remaining`}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   COMPARISON (period-over-period)
═══════════════════════════════════════════════════════════════════════════ */
export function ComparisonWidget({ data }: { data: any }) {
  const current = Number(data.current ?? 0);
  const previous = Number(data.previous ?? 0);
  const changePct = Number(data.changePct ?? 0);
  const format = data.format ?? "currency";
  const isUp = changePct >= 0;
  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-secondary/50 p-3">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">This Month</div>
          <div className="text-xl font-mono font-bold tabular-nums">{fmtValue(current, format)}</div>
        </div>
        <div className="rounded-lg bg-secondary/50 p-3">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Last Month</div>
          <div className="text-xl font-mono font-bold tabular-nums text-muted-foreground">{fmtValue(previous, format)}</div>
        </div>
      </div>
      <div className={`flex items-center gap-1.5 text-sm font-semibold ${isUp ? "text-emerald-500" : "text-red-500"}`}>
        {changePct === 0 ? <Minus className="h-4 w-4" /> : isUp ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
        <span>{Math.abs(changePct)}% {isUp ? "increase" : "decrease"} vs last month</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   PIPELINE STAGE BREAKDOWN (horizontal bars)
═══════════════════════════════════════════════════════════════════════════ */
const STAGE_COLORS: Record<string, string> = {
  discovery: "#3B82F6",
  qualified: "#8B5CF6",
  proposal: "#F59E0B",
  negotiation: "#F97316",
  won: "#22C55E",
  lost: "#EF4444",
};

export function PipelineStageWidget({ data }: { data: any }) {
  const series = (data.series ?? []) as Array<{ stage: string; count: number; value: number }>;
  if (series.length === 0) {
    return <p className="text-xs text-muted-foreground py-4 text-center">No pipeline data</p>;
  }
  const maxValue = Math.max(...series.map((s) => s.value), 1);
  const totalValue = series.reduce((s, r) => s + r.value, 0);
  return (
    <div className="space-y-2 text-xs">
      {series.map((s) => (
        <div key={s.stage} className="flex items-center gap-2">
          <span className="capitalize w-20 text-muted-foreground shrink-0">{s.stage}</span>
          <div className="flex-1 h-2.5 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${(s.value / maxValue) * 100}%`, background: STAGE_COLORS[s.stage] ?? "#14B89A" }}
            />
          </div>
          <span className="font-mono tabular-nums w-14 text-right">{fmtCurrency(s.value)}</span>
          <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4 shrink-0">{s.count}</Badge>
        </div>
      ))}
      <div className="pt-1 border-t border-border flex justify-between text-muted-foreground">
        <span>Total pipeline</span>
        <span className="font-mono font-semibold text-foreground">{fmtCurrency(totalValue)}</span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   REP PERFORMANCE TABLE
═══════════════════════════════════════════════════════════════════════════ */
export function RepPerformanceWidget({ data }: { data: any }) {
  const rows = (data.rows ?? []) as Array<{
    name: string; deals: number; revenue: number; pipeline: number; winRate: number; activities: number;
  }>;
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground py-4 text-center">No rep data</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground border-b border-border">
            <th className="text-left py-1 pr-2 font-medium">Rep</th>
            <th className="text-right py-1 px-1 font-medium">Deals</th>
            <th className="text-right py-1 px-1 font-medium">Revenue</th>
            <th className="text-right py-1 px-1 font-medium">Pipeline</th>
            <th className="text-right py-1 px-1 font-medium">Win%</th>
            <th className="text-right py-1 pl-1 font-medium">Acts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
              <td className="py-1.5 pr-2 font-medium truncate max-w-[80px]">{r.name}</td>
              <td className="py-1.5 px-1 text-right tabular-nums font-mono">{r.deals}</td>
              <td className="py-1.5 px-1 text-right tabular-nums font-mono">{fmtCurrency(r.revenue)}</td>
              <td className="py-1.5 px-1 text-right tabular-nums font-mono text-muted-foreground">{fmtCurrency(r.pipeline)}</td>
              <td className="py-1.5 px-1 text-right tabular-nums font-mono">
                <span className={r.winRate >= 50 ? "text-emerald-500" : r.winRate >= 25 ? "text-amber-500" : "text-red-500"}>
                  {r.winRate}%
                </span>
              </td>
              <td className="py-1.5 pl-1 text-right tabular-nums font-mono text-muted-foreground">{r.activities}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   EMAIL HEALTH (existing widget, moved here for consistency)
═══════════════════════════════════════════════════════════════════════════ */
export function EmailHealthWidget({ data }: { data: any }) {
  const { total = 0, valid = 0, acceptAll = 0, risky = 0, invalid = 0, unknown = 0, verifiedPct = 0 } = data ?? {};
  const rows = [
    { label: "Valid", count: valid, color: "bg-emerald-500" },
    { label: "Accept-All", count: acceptAll, color: "bg-blue-500" },
    { label: "Risky", count: risky, color: "bg-amber-500" },
    { label: "Invalid", count: invalid, color: "bg-red-500" },
    { label: "Unknown", count: unknown, color: "bg-secondary" },
  ];
  return (
    <div className="space-y-2 text-xs">
      <div className="flex justify-between text-muted-foreground">
        <span>Total contacts</span>
        <span className="font-mono font-semibold text-foreground">{fmtNumber(total)}</span>
      </div>
      <Progress value={verifiedPct} className="h-2" />
      <div className="text-[10px] text-muted-foreground text-right">{verifiedPct}% verified</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${r.color}`} />
          <span className="flex-1 text-muted-foreground">{r.label}</span>
          <span className="font-mono tabular-nums">{fmtNumber(r.count)}</span>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   TABLE WIDGET (top accounts)
═══════════════════════════════════════════════════════════════════════════ */
export function TableWidget({ data }: { data: any }) {
  const rows = (data.rows ?? []) as Array<{ id: number; name: string; value: number }>;
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground py-4 text-center">No data</p>;
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-muted-foreground border-b border-border">
          <th className="text-left py-1 font-medium">Account</th>
          <th className="text-right py-1 font-medium">Pipeline</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-border/50 hover:bg-secondary/30 transition-colors">
            <td className="py-1.5 truncate max-w-[120px]">{r.name}</td>
            <td className="py-1.5 text-right font-mono tabular-nums">{fmtCurrency(r.value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   WIDGET DISPATCHER — renders the correct widget component for non-chart types
═══════════════════════════════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════════════════════════════
   PROPOSAL EXPIRY FUNNEL WIDGET
   Shows expired / extended / accepted counts for 30/60/90d windows
═══════════════════════════════════════════════════════════════════════════ */
export function ProposalExpiryFunnelWidget({ data }: { data: any }) {
  const series: Array<{ label: string; expired: number; extended: number; accepted: number; windowDays: number }> =
    data?.series ?? [];
  if (series.length === 0) {
    return <div className="text-xs text-muted-foreground text-center py-4">No data yet.</div>;
  }
  return (
    <div className="space-y-3 text-xs">
      {series.map((w) => {
        const total = w.expired + w.extended + w.accepted;
        const acceptedPct = total === 0 ? 0 : Math.round((w.accepted / total) * 100);
        const activePct   = total === 0 ? 0 : Math.round((w.extended / total) * 100);
        const expiredPct  = total === 0 ? 0 : Math.round((w.expired  / total) * 100);
        const days = w.windowDays ?? parseInt(w.label);
        return (
          <div key={w.label} className="space-y-1">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="font-medium text-foreground">Last {w.label}</span>
              <span>{total} proposals</span>
            </div>
            {/* stacked progress bar — each segment is a drill-down link */}
            <div className="flex h-2 rounded-full overflow-hidden bg-muted/40 gap-px">
              {w.accepted > 0 && (
                <a
                  href={`/proposals?expiryFilter=accepted&window=${days}`}
                  className="bg-emerald-500 hover:brightness-110 transition-all cursor-pointer"
                  style={{ width: `${acceptedPct}%` }}
                  title={`Accepted: ${w.accepted} — click to filter`}
                />
              )}
              {w.extended > 0 && (
                <a
                  href={`/proposals?expiryFilter=active&window=${days}`}
                  className="bg-blue-500 hover:brightness-110 transition-all cursor-pointer"
                  style={{ width: `${activePct}%` }}
                  title={`Active/Extended: ${w.extended} — click to filter`}
                />
              )}
              {w.expired > 0 && (
                <a
                  href={`/proposals?expiryFilter=expired&window=${days}`}
                  className="bg-red-500 hover:brightness-110 transition-all cursor-pointer"
                  style={{ width: `${expiredPct}%` }}
                  title={`Expired: ${w.expired} — click to filter`}
                />
              )}
            </div>
            <div className="flex gap-3 text-[10px] text-muted-foreground flex-wrap">
              <a href={`/proposals?expiryFilter=accepted&window=${days}`} className="flex items-center gap-1 hover:text-emerald-400 transition-colors cursor-pointer">
                <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />Accepted {w.accepted}
              </a>
              <a href={`/proposals?expiryFilter=active&window=${days}`} className="flex items-center gap-1 hover:text-blue-400 transition-colors cursor-pointer">
                <span className="w-2 h-2 rounded-full bg-blue-500 inline-block" />Active {w.extended}
              </a>
              <a href={`/proposals?expiryFilter=expired&window=${days}`} className="flex items-center gap-1 hover:text-red-400 transition-colors cursor-pointer">
                <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />Expired {w.expired}
              </a>
            </div>
          </div>
        );
      })}
      <p className="text-[10px] text-muted-foreground/60 text-right pt-1">Click a segment to filter proposals</p>
    </div>
  );
}
export function WidgetDataRenderer({ data }: { data: any }) {
  if (!data) return <p className="text-xs text-muted-foreground py-4 text-center">Loading…</p>;
  switch (data.type) {
    case "kpi":
    case "single_value":
    case "gauge":
      return <KpiCardWidget data={data} />;
    case "leaderboard":
      return <LeaderboardWidget data={data} />;
    case "activity_feed":
      return <ActivityFeedWidget data={data} />;
    case "goal_progress":
      return <GoalProgressWidget data={data} />;
    case "comparison":
      return <ComparisonWidget data={data} />;
    case "pipeline_stage":
      return <PipelineStageWidget data={data} />;
    case "rep_performance":
      return <RepPerformanceWidget data={data} />;
    case "email_health":
      return <EmailHealthWidget data={data} />;
    case "proposal_expiry_funnel":
      return <ProposalExpiryFunnelWidget data={data} />;
    case "table":
      return <TableWidget data={data} />;
    default:
      return null; // chart types handled by DashboardChartRenderer
  }
}
