import { PageHeader, Shell, StatCard } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { LayoutDashboard, Loader2, TrendingUp } from "lucide-react";
import { Link } from "wouter";

const fmt$ = (n: number | null | undefined) => `$${(Number(n ?? 0)).toLocaleString()}`;

export default function DashboardHome2() {
  const { data: summary, isLoading } = trpc.workspace.summary.useQuery();
  const { data: kpis } = trpc.cs.kpis.useQuery();
  const { data: drafts } = trpc.emailDrafts.list.useQuery({ status: "pending_review" });
  const { data: opps } = trpc.opportunities.board.useQuery();

  const recentOpps = (opps ?? []).slice(0, 6);

  return (
    <Shell title="Home 2">
      <PageHeader title="Welcome back" description="Pipeline, retention, and engagement overview." pageKey="dashboard-home2" icon={<LayoutDashboard className="size-5" />} />
      <div className="p-6 space-y-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading workspace…</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 @container">
            <div className="@container"><StatCard label="Pipeline value" value={fmt$(summary?.pipelineValue ?? 0)} hint={`${summary?.opportunities ?? 0} open opps`} /></div>
            <div className="@container"><StatCard label="Closed-won" value={fmt$(summary?.closedWon ?? 0)} tone="success" /></div>
            <div className="@container"><StatCard label="Open accounts" value={summary?.accounts ?? 0} hint={`${summary?.contacts ?? 0} contacts`} /></div>
            <div className="@container"><StatCard label="Active leads" value={summary?.leads ?? 0} /></div>
            <div className="@container"><StatCard label="Customers" value={kpis?.total ?? summary?.customers ?? 0} hint={kpis ? `${kpis.atRisk} at-risk` : undefined} tone={kpis && kpis.atRisk > 0 ? "warning" : undefined} /></div>
            <div className="@container"><StatCard label="Open tasks" value={summary?.openTasks ?? 0} /></div>
          </div>
        )}

        {kpis && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card title="Recurring revenue">
              <div className="text-2xl md:text-3xl font-semibold font-mono tabular-nums truncate" title={fmt$(kpis.arr)}>{fmt$(kpis.arr)}</div>
              <div className="text-xs text-muted-foreground mt-1 truncate">Across {kpis.total} customers</div>
              <div className="mt-3 text-sm flex items-center gap-1 text-emerald-700 truncate"><TrendingUp className="size-3.5 shrink-0" /> Expansion potential {fmt$(kpis.expansion)}</div>
            </Card>
            <Card title="NPS">
              <div className="text-2xl md:text-3xl font-semibold font-mono tabular-nums">{kpis.npsBand}</div>
              <div className="text-xs text-muted-foreground mt-1">Avg score {kpis.avgNps}</div>
            </Card>
            <Card title="Renewals next 90 days">
              <div className="text-2xl md:text-3xl font-semibold font-mono tabular-nums">{kpis.renewing90}</div>
              <div className="text-xs text-muted-foreground mt-1">Customers in active renewal motion</div>
              <Link href="/renewals" className="text-xs text-primary mt-3 inline-block">Open renewals board →</Link>
            </Card>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card title="Recent opportunities" right={<Link href="/pipeline" className="text-xs text-primary">View pipeline →</Link>}>
            <div className="divide-y -mx-2">
              {recentOpps.length === 0 && <div className="text-sm text-muted-foreground p-4">No opportunities yet.</div>}
              {recentOpps.map((o) => (
                <Link key={o.id} href={`/pipeline`} className="flex items-center gap-3 px-2 py-2.5 hover:bg-secondary/50 rounded">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{o.name}</div>
                    <div className="text-xs text-muted-foreground">{o.accountName} · {o.stage}</div>
                  </div>
                  <div className="font-mono text-sm tabular-nums shrink-0">{fmt$(Number(o.value))}</div>
                </Link>
              ))}
            </div>
          </Card>

          <Card title="AI drafts awaiting review" right={<Link href="/email-drafts" className="text-xs text-primary">Review queue →</Link>}>
            {(drafts ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground p-2">No drafts in the queue.</div>
            ) : (
              <div className="space-y-2">
                {(drafts ?? []).slice(0, 5).map((d) => (
                  <div key={d.id} className="border rounded p-2.5">
                    <div className="text-sm font-medium truncate">{d.subject}</div>
                    <div className="text-xs text-muted-foreground line-clamp-2">{d.body}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </Shell>
  );
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="px-4 py-3 border-b flex items-center">
        <div className="text-sm font-semibold">{title}</div>
        <div className="ml-auto">{right}</div>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}
