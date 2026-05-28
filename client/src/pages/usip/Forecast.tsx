/**
 * /forecast — per-rep forecast rollup.
 *
 * Columns: owner | open count | total pipeline | weighted | commit
 * (>=90%) | best-case (>=50%) | won this quarter.
 *
 * Server side does the math (opportunities.forecastByRep). This page
 * just renders + joins owner names from team.list.
 */
import { useMemo } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader, StatCard, EmptyState } from "@/components/usip/Shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Target, BarChart3 } from "lucide-react";

function fmt$(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export default function Forecast() {
  const { data: byRep, isLoading } = trpc.opportunities.forecastByRep.useQuery();
  const { data: members } = trpc.team.list.useQuery();

  const memberMap = useMemo(() => {
    const m = new Map<number, string>();
    (members ?? []).forEach((mem: any) => m.set(mem.userId, mem.name ?? `User ${mem.userId}`));
    return m;
  }, [members]);

  const totals = useMemo(() => {
    const z = { open: 0, weighted: 0, commit: 0, bestCase: 0, won: 0 };
    for (const r of byRep ?? []) {
      z.open += r.total;
      z.weighted += r.weighted;
      z.commit += r.commit;
      z.bestCase += r.bestCase;
      z.won += r.wonThisQuarter;
    }
    return z;
  }, [byRep]);

  return (
    <Shell title="Forecast">
      <PageHeader title="Forecast" description="Per-rep pipeline rollup. Commit = ≥90% win prob. Best-case = ≥50%. Weighted = value × win prob." icon={<TrendingUp className="size-5" />} />
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="Total open" value={fmt$(totals.open)} />
          <StatCard label="Weighted" value={fmt$(totals.weighted)} hint="value × win prob" />
          <StatCard label="Commit (≥90%)" value={fmt$(totals.commit)} tone="success" />
          <StatCard label="Best case (≥50%)" value={fmt$(totals.bestCase)} tone="warning" />
          <StatCard label="Won this quarter" value={fmt$(totals.won)} tone="success" />
        </div>

        <Card><CardContent className="pt-4">
          {isLoading ? <div className="text-sm text-muted-foreground">Loading…</div> :
            !byRep || byRep.length === 0 ? <EmptyState icon={BarChart3} title="No pipeline data yet" /> :
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr>
                    <th className="text-left px-3 py-2">Owner</th>
                    <th className="text-right px-3 py-2">Open</th>
                    <th className="text-right px-3 py-2">Total pipeline</th>
                    <th className="text-right px-3 py-2">Weighted</th>
                    <th className="text-right px-3 py-2">Commit</th>
                    <th className="text-right px-3 py-2">Best case</th>
                    <th className="text-right px-3 py-2">Won (this Q)</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {byRep.slice().sort((a, b) => b.weighted - a.weighted).map((r) => (
                    <tr key={r.ownerUserId ?? "unassigned"} className="hover:bg-secondary/30">
                      <td className="px-3 py-2 font-medium">
                        {r.ownerUserId ? (
                          <Link href={`/pipeline?owner=${r.ownerUserId}`} className="hover:underline flex items-center gap-2">
                            <Target className="size-3.5 text-muted-foreground" />
                            {memberMap.get(r.ownerUserId) ?? `User ${r.ownerUserId}`}
                          </Link>
                        ) : <Badge variant="outline">Unassigned</Badge>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.openCount}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt$(r.total)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt$(r.weighted)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400">{fmt$(r.commit)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-amber-700 dark:text-amber-400">{fmt$(r.bestCase)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmt$(r.wonThisQuarter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          }
        </CardContent></Card>
      </div>
    </Shell>
  );
}
