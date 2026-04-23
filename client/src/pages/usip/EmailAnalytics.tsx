import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { BarChart2, ChevronDown, ChevronUp, Mail, MousePointer, Send, TrendingUp } from "lucide-react";
import { useMemo, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

type SortField = "subject" | "sentAt" | "openCount" | "clickCount";
type SortDir = "asc" | "desc";

function KpiCard({ label, value, sub, icon: Icon, accent }: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-5 flex items-start gap-4">
      <div className={`rounded-lg p-2.5 ${accent ?? "bg-primary/10"}`}>
        <Icon className="size-5 text-primary" />
      </div>
      <div>
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

export default function EmailAnalytics() {
  const { data: summary, isLoading: summaryLoading } = trpc.smtpConfig.getAnalyticsSummary.useQuery();
  const { data: overview, isLoading: overviewLoading } = trpc.smtpConfig.getTrackingOverview.useQuery({ limit: 100 });

  const [sortField, setSortField] = useState<SortField>("sentAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [search, setSearch] = useState("");

  function toggleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("desc"); }
  }

  const sortedDrafts = useMemo(() => {
    const drafts = (overview ?? []).filter((d) =>
      !search || d.subject?.toLowerCase().includes(search.toLowerCase()) || d.toEmail?.toLowerCase().includes(search.toLowerCase())
    );
    return [...drafts].sort((a, b) => {
      let av: any, bv: any;
      if (sortField === "subject") { av = a.subject ?? ""; bv = b.subject ?? ""; }
      else if (sortField === "sentAt") { av = a.sentAt ? new Date(a.sentAt).getTime() : 0; bv = b.sentAt ? new Date(b.sentAt).getTime() : 0; }
      else if (sortField === "openCount") { av = a.openCount ?? 0; bv = b.openCount ?? 0; }
      else { av = a.clickCount ?? 0; bv = b.clickCount ?? 0; }
      return sortDir === "asc" ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
    });
  }, [overview, sortField, sortDir, search]);

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <ChevronDown className="size-3 text-muted-foreground/40" />;
    return sortDir === "asc" ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />;
  }

  const chartData = summary?.dailyBreakdown ?? [];

  return (
    <Shell title="Email Analytics">
      <PageHeader title="Email Analytics" description="Delivery, open, and click metrics for all outbound emails." />

      {/* KPI Cards */}
      <div className="px-6 pt-2 grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Emails Sent" value={summary?.totalSent ?? "—"} icon={Send} />
        <KpiCard label="Open Rate" value={summary ? `${summary.openRate}%` : "—"} sub={`${summary?.uniqueOpened ?? 0} unique opens`} icon={Mail} accent="bg-blue-500/10" />
        <KpiCard label="Click Rate" value={summary ? `${summary.clickRate}%` : "—"} sub={`${summary?.uniqueClicked ?? 0} unique clicks`} icon={MousePointer} accent="bg-green-500/10" />
        <KpiCard label="Total Events" value={summary ? summary.totalOpens + summary.totalClicks : "—"} sub={`${summary?.totalOpens ?? 0} opens · ${summary?.totalClicks ?? 0} clicks`} icon={TrendingUp} accent="bg-purple-500/10" />
      </div>

      {/* Time-series chart */}
      <div className="px-6 pt-6">
        <div className="rounded-xl border bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <BarChart2 className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Opens &amp; Clicks — Last 30 Days</span>
          </div>
          {chartData.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">
              No tracking events yet. Send some emails to see data here.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(v) => v.slice(5)} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: 12 }}
                  labelFormatter={(v) => `Date: ${v}`}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="opens" name="Opens" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                <Bar dataKey="clicks" name="Clicks" fill="hsl(var(--chart-2, #22c55e))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Sent drafts table */}
      <div className="px-6 pt-6 pb-8">
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
            <EmptyState icon={Mail} title="No sent emails" description="Sent emails will appear here once you send approved drafts." />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/20 text-xs text-muted-foreground">
                  <th className="text-left px-4 py-2.5">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("subject")}>
                      Subject <SortIcon field="subject" />
                    </button>
                  </th>
                  <th className="text-left px-4 py-2.5">Recipient</th>
                  <th className="text-left px-4 py-2.5">
                    <button className="flex items-center gap-1" onClick={() => toggleSort("sentAt")}>
                      Sent <SortIcon field="sentAt" />
                    </button>
                  </th>
                  <th className="text-center px-4 py-2.5">
                    <button className="flex items-center gap-1 mx-auto" onClick={() => toggleSort("openCount")}>
                      Opens <SortIcon field="openCount" />
                    </button>
                  </th>
                  <th className="text-center px-4 py-2.5">
                    <button className="flex items-center gap-1 mx-auto" onClick={() => toggleSort("clickCount")}>
                      Clicks <SortIcon field="clickCount" />
                    </button>
                  </th>
                  <th className="text-left px-4 py-2.5">Last Activity</th>
                </tr>
              </thead>
              <tbody>
                {sortedDrafts.map((d) => (
                  <tr key={d.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 font-medium max-w-xs truncate">{d.subject ?? <span className="text-muted-foreground italic">No subject</span>}</td>
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{d.toEmail ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {d.sentAt ? new Date(d.sentAt).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {(d.openCount ?? 0) > 0 ? (
                        <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20">
                          <Mail className="size-3 mr-1" />{d.openCount}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground/50 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {(d.clickCount ?? 0) > 0 ? (
                        <Badge variant="secondary" className="bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20">
                          <MousePointer className="size-3 mr-1" />{d.clickCount}
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
