/**
 * Dashboard — Velocity Home Screen (Mockup B+)
 *
 * Layout:
 *   Row 1: 4 live stat cards with MoM delta badges + goal progress bars
 *   Row 2: Revenue area chart (period dropdown) | Win/Loss donut
 *   Row 3: Stage Funnel bar chart | Top Reps leaderboard (clickable → filtered Pipeline)
 *   Row 4: Recent Opportunities table | AI Drafts Awaiting Review
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
  Trophy,
  Target,
  TrendingUp,
  Zap,
  RefreshCw,
  Pencil,
  Check,
  Link2,
  UserPlus,
  MessageSquare,
  AlertTriangle,
  Timer, LayoutDashboard
} from "lucide-react";
import { useState, useCallback, useRef } from "react";
import { Link, useLocation } from "wouter";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/* ─── constants ───────────────────────────────────────────────────────────── */
const GOALS_KEY = "velocity_dashboard_goals";

const DEFAULT_GOALS: Record<string, number> = {
  pipelineValue: 5_000_000,
  closedWon:     20,
  activeLeads:   100,
  customers:     50,
  staleProposals: 5,
};

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

const fmtRelative = (d: Date) => {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 5)  return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
};

const PERIOD_OPTIONS = [
  { value: "1",  label: "Past 30 days",   months: 1 },
  { value: "3",  label: "Past 3 months",  months: 3 },
  { value: "6",  label: "Past 6 months",  months: 6 },
  { value: "12", label: "Past 12 months", months: 12 },
  { value: "24", label: "Past 24 months", months: 24 },
] as const;

const STAGE_COLORS: Record<string, string> = {
  Prospect:    "#60A5FA",
  Qualified:   "#FCD34D",
  Proposal:    "#C084FC",
  Negotiation: "#F87171",
  Closing:     "#2DD4BF",
};

/* ─── Goal progress bar ───────────────────────────────────────────────────── */
function GoalBar({
  goalKey,
  current,
  goals,
  onGoalChange,
  isMoney,
}: {
  goalKey: string;
  current: number;
  goals: Record<string, number>;
  onGoalChange: (key: string, val: number) => void;
  isMoney?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const goal = goals[goalKey] ?? DEFAULT_GOALS[goalKey] ?? 100;
  const pct = Math.min(Math.round((current / goal) * 100), 100);
  const over = current >= goal;

  const startEdit = () => {
    setDraft(String(goal));
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitEdit = () => {
    const v = Number(draft.replace(/[^0-9.]/g, ""));
    if (v > 0) onGoalChange(goalKey, v);
    setEditing(false);
  };

  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span className={over ? "text-emerald-500 font-semibold" : ""}>
          {pct}% of goal
        </span>
        {editing ? (
          <div className="flex items-center gap-1">
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditing(false); }}
              className="w-20 border rounded px-1 py-0 text-[10px] bg-background text-foreground"
            />
            <button onClick={commitEdit} className="text-emerald-500 hover:text-emerald-600">
              <Check className="size-3" />
            </button>
          </div>
        ) : (
          <button
            onClick={startEdit}
            className="flex items-center gap-0.5 hover:text-foreground transition-colors"
          >
            Goal: {isMoney ? fmt$(goal) : goal.toLocaleString()}
            <Pencil className="size-2.5 ml-0.5" />
          </button>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${pct}%`,
            background: over ? "#34D399" : pct >= 70 ? "#FCD34D" : "#60A5FA",
          }}
        />
      </div>
    </div>
  );
}

/* ─── Stat card ───────────────────────────────────────────────────────────── */
interface StatProps {
  label: string;
  value: string | number;
  rawValue: number;
  hint?: string;
  delta?: number;
  icon: React.ElementType;
  iconColor: string;
  loading?: boolean;
  goalKey: string;
  goals: Record<string, number>;
  onGoalChange: (key: string, val: number) => void;
  isMoney?: boolean;
}

function MBStatCard({
  label, value, rawValue, hint, delta, icon: Icon, iconColor, loading,
  goalKey, goals, onGoalChange, isMoney,
}: StatProps) {
  const trend = delta === undefined ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return (
    <div
      className="rounded-xl border bg-card p-5 flex flex-col gap-2 hover:shadow-md transition-shadow"
      style={{ borderLeftWidth: 3, borderLeftColor: iconColor }}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground font-medium">{label}</span>
        <div className="rounded-lg p-2" style={{ background: `${iconColor}22` }}>
          <Icon className="size-4" style={{ color: iconColor }} />
        </div>
      </div>
      {loading ? (
        <div className="h-8 flex items-center"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="text-2xl font-bold font-mono tabular-nums" style={{ color: iconColor }}>
          {value}
        </div>
      )}
      <div className="flex items-center gap-1.5 text-xs">
        {trend === "up"   && <ArrowUp   className="size-3 text-emerald-500" />}
        {trend === "down" && <ArrowDown className="size-3 text-red-500" />}
        {trend === "flat" && <Minus     className="size-3 text-muted-foreground" />}
        {delta !== undefined && (
          <span className={
            trend === "up" ? "text-emerald-600 font-semibold" :
            trend === "down" ? "text-red-500 font-semibold" :
            "text-muted-foreground"
          }>
            {delta > 0 ? "+" : ""}{delta}% vs last month
          </span>
        )}
        {hint && <span className="text-muted-foreground ml-1">· {hint}</span>}
      </div>
      {!loading && (
        <GoalBar
          goalKey={goalKey}
          current={rawValue}
          goals={goals}
          onGoalChange={onGoalChange}
          isMoney={isMoney}
        />
      )}
    </div>
  );
}

/* ─── Custom tooltips ─────────────────────────────────────────────────────── */
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

function FunnelTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border bg-popover text-popover-foreground shadow-lg px-3 py-2 text-xs space-y-1">
      <div className="font-semibold">{d.stage}</div>
      <div className="text-muted-foreground">{d.count} deals · {fmt$(d.value)}</div>
    </div>
  );
}

function WinLossTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  return (
    <div className="rounded-lg border bg-popover text-popover-foreground shadow-lg px-3 py-2 text-xs">
      <span className="font-semibold" style={{ color: d.payload.fill }}>{d.name}</span>
      <span className="ml-2 text-muted-foreground">{d.value} deals</span>
    </div>
  );
}

/* ─── Main page ───────────────────────────────────────────────────────────── */
export default function Dashboard() {
  const [, navigate] = useLocation();
  const [period, setPeriod] = useState<string>("6");
  const months = PERIOD_OPTIONS.find((o) => o.value === period)?.months ?? 6;

  // Goals stored in localStorage
  const [goals, setGoals] = useState<Record<string, number>>(() => {
    try {
      return { ...DEFAULT_GOALS, ...JSON.parse(localStorage.getItem(GOALS_KEY) ?? "{}") };
    } catch {
      return { ...DEFAULT_GOALS };
    }
  });

  const handleGoalChange = useCallback((key: string, val: number) => {
    setGoals((prev) => {
      const next = { ...prev, [key]: val };
      localStorage.setItem(GOALS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Last refreshed timestamp
  const [lastRefreshed, setLastRefreshed] = useState(() => new Date());
  const [refreshTick, setRefreshTick] = useState(0);

  const utils = trpc.useUtils();
  const handleRefresh = useCallback(() => {
    utils.opportunities.dashboardStats.invalidate();
    utils.opportunities.revenueChart.invalidate();
    utils.opportunities.stageFunnel.invalidate();
    utils.opportunities.topReps.invalidate();
    utils.opportunities.winLoss.invalidate();
    utils.emailDrafts.list.invalidate();
    utils.opportunities.board.invalidate();
    utils.unipile.metrics.invalidate();
    setLastRefreshed(new Date());
    setRefreshTick((t) => t + 1);
  }, [utils]);

  const { data: stats, isLoading: statsLoading } = trpc.opportunities.dashboardStats.useQuery();
  const { data: chartData, isLoading: chartLoading } = trpc.opportunities.revenueChart.useQuery({ months });
  const { data: funnel } = trpc.opportunities.stageFunnel.useQuery();
  const { data: topReps } = trpc.opportunities.topReps.useQuery();
  const { data: winLoss } = trpc.opportunities.winLoss.useQuery();
  const { data: drafts } = trpc.emailDrafts.list.useQuery({ status: "pending_review" });
  const { data: opps } = trpc.opportunities.board.useQuery();
  const { data: unipileMetrics } = trpc.unipile.metrics.useQuery();

  const recentOpps = (opps ?? []).slice(0, 6);
  const accent = useAccentColor();

  const winLossData = winLoss
    ? [
        { name: "Won",  value: winLoss.won,  fill: "#34D399" },
        { name: "Lost", value: winLoss.lost, fill: "#F87171" },
      ]
    : [];

  const maxRepValue = Math.max(...(topReps ?? []).map((r) => r.value), 1);

  return (
    <Shell title="Dashboard">
      <PageHeader title="Dashboard" description="Your unified revenue intelligence overview — pipeline health, activity, and team performance at a glance." pageKey="dashboard"
        icon={<LayoutDashboard className="size-5" />}
      >
        {/* Last refreshed + Refresh button */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Updated {fmtRelative(lastRefreshed)}</span>
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs hover:bg-secondary transition-colors"
          >
            <RefreshCw className="size-3" /> Refresh
          </button>
        </div>
      </PageHeader>
      <div className="p-6 space-y-6">

        {/* ── Row 1: Live stat cards with goal progress ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          <MBStatCard
            label="Pipeline Value"
            value={fmt$(stats?.pipelineValue ?? 0)}
            rawValue={stats?.pipelineValue ?? 0}
            hint={`${stats?.openOppsCount ?? 0} open opps`}
            delta={stats?.pipelineDelta}
            icon={BarChart2}
            iconColor="#60A5FA"
            loading={statsLoading}
            goalKey="pipelineValue"
            goals={goals}
            onGoalChange={handleGoalChange}
            isMoney
          />
          <MBStatCard
            label="Closed-Won"
            value={`${stats?.closedWonCount ?? 0} deals`}
            rawValue={stats?.closedWonCount ?? 0}
            hint={fmt$(stats?.totalWonValue ?? 0)}
            delta={stats?.closedWonDelta}
            icon={Briefcase}
            iconColor="#34D399"
            loading={statsLoading}
            goalKey="closedWon"
            goals={goals}
            onGoalChange={handleGoalChange}
          />
          <MBStatCard
            label="Active Leads"
            value={(stats?.activeLeads ?? 0).toLocaleString()}
            rawValue={stats?.activeLeads ?? 0}
            delta={stats?.leadsDelta}
            icon={Users}
            iconColor="#C084FC"
            loading={statsLoading}
            goalKey="activeLeads"
            goals={goals}
            onGoalChange={handleGoalChange}
          />
          <MBStatCard
            label="Customers"
            value={stats?.customerCount ?? 0}
            rawValue={stats?.customerCount ?? 0}
            delta={stats?.customerDelta}
            icon={UserCheck}
            iconColor="#F87171"
            loading={statsLoading}
            goalKey="customers"
            goals={goals}
            onGoalChange={handleGoalChange}
          />
          <Link href="/proposals">
            <MBStatCard
              label="Stale Proposals"
              value={(stats?.staleProposals ?? 0).toLocaleString()}
              rawValue={stats?.staleProposals ?? 0}
              hint={
                (stats?.expiringProposals ?? 0) > 0
                  ? `${stats?.expiringProposals} expiring soon`
                  : "no expiring soon"
              }
              icon={AlertTriangle}
              iconColor="#F59E0B"
              loading={statsLoading}
              goalKey="staleProposals"
              goals={goals}
              onGoalChange={handleGoalChange}
            />
          </Link>
        </div>

        {/* ── Row 2: Revenue chart + Win/Loss donut ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Revenue chart — 2/3 width */}
          <div className="lg:col-span-2 rounded-xl border bg-card">
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp className="size-4" style={{ color: accent }} />
                <span className="text-base font-semibold">Revenue</span>
              </div>
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
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={chartData ?? []} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gradRevenue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={accent}    stopOpacity={0.3} />
                        <stop offset="95%" stopColor={accent}    stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="gradForecast" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#C084FC" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#C084FC" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={fmtAxis} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={56} />
                    <Tooltip content={<RevenueTooltip />} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 12 }} />
                    <Area type="monotone" dataKey="revenue"  name="Total Revenue"      stroke={accent}    strokeWidth={2.5} fill="url(#gradRevenue)"  dot={false} activeDot={{ r: 4 }} />
                    <Area type="monotone" dataKey="forecast" name="Forecasted Revenue" stroke="#C084FC" strokeWidth={2} strokeDasharray="5 3" fill="url(#gradForecast)" dot={false} activeDot={{ r: 4 }} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Win/Loss donut — 1/3 width */}
          <div className="rounded-xl border bg-card">
            <div className="px-5 py-4 border-b flex items-center gap-2">
              <Target className="size-4 text-amber-500" />
              <span className="text-base font-semibold">Win / Loss</span>
              <span className="ml-auto text-xs text-muted-foreground">Last 90 days</span>
            </div>
            <div className="p-5 flex flex-col items-center gap-4">
              {winLossData.every((d) => d.value === 0) ? (
                <div className="text-sm text-muted-foreground py-8">No closed deals yet.</div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie
                        data={winLossData}
                        cx="50%"
                        cy="50%"
                        innerRadius={52}
                        outerRadius={78}
                        paddingAngle={3}
                        dataKey="value"
                        strokeWidth={0}
                      >
                        {winLossData.map((entry, i) => (
                          <Cell key={i} fill={entry.fill} />
                        ))}
                      </Pie>
                      <Tooltip content={<WinLossTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="grid grid-cols-2 gap-3 w-full text-center">
                    <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 py-2">
                      <div className="text-xl font-bold text-emerald-500">{winLoss?.won ?? 0}</div>
                      <div className="text-xs text-muted-foreground">Won</div>
                      <div className="text-xs font-mono text-emerald-600">{fmt$(winLoss?.wonValue ?? 0)}</div>
                    </div>
                    <div className="rounded-lg bg-red-500/10 border border-red-500/20 py-2">
                      <div className="text-xl font-bold text-red-500">{winLoss?.lost ?? 0}</div>
                      <div className="text-xs text-muted-foreground">Lost</div>
                      <div className="text-xs font-mono text-red-600">{fmt$(winLoss?.lostValue ?? 0)}</div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Row 3: Stage Funnel + Top Reps ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Stage Funnel */}
          <div className="rounded-xl border bg-card">
            <div className="px-5 py-4 border-b flex items-center gap-2">
              <Zap className="size-4 text-yellow-500" />
              <span className="text-base font-semibold">Pipeline Funnel</span>
            </div>
            <div className="p-5">
              {(funnel ?? []).length === 0 ? (
                <div className="text-sm text-muted-foreground py-4">No open pipeline data.</div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={funnel ?? []} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                    <XAxis type="number" tickFormatter={fmtAxis} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="stage" tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={80} />
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                    <Tooltip content={<FunnelTooltip />} cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }} />
                    <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={22}>
                      {(funnel ?? []).map((entry, i) => (
                        <Cell key={i} fill={STAGE_COLORS[entry.stage] ?? accent} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Top Reps leaderboard — rows are clickable → /pipeline?owner=<userId> */}
          <div className="rounded-xl border bg-card">
            <div className="px-5 py-4 border-b flex items-center gap-2">
              <Trophy className="size-4 text-amber-500" />
              <span className="text-base font-semibold">Top Reps</span>
              <span className="ml-auto text-xs text-muted-foreground">Closed-Won value · click to drill down</span>
            </div>
            <div className="p-4 space-y-3">
              {(topReps ?? []).length === 0 ? (
                <div className="text-sm text-muted-foreground py-4">No rep data yet.</div>
              ) : (
                (topReps ?? []).map((rep, i) => {
                  const pct = Math.round((rep.value / maxRepValue) * 100);
                  const medalColors = ["#FCD34D", "#94A3B8", "#CD7F32"];
                  const barColor = i < 3 ? medalColors[i] : accent;
                  return (
                    <button
                      key={rep.userId}
                      className="w-full space-y-1 text-left group rounded-lg px-2 py-1 hover:bg-secondary/60 transition-colors cursor-pointer"
                      onClick={() => navigate(`/pipeline?owner=${rep.userId}`)}
                      title={`View ${rep.name}'s open deals`}
                    >
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold w-4 text-center" style={{ color: barColor }}>
                            {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`}
                          </span>
                          <span className="font-medium truncate max-w-[120px] group-hover:underline">{rep.name}</span>
                        </div>
                        <div className="text-right flex items-center gap-1">
                          <span className="font-mono font-semibold text-xs">{fmt$(rep.value)}</span>
                          <span className="text-muted-foreground text-xs">· {rep.count} deals</span>
                          <ArrowRight className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </div>
                      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-700"
                          style={{ width: `${pct}%`, background: barColor }}
                        />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* ── Row 4½: Unipile Multichannel Metrics ── */}
        <div className="rounded-xl border bg-card">
          <div className="px-5 py-4 border-b flex items-center gap-2">
            <Link2 className="size-4" style={{ color: "#0A66C2" }} />
            <span className="text-base font-semibold">Multichannel Outreach</span>
            <span className="ml-auto text-xs text-muted-foreground">Last 30 days</span>
            <Link href="/connected-accounts" className="ml-2 text-xs flex items-center gap-1" style={{ color: accent }}>
              Manage <ArrowRight className="size-3" />
            </Link>
          </div>
          <div className="p-5">
            {/* Stat row */}
            <div className="grid grid-cols-3 gap-4 mb-5">
              <div className="rounded-lg border bg-secondary/30 p-3 text-center" style={{ borderLeftWidth: 3, borderLeftColor: "#0A66C2" }}>
                <div className="flex items-center justify-center gap-1 mb-1">
                  <MessageSquare className="size-3.5" style={{ color: "#0A66C2" }} />
                  <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Messages Sent</span>
                </div>
                <div className="text-2xl font-bold font-mono tabular-nums" style={{ color: "#0A66C2" }}>
                  {unipileMetrics?.messagesSent ?? 0}
                </div>
              </div>
              <div className="rounded-lg border bg-secondary/30 p-3 text-center" style={{ borderLeftWidth: 3, borderLeftColor: "#34D399" }}>
                <div className="flex items-center justify-center gap-1 mb-1">
                  <UserPlus className="size-3.5 text-emerald-500" />
                  <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Connections</span>
                </div>
                <div className="text-2xl font-bold font-mono tabular-nums text-emerald-500">
                  {unipileMetrics?.connectionsAccepted ?? 0}
                </div>
              </div>
              <div className="rounded-lg border bg-secondary/30 p-3 text-center" style={{ borderLeftWidth: 3, borderLeftColor: "#FCD34D" }}>
                <div className="flex items-center justify-center gap-1 mb-1">
                  <Target className="size-3.5 text-amber-500" />
                  <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Acceptance</span>
                </div>
                <div className="text-2xl font-bold font-mono tabular-nums text-amber-600">
                  {unipileMetrics?.acceptanceRate ?? 0}%
                </div>
              </div>
            </div>
            {/* Provider breakdown bar chart */}
            {(unipileMetrics?.byProvider ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-2">
                No outbound messages yet. <Link href="/connected-accounts" className="underline" style={{ color: accent }}>Connect a channel</Link> to start.
              </div>
            ) : (
              <div className="space-y-2">
                {(unipileMetrics?.byProvider ?? []).map((p) => {
                  const maxCount = Math.max(...(unipileMetrics?.byProvider ?? []).map((x) => x.count), 1);
                  const pct = Math.round((p.count / maxCount) * 100);
                  const PROVIDER_COLORS: Record<string, string> = {
                    LINKEDIN: "#0A66C2",
                    WHATSAPP: "#25D366",
                    INSTAGRAM: "#E1306C",
                    MESSENGER: "#0084FF",
                    TELEGRAM: "#2AABEE",
                    TWITTER: "#000000",
                    GOOGLE: "#EA4335",
                    MICROSOFT: "#0078D4",
                    IMAP: "#6B7280",
                  };
                  const color = PROVIDER_COLORS[p.provider.toUpperCase()] ?? accent;
                  return (
                    <div key={p.provider} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-20 shrink-0 capitalize">{p.provider.toLowerCase()}</span>
                      <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-700"
                          style={{ width: `${pct}%`, background: color }}
                        />
                      </div>
                      <span className="text-xs font-mono font-semibold w-8 text-right tabular-nums" style={{ color }}>{p.count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* ── Row 4: Recent Opps + AI Drafts ── */}
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
              {recentOpps.map((o) => {
                const stageColor = STAGE_COLORS[o.stage ? o.stage.charAt(0).toUpperCase() + o.stage.slice(1) : ""] ?? accent;
                return (
                  <Link
                    key={o.id}
                    href="/pipeline"
                    className="flex items-center gap-3 px-5 py-3 hover:bg-secondary/50 transition-colors"
                  >
                    <div
                      className="size-2 rounded-full shrink-0"
                      style={{ background: stageColor }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{o.name}</div>
                      <div className="text-xs text-muted-foreground truncate">{o.accountName} ·{" "}
                        <span style={{ color: stageColor }}>{o.stage}</span>
                      </div>
                    </div>
                    <div className="font-mono text-sm tabular-nums shrink-0 font-semibold" style={{ color: stageColor }}>
                      {fmt$(Number(o.value ?? 0))}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* AI Drafts */}
          <div className="rounded-xl border bg-card">
            <div className="px-5 py-3.5 border-b flex items-center">
              <div className="flex items-center gap-2">
                <Zap className="size-3.5 text-violet-500" />
                <div className="text-sm font-semibold">AI Drafts Awaiting Review</div>
                {(drafts ?? []).length > 0 && (
                  <span className="ml-1 rounded-full bg-violet-500/20 text-violet-600 text-xs font-bold px-2 py-0.5">
                    {(drafts ?? []).length}
                  </span>
                )}
              </div>
              <Link href="/email-drafts" className="ml-auto text-xs flex items-center gap-1" style={{ color: accent }}>
                Review queue <ArrowRight className="size-3" />
              </Link>
            </div>
            <div className="p-4">
              {(drafts ?? []).length === 0 ? (
                <div className="text-sm text-muted-foreground py-2 flex items-center gap-2">
                  <span className="text-emerald-500">✓</span> No drafts in the queue — you're all caught up!
                </div>
              ) : (
                <div className="space-y-2">
                  {(drafts ?? []).slice(0, 5).map((d) => (
                    <div
                      key={d.id}
                      className="rounded-lg border bg-secondary/30 px-3 py-2.5 hover:bg-secondary/60 transition-colors cursor-pointer"
                      style={{ borderLeftWidth: 3, borderLeftColor: "#C084FC" }}
                    >
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
