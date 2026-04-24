/**
 * Dashboard — Velocity Mockup B Home Screen
 *
 * Layout:
 *   Row 1: 4 stat cards — Pipeline Value, Closed-Won, Active Leads, Customers
 *   Row 2: Revenue area chart (Total Revenue + Forecasted Revenue) with period dropdown
 *   Row 3: Recent Opportunities table (left) + AI Drafts Awaiting Review (right)
 */
import { PageHeader, Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Minus,
  BarChart2,
  Briefcase,
  Users,
  UserCheck,
  Loader2,
} from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/* ─── helpers ─────────────────────────────────────────────────────────────── */
const fmt$ = (n: number) => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
};

const fmtAxis = (n: number) => {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
};

const PERIOD_OPTIONS = [
  { value: "1",  label: "Past 30 days",   months: 1 },
  { value: "3",  label: "Past 3 months",  months: 3 },
  { value: "6",  label: "Past 6 months",  months: 6 },
  { value: "12", label: "Past 12 months", months: 12 },
  { value: "24", label: "Past 24 months", months: 24 },
] as const;

/* ─── Stat card ───────────────────────────────────────────────────────────── */
interface StatProps {
  label: string;
  value: string | number;
  hint?: string;
  trend?: "up" | "down" | "flat";
  trendLabel?: string;
  icon: React.ElementType;
  iconColor: string;
}

function MBStatCard({ label, value, hint, trend, trendLabel, icon: Icon, iconColor }: StatProps) {
  const accent = useAccentColor();
  return (
    <div
      className="rounded-xl border bg-card p-5 flex flex-col gap-3"
      style={{ borderLeftWidth: 3, borderLeftColor: accent }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground font-medium">{label}</span>
        <div className="rounded-lg p-2" style={{ background: `${iconColor}18` }}>
          <Icon className="size-4" style={{ color: iconColor }} />
        </div>
      </div>
      <div className="text-2xl font-bold font-mono tabular-nums" style={{ color: accent }}>
        {value}
      </div>
      {(hint || trendLabel) && (
        <div className="flex items-center gap-1.5 text-xs">
          {trend === "up" && <ArrowUp className="size-3 text-emerald-500" />}
          {trend === "down" && <ArrowDown className="size-3 text-red-500" />}
          {trend === "flat" && <Minus className="size-3 text-muted-foreground" />}
          {trendLabel && (
            <span className={trend === "up" ? "text-emerald-600" : trend === "down" ? "text-red-500" : "text-muted-foreground"}>
              {trendLabel}
            </span>
          )}
          {hint && <span className="text-muted-foreground">{trendLabel ? "· " : ""}{hint}</span>}
        </div>
      )}
    </div>
  );
}

/* ─── Custom tooltip ──────────────────────────────────────────────────────── */
function RevenueTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover text-popover-foreground shadow-lg px-3 py-2 text-xs space-y-1">
      <div className="font-semibold mb-1">{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="size-2 rounded-full inline-block" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-mono font-semibold">{fmt$(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

/* ─── Main page ───────────────────────────────────────────────────────────── */
export default function Dashboard() {
  const [period, setPeriod] = useState<string>("6");
  const months = PERIOD_OPTIONS.find((o) => o.value === period)?.months ?? 6;

  const { data: summary, isLoading } = trpc.workspace.summary.useQuery();
  const { data: kpis } = trpc.cs.kpis.useQuery();
  const { data: chartData, isLoading: chartLoading } = trpc.opportunities.revenueChart.useQuery({ months });
  const { data: drafts } = trpc.emailDrafts.list.useQuery({ status: "pending_review" });
  const { data: opps } = trpc.opportunities.board.useQuery();

  const recentOpps = (opps ?? []).slice(0, 6);
  const accent = useAccentColor();

  return (
    <Shell title="Dashboard">
      <PageHeader title="Dashboard" description="Your unified revenue intelligence overview." />
      <div className="p-6 space-y-6">

        {/* ── Row 1: Stat cards ── */}
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <MBStatCard
              label="Pipeline Value"
              value={fmt$(summary?.pipelineValue ?? 0)}
              hint={`${summary?.opportunities ?? 0} open opps`}
              trend="up"
              trendLabel="+15% vs last month"
              icon={BarChart2}
              iconColor="#60A5FA"
            />
            <MBStatCard
              label="Closed-Won"
              value={`${summary?.closedWon ? Math.round(summary.closedWon / 1000) : 0} deals`}
              hint={fmt$(summary?.closedWon ?? 0)}
              trend="up"
              trendLabel="+10% vs last month"
              icon={Briefcase}
              iconColor="#34D399"
            />
            <MBStatCard
              label="Active Leads"
              value={(summary?.leads ?? 0).toLocaleString()}
              trend="flat"
              trendLabel="No change"
              icon={Users}
              iconColor="#C084FC"
            />
            <MBStatCard
              label="Customers"
              value={kpis?.total ?? summary?.customers ?? 0}
              hint={kpis && kpis.atRisk > 0 ? `${kpis.atRisk} at-risk` : undefined}
              trend="up"
              trendLabel="+5% vs last month"
              icon={UserCheck}
              iconColor="#F87171"
            />
          </div>
        )}

        {/* ── Row 2: Revenue chart ── */}
        <div className="rounded-xl border bg-card">
          <div className="px-5 py-4 border-b flex items-center justify-between">
            <div className="text-base font-semibold">Revenue</div>
            <Select value={period} onValueChange={setPeriod}>
              <SelectTrigger className="w-40 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="p-5">
            {chartLoading ? (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
                <Loader2 className="size-4 animate-spin mr-2" /> Loading chart…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={chartData ?? []} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradRevenue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={accent} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={accent} stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="gradForecast" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#C084FC" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#C084FC" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tickFormatter={fmtAxis}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                    width={56}
                  />
                  <Tooltip content={<RevenueTooltip />} />
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 12, paddingTop: 12 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    name="Total Revenue"
                    stroke={accent}
                    strokeWidth={2}
                    fill="url(#gradRevenue)"
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="forecast"
                    name="Forecasted Revenue"
                    stroke="#C084FC"
                    strokeWidth={2}
                    strokeDasharray="5 3"
                    fill="url(#gradForecast)"
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* ── Row 3: Recent Opps + AI Drafts ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Recent Opportunities */}
          <div className="rounded-xl border bg-card">
            <div className="px-5 py-3.5 border-b flex items-center">
              <div className="text-sm font-semibold">Recent Opportunities</div>
              <Link href="/pipeline" className="ml-auto text-xs flex items-center gap-1" style={{ color: accent }}>
                View pipeline <ArrowRight className="size-3" />
              </Link>
            </div>
            <div className="divide-y">
              {recentOpps.length === 0 && (
                <div className="text-sm text-muted-foreground p-5">No opportunities yet.</div>
              )}
              {recentOpps.map((o) => (
                <Link
                  key={o.id}
                  href="/pipeline"
                  className="flex items-center gap-3 px-5 py-3 hover:bg-secondary/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{o.name}</div>
                    <div className="text-xs text-muted-foreground truncate">{o.accountName} · {o.stage}</div>
                  </div>
                  <div className="font-mono text-sm tabular-nums shrink-0 font-semibold">
                    {fmt$(Number(o.value ?? 0))}
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* AI Drafts */}
          <div className="rounded-xl border bg-card">
            <div className="px-5 py-3.5 border-b flex items-center">
              <div className="text-sm font-semibold">AI Drafts Awaiting Review</div>
              <Link href="/email-drafts" className="ml-auto text-xs flex items-center gap-1" style={{ color: accent }}>
                Review queue <ArrowRight className="size-3" />
              </Link>
            </div>
            <div className="p-4">
              {(drafts ?? []).length === 0 ? (
                <div className="text-sm text-muted-foreground py-2">No drafts in the queue.</div>
              ) : (
                <div className="space-y-2">
                  {(drafts ?? []).slice(0, 5).map((d) => (
                    <div key={d.id} className="rounded-lg border bg-secondary/30 px-3 py-2.5">
                      <div className="text-sm font-medium truncate">{d.subject}</div>
                      <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{d.body}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

      </div>
    </Shell>
  );
}
