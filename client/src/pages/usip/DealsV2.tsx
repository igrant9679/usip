/**
 * DealsV2 — the Win-deals → "Deals" surface (/v2/deals).
 *
 * A pipeline kanban plus the AI **Deal Autopilot**: the autonomous pipeline
 * manager that keeps open deals moving (AI next-step + win-prob, and in auto
 * mode a follow-up task per deal). Reuses the existing opportunities / crm
 * pipeline / pipelineAlerts / forecastAi routers — this page only adds the
 * autonomy layer (deals.* ) on top. The classic editor stays at /pipeline.
 */
import { useMemo } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  KanbanSquare, Bot, Zap, Sparkles, TrendingUp, AlertTriangle, MoreHorizontal, ExternalLink, Building2, ArrowRight,
} from "lucide-react";

type Opp = {
  id: number;
  name: string;
  accountId?: number | null;
  accountName?: string | null;
  stage: string;
  value?: number | string | null;
  winProb?: number | null;
  nextStep?: string | null;
  closeDate?: string | Date | null;
  ownerUserId?: number | null;
};

type Stage = { key: string; label: string; sortOrder?: number; isWon?: boolean; isLost?: boolean };

const LEGACY_STAGES: Stage[] = [
  { key: "discovery", label: "Discovery" },
  { key: "qualified", label: "Qualified" },
  { key: "proposal", label: "Proposal" },
  { key: "negotiation", label: "Negotiation" },
  { key: "won", label: "Won", isWon: true },
  { key: "lost", label: "Lost", isLost: true },
];

const MODE_META: Record<string, { label: string; blurb: string }> = {
  off: { label: "Autopilot off", blurb: "AI won't touch your deals." },
  approval: { label: "Autopilot: Approve", blurb: "AI writes a recommended next step + win probability on each open deal for you to act on." },
  auto: { label: "Autopilot: Autonomous", blurb: "AI also creates the follow-up task on each open deal so nothing stalls." },
};

function money(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return "$0";
  if (n >= 1000) return "$" + (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k";
  return "$" + n.toFixed(0);
}

export default function DealsV2() {
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  const board = trpc.opportunities.board.useQuery({});
  const pipe = trpc.crmPipelines.get.useQuery({} as any);
  const autopilot = trpc.deals.getAutopilotSettings.useQuery();
  const alerts = trpc.pipelineAlerts.list.useQuery(undefined as any, { retry: false });
  const commentary = trpc.forecastAi.getCommentary.useQuery(undefined as any, { retry: false });

  const setMode = trpc.deals.setAutopilotSettings.useMutation({
    onSuccess: () => { utils.deals.getAutopilotSettings.invalidate(); toast.success("Autopilot updated"); },
    onError: (e) => toast.error(e.message.includes("FORBIDDEN") ? "Only admins can change Autopilot" : e.message),
  });
  const analyze = trpc.deals.analyzeAll.useMutation({
    onSuccess: (r) => { utils.opportunities.board.invalidate(); toast.success(r.analyzed === 0 ? "No open deals to analyze" : `AI analyzed ${r.analyzed} deal${r.analyzed === 1 ? "" : "s"}`); },
    onError: (e) => toast.error(e.message),
  });
  const setStage = trpc.opportunities.setStage.useMutation({
    onSuccess: () => utils.opportunities.board.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const mode = autopilot.data?.mode ?? "off";
  const opps = (board.data ?? []) as Opp[];

  // Stage columns: prefer the workspace pipeline's stages; fall back to legacy;
  // then append any stage present in the data that isn't already a column.
  const stages: Stage[] = useMemo(() => {
    const raw: any = pipe.data;
    let list: Stage[] = raw?.stages ?? raw?.pipeline?.stages ?? [];
    if (!Array.isArray(list) || list.length === 0) list = LEGACY_STAGES;
    list = [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const known = new Set(list.map((s) => s.key));
    for (const o of opps) {
      if (o.stage && !known.has(o.stage)) { list.push({ key: o.stage, label: o.stage }); known.add(o.stage); }
    }
    return list;
  }, [pipe.data, opps]);

  const byStage = useMemo(() => {
    const m: Record<string, Opp[]> = {};
    for (const o of opps) (m[o.stage] ??= []).push(o);
    return m;
  }, [opps]);

  const openOpps = opps.filter((o) => o.stage !== "won" && o.stage !== "lost");
  const totalValue = openOpps.reduce((s, o) => s + Number(o.value ?? 0), 0);
  const weighted = openOpps.reduce((s, o) => s + Number(o.value ?? 0) * (Number(o.winProb ?? 0) / 100), 0);
  const wonCount = opps.filter((o) => o.stage === "won").length;
  const activeAlerts = (alerts.data as any[])?.filter?.((a) => !a.dismissedAt) ?? (alerts.data as any[]) ?? [];

  const StatCard = ({ label, value, tone }: { label: string; value: string | number; tone?: "good" | "warn" }) => {
    const color = tone === "good" ? "#059669" : tone === "warn" ? "#d97706" : accent;
    return (
      <div className="rounded-lg border bg-card p-3 shadow-sm" style={{ borderLeft: `3px solid ${color}` }}>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums mt-0.5" style={{ color }}>{value}</div>
      </div>
    );
  };

  const Card = ({ o }: { o: Opp }) => (
    <div className="rounded-lg border bg-card p-2.5 shadow-sm space-y-1.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link href={`/opportunities/${o.id}`} className="text-[13px] font-medium truncate block hover:underline">{o.name}</Link>
          {o.accountName && <div className="text-[11px] text-muted-foreground truncate flex items-center gap-1"><Building2 className="size-3" /> {o.accountName}</div>}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-6 shrink-0"><MoreHorizontal className="size-3.5" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Move to stage</DropdownMenuLabel>
            {stages.filter((st) => st.key !== o.stage).map((st) => (
              <DropdownMenuItem key={st.key} onClick={() => setStage.mutate({ id: o.id, stage: st.key })}>
                <ArrowRight className="size-3.5 mr-2" /> {st.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex items-center gap-2 text-[11px]">
        <span className="font-semibold tabular-nums" style={{ color: accent }}>{money(o.value)}</span>
        <span className="rounded px-1.5 py-0.5 bg-secondary text-muted-foreground tabular-nums">{o.winProb ?? 0}%</span>
      </div>
      {o.nextStep && <div className="text-[11px] text-muted-foreground flex items-start gap-1"><Sparkles className="size-3 mt-0.5 shrink-0" style={{ color: "#7c3aed" }} /><span className="line-clamp-2">{o.nextStep}</span></div>}
    </div>
  );

  return (
    <Shell title="Deals">
      <div className="flex flex-col h-full min-h-0">
        {/* Header */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <KanbanSquare className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Deals</h1>
          <div className="flex-1" />
          <Link href="/pipeline" className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mr-1"><ExternalLink className="size-3" /> Classic pipeline</Link>
          <div className="flex items-center gap-1.5">
            <Bot className="size-3.5 text-muted-foreground" />
            <Select value={mode} onValueChange={(v) => setMode.mutate({ mode: v as "off" | "approval" | "auto" })}>
              <SelectTrigger className="h-7 w-[168px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Autopilot: Off</SelectItem>
                <SelectItem value="approval">Autopilot: Approve</SelectItem>
                <SelectItem value="auto">Autopilot: Autonomous</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={analyze.isPending} onClick={() => analyze.mutate({ limit: 15 })}>
            <Sparkles className="size-3.5" /> {analyze.isPending ? "Analyzing…" : "Analyze with AI"}
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-5">
          {/* Autopilot status strip */}
          <div className="rounded-lg border bg-card px-4 py-2.5 flex items-center gap-3 shadow-sm">
            <span className="shrink-0 size-8 rounded-full flex items-center justify-center" style={{ backgroundColor: mode === "off" ? "hsl(var(--muted))" : "#7c3aed1f", color: mode === "off" ? undefined : "#7c3aed" }}>
              {mode === "auto" ? <Zap className="size-4" /> : <Bot className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{MODE_META[mode]?.label}</div>
              <div className="text-[12px] text-muted-foreground">{MODE_META[mode]?.blurb}</div>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Open deals" value={openOpps.length} />
            <StatCard label="Pipeline value" value={money(totalValue)} />
            <StatCard label="Weighted" value={money(weighted)} tone="good" />
            <StatCard label="Won" value={wonCount} tone="good" />
          </div>

          {/* AI forecast commentary */}
          {commentary.data?.commentary && (
            <div className="rounded-lg border bg-card px-4 py-2.5 flex items-start gap-2.5 shadow-sm">
              <TrendingUp className="size-4 mt-0.5 shrink-0" style={{ color: "#7c3aed" }} />
              <div className="text-[12px] text-muted-foreground">{commentary.data.commentary}</div>
            </div>
          )}

          {/* At-risk alerts */}
          {activeAlerts.length > 0 && (
            <div className="rounded-lg border border-amber-300/60 bg-amber-50/50 dark:bg-amber-900/10 px-4 py-2.5 shadow-sm">
              <div className="text-[12px] font-medium flex items-center gap-1.5 text-amber-700 dark:text-amber-300 mb-1"><AlertTriangle className="size-3.5" /> {activeAlerts.length} deal{activeAlerts.length === 1 ? "" : "s"} need attention</div>
              <div className="flex flex-wrap gap-1.5">
                {activeAlerts.slice(0, 6).map((a: any, i: number) => (
                  <span key={a.id ?? i} className="text-[11px] rounded px-1.5 py-0.5 bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                    {a.details?.oppName ?? "Deal"} · {String(a.alertType ?? "").replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Kanban board */}
          {board.isLoading ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-40 rounded-xl bg-muted/50 animate-pulse" />)}</div>
          ) : board.error ? (
            <div className="rounded-xl border bg-card text-center py-12 px-4">
              <p className="text-sm text-muted-foreground">Couldn’t load the pipeline. {board.error.message}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => board.refetch()}>Retry</Button>
            </div>
          ) : opps.length === 0 ? (
            <div className="rounded-xl border bg-card text-center py-14 px-4">
              <KanbanSquare className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
              <div className="text-sm font-medium">No deals yet</div>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">Deals appear here as meetings convert to opportunities. The autopilot keeps them moving toward close.</p>
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-2">
              {stages.map((st) => {
                const list = byStage[st.key] ?? [];
                const colValue = list.reduce((s, o) => s + Number(o.value ?? 0), 0);
                return (
                  <div key={st.key} className="w-64 shrink-0">
                    <div className="flex items-center justify-between px-1 mb-1.5">
                      <div className="text-[12px] font-semibold flex items-center gap-1.5">
                        <span className={cn("size-2 rounded-full", st.isWon ? "bg-emerald-500" : st.isLost ? "bg-rose-400" : "")} style={!st.isWon && !st.isLost ? { backgroundColor: accent } : undefined} />
                        {st.label} <span className="text-muted-foreground font-normal">{list.length}</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground tabular-nums">{money(colValue)}</span>
                    </div>
                    <div className="space-y-2 rounded-xl border bg-muted/20 p-2 min-h-[80px]">
                      {list.map((o) => <Card key={o.id} o={o} />)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
