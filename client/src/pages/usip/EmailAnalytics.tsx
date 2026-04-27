import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeader, Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  BarChart2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Mail,
  MousePointer,
  Send,
  ShieldAlert,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

type SortField = "subject" | "sentAt" | "openCount" | "clickCount";
type SortDir = "asc" | "desc";

const DATE_RANGE_OPTIONS: { label: string; days: number }[] = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
  warn,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  accent?: string;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border bg-card p-5 flex items-start gap-4 ${warn ? "border-red-500/40" : ""}`}
    >
      <div className={`rounded-lg p-2.5 ${accent ?? "bg-primary/10"}`}>
        <Icon className={`size-5 ${warn ? "text-red-500" : "text-primary"}`} />
      </div>
      <div>
        <div
          className={`text-2xl font-bold tracking-tight ${warn ? "text-red-500" : ""}`}
        >
          {value}
        </div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

export default function EmailAnalytics() {
  const { data: summary } = trpc.smtpConfig.getAnalyticsSummary.useQuery();
  const { data: overview, isLoading: overviewLoading } =
    trpc.smtpConfig.getTrackingOverview.useQuery({ limit: 100 });
  const { data: bounceStats } = trpc.smtpConfig.getBounceStats.useQuery();

  const accent = useAccentColor();
  // Time-series chart state
  const [chartDays, setChartDays] = useState(30);
  const { data: timeSeriesData, isLoading: timeSeriesLoading } =
    trpc.smtpConfig.getTrackingTimeSeries.useQuery({ days: chartDays });

  // Table state
  const [sortField, setSortField] = useState<SortField>("sentAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [search, setSearch] = useState("");

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortField(field);
      setSortDir("desc");
    }
  }

  const sortedDrafts = useMemo(() => {
    const drafts = (overview ?? []).filter(
      (d) =>
        !search ||
        d.subject?.toLowerCase().includes(search.toLowerCase()) ||
        d.toEmail?.toLowerCase().includes(search.toLowerCase()),
    );
    return [...drafts].sort((a, b) => {
      let av: number | string, bv: number | string;
      if (sortField === "subject") {
        av = a.subject ?? "";
        bv = b.subject ?? "";
      } else if (sortField === "sentAt") {
        av = a.sentAt ? new Date(a.sentAt).getTime() : 0;
        bv = b.sentAt ? new Date(b.sentAt).getTime() : 0;
      } else if (sortField === "openCount") {
        av = a.openCount ?? 0;
        bv = b.openCount ?? 0;
      } else {
        av = a.clickCount ?? 0;
        bv = b.clickCount ?? 0;
      }
      return sortDir === "asc" ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
    });
  }, [overview, sortField, sortDir, search]);

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field)
      return <ChevronDown className="size-3 text-muted-foreground/40" />;
    return sortDir === "asc" ? (
      <ChevronUp className="size-3" />
    ) : (
      <ChevronDown className="size-3" />
    );
  }

  const [, setLocation] = useLocation();

  const periodTotals = useMemo(() => {
    if (!timeSeriesData) return { opens: 0, clicks: 0, bounces: 0 };
    return timeSeriesData.reduce(
      (acc, d) => ({ opens: acc.opens + d.opens, clicks: acc.clicks + d.clicks, bounces: acc.bounces + (d.bounces ?? 0) }),
      { opens: 0, clicks: 0, bounces: 0 },
    );
  }, [timeSeriesData]);

  const hasChartData =
    timeSeriesData && timeSeriesData.some((d) => d.opens > 0 || d.clicks > 0 || (d.bounces ?? 0) > 0);

  const bounceRateWarn = (bounceStats?.bounceRate ?? 0) >= 5;

  return (
    <Shell title="Email Analytics">
      <PageHeader
        title="Email Analytics" pageKey="email-analytics"
        description="Delivery, open, and click metrics for all outbound emails."
      />

      {/* KPI Cards */}
      <div className="px-6 pt-2 grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Emails Sent" value={summary?.totalSent ?? "—"} icon={Send} />
        <KpiCard
          label="Open Rate"
          value={summary ? `${summary.openRate}%` : "—"}
          sub={`${summary?.uniqueOpened ?? 0} unique opens`}
          icon={Mail}
          accent="bg-blue-500/10"
        />
        <KpiCard
          label="Click Rate"
          value={summary ? `${summary.clickRate}%` : "—"}
          sub={`${summary?.uniqueClicked ?? 0} unique clicks`}
          icon={MousePointer}
          accent="bg-green-500/10"
        />
        <KpiCard
          label="Total Events"
          value={summary ? summary.totalOpens + summary.totalClicks : "—"}
          sub={`${summary?.totalOpens ?? 0} opens · ${summary?.totalClicks ?? 0} clicks`}
          icon={TrendingUp}
          accent="bg-purple-500/10"
        />
      </div>

      {/* ── Bounce Health Card (Feature 55) ─────────────────────────────── */}
      <div className="px-6 pt-4">
        <div
          className={`rounded-xl border bg-card p-5 ${bounceRateWarn ? "border-red-500/30" : ""}`}
        >
          {/* Header */}
          <div className="flex items-center gap-2 mb-4">
            <ShieldAlert
              className={`size-4 ${bounceRateWarn ? "text-red-500" : "text-muted-foreground"}`}
            />
            <span className="text-sm font-medium">Bounce Health</span>
            {bounceRateWarn && (
              <Badge
                variant="destructive"
                className="text-xs ml-1 bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30"
              >
                <AlertTriangle className="size-3 mr-1" />
                High bounce rate
              </Badge>
            )}
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {/* Bounce Rate KPI */}
            <div className="col-span-2 sm:col-span-1 flex flex-col gap-1">
              <div
                className={`text-3xl font-bold tabular-nums ${bounceRateWarn ? "text-red-500" : "text-foreground"}`}
              >
                {bounceStats ? `${bounceStats.bounceRate}%` : "—"}
              </div>
              <div className="text-xs text-muted-foreground">Bounce Rate</div>
              {bounceStats && (
                <div className="text-xs text-muted-foreground">
                  {bounceStats.totalBounced} of {bounceStats.totalSent} sent
                </div>
              )}
            </div>

            {/* Hard Bounces */}
            <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3">
              <div className="rounded-md p-1.5 bg-red-500/10">
                <XCircle className="size-4 text-red-500" />
              </div>
              <div>
                <div className="text-xl font-bold tabular-nums">
                  {bounceStats?.hardBounces ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground">Hard Bounces</div>
                <div className="text-xs text-muted-foreground/60 mt-0.5">
                  Invalid address
                </div>
              </div>
            </div>

            {/* Soft Bounces */}
            <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3">
              <div className="rounded-md p-1.5 bg-amber-500/10">
                <AlertTriangle className="size-4 text-amber-500" />
              </div>
              <div>
                <div className="text-xl font-bold tabular-nums">
                  {bounceStats?.softBounces ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground">Soft Bounces</div>
                <div className="text-xs text-muted-foreground/60 mt-0.5">
                  Temporary failure
                </div>
              </div>
            </div>

            {/* Spam Complaints */}
            <div className="flex items-start gap-3 rounded-lg border bg-muted/20 p-3">
              <div className="rounded-md p-1.5 bg-orange-500/10">
                <ShieldAlert className="size-4 text-orange-500" />
              </div>
              <div>
                <div className="text-xl font-bold tabular-nums">
                  {bounceStats?.spamComplaints ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground">Spam Complaints</div>
                <div className="text-xs text-muted-foreground/60 mt-0.5">
                  Marked as spam
                </div>
              </div>
            </div>
          </div>

          {/* View bounced emails link (Feature 58) + Suppression note */}
          {bounceStats && (bounceStats.totalBounced > 0 || bounceStats.suppressedEmails > 0) && (
            <div className="mt-3 border-t pt-3 flex flex-wrap items-center justify-between gap-2">
              {bounceStats.totalBounced > 0 && (
                <button
                  onClick={() => setLocation("/email-drafts?filter=bounced")}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ChevronRight className="size-3" />
                  View {bounceStats.totalBounced} bounced email{bounceStats.totalBounced !== 1 ? "s" : ""}
                </button>
              )}
              {bounceStats.suppressedEmails > 0 && (
                <div className="text-xs text-muted-foreground">
                  <span className="font-medium">{bounceStats.suppressedEmails}</span> email
                  {bounceStats.suppressedEmails !== 1 ? "s" : ""} on suppression list.{" "}
                  <a href="/email-suppressions" className="underline text-primary">
                    Manage
                  </a>
                </div>
              )}
            </div>
          )}

          {/* Healthy state */}
          {bounceStats && bounceStats.totalBounced === 0 && bounceStats.totalSent > 0 && (
            <div className="mt-3 text-xs text-green-600 dark:text-green-400 border-t pt-3">
              No bounces recorded. Your sender reputation looks healthy.
            </div>
          )}
        </div>
      </div>

      {/* Time-series chart */}
      <div className="px-6 pt-4">
        <div className="rounded-xl border bg-card p-5">
          <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
            <div className="flex items-center gap-2">
              <BarChart2 className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">Opens, Clicks &amp; Bounces Over Time</span>
              {!timeSeriesLoading && hasChartData && (
                <span className="text-xs text-muted-foreground ml-1">
                  ({periodTotals.opens} opens · {periodTotals.clicks} clicks{periodTotals.bounces > 0 ? ` · ${periodTotals.bounces} bounces` : ""} in period)
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 rounded-lg border bg-muted/40 p-0.5">
              {DATE_RANGE_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  onClick={() => setChartDays(opt.days)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    chartDays === opt.days
                      ? "bg-background shadow-sm text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {timeSeriesLoading ? (
            <div className="h-52 flex items-center justify-center text-sm text-muted-foreground">
              Loading chart data…
            </div>
          ) : !hasChartData ? (
            <div className="h-52 flex items-center justify-center text-sm text-muted-foreground">
              No tracking events in the last {chartDays} days. Send some emails to see
              data here.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart
                data={timeSeriesData}
                margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="colorOpens" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={accent} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={accent} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="colorClicks" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="colorBounces" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: string) => {
                    if (chartDays <= 30) return v.slice(5).replace("-", "/");
                    const d = new Date(v + "T00:00:00");
                    return d.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    });
                  }}
                  interval={chartDays <= 14 ? 0 : chartDays <= 30 ? 3 : 6}
                />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: 12,
                  }}
                  labelFormatter={(v: string) => `Date: ${v}`}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area
                  type="monotone"
                  dataKey="opens"
                  name="Opens"
                  stroke={accent}
                  strokeWidth={2}
                  fill="url(#colorOpens)"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Area
                  type="monotone"
                  dataKey="clicks"
                  name="Clicks"
                  stroke="#22c55e"
                  strokeWidth={2}
                  fill="url(#colorClicks)"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Area
                  type="monotone"
                  dataKey="bounces"
                  name="Bounces"
                  stroke="#ef4444"
                  strokeWidth={2}
                  fill="url(#colorBounces)"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Sent drafts table */}
      <div className="px-6 pt-4 pb-8">
        <div className="rounded-xl border bg-card overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 border-b bg-muted/30">
            <span className="text-sm font-medium flex-1">Sent Emails</span>
            <input
              type="search"
              placeholder="Search subject or recipient…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 rounded-md border bg-background px-3 text-sm w-64 focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          {overviewLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
          ) : sortedDrafts.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="No sent emails"
              description="Sent emails will appear here once you send approved drafts."
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                  <th className="text-left px-4 py-2.5">
                    <button
                      className="flex items-center gap-1"
                      onClick={() => toggleSort("subject")}
                    >
                      Subject <SortIcon field="subject" />
                    </button>
                  </th>
                  <th className="text-left px-4 py-2.5">Recipient</th>
                  <th className="text-left px-4 py-2.5">
                    <button
                      className="flex items-center gap-1"
                      onClick={() => toggleSort("sentAt")}
                    >
                      Sent <SortIcon field="sentAt" />
                    </button>
                  </th>
                  <th className="text-center px-4 py-2.5">
                    <button
                      className="flex items-center gap-1 mx-auto"
                      onClick={() => toggleSort("openCount")}
                    >
                      Opens <SortIcon field="openCount" />
                    </button>
                  </th>
                  <th className="text-center px-4 py-2.5">
                    <button
                      className="flex items-center gap-1 mx-auto"
                      onClick={() => toggleSort("clickCount")}
                    >
                      Clicks <SortIcon field="clickCount" />
                    </button>
                  </th>
                  <th className="text-left px-4 py-2.5">Last Activity</th>
                </tr>
              </thead>
              <tbody>
                {sortedDrafts.map((d) => (
                  <tr
                    key={d.id}
                    className="border-b last:border-0 hover:bg-muted/20 transition-colors"
                  >
                    <td className="px-4 py-3 font-medium max-w-xs truncate">
                      {d.subject ?? (
                        <span className="text-muted-foreground italic">No subject</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                      {d.toEmail ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {d.sentAt ? new Date(d.sentAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {(d.openCount ?? 0) > 0 ? (
                        <Badge
                          variant="secondary"
                          className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20"
                        >
                          <Mail className="size-3 mr-1" />
                          {d.openCount}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground/50 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {(d.clickCount ?? 0) > 0 ? (
                        <Badge
                          variant="secondary"
                          className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20"
                        >
                          <MousePointer className="size-3 mr-1" />
                          {d.clickCount}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground/50 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {d.lastClickedAt
                        ? `Clicked ${new Date(d.lastClickedAt).toLocaleString()}`
                        : d.lastOpenedAt
                          ? `Opened ${new Date(d.lastOpenedAt).toLocaleString()}`
                          : "No activity"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Shell>
  );
}
