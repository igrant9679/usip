/**
 * /engine-status — is everything running? (audit 2026-10-20, F49)
 *
 * For admins: each background engine's last tick, how long it took, and its
 * failures since the server last started; this workspace's queues (how much
 * is waiting, how much is due, how much failed today, the oldest thing still
 * due); the errors browsers reported here in the last day; and how many
 * database queries ran slow. Read from what the engines already record
 * (server/services/engineStatus.ts). Refresh reads it again; it does not poll.
 */
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeader, QueryError, Shell, TableSkeleton } from "@/components/usip/Shell";
import { Section } from "@/components/usip/Common";

type When = Date | string | null | undefined;

/** "3 min ago", "2 h ago", or "never". */
export function ago(at: When, now: number = Date.now()): string {
  if (!at) return "never";
  const ms = now - new Date(at).getTime();
  if (!Number.isFinite(ms)) return "never";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return `${Math.round(ms / 86_400_000)} d ago`;
}

/** An engine needs a look when it failed last time or several times running. */
export function engineHealth(e: { running: boolean; consecutiveFailures: number; runs: number }): "failing" | "running" | "ok" | "idle" {
  if (e.consecutiveFailures > 0) return "failing";
  if (e.running) return "running";
  return e.runs > 0 ? "ok" : "idle";
}

const HEALTH_BADGE: Record<ReturnType<typeof engineHealth>, { label: string; variant: "destructive" | "default" | "secondary" | "outline" }> = {
  failing: { label: "Failing", variant: "destructive" },
  running: { label: "Running", variant: "default" },
  ok: { label: "OK", variant: "secondary" },
  idle: { label: "Not run yet", variant: "outline" },
};

const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());

export default function EngineStatus() {
  const q = trpc.system.engineStatus.useQuery(undefined, { refetchOnWindowFocus: false });
  const data = q.data;

  return (
    <Shell title="Engine status">
      <PageHeader
        title="Engine status"
        pageKey="engine-status"
        icon={<Activity className="size-5" />}
        description="Each background engine's last run and failures, this workspace's queues, the errors browsers reported here today, and slow database queries."
      >
        <Button size="sm" variant="outline" onClick={() => { void q.refetch(); }} disabled={q.isFetching}>
          <RefreshCw className="size-3.5 mr-1.5" aria-hidden="true" /> Refresh
        </Button>
      </PageHeader>

      <div className="p-4 md:p-6 space-y-6">
        {q.error && !data ? (
          <QueryError what="engine status" message={q.error.message} onRetry={() => { void q.refetch(); }} />
        ) : !data ? (
          <TableSkeleton />
        ) : (
          <>
            {q.error && <QueryError compact what="the latest engine status" message={q.error.message} onRetry={() => { void q.refetch(); }} />}

            <Section title="Engines">
              <p className="text-xs text-muted-foreground mb-2">Since the server last started. An engine that has not ticked yet says so.</p>
              {data.engines.length === 0 ? (
                <EmptyState title="No engine has started in this process yet" />
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-muted-foreground bg-muted/40">
                      <tr>
                        <th className="text-left px-3 py-2">Engine</th>
                        <th className="text-left px-3 py-2">State</th>
                        <th className="text-left px-3 py-2">Last run</th>
                        <th className="text-right px-3 py-2">Took</th>
                        <th className="text-left px-3 py-2">Last success</th>
                        <th className="text-right px-3 py-2">Runs</th>
                        <th className="text-right px-3 py-2">Failures</th>
                        <th className="text-right px-3 py-2">Overlaps skipped</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {data.engines.map((e) => {
                        const health = HEALTH_BADGE[engineHealth(e)];
                        return (
                          <tr key={e.name} className="align-top">
                            <td className="px-3 py-2 font-medium">
                              {e.name}
                              {e.lastError && <div className="text-xs text-destructive mt-0.5 break-words">{e.lastError}</div>}
                            </td>
                            <td className="px-3 py-2"><Badge variant={health.variant}>{health.label}</Badge></td>
                            <td className="px-3 py-2">{ago(e.lastStartedAt)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{e.lastDurationMs == null ? "—" : `${(e.lastDurationMs / 1000).toFixed(1)} s`}</td>
                            <td className="px-3 py-2">{ago(e.lastOkAt)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{num(e.runs)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{e.failures > 0 ? `${e.failures} (${e.consecutiveFailures} in a row)` : "0"}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{num(e.skipped)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            <Section title="Queues in this workspace">
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground bg-muted/40">
                    <tr>
                      <th className="text-left px-3 py-2">Queue</th>
                      <th className="text-right px-3 py-2">Waiting</th>
                      <th className="text-right px-3 py-2">Due now</th>
                      <th className="text-right px-3 py-2">Stuck</th>
                      <th className="text-right px-3 py-2">Failed today</th>
                      <th className="text-left px-3 py-2">Oldest due</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.queues.map((row) => (
                      <tr key={row.key}>
                        <td className="px-3 py-2">
                          <div className="font-medium">{row.label}</div>
                          <div className="text-xs text-muted-foreground">Drained by {row.drainedBy}</div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(row.waiting)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(row.dueNow)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${row.stuck ? "text-destructive font-medium" : ""}`}>{num(row.stuck)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${row.failed24h ? "text-destructive font-medium" : ""}`}>{num(row.failed24h)}</td>
                        <td className="px-3 py-2">{row.oldestDueAt ? ago(row.oldestDueAt) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section title="Automatic tasks today">
              <p className="text-xs text-muted-foreground mb-2">Each source files at most its daily cap (set on the Tasks page); more wait for tomorrow and are counted here.</p>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground bg-muted/40">
                    <tr>
                      <th className="text-left px-3 py-2">Source</th>
                      <th className="text-right px-3 py-2">Filed</th>
                      <th className="text-right px-3 py-2">Cap</th>
                      <th className="text-right px-3 py-2">Held back</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.autoTasks.map((t) => (
                      <tr key={t.source}>
                        <td className="px-3 py-2">{t.label}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(t.filed)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(t.cap)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums ${t.skipped ? "text-destructive font-medium" : ""}`}>{num(t.skipped)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section title={`Browser errors today (${data.clientErrors.total})`}>
              {data.clientErrors.groups.length === 0 ? (
                <p className="text-sm text-muted-foreground">No errors reported from this workspace in the last day.</p>
              ) : (
                <ul className="space-y-2">
                  {data.clientErrors.groups.map((g) => (
                    <li key={`${g.kind}:${g.message}`} className="rounded-lg border p-3 text-sm">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="size-4 text-destructive shrink-0 mt-0.5" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium break-words">{g.message}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {g.count} × {g.kind} · last {ago(g.lastAt)}{g.path ? ` · on ${g.path}` : ""}
                          </div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Slow database queries">
              <p className="text-sm">
                {data.slowQueries.slow.toLocaleString()} {data.slowQueries.slow === 1 ? "query" : "queries"} over {data.slowQueries.thresholdMs} ms since the server started
                {data.slowQueries.slow > 0 ? `; the slowest took ${(data.slowQueries.slowestMs / 1000).toFixed(1)} s` : ""}.
                <span className="text-muted-foreground"> {Math.round(data.slowQueries.sampleRate * 100)}% of them are logged.</span>
              </p>
              {data.slowQueries.samples.length > 0 && (
                <ul className="mt-2 space-y-1.5">
                  {data.slowQueries.samples.slice(0, 20).map((s, i) => (
                    <li key={i} className="text-xs font-mono rounded border bg-muted/30 p-2 break-all">
                      <span className="text-destructive font-sans font-medium mr-2">{s.ms} ms</span>{s.sql}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>
    </Shell>
  );
}
