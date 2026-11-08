/**
 * /forecast — the forecast call (audit 2026-10-20, F29 and R41).
 *
 * One fiscal period at a time (this quarter, next quarter, this year — the
 * workspace's fiscal calendar, Settings → General): Closed, Commit, Best case,
 * Pipeline and Omitted per rep, quota pacing beside it, and the deals behind
 * the numbers, where the owner sets their call and a manager can override it
 * (recorded: who, when, from what). Amounts show in the workspace currency.
 *
 * The server does the math (opportunities.forecastCall, from the deal
 * metrics every revenue number reads; quota.teamSummary / quota.myPacing for
 * the pacing). A rep sees their own deals; managers see the team.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { invalidateDealReads } from "@/lib/crmCache";
import { useAuth } from "@/_core/hooks/useAuth";
import { tablistProps, tabProps } from "@/lib/tabs";
import { Shell, PageHeader, StatCard, EmptyState, QueryError } from "@/components/usip/Shell";
import { FailedLoadsBanner } from "@/components/usip/QueryState";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Target, BarChart3, AlertTriangle } from "lucide-react";
import { formatAmount } from "@shared/money";
import { FORECAST_CATEGORIES, FORECAST_CATEGORY_LABEL, type ForecastCategory } from "@shared/forecastCategory";

/** What the numbers are (R41, F29): the categories, the period, and whose rows a rep sees. */
export const FORECAST_DESCRIPTION =
  "One fiscal period at a time. Closed is won in the period; Commit, Best case and Pipeline are open deals expected to close in it, in the category set on each deal (a deal with none counts in Commit at 90% or more and in Best case at 50% or more). Quarters are your fiscal quarters, set in Settings → General. Reps see their own deals; managers see the team and can override a rep's call.";

const PERIODS = [
  { id: "quarter", label: "This quarter" },
  { id: "next_quarter", label: "Next quarter" },
  { id: "year", label: "This year" },
] as const;
type PeriodId = (typeof PERIODS)[number]["id"];

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  attained: { label: "Attained", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  ahead: { label: "Ahead of pace", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  on_track: { label: "On track with Commit", cls: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300" },
  behind: { label: "Behind", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" },
  no_target: { label: "No target", cls: "bg-muted text-muted-foreground" },
};

export default function Forecast() {
  const { user } = useAuth();
  const [period, setPeriod] = useState<PeriodId>("quarter");
  const { data, isLoading, error, refetch } = trpc.opportunities.forecastCall.useQuery({ period });
  const { data: members } = trpc.team.list.useQuery();
  const seesTeam = !!data?.seesTeam;
  // Pacing: the team's for a manager (quota.teamSummary), a rep's own otherwise.
  const team = trpc.quota.teamSummary.useQuery({ period }, { enabled: seesTeam, retry: false });
  const mine = trpc.quota.myPacing.useQuery({ period }, { enabled: !!data && !seesTeam, retry: false });
  const pacing = seesTeam ? team.data : mine.data;
  const utils = trpc.useUtils();
  const setCategory = trpc.opportunities.setForecastCategory.useMutation({
    onSuccess: () => { invalidateDealReads(utils); utils.quota.invalidate(); toast.success("Forecast category saved"); },
    onError: (e) => toast.error(e.message),
  });

  const money = (n: number) => formatAmount(n, { compact: true, currency: data?.currency });
  const memberMap = useMemo(() => {
    const m = new Map<number, string>();
    (members ?? []).forEach((mem: any) => m.set(mem.userId, mem.name ?? `User ${mem.userId}`));
    return m;
  }, [members]);
  const nameOf = (id: number | null | undefined) => (id ? memberMap.get(id) ?? `User ${id}` : "Unassigned");
  const t = data?.totals;

  return (
    <Shell title="Forecast">
      <PageHeader title="Forecast" description={FORECAST_DESCRIPTION} icon={<TrendingUp className="size-5" />}>
        <div {...tablistProps("Forecast period")} className="flex items-center border rounded-md overflow-hidden text-sm">
          {PERIODS.map((p) => (
            <button key={p.id} {...tabProps(period === p.id)} onClick={() => setPeriod(p.id)}
              className={`px-3 py-1.5 transition-colors ${period === p.id ? "bg-primary text-primary-foreground font-semibold" : "text-muted-foreground hover:bg-muted"}`}>
              {p.label}
            </button>
          ))}
        </div>
      </PageHeader>
      <div className="p-4 md:p-5 space-y-4">
        {/* The totals read the same query: when it fails they are not zeros (audit X1.6). */}
        <FailedLoadsBanner />
        {data && <div className="text-sm text-muted-foreground">{data.period.label} · amounts in {data.currency}</div>}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <StatCard label="Closed" value={money(t?.closed ?? 0)} hint="won in the period" tone="success" />
          <StatCard label="Commit" value={money(t?.commit ?? 0)} hint="marked Commit, or 90%+" tone="success" />
          <StatCard label="Best case" value={money(t?.bestCase ?? 0)} hint="Commit + Best case, or 50%+" tone="warning" />
          <StatCard label="Pipeline" value={money(t?.pipeline ?? 0)} hint="the rest still open" />
          <StatCard label="Omitted" value={money(t?.omitted ?? 0)} hint="open, called out of the period" />
          <StatCard label="No close date" value={money(t?.noCloseDate ?? 0)} hint="open, not counted until dated" />
        </div>

        {/* Quota pacing (F29): closed and Commit against the target, against time gone. */}
        <Card><CardContent className="pt-4">
          <div className="flex items-center gap-2 mb-3">
            <Target className="size-4 text-muted-foreground" />
            <div className="text-sm font-semibold">Quota pacing</div>
            {pacing && <div className="ml-auto text-xs text-muted-foreground">{pacing.team.elapsedPct}% of the period gone</div>}
          </div>
          {!pacing ? <div className="text-sm text-muted-foreground">Loading…</div> : pacing.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No targets for this period. <Link href="/quota" className="underline">Set targets on Quota</Link>.</p>
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b"><tr>
                <th className="text-left px-3 py-2">Rep</th><th className="text-right px-3 py-2">Target</th>
                <th className="text-right px-3 py-2">Closed</th><th className="text-right px-3 py-2">+ Commit</th>
                <th className="text-right px-3 py-2">Expected by now</th><th className="text-left px-3 py-2 w-56">Pace</th>
              </tr></thead>
              <tbody className="divide-y">
                {[...pacing.rows, ...(seesTeam && pacing.rows.length > 1 ? [{ userId: 0, ...pacing.team }] : [])].map((r: any) => (
                  <tr key={r.userId} className={r.userId === 0 ? "font-semibold bg-secondary/30" : ""}>
                    <td className="px-3 py-2">{r.userId === 0 ? "Team" : nameOf(r.userId)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.target > 0 ? money(r.target) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.closed)}{r.attainmentPct != null && <span className="text-xs text-muted-foreground"> ({r.attainmentPct}%)</span>}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(r.projected)}{r.projectedPct != null && <span className="text-xs text-muted-foreground"> ({r.projectedPct}%)</span>}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.target > 0 ? money(r.expectedToDate) : "—"}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <PaceBar closed={r.closed} projected={r.projected} target={r.target} elapsedPct={r.elapsedPct} />
                        <span className={`text-[10px] rounded px-1.5 py-0.5 whitespace-nowrap ${STATUS_LABEL[r.status]?.cls ?? ""}`}>{STATUS_LABEL[r.status]?.label ?? r.status}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </CardContent></Card>

        <Card><CardContent className="pt-4">
          {isLoading ? <div className="text-sm text-muted-foreground">Loading…</div> :
            // A failed read is not "nothing in this period" (audit X1.6, kept at the merge with CRMD).
            error && !data ? <QueryError what="the forecast" message={error.message} onRetry={() => { void refetch(); }} /> :
            !data || data.reps.length === 0 ? <EmptyState icon={BarChart3} title="Nothing in this period yet" /> :
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr>
                    <th className="text-left px-3 py-2">Owner</th>
                    <th className="text-right px-3 py-2">Closed</th>
                    <th className="text-right px-3 py-2">Commit</th>
                    <th className="text-right px-3 py-2">Best case</th>
                    <th className="text-right px-3 py-2">Pipeline</th>
                    <th className="text-right px-3 py-2">Omitted</th>
                    <th className="text-right px-3 py-2">No close date</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.reps.slice().sort((a, b) => (b.closed + b.commit) - (a.closed + a.commit)).map((r) => (
                    <tr key={r.ownerUserId ?? "unassigned"} className="hover:bg-secondary/30">
                      <td className="px-3 py-2 font-medium">
                        {r.ownerUserId ? (
                          <Link href={`/pipeline?owner=${r.ownerUserId}`} className="hover:underline">{nameOf(r.ownerUserId)}</Link>
                        ) : <Badge variant="outline">Unassigned</Badge>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(r.closed)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400">{money(r.commit)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-700 dark:text-amber-400">{money(r.bestCase)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(r.pipeline)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(r.omitted)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{money(r.noCloseDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          }
        </CardContent></Card>

        {/* The deals behind the numbers: the owner sets their call, a manager
            can override it, and the last change says who, when and from what. */}
        {data && data.deals.length > 0 && (
          <Card><CardContent className="pt-4">
            <div className="text-sm font-semibold mb-2">Deals in {data.period.label}{data.dealsTotal > data.deals.length ? ` (the ${data.deals.length} largest of ${data.dealsTotal})` : ""}</div>
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b"><tr>
                <th className="text-left px-3 py-2">Deal</th><th className="text-left px-3 py-2">Owner</th>
                <th className="text-left px-3 py-2">Close</th><th className="text-right px-3 py-2">Value</th>
                <th className="text-right px-3 py-2">Win %</th><th className="text-left px-3 py-2">Category</th>
              </tr></thead>
              <tbody className="divide-y">
                {data.deals.map((d) => {
                  const mayEdit = d.category !== "closed" && (seesTeam || d.ownerUserId === user?.id);
                  const ch = d.lastChange;
                  return (
                    <tr key={d.id}>
                      <td className="px-3 py-2"><Link href={`/opportunities/${d.id}`} className="hover:underline font-medium">{d.name}</Link>
                        {d.overdue && <span className="ml-2 inline-flex items-center gap-0.5 text-[10px] text-rose-700"><AlertTriangle className="size-3" />close date passed</span>}
                      </td>
                      <td className="px-3 py-2">{nameOf(d.ownerUserId)}</td>
                      <td className="px-3 py-2 tabular-nums">{d.closeDate ?? "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(d.value)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{d.winProb}%</td>
                      <td className="px-3 py-2">
                        {d.category === "closed" ? <Badge>Closed</Badge> : mayEdit ? (
                          <select aria-label={`Forecast category for ${d.name}`} className="h-7 text-xs rounded-md border bg-background px-2" disabled={setCategory.isPending}
                            value={d.setCategory ?? ""}
                            onChange={(e) => setCategory.mutate({ id: d.id, category: (e.target.value || null) as ForecastCategory | null })}>
                            <option value="">By win % ({FORECAST_CATEGORY_LABEL[d.category as ForecastCategory]})</option>
                            {FORECAST_CATEGORIES.map((c) => <option key={c} value={c}>{FORECAST_CATEGORY_LABEL[c]}</option>)}
                          </select>
                        ) : <span>{FORECAST_CATEGORY_LABEL[d.category as ForecastCategory]}</span>}
                        {ch && (
                          <div className={`text-[10px] mt-0.5 ${ch.isOverride ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
                            {ch.isOverride ? "Override: " : ""}{FORECAST_CATEGORY_LABEL[(ch.to ?? "") as ForecastCategory] ?? "By win %"} by {nameOf(ch.by)}
                            {ch.at ? ` on ${new Date(ch.at).toLocaleDateString()}` : ""}, was {FORECAST_CATEGORY_LABEL[(ch.from ?? "") as ForecastCategory] ?? "by win %"}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </CardContent></Card>
        )}
      </div>
    </Shell>
  );
}

/** Closed (solid) and Commit (light) against the target, with a mark at the time gone. */
function PaceBar({ closed, projected, target, elapsedPct }: { closed: number; projected: number; target: number; elapsedPct: number }) {
  if (!(target > 0)) return <div className="h-2 flex-1 rounded-full bg-muted" />;
  const w = (v: number) => `${Math.min(100, Math.max(0, (v / target) * 100))}%`;
  return (
    <div className="relative h-2 flex-1 rounded-full bg-muted overflow-hidden" role="img" aria-label={`${Math.round((closed / target) * 100)}% closed, ${Math.round((projected / target) * 100)}% with Commit, ${elapsedPct}% of the period gone`}>
      <div className="absolute inset-y-0 left-0 bg-emerald-300/70" style={{ width: w(projected) }} />
      <div className="absolute inset-y-0 left-0 bg-emerald-600" style={{ width: w(closed) }} />
      <div className="absolute inset-y-0 w-0.5 bg-foreground/70" style={{ left: `${elapsedPct}%` }} />
    </div>
  );
}
