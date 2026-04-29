import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Field, fmt$, FormDialog, SelectField } from "@/components/usip/Common";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { trpc } from "@/lib/trpc";
import { ArrowRight, Brain, Download, Loader2, Plus, TrendingUp, Zap, Filter, X, User, KanbanSquare, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const STAGES = [
  { id: "discovery", label: "Discovery" },
  { id: "qualified", label: "Qualified" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
] as const;

const STAGE_COLORS: Record<string, string> = {
  discovery: "bg-slate-400",
  qualified: "bg-blue-400",
  proposal: "bg-violet-400",
  negotiation: "bg-amber-400",
  won: "bg-emerald-500",
  lost: "bg-red-400",
};

function WinProbBadge({ prob, aiGenerated }: { prob: number; aiGenerated?: boolean }) {
  const color =
    prob >= 70
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
      : prob >= 40
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
      : "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300";
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-1.5 py-0.5 rounded-full ${color}`}>
      {aiGenerated && <Brain className="size-2.5" />}
      {prob}%
    </span>
  );
}

function DealCard({
  opp, intel, onOpen, onAnalyze, isAnalyzing, onAcceptStage, isAccepting,
}: {
  opp: any; intel: any | null; onOpen: () => void;
  onAnalyze: (e: React.MouseEvent) => void; isAnalyzing: boolean;
  onAcceptStage: (e: React.MouseEvent, toStage: string) => void; isAccepting: boolean;
}) {
  const winProb = intel ? Math.round(Number(intel.winProbability)) : opp.winProb;
  const nba: any[] = (intel?.nextBestActions as any) ?? [];
  const topNba = nba[0] ?? null;
  // Only show suggestion if it's a different stage from current and not won/lost
  const suggestedStage: string | null = intel?.suggestedStage ?? null;
  const showStageSuggestion =
    suggestedStage &&
    suggestedStage !== opp.stage &&
    suggestedStage !== "won" &&
    suggestedStage !== "lost";
  const stageLabel = (id: string) => STAGES.find((s) => s.id === id)?.label ?? id;

  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", String(opp.id))}
      onClick={onOpen}
      className="bg-card border rounded-lg p-3 cursor-pointer hover:shadow-md hover:border-[#14B89A] transition-all group"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{opp.name}</div>
          <div className="text-[11px] text-muted-foreground truncate mt-0.5">{opp.accountName}</div>
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onAnalyze}
                disabled={isAnalyzing}
                className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted"
              >
                {isAnalyzing ? (
                  <Loader2 className="size-3 animate-spin text-muted-foreground" />
                ) : (
                  <Brain className="size-3 text-muted-foreground" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {isAnalyzing ? "Analyzing..." : "Run AI analysis"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      <div className="flex items-center justify-between mt-2">
        <div className="font-mono text-sm tabular-nums whitespace-nowrap">{fmt$(Number(opp.value))}</div>
        <WinProbBadge prob={winProb} aiGenerated={!!intel} />
      </div>

      {intel?.winProbabilityRationale && (
        <p className="text-[10px] text-muted-foreground mt-1.5 line-clamp-2 leading-relaxed">
          {intel.winProbabilityRationale}
        </p>
      )}

      {topNba && (
        <div className="mt-2 pt-2 border-t border-dashed">
          <div className="flex items-start gap-1.5">
            <Zap
              className={`size-3 mt-0.5 shrink-0 ${
                topNba.priority === "high" ? "text-red-500"
                  : topNba.priority === "medium" ? "text-amber-500"
                  : "text-blue-500"
              }`}
            />
            <p className="text-[10px] text-foreground/80 line-clamp-2 leading-relaxed">{topNba.action}</p>
          </div>
        </div>
      )}

      {!intel && (
        <p className="text-[10px] text-muted-foreground/60 mt-2 italic">No AI analysis yet</p>
      )}

      {showStageSuggestion && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className="mt-2 pt-2 border-t border-dashed flex items-center justify-between gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center gap-1 min-w-0">
                  <Brain className="size-3 shrink-0 text-violet-500" />
                  <span className="text-[10px] text-violet-700 dark:text-violet-300 font-medium truncate">
                    AI suggests: {stageLabel(suggestedStage!)}
                  </span>
                </div>
                <button
                  onClick={(e) => onAcceptStage(e, suggestedStage!)}
                  disabled={isAccepting}
                  className="shrink-0 flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:hover:bg-violet-900/70 transition-colors disabled:opacity-50"
                >
                  {isAccepting ? <Loader2 className="size-2.5 animate-spin" /> : <ArrowRight className="size-2.5" />}
                  Accept
                </button>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs max-w-[220px]">
              {intel?.suggestedStageRationale || "AI recommends advancing this deal."}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

/* ─── Forecast View ─────────────────────────────────────────────────────── */
function ForecastView() {
  const [selectedStages, setSelectedStages] = useState<string[]>([]);
  const [commentary, setCommentary] = useState<string | null>(null);
  const commentaryMut = trpc.forecastAi.generateCommentary.useMutation({
    onSuccess: (r) => setCommentary(r.commentary),
    onError: (e: any) => toast.error(e.message),
  });
  // Unfiltered query to always have the full availableStages list for the filter UI
  const { data: allFc } = trpc.opportunities.forecast.useQuery(undefined);
  const availableStages = allFc?.availableStages ?? [];
  // Filtered query — passes selectedStages only when at least one is chosen
  const { data: fc, isLoading } = trpc.opportunities.forecast.useQuery(
    selectedStages.length > 0 ? { stages: selectedStages } : undefined
  );

  function toggleStage(stage: string) {
    setSelectedStages((prev) =>
      prev.includes(stage) ? prev.filter((s) => s !== stage) : [...prev, stage]
    );
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (!fc) return null;

  const { grandTotal, grandWeighted, months, stages } = fc;
  const coverageRatio = grandTotal > 0 ? Math.round((grandWeighted / grandTotal) * 100) : 0;
  const maxMonthWeighted = Math.max(...months.map((m) => m.weighted), 1);

  const fmtMonth = (key: string) => {
    if (key === "no-date") return "No close date";
    const [y, m] = key.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleString("default", { month: "short", year: "numeric" });
  };

  const stageLabel = (id: string) => STAGES.find((s) => s.id === id)?.label ?? id;

  return (
    <div className="p-6 space-y-6">
      {/* Stage filter toolbar */}
      {availableStages.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <Filter className="size-3" /> Filter by stage:
          </span>
          {availableStages.map((stage) => {
            const active = selectedStages.includes(stage);
            return (
              <button
                key={stage}
                onClick={() => toggleStage(stage)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-all ${
                  active
                    ? "bg-[#14B89A] text-white border-[#14B89A]"
                    : "bg-background border-border text-muted-foreground hover:border-[#14B89A] hover:text-foreground"
                }`}
              >
                <span
                  className={`size-2 rounded-full inline-block ${STAGE_COLORS[stage] ?? "bg-muted"}`}
                />
                {stageLabel(stage)}
                {active && <X className="size-2.5 ml-0.5" />}
              </button>
            );
          })}
          {selectedStages.length > 0 && (
            <button
              onClick={() => setSelectedStages([])}
              className="text-xs text-muted-foreground hover:text-foreground underline ml-1"
            >
              Clear all
            </button>
          )}
        </div>
      )}
      {/* KPI row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: "Total Pipeline", value: fmt$(grandTotal), sub: "excl. lost" },
          { label: "Weighted Forecast", value: fmt$(grandWeighted), sub: "probability-adjusted" },
          { label: "Coverage Ratio", value: `${coverageRatio}%`, sub: "weighted / total" },
          { label: "Open Deals", value: String(stages.reduce((s, st) => s + st.count, 0)), sub: "across all stages" },
        ].map(({ label, value, sub }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
              <p className="text-2xl font-bold tabular-nums mt-1">{value}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Stage funnel */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground mb-3">Stage Funnel</h3>
        <div className="space-y-2">
          {STAGES.filter((s) => s.id !== "lost").map((s) => {
            const st = stages.find((x) => x.stage === s.id);
            if (!st) return null;
            const pct = grandTotal > 0 ? Math.round((st.total / grandTotal) * 100) : 0;
            return (
              <div key={s.id} className="flex items-center gap-3 text-sm">
                <span className="w-28 text-xs text-muted-foreground shrink-0">{s.label}</span>
                <div className="flex-1 bg-muted rounded-full h-3 overflow-hidden">
                  <div
                    className={`h-3 rounded-full transition-all ${STAGE_COLORS[s.id] ?? "bg-primary"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-20 text-xs tabular-nums text-right shrink-0">{fmt$(st.total)}</span>
                <span className="w-12 text-xs tabular-nums text-right text-muted-foreground shrink-0">{pct}%</span>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0">{st.count}</Badge>
              </div>
            );
          })}
        </div>
      </div>

      {/* Monthly close projection */}
      {months.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground mb-3">Monthly Close Projection (weighted)</h3>
          <div className="space-y-2">
            {months.map((m) => {
              const barPct = Math.round((m.weighted / maxMonthWeighted) * 100);
              return (
                <div key={m.month} className="flex items-center gap-3 text-sm">
                  <span className="w-28 text-xs text-muted-foreground shrink-0 font-mono">{fmtMonth(m.month)}</span>
                  <div className="flex-1 bg-muted rounded-full h-3 overflow-hidden">
                    <div
                      className="h-3 rounded-full bg-[#14B89A] transition-all"
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                  <span className="w-24 text-xs tabular-nums text-right shrink-0">{fmt$(m.weighted)}</span>
                  <span className="w-16 text-xs tabular-nums text-right text-muted-foreground shrink-0">
                    total {fmt$(m.total)}
                  </span>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0">{m.count}</Badge>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {months.length === 0 && stages.length === 0 && (
        <div className="text-center py-16 text-muted-foreground text-sm">
          <TrendingUp className="size-10 mx-auto mb-3 opacity-30" />
          No open opportunities to forecast. Add deals with close dates to see projections.
        </div>
      )}

      {/* AI Forecast Commentary */}
      <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 text-sm font-medium text-violet-800">
            <Sparkles className="size-4" />
            AI Forecast Commentary
          </div>
          <Button size="sm" variant="outline" onClick={() => commentaryMut.mutate({})} disabled={commentaryMut.isPending}>
            {commentaryMut.isPending ? <><Loader2 className="size-3.5 animate-spin" /> Generating…</> : "Generate"}
          </Button>
        </div>
        {commentary ? (
          <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{commentary}</p>
        ) : (
          <p className="text-xs text-muted-foreground italic">Click Generate to get an AI-written narrative summary of your current pipeline health, top risks, and recommended actions to hit quota.</p>
        )}
      </div>
    </div>
  );
}

/* ─── Main Page ─────────────────────────────────────────────────────────── */
export default function Pipeline() {
  const utils = trpc.useUtils();
  const [location, navigate] = useLocation();
  // Parse optional ?owner=<userId> from the URL for rep drill-down from Dashboard
  const ownerUserId = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("owner");
    return v ? Number(v) : undefined;
  }, [location]);
  const { data } = trpc.opportunities.board.useQuery(ownerUserId ? { ownerUserId } : undefined);
  const { data: accounts } = trpc.accounts.list.useQuery();
  const { data: boardIntel = [] } = trpc.oppIntelligence.getIntelligenceForBoard.useQuery();

  const intelMap = useMemo(() => {
    const m = new Map<number, any>();
    boardIntel.forEach((i) => m.set(i.opportunityId, i));
    return m;
  }, [boardIntel]);

  const [analyzingIds, setAnalyzingIds] = useState<Set<number>>(new Set());
  const [acceptingIds, setAcceptingIds] = useState<Set<number>>(new Set());
  const [view, setView] = useState<"board" | "forecast">("board");

  const generateIntel = trpc.oppIntelligence.generateIntelligence.useMutation({
    onSuccess: (_data, vars) => {
      utils.oppIntelligence.getIntelligenceForBoard.invalidate();
      utils.opportunities.board.invalidate();
      setAnalyzingIds((prev) => { const next = new Set(prev); next.delete(vars.opportunityId); return next; });
      toast.success("AI analysis complete");
    },
    onError: (e, vars) => {
      setAnalyzingIds((prev) => { const next = new Set(prev); next.delete(vars.opportunityId); return next; });
      toast.error(e.message);
    },
  });

  const handleAnalyze = (e: React.MouseEvent, opportunityId: number) => {
    e.stopPropagation();
    setAnalyzingIds((prev) => new Set(prev).add(opportunityId));
    generateIntel.mutate({ opportunityId });
  };

  const requestStageChange = trpc.oppIntelligence.requestStageChange.useMutation({
    onSuccess: (_data, vars) => {
      utils.opportunities.board.invalidate();
      utils.oppIntelligence.getIntelligenceForBoard.invalidate();
      setAcceptingIds((prev) => { const next = new Set(prev); next.delete(vars.opportunityId); return next; });
      toast.success("Stage change submitted for approval");
    },
    onError: (e, vars) => {
      setAcceptingIds((prev) => { const next = new Set(prev); next.delete(vars.opportunityId); return next; });
      toast.error(e.message);
    },
  });

  const handleAcceptStage = (e: React.MouseEvent, opportunityId: number, toStage: string) => {
    e.stopPropagation();
    setAcceptingIds((prev) => new Set(prev).add(opportunityId));
    requestStageChange.mutate({ opportunityId, toStage, note: "Accepted AI stage suggestion" });
  };

  const setStage = trpc.opportunities.setStage.useMutation({
    onMutate: async ({ id, stage }) => {
      await utils.opportunities.board.cancel();
      const prev = utils.opportunities.board.getData();
      utils.opportunities.board.setData(undefined, (old) => (old ?? []).map((o) => (o.id === id ? { ...o, stage } : o)));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) utils.opportunities.board.setData(undefined, ctx.prev); toast.error("Move failed"); },
    onSettled: () => utils.opportunities.board.invalidate(),
  });

  const [addOpen, setAddOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ id: number; name: string; subtitle: string } | null>(null);

  const create = trpc.opportunities.create.useMutation({
    onSuccess: () => { utils.opportunities.board.invalidate(); setAddOpen(false); toast.success("Opportunity created"); },
  });

  const grouped = useMemo(() => {
    const buckets: Record<string, typeof data> = {};
    STAGES.forEach((s) => (buckets[s.id] = []));
    (data ?? []).forEach((o) => buckets[o.stage]?.push(o));
    return buckets;
  }, [data]);

  return (
    <Shell title="Pipeline">
      {ownerUserId && (
        <div className="mx-6 mt-4 flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-2 text-sm">
          <User className="size-4 text-amber-400" />
          <span className="text-amber-700 dark:text-amber-300 font-medium">Showing deals for one rep.</span>
          <button
            onClick={() => navigate("/pipeline")}
            className="ml-auto flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 hover:underline"
          >
            <X className="size-3" /> Clear filter
          </button>
        </div>
      )}
      <PageHeader title="Pipeline" description="Visualise and advance open opportunities across every stage of your sales funnel. Drag deals between stages, set close dates, and get AI-powered next-step recommendations." pageKey="pipeline"
        icon={<KanbanSquare className="size-5" />}
      >
        {/* View toggle */}
        <div className="flex items-center border rounded-md overflow-hidden text-sm">
          {(["board", "forecast"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1.5 capitalize transition-colors ${
                view === v
                  ? "bg-[#14B89A] text-white font-semibold"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {v === "forecast" ? <><TrendingUp className="size-3 inline mr-1" />Forecast</> : "Board"}
            </button>
          ))}
        </div>
        <Button variant="outline" onClick={() => {
          const rows = data ?? [];
          if (!rows.length) return;
          const cols = ["id", "name", "stage", "value", "winProb", "closeDate", "accountName", "createdAt"];
          const lines = [cols.join(","), ...rows.map((r: any) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))];
          const blob = new Blob([lines.join("\n")], { type: "text/csv" });
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `pipeline-${Date.now()}.csv`; a.click();
        }} disabled={!data?.length}>
          <Download className="size-4" /> Export CSV
        </Button>
        <Button onClick={() => setAddOpen(true)}><Plus className="size-4" /> New opportunity</Button>
      </PageHeader>

      {view === "forecast" ? (
        <ForecastView />
      ) : (
        <div className="p-4 overflow-x-auto">
          <div className="flex gap-3 min-w-max">
            {STAGES.map((s) => {
              const items = grouped[s.id] ?? [];
              const total = items.reduce((sum, o) => sum + Number(o.value ?? 0), 0);
              const avgProb = items.length > 0
                ? Math.round(items.reduce((sum, o) => {
                    const intel = intelMap.get(o.id);
                    return sum + (intel ? Math.round(Number(intel.winProbability)) : o.winProb);
                  }, 0) / items.length)
                : null;
              return (
                <div
                  key={s.id}
                  className="w-72 shrink-0 bg-secondary/40 border rounded-lg flex flex-col"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    const id = Number(e.dataTransfer.getData("text/plain"));
                    if (id) setStage.mutate({ id, stage: s.id });
                  }}
                >
                  <div className="px-3 py-2 border-b flex items-center gap-2">
                    <div className="text-sm font-medium">{s.label}</div>
                    <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{items.length} · {fmt$(total)}</span>
                      {avgProb !== null && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">avg {avgProb}%</Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 p-2 space-y-2 min-h-[60vh]">
                    {items.map((o) => (
                      <DealCard
                        key={o.id}
                        opp={o}
                        intel={intelMap.get(o.id) ?? null}
                        onOpen={() => setDrawer({
                          id: o.id,
                          name: o.name,
                          subtitle: `${o.accountName} · ${fmt$(Number(o.value))} · ${
                            intelMap.get(o.id)
                              ? `${Math.round(Number(intelMap.get(o.id)!.winProbability))}% (AI)`
                              : `${o.winProb}%`
                          }`,
                        })}
                        onAnalyze={(e) => handleAnalyze(e, o.id)}
                        isAnalyzing={analyzingIds.has(o.id)}
                        onAcceptStage={(e, toStage) => handleAcceptStage(e, o.id, toStage)}
                        isAccepting={acceptingIds.has(o.id)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <FormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="New opportunity"
        isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          name: String(f.get("name")),
          accountId: Number(f.get("accountId")),
          value: Number(f.get("value")),
          stage: f.get("stage") as any,
          winProb: Number(f.get("winProb") ?? 25),
        })}
      >
        <Field name="name" label="Name" required />
        <SelectField
          name="accountId"
          label="Account"
          options={(accounts ?? []).map((a) => ({ value: String(a.id), label: a.name }))}
        />
        <div className="grid grid-cols-3 gap-3">
          <Field name="value" label="Value ($)" type="number" required defaultValue={10000} />
          <SelectField name="stage" label="Stage" options={STAGES.map((s) => ({ value: s.id, label: s.label }))} defaultValue="discovery" />
          <Field name="winProb" label="Win %" type="number" defaultValue={25} />
        </div>
      </FormDialog>

      <RecordDrawer
        open={!!drawer}
        onOpenChange={(v) => !v && setDrawer(null)}
        relatedType="opportunity"
        relatedId={drawer?.id ?? null}
        title={drawer?.name ?? ""}
        subtitle={drawer?.subtitle}
      />
    </Shell>
  );
}
