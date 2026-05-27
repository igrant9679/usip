/**
 * /discovery-logs — workspace-wide history of every prospect-discovery
 * run (sibling to the ARE Logs tab, which is campaign-bound).
 *
 * Layout:
 *   - List of runs (newest first), each collapsible to reveal:
 *       • the structured search input
 *       • per-source counts + duration
 *       • the full per-step trace from discovery_logs
 *       • jump-off links to the run's raw_finds and to the
 *         prospects produced/touched by the run.
 *   - Top filter strip (status, mode).
 */
import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  ScrollText,
  ChevronRight,
  ChevronDown,
  User,
  Building2,
  Loader2,
  Clock,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

function tierBreakdown(r: any) {
  return `${r.highConfidenceCount} high · ${r.mediumConfidenceCount} med · ${r.lowConfidenceCount} low`;
}

function StatusBadge({ status }: { status: string }) {
  const c =
    status === "complete" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" :
    status === "failed"   ? "bg-red-500/15 text-red-700 dark:text-red-400" :
                            "bg-amber-500/15 text-amber-700 dark:text-amber-400";
  return <Badge className={`text-[10px] ${c}`}>{status}</Badge>;
}

export default function DiscoveryLogs() {
  const utils = trpc.useUtils();
  const { data: runs = [], isLoading, refetch } = trpc.discovery.listRuns.useQuery({ limit: 100 });
  const [openId, setOpenId] = useState<number | null>(null);
  const reprocess = trpc.discovery.reprocess.useMutation({
    onSuccess: () => { toast.success("Re-scored"); refetch(); utils.prospects.list.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Shell title="Discovery Logs">
      <PageHeader
        title="Discovery Logs"
        description="Every prospect-discovery run for this workspace: structured input, sources hit, raw finds, confidence breakdown, and the full per-step trace."
        pageKey="discovery-logs"
        icon={<ScrollText className="size-5" />}
      >
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-1.5">
          <RefreshCw className="size-3.5" /> Refresh
        </Button>
      </PageHeader>

      <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-3">
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-12 text-center">
            <Loader2 className="size-4 animate-spin inline mr-2" /> Loading runs…
          </div>
        ) : runs.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              No discovery runs yet — start one from <Link href="/find-prospects"><span className="underline">Find Prospects</span></Link>.
            </CardContent>
          </Card>
        ) : (
          runs.map((r: any) => (
            <RunCard
              key={r.id}
              run={r}
              open={openId === r.id}
              onToggle={() => setOpenId(openId === r.id ? null : r.id)}
              onReprocess={() => reprocess.mutate({ runId: r.id })}
              reprocessing={reprocess.isPending}
            />
          ))
        )}
      </div>
    </Shell>
  );
}

/* ─── One run card with expandable detail ───────────────────────────── */
function RunCard({ run, open, onToggle, onReprocess, reprocessing }: {
  run: any; open: boolean; onToggle: () => void; onReprocess: () => void; reprocessing: boolean;
}) {
  const ModeIcon = run.mode === "person" ? User : Building2;
  return (
    <Card>
      <button type="button" onClick={onToggle} className="w-full text-left">
        <CardContent className="p-3 sm:p-4 flex items-center gap-3 hover:bg-muted/30 transition-colors">
          {open ? <ChevronDown className="size-4 text-muted-foreground shrink-0" /> : <ChevronRight className="size-4 text-muted-foreground shrink-0" />}
          <div className="size-8 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: run.mode === "person" ? "#A78BFA22" : "#34D39922" }}>
            <ModeIcon className="size-4" style={{ color: run.mode === "person" ? "#A78BFA" : "#34D399" }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">Run #{run.id}</span>
              <StatusBadge status={run.status} />
              <Badge variant="outline" className="text-[10px]">{run.mode}</Badge>
              {run.errorMessage && (
                <Badge variant="outline" className="text-[10px] border-destructive/40 text-destructive gap-1">
                  <AlertCircle className="size-2.5" /> error
                </Badge>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {run.rawFindCount} raw · {run.prospectsCreated} new prospects · {tierBreakdown(run)} ·
              <span className="ml-1 inline-flex items-center gap-1"><Clock className="size-2.5" /> {run.durationMs}ms</span>
            </div>
          </div>
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 hidden sm:inline">
            {new Date(run.startedAt).toLocaleString()}
          </span>
        </CardContent>
      </button>
      {open && <RunDetail run={run} onReprocess={onReprocess} reprocessing={reprocessing} />}
    </Card>
  );
}

/* ─── Expanded run detail (input, logs, jump-offs) ──────────────────── */
function RunDetail({ run, onReprocess, reprocessing }: { run: any; onReprocess: () => void; reprocessing: boolean }) {
  const { data: logs = [] } = trpc.discovery.getLogs.useQuery({ runId: run.id, limit: 300 });
  const { data: rawFinds = [] } = trpc.discovery.getRawFinds.useQuery({ runId: run.id, limit: 10 });
  const { data: prospectsForRun } = trpc.prospects.list.useQuery({ discoveryRunId: run.id, perPage: 50, page: 1 });

  const input = (run.input ?? {}) as Record<string, unknown>;
  const inputEntries = Object.entries(input).filter(([, v]) => v != null && (Array.isArray(v) ? v.length > 0 : String(v).trim() !== ""));

  return (
    <div className="border-t bg-muted/20">
      <div className="p-4 space-y-4">
        {/* Search input */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Search input</div>
          {inputEntries.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">(empty)</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {inputEntries.map(([k, v]) => (
                <Badge key={k} variant="outline" className="text-[10px]">
                  <span className="text-muted-foreground mr-1">{k}:</span>
                  <span>{Array.isArray(v) ? v.join(", ") : String(v)}</span>
                </Badge>
              ))}
            </div>
          )}
        </div>

        {/* Action row */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onReprocess} disabled={reprocessing} className="gap-1.5 text-xs">
            <RefreshCw className="size-3" /> Re-score from raw finds
          </Button>
          {prospectsForRun && prospectsForRun.total > 0 && (
            <Badge variant="outline" className="text-[11px] gap-1">
              <CheckCircle2 className="size-3 text-emerald-500" /> {prospectsForRun.total} prospect{prospectsForRun.total === 1 ? "" : "s"} from this run
            </Badge>
          )}
        </div>

        {/* Per-step trace */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Per-step trace</div>
          <div className="text-[11px] font-mono space-y-0.5 max-h-72 overflow-y-auto border rounded p-2 bg-card">
            {logs.length === 0 ? (
              <div className="text-muted-foreground italic">No log entries.</div>
            ) : (
              logs.map((l: any) => (
                <div key={l.id} className="flex gap-2 items-start">
                  <span className="text-muted-foreground shrink-0 tabular-nums">{new Date(l.createdAt).toLocaleTimeString()}</span>
                  <span className={`shrink-0 ${l.level === "error" ? "text-red-500" : l.level === "warn" ? "text-amber-500" : "text-emerald-500"}`}>[{l.phase}]</span>
                  <span className="break-words">{l.message}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Raw finds preview */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
            Raw finds preview ({rawFinds.length} of {run.rawFindCount})
          </div>
          {rawFinds.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">No raw finds for this run.</div>
          ) : (
            <div className="space-y-1.5">
              {rawFinds.map((f: any) => (
                <div key={f.id} className="text-[11px] border rounded p-2 bg-card flex items-start gap-2">
                  <Badge variant="outline" className="text-[10px] shrink-0">{f.source}</Badge>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {[f.firstName, f.lastName].filter(Boolean).join(" ") || f.companyName || "(no identity)"}
                      {f.title && <span className="text-muted-foreground font-normal"> · {f.title}</span>}
                      {f.companyName && f.firstName && <span className="text-muted-foreground font-normal"> · {f.companyName}</span>}
                    </div>
                    {f.sourceUrl && (
                      <a href={f.sourceUrl} target="_blank" rel="noopener noreferrer"
                         className="text-muted-foreground hover:text-foreground hover:underline inline-flex items-center gap-1 truncate max-w-full">
                        <ExternalLink className="size-2.5" /> <span className="truncate">{f.sourceUrl}</span>
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Prospects produced */}
        {prospectsForRun && prospectsForRun.data.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Prospects from this run
            </div>
            <div className="space-y-1">
              {prospectsForRun.data.slice(0, 10).map((p: any) => (
                <Link key={p.id} href={`/prospects/${p.id}`}>
                  <div className="text-[11px] border rounded p-2 bg-card hover:border-primary/30 cursor-pointer flex items-center gap-2">
                    <span className="font-medium flex-1 truncate">{p.firstName} {p.lastName} <span className="text-muted-foreground font-normal">· {p.title ?? "—"}</span></span>
                    <Badge variant="outline" className="text-[10px]">{p.confidenceScore ?? "—"}/100 {p.confidenceTier ?? ""}</Badge>
                    <Badge variant="outline" className="text-[10px]">{p.verificationStatus ?? "—"}</Badge>
                    <ChevronRight className="size-3 text-muted-foreground" />
                  </div>
                </Link>
              ))}
              {prospectsForRun.total > 10 && (
                <div className="text-[11px] text-muted-foreground text-center pt-1">
                  +{prospectsForRun.total - 10} more — see Prospects list
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
