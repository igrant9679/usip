/**
 * THE deal board (/pipeline) — audit 2026-10-20, U13 and X6.3; batch CONB,
 * 2026-11-08. /v2/deals and this page were two boards over the same deals;
 * /v2/deals folded in here and redirects (lib/retiredRoutes.ts), its file
 * kept, unrouted. What came across: the Deal Autopilot dial and its strip,
 * Analyze with AI, the header numbers, the AI forecast commentary, the
 * at-risk alerts strip (/pipeline#alerts), a Move menu on every card and the
 * won confetti. What is new: owner and close-date filters as controls
 * (?owner=, ?close=), closed columns that collapse, and "Show more" on a
 * closed column, which pages past the latest 50 (CRMP's server paging).
 * Every move — drag, arrows, Move menu, accepted AI suggestion — goes through
 * the lost-reason prompt (F28). The forecast, create and export stay.
 */
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { fmt$ } from "@/components/usip/Common";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { NewOpportunityDialog } from "@/components/usip/NewOpportunityDialog";
import { useLostReasonPrompt } from "@/components/usip/LostReasonDialog";
import { trpc } from "@/lib/trpc";
import { invalidateDealReads } from "@/lib/crmCache";
import { usePermissions } from "@/hooks/usePermissions";
import { ArrowRight, Brain, Download, Loader2, Plus, TrendingUp, Zap, Filter, X, User, KanbanSquare, Sparkles, ChevronLeft, ChevronRight, Bot, AlertTriangle, MoreHorizontal, ChevronsLeftRight, ChevronsRightLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { forbiddenMessage } from "@/lib/forbidden";
import { confirmAction } from "@/components/usip/Common";
import { WonConfetti } from "@/components/usip/WonConfetti";
import { ANALYZE_LIMIT, CLOSE_RANGE_OPTIONS, DEAL_AUTOPILOT_MODES, closeRangeFrom, dealAnalyzeToast, type CloseRangeValue } from "@/lib/dealAutopilot";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { urlParam, useUrlState } from "@/lib/urlState";
import { tablistProps, tabProps } from "@/lib/tabs";
import { csvCell } from "@shared/csvCell";
import { FailedLoadsBanner } from "@/components/usip/QueryState";

type StageItem = { id: string; label: string; isWon: boolean; isLost: boolean; defaultWinProb?: number | null };

/**
 * A card's drag payload (audit 2026-10-20, R82). The drop read "text/plain",
 * so dropping any selected text that was a number onto a column moved the
 * deal with that id.
 */
export const DEAL_DRAG_TYPE = "application/x-velocity-deal";

/** The deal a drop carries, or null when it carries no card. */
export function droppedDealId(dt: { types: ReadonlyArray<string>; getData(type: string): string }): number | null {
  if (!Array.from(dt.types).includes(DEAL_DRAG_TYPE)) return null;
  const id = Number(dt.getData(DEAL_DRAG_TYPE));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** A closed column's page: the server's default (BOARD_CLOSED_LIMIT), and its ceiling. */
export const BOARD_CLOSED_STEP = 50;
export const BOARD_CLOSED_MAX = 500;
/** This browser remembers whether the closed columns are folded. */
const CLOSED_FOLD_KEY = "velocity_board_closed_folded";

/** Loading fallback only — the real flags come from crmPipelines.get. */
const LEGACY_STAGES: StageItem[] = [
  { id: "discovery", label: "Discovery", isWon: false, isLost: false },
  { id: "qualified", label: "Qualified", isWon: false, isLost: false },
  { id: "proposal", label: "Proposal", isWon: false, isLost: false },
  { id: "negotiation", label: "Negotiation", isWon: false, isLost: false },
  { id: "won", label: "Won", isWon: true, isLost: false },
  { id: "lost", label: "Lost", isWon: false, isLost: true },
];

const STAGE_COLORS: Record<string, string> = {
  discovery: "bg-slate-400",
  qualified: "bg-blue-400",
  proposal: "bg-violet-400",
  negotiation: "bg-amber-400",
  won: "bg-emerald-500",
  lost: "bg-red-400",
};

/**
 * Returns the active stage list for a pipeline. Falls back to LEGACY_STAGES
 * while loading or when the workspace has no configured pipelines yet (which
 * also seeds the Default pipeline on the server side).
 */
function useStagesFor(pipelineId?: number): StageItem[] {
  const { data } = trpc.crmPipelines.get.useQuery(
    pipelineId ? { pipelineId } : undefined as any,
    { staleTime: 60_000 },
  );
  if (!data) return LEGACY_STAGES;
  // The flags travel with the list: every "is this the closing column?"
  // question on this page used to be `id === "won"`, which is false for every
  // workspace that renamed its closing stage.
  return data.stages.map((s) => ({ id: s.key, label: s.label, isWon: !!s.isWon, isLost: !!s.isLost, defaultWinProb: s.defaultWinProb ?? null }));
}

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
  opp, intel, onOpen, onAnalyze, isAnalyzing, onAcceptStage, isAccepting, onMove, stages,
}: {
  opp: any; intel: any | null; onOpen: () => void;
  onAnalyze: (e: React.MouseEvent) => void; isAnalyzing: boolean;
  onAcceptStage: (e: React.MouseEvent, toStage: string) => void; isAccepting: boolean;
  onMove: (toStage: string) => void;
  stages: StageItem[];
}) {
  const STAGES = stages;
  // Keyboard/click stage moves so the board isn't drag-only (a11y).
  const curIdx = STAGES.findIndex((s) => s.id === opp.stage);
  const prevStage = curIdx > 0 ? STAGES[curIdx - 1] : null;
  const nextStage = curIdx >= 0 && curIdx < STAGES.length - 1 ? STAGES[curIdx + 1] : null;
  const winProb = intel ? Math.round(Number(intel.winProbability)) : opp.winProb;
  const nba: any[] = (intel?.nextBestActions as any) ?? [];
  const topNba = nba[0] ?? null;
  // Only show suggestion if it's a different stage from current and not won/lost
  const suggestedStage: string | null = intel?.suggestedStage ?? null;
  const suggestedMeta = suggestedStage ? STAGES.find((s) => s.id === suggestedStage) : null;
  const showStageSuggestion =
    !!suggestedStage &&
    suggestedStage !== opp.stage &&
    !!suggestedMeta &&
    !suggestedMeta.isWon &&
    !suggestedMeta.isLost;
  const stageLabel = (id: string) => STAGES.find((s) => s.id === id)?.label ?? id;

  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData(DEAL_DRAG_TYPE, String(opp.id)); e.dataTransfer.effectAllowed = "move"; }}
      onClick={onOpen}
      tabIndex={0}
      role="button"
      aria-label={`${opp.name}, ${stageLabel(opp.stage)} stage. Press Enter to open.`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
      }}
      className="bg-card border rounded-lg p-3 cursor-pointer hover:shadow-md hover:border-[#14B89A] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#14B89A] transition-all group"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/opportunities/${opp.id}`} onClick={(e) => e.stopPropagation()} className="text-sm font-medium truncate hover:underline block">
            {opp.name}
          </Link>
          <div className="text-[11px] text-muted-foreground truncate mt-0.5">{opp.accountName}</div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
        {/* The Move menu from /v2/deals (U13): any stage, not just the next
            one. It goes through onMove, i.e. the lost-reason prompt (F28).
            The menu sits in a portal, so its clicks and keys must not reach
            the card's own open-the-drawer handlers. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Move deal to a stage" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
              className="p-1 rounded hover:bg-muted opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity">
              <MoreHorizontal className="size-3 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Move to stage</DropdownMenuLabel>
            {STAGES.filter((st) => st.id !== opp.stage).map((st) => (
              <DropdownMenuItem key={st.id} onClick={() => onMove(st.id)}>
                <ArrowRight className="size-3.5 mr-2" /> {st.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button aria-label={isAnalyzing ? "Analyzing..." : "Run AI analysis"}
                onClick={onAnalyze}
                disabled={isAnalyzing}
                className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity p-1 rounded hover:bg-muted"
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

      {/* Keyboard/click stage moves — board isn't drag-only. Shown on hover/focus. */}
      <div
        className="mt-2 pt-2 border-t border-dashed flex items-center justify-between opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-focus-within:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          disabled={!prevStage}
          aria-label={prevStage ? `Move to ${prevStage.label}` : "Already at first stage"}
          title={prevStage ? `Move to ${prevStage.label}` : undefined}
          onClick={(e) => { e.stopPropagation(); if (prevStage) onMove(prevStage.id); }}
          className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="size-3" /> {prevStage?.label ?? ""}
        </button>
        <button
          type="button"
          disabled={!nextStage}
          aria-label={nextStage ? `Move to ${nextStage.label}` : "Already at last stage"}
          title={nextStage ? `Move to ${nextStage.label}` : undefined}
          onClick={(e) => { e.stopPropagation(); if (nextStage) onMove(nextStage.id); }}
          className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {nextStage?.label ?? ""} <ChevronRight className="size-3" />
        </button>
      </div>
    </div>
  );
}

/* ─── Forecast View ─────────────────────────────────────────────────────── */
function ForecastView({ scope, scopeLabel }: { scope: { pipelineId?: number; ownerUserId?: number; closeRange?: CloseRangeValue }; scopeLabel: string }) {
  const STAGES = useStagesFor(scope.pipelineId);
  const [selectedStages, setSelectedStages] = useState<string[]>([]);
  const [commentary, setCommentary] = useState<string | null>(null);
  const commentaryMut = trpc.forecastAi.generateCommentary.useMutation({
    onSuccess: (r) => setCommentary(r.commentary),
    onError: (e: any) => toast.error(e.message),
  });
  // Unfiltered query to always have the full availableStages list for the filter UI
  // The board's pipeline and owner filter (R39): this tab and the board beside it count the same deals.
  const { data: allFc } = trpc.opportunities.forecast.useQuery(scope);
  const availableStages = allFc?.availableStages ?? [];
  // Filtered query — passes selectedStages only when at least one is chosen
  const { data: fc, isLoading } = trpc.opportunities.forecast.useQuery(
    selectedStages.length > 0 ? { ...scope, stages: selectedStages } : scope
  );

  function toggleStage(stage: string) {
    setSelectedStages((prev) =>
      prev.includes(stage) ? prev.filter((s) => s !== stage) : [...prev, stage]
    );
  }

  if (isLoading) {
    return (
      <div className="p-4 md:p-5 space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (!fc) return null;

  const { grandTotal, grandWeighted, months, stages } = fc;
  // Weighted ÷ total is the pipeline's average confidence, not coverage
  // (coverage compares pipeline with a target) — R19.
  const weightedShare = grandTotal > 0 ? Math.round((grandWeighted / grandTotal) * 100) : 0;
  const maxMonthWeighted = Math.max(...months.map((m) => m.weighted), 1);

  const fmtMonth = (key: string) => {
    if (key === "no-date") return "No close date";
    const [y, m] = key.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleString("default", { month: "short", year: "numeric" });
  };

  const stageLabel = (id: string) => STAGES.find((s) => s.id === id)?.label ?? id;

  return (
    <div className="p-4 md:p-5 space-y-6">
      <p className="text-xs text-muted-foreground">{scopeLabel}</p>
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
          { label: "Total Pipeline", value: fmt$(grandTotal), sub: "open deals" },
          { label: "Weighted Forecast", value: fmt$(grandWeighted), sub: "probability-adjusted" },
          { label: "Weighted Share", value: `${weightedShare}%`, sub: "weighted / total" },
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
          {STAGES.filter((s) => !s.isLost).map((s) => {
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
          <Button size="sm" variant="outline" onClick={() => commentaryMut.mutate()} disabled={commentaryMut.isPending}>
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
  // UX, not a boundary — the CSV below is assembled from rows already in the
  // browser. See the comment on reports.exportCsv.
  const { can } = usePermissions();
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  // ?owner=<userId>, the rep drill-down from Dashboard and Forecast. From
  // useSearch (audit 2026-10-20, R30): memoised on wouter's location, which is
  // the path only, "Clear filter" changed the query string and nothing re-read it.
  // 2026-11-08 (audit U6): ?owner= and ?close= keep their names and links,
  // now read and written through the shared URL-state hook with the view,
  // the pipeline and the open deal, so a refresh or a copied link restores
  // the whole board. Each setter keeps every other parameter.
  const [ownerParam, setOwnerParam] = useUrlState("owner", urlParam.id());
  const ownerUserId = ownerParam ?? undefined;
  // ?close=, the close-date filter (U13): one of dealAutopilot's ranges.
  const [closeParam, setCloseParam] = useUrlState("close", urlParam.string());
  const closeRange = useMemo(() => closeRangeFrom(closeParam || null), [closeParam]);
  /** Set or clear one filter in the URL, keeping the others (owner and close are links). */
  const setFilterParam = (key: "owner" | "close", value: string | null) => {
    if (key === "owner") setOwnerParam(value ? Number(value) : null);
    else setCloseParam(value ?? "");
  };
  const { data: team } = trpc.team.list.useQuery();
  const owners = useMemo(() => ((team ?? []) as Array<{ userId: number; name: string | null; deactivatedAt?: unknown }>).filter((m) => !m.deactivatedAt), [team]);
  // Closed columns show their latest deals; "Show more" pages further (CRMP's
  // closedLimit, up to the server's 500), and they can fold away (U13). The
  // fold is this browser's convenience, so it is remembered here only.
  const [closedLimit, setClosedLimit] = useState(BOARD_CLOSED_STEP);
  const [closedFolded, setClosedFolded] = useState<boolean>(() => {
    try { return localStorage.getItem(CLOSED_FOLD_KEY) === "1"; } catch { return false; }
  });
  const toggleClosedFolded = () => setClosedFolded((v) => {
    try { localStorage.setItem(CLOSED_FOLD_KEY, v ? "0" : "1"); } catch { /* this visit only */ }
    return !v;
  });

  const [analyzingIds, setAnalyzingIds] = useState<Set<number>>(new Set());
  const [acceptingIds, setAcceptingIds] = useState<Set<number>>(new Set());
  const [view, setView] = useUrlState("view", urlParam.oneOf(["board", "forecast"] as const, "board"));

  // Multi-pipeline support: list available pipelines, default to the workspace's
  // default. Persist the selection in URL so a refresh keeps the user on the same
  // pipeline.
  const { data: pipelines } = trpc.crmPipelines.list.useQuery();
  const defaultPipelineId = useMemo(() => pipelines?.find((p) => p.isDefault)?.id ?? pipelines?.[0]?.id, [pipelines]);
  const [pipelineParam, setSelectedPipelineId] = useUrlState("pipeline", urlParam.id());
  const selectedPipelineId = pipelineParam ?? undefined;
  const pipelineId = selectedPipelineId ?? defaultPipelineId;
  const STAGES = useStagesFor(pipelineId);
  const pipelineName = pipelines?.find((p) => p.id === pipelineId)?.name;

  // One pipeline's deals, read by the server (L7), and the same input for
  // every read and write of this cache — the optimistic move wrote the
  // unfiltered entry while a filtered board was on screen (R30).
  // 2026-11-08 (U13): the close-date range is part of the board's scope, so
  // every read below counts the same deals. The board itself also carries the
  // closed columns' page size, and its cache is keyed by that.
  const boardInput = useMemo(() => ({ ownerUserId, pipelineId, closeRange }), [ownerUserId, pipelineId, closeRange]);
  const boardQueryInput = useMemo(() => ({ ...boardInput, closedLimit }), [boardInput, closedLimit]);
  const { data, isLoading: boardLoading } = trpc.opportunities.board.useQuery(boardQueryInput, { enabled: pipelines !== undefined });
  // Each column's count and value, counted by the server over every deal in
  // scope (audit 2026-10-20, X4.1): a won or lost column shows its latest
  // deals only, and its header still says how many it has.
  const { data: totals } = trpc.opportunities.boardTotals.useQuery(boardInput, { enabled: pipelines !== undefined });
  const totalsByStage = useMemo(() => new Map((totals ?? []).map((t) => [t.stage, t])), [totals]);
  const { data: boardIntel = [] } = trpc.oppIntelligence.getIntelligenceForBoard.useQuery(boardInput, { enabled: pipelines !== undefined });

  const intelMap = useMemo(() => {
    const m = new Map<number, any>();
    boardIntel.forEach((i) => m.set(i.opportunityId, i));
    return m;
  }, [boardIntel]);

  const generateIntel = trpc.oppIntelligence.generateIntelligence.useMutation({
    onSuccess: (_data, vars) => {
      invalidateDealReads(utils);
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

  /**
   * "Accept AI stage suggestion" used to call oppIntelligence.requestStageChange
   * and toast "Stage change submitted for approval" — and the deal never moved,
   * because that approval could never be reviewed by anyone:
   * listPendingApprovals and reviewStageChange have ZERO callers anywhere in
   * client/src, so no screen lists pending requests and no notification fires.
   * The row went into stage_approvals and sat there forever.
   *
   * It also wasn't gating anything: dragging the same card between columns
   * calls opportunities.setStage directly with no approval at all, and both
   * procedures are repProcedure — the same permission level. So the indirection
   * added no control, only a dead end.
   *
   * Accepting a suggestion now does what the button says: moves the deal, via
   * the same path (and optimistic update) as a drag. The stage_approvals
   * mechanism is left intact but deliberately unused — do not route traffic
   * into it again until a reviewer UI exists.
   */
  const handleAcceptStage = (e: React.MouseEvent, opportunityId: number, toStage: string) => {
    e.stopPropagation();
    // A suggestion to close it lost asks why, like every move to Lost (F28).
    if (STAGES.find((s) => s.id === toStage)?.isLost) { requestMove(opportunityId, toStage); return; }
    setAcceptingIds((prev) => new Set(prev).add(opportunityId));
    setStage.mutate(
      { id: opportunityId, stage: toStage },
      {
        onSettled: () => {
          setAcceptingIds((prev) => { const next = new Set(prev); next.delete(opportunityId); return next; });
          invalidateDealReads(utils);
        },
      },
    );
  };

  const setStage = trpc.opportunities.setStage.useMutation({
    onMutate: async ({ id, stage }) => {
      await utils.opportunities.board.cancel(boardQueryInput);
      const prev = utils.opportunities.board.getData(boardQueryInput);
      utils.opportunities.board.setData(boardQueryInput, (old) => (old ?? []).map((o) => (o.id === id ? { ...o, stage } : o)));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) utils.opportunities.board.setData(boardQueryInput, ctx.prev); toast.error("Move failed"); },
    // Every read a stage move changes, not just this board (R31).
    onSuccess: (res, vars) => {
      if (res?.customerCreated) toast.success("Closed won 🎉 — customer created");
      // The won confetti from /v2/deals (U13), on the stage's flag, not its key.
      else if (STAGES.find((s) => s.id === vars.stage)?.isWon) toast.success("Deal won! 🎉");
      if (STAGES.find((s) => s.id === vars.stage)?.isWon) { setCelebrate(Date.now()); setTimeout(() => setCelebrate(0), 1800); }
      invalidateDealReads(utils);
    },
    // A failed move re-reads the board it optimistically changed; a good one
    // already refreshed every deal read in onSuccess (X1.7).
    onSettled: (_d, err) => { if (err) invalidateDealReads(utils); },
  });

  const [addOpen, setAddOpen] = useState(false);
  // The open deal is ?deal= (U6): opening writes it, closing removes it, so a
  // link opens the same deal. The card's name and line ride along in state.
  const [dealParam, setDealParam] = useUrlState("deal", urlParam.id());
  const [drawerMeta, setDrawerMeta] = useState<{ id: number; name: string; subtitle: string } | null>(null);
  const drawer = dealParam != null
    ? { id: dealParam, name: drawerMeta?.id === dealParam ? drawerMeta.name : "Deal", subtitle: drawerMeta?.id === dealParam ? drawerMeta.subtitle : undefined }
    : null;
  const setDrawer = (d: { id: number; name: string; subtitle: string } | null) => { setDrawerMeta(d); setDealParam(d ? d.id : null); };
  const [celebrate, setCelebrate] = useState(0);

  /* ── From /v2/deals (U13): the Deal Autopilot, the header numbers, the AI
   *    commentary and the at-risk alerts. ─────────────────────────────── */
  const autopilot = trpc.deals.getAutopilotSettings.useQuery();
  const mode = autopilot.data?.mode ?? "off";
  const setMode = trpc.deals.setAutopilotSettings.useMutation({
    onSuccess: () => { utils.deals.getAutopilotSettings.invalidate(); toast.success("Autopilot updated"); },
    onError: (e) => toast.error(forbiddenMessage(e, "Only admins can change Autopilot")),
  });
  // Analyze runs in Approve mode whatever the setting: drafts, not deal edits (R43).
  const analyze = trpc.deals.analyzeAll.useMutation({
    onSuccess: (r) => {
      invalidateDealReads(utils);
      toast.success(dealAnalyzeToast(r), r.tasksCreated > 0 ? { action: { label: "Review", onClick: () => navigate("/v2/tasks") } } : undefined);
    },
    onError: (e) => toast.error(e.message),
  });
  // The header numbers are the server's deal metrics for the board's scope (R39).
  const summary = trpc.opportunities.summary.useQuery(boardInput, { enabled: pipelines !== undefined });
  const commentary = trpc.forecastAi.getCommentary.useQuery(undefined as any, { retry: false });
  const alerts = trpc.pipelineAlerts.list.useQuery(undefined as any, { retry: false });
  const activeAlerts = ((alerts.data as any[])?.filter?.((a) => !a.dismissedAt) ?? (alerts.data as any[]) ?? []) as any[];
  // /pipeline#alerts (the Library's "Pipeline Alerts") lands on the strip once
  // the alerts have loaded (R103); the hash rides through the /v2/deals redirect.
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#alerts" || !alerts.isFetched) return;
    document.getElementById("alerts")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [alerts.isFetched]);
  const showAlerts = activeAlerts.length > 0 || (typeof window !== "undefined" && window.location.hash === "#alerts" && alerts.isFetched);

  // The server returns the selected pipeline's deals (legacy deals with no
  // pipeline sit on the default board), so the board is what it sent.
  const filteredOpps = data ?? [];
  // Every move on this board — a drop, a card's arrows, an accepted AI
  // suggestion — asks why when it goes to a lost stage (audit 2026-10-20,
  // F28). Skipping the question still moves the deal.
  const lostPrompt = useLostReasonPrompt((v: { id: number; stage: string }) => setStage.mutate(v));
  const requestMove = (id: number, toStage: string) => {
    const st = STAGES.find((s) => s.id === toStage);
    const deal = filteredOpps.find((o: any) => o.id === id);
    lostPrompt.ask({ id, stage: toStage }, { isLost: !!st?.isLost, dealName: deal?.name ?? "this deal", stageLabel: st?.label ?? toStage });
  };
  const closeLabel = CLOSE_RANGE_OPTIONS.find((o) => o.value === closeRange)?.label.toLowerCase();
  const scopeLabel = `${pipelineName ? `${pipelineName} pipeline` : "All deals"}${ownerUserId ? ", one rep" : ", every owner"}${closeLabel ? `, ${closeLabel}` : ""}: the deals on the board.`;
  const ownerName = owners.find((m) => m.userId === ownerUserId)?.name;

  const grouped = useMemo(() => {
    const buckets: Record<string, typeof data> = {};
    STAGES.forEach((s) => (buckets[s.id] = []));
    filteredOpps.forEach((o: any) => { if (buckets[o.stage]) buckets[o.stage]!.push(o); });
    return buckets;
  }, [filteredOpps, STAGES]);

  return (
    <Shell title="Pipeline">
      {ownerUserId && (
        <div className="mx-6 mt-4 flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-2 text-sm">
          <User className="size-4 text-amber-400" />
          <span className="text-amber-700 dark:text-amber-300 font-medium">Showing deals for {ownerName ?? "one rep"}.</span>
          <button
            onClick={() => setFilterParam("owner", null)}
            className="ml-auto flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 hover:underline"
          >
            <X className="size-3" /> Clear filter
          </button>
        </div>
      )}
      <PageHeader title="Pipeline" description="Every deal by stage, with the Deal Autopilot, at-risk alerts and the weighted forecast. Drag a deal or use its Move menu, filter by owner and close date, and get AI next steps." pageKey="pipeline"
        icon={<KanbanSquare className="size-5" />}
      >
        {/* Pipeline switcher (multi-pipeline support) */}
        {pipelines && pipelines.length > 1 && (
          <select
            className="text-sm bg-secondary rounded px-2 py-1.5 border"
            value={String(pipelineId ?? "")}
            onChange={(e) => setSelectedPipelineId(Number(e.target.value))}
            title="Pipeline"
          >
            {pipelines.map((p) => (
              <option key={p.id} value={String(p.id)}>{p.name}{p.isDefault ? " (default)" : ""}</option>
            ))}
          </select>
        )}
        <Button variant="ghost" size="sm" onClick={() => navigate("/settings/pipelines")} title="Configure pipelines">
          Configure
        </Button>
        {/* The Deal Autopilot dial, from /v2/deals (U13). */}
        <div className="flex items-center gap-1.5">
          <Bot className="size-3.5 text-muted-foreground" aria-hidden />
          <Select value={mode} onValueChange={(v) => setMode.mutate({ mode: v as "off" | "approval" | "auto" })}>
            <SelectTrigger aria-label="Deal Autopilot" className="h-8 w-[168px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Autopilot: Off</SelectItem>
              <SelectItem value="approval">Autopilot: Approve</SelectItem>
              <SelectItem value="auto">Autopilot: Autonomous</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {/* Spends AI: says how many calls and asks first (batch rule on spending). */}
        <Button variant="outline" size="sm" disabled={analyze.isPending}
          title={`Drafts a next step and win probability for up to ${ANALYZE_LIMIT} open deals, as tasks for you to review. Deals are not changed.`}
          onClick={() => confirmAction({
            title: `Analyze up to ${ANALYZE_LIMIT} open deals with AI?`,
            count: { n: ANALYZE_LIMIT, one: "open deal", upTo: true },
            cost: { kind: "ai", calls: ANALYZE_LIMIT, what: "at most, one per deal" },
            description: `One AI call per deal, up to ${ANALYZE_LIMIT}, counted in this workspace's AI spend (Settings → Billing and credits) and held to its caps. Each result is a draft task for you to review in Tasks; no deal is changed.`,
            confirmLabel: "Analyze",
            destructive: false,
          }, () => analyze.mutate({ limit: ANALYZE_LIMIT }))}>
          <Sparkles className="size-3.5" /> {analyze.isPending ? "Analyzing…" : "Analyze with AI"}
        </Button>
        {/* View toggle */}
        <div {...tablistProps("Pipeline view")} className="flex items-center border rounded-md overflow-hidden text-sm" data-tour-id="pipeline-view-toggle">
          {(["board", "forecast"] as const).map((v) => (
            <button {...tabProps(view === v)}
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
        {can("export_data") && (
        <Button variant="outline" onClick={async () => {
          // What the board holds — this pipeline, this owner filter (R39) —
          // every deal, from the server: a won or lost column shows only its
          // latest (X4.1).
          const rows = await utils.opportunities.boardExport.fetch(boardInput).catch((e) => { toast.error(e.message); return []; });
          if (!rows.length) return;
          const cols = ["id", "name", "stage", "value", "winProb", "closeDate", "accountName", "createdAt"];
          // One CSV cell rule (R63): quotes doubled, formulas neutralised.
          const lines = [cols.join(","), ...rows.map((r: any) => cols.map((c) => csvCell(r[c])).join(","))];
          const blob = new Blob([lines.join("\n")], { type: "text/csv" });
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `pipeline-${Date.now()}.csv`; a.click();
        }} disabled={!filteredOpps.length}>
          <Download className="size-4" /> Export CSV
        </Button>
        )}
        <Button onClick={() => setAddOpen(true)} data-tour-id="pipeline-new-button"><Plus className="size-4" /> New opportunity</Button>
      </PageHeader>
      {/* A failed load says so instead of showing an empty page (audit X1.6). */}
      <div className="px-4 md:px-6 pt-2 empty:hidden"><FailedLoadsBanner /></div>

      <div className="px-4 pt-3 space-y-3">
        {/* Owner and close-date filters as controls (U13). Each is a URL
            parameter, so a filtered board is a link (Top Reps uses ?owner=). */}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label htmlFor="board-owner" className="text-muted-foreground">Owner</label>
          <select id="board-owner" className="rounded border bg-background px-2 py-1" value={ownerUserId ? String(ownerUserId) : ""}
            onChange={(e) => setFilterParam("owner", e.target.value || null)}>
            <option value="">Everyone</option>
            {owners.map((m) => <option key={m.userId} value={String(m.userId)}>{m.name ?? `User ${m.userId}`}</option>)}
          </select>
          <label htmlFor="board-close" className="text-muted-foreground">Close date</label>
          <select id="board-close" className="rounded border bg-background px-2 py-1" value={closeRange ?? ""}
            onChange={(e) => setFilterParam("close", e.target.value || null)}>
            {CLOSE_RANGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {(ownerUserId || closeRange) && (
            <button type="button" className="text-muted-foreground underline hover:text-foreground" onClick={() => { setOwnerParam(null); setCloseParam(""); }}>Clear filters</button>
          )}
        </div>

        {/* The Deal Autopilot's strip: what the current mode does (R43). */}
        <div className="rounded-lg border bg-card px-4 py-2.5 flex items-center gap-3 shadow-sm">
          <span className="shrink-0 size-8 rounded-full flex items-center justify-center" style={{ backgroundColor: mode === "off" ? "hsl(var(--muted))" : "#7c3aed1f", color: mode === "off" ? undefined : "#7c3aed" }}>
            {mode === "auto" ? <Zap className="size-4" /> : <Bot className="size-4" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{DEAL_AUTOPILOT_MODES[mode]?.label}</div>
            <div className="text-[12px] text-muted-foreground">{DEAL_AUTOPILOT_MODES[mode]?.blurb}</div>
          </div>
        </div>

        {/* The header numbers, for what the board shows (R39). */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: "Open deals", value: String(summary.data?.open.count ?? 0) },
            { label: "Pipeline value", value: fmt$(summary.data?.open.value ?? 0) },
            { label: "Weighted", value: fmt$(summary.data?.open.weighted ?? 0) },
            { label: "Won", value: String(summary.data?.won.count ?? 0) },
          ].map((c) => (
            <div key={c.label} className="rounded-lg border bg-card p-3 shadow-sm">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{c.label}</div>
              <div className="text-xl font-semibold tabular-nums mt-0.5">{c.value}</div>
            </div>
          ))}
        </div>

        {commentary.data?.commentary && (
          <div className="rounded-lg border bg-card px-4 py-2.5 flex items-start gap-2.5 shadow-sm">
            <TrendingUp className="size-4 mt-0.5 shrink-0" style={{ color: "#7c3aed" }} />
            <div className="text-[12px] text-muted-foreground">{commentary.data.commentary}</div>
          </div>
        )}

        {/* At-risk alerts (R103): each chip opens its deal. */}
        {showAlerts && (
          <div id="alerts" className="rounded-lg border border-amber-300/60 bg-amber-50/50 dark:bg-amber-900/10 px-4 py-2.5 shadow-sm scroll-mt-4">
            <div className="text-[12px] font-medium flex items-center gap-1.5 text-amber-700 dark:text-amber-300 mb-1">
              <AlertTriangle className="size-3.5" />
              {activeAlerts.length === 0 ? "No deals need attention right now" : `${activeAlerts.length} deal${activeAlerts.length === 1 ? "" : "s"} need attention`}
              <Link href="/pipeline-alerts" className="ml-auto font-normal underline">All alerts</Link>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {activeAlerts.slice(0, 6).map((a: any, i: number) => (
                <Link key={a.id ?? i} href={`/opportunities/${a.opportunityId}`}
                  className="text-[11px] rounded px-1.5 py-0.5 bg-amber-100 text-amber-800 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50">
                  {a.opportunity?.name ?? a.details?.oppName ?? "Deal"} · {String(a.alertType ?? "").replace(/_/g, " ")}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {view === "forecast" ? (
        <ForecastView scope={boardInput} scopeLabel={scopeLabel} />
      ) : (
        <div className="p-4 overflow-x-auto" tabIndex={0} role="region" aria-label="Pipeline board" data-tour-id="deals-board">
          {boardLoading && <p className="mb-2 text-xs text-muted-foreground">Loading deals…</p>}
          <div className="flex gap-3 min-w-max" data-tour-id="pipeline-board">
            {STAGES.map((s) => {
              const items = grouped[s.id] ?? [];
              const closed = s.isWon || s.isLost;
              const t = totalsByStage.get(s.id);
              const count = t?.count ?? items.length;
              const total = t?.value ?? items.reduce((sum, o) => sum + Number(o.value ?? 0), 0);
              // The deal's own win % — the one the forecast weights by. The AI's
              // estimate was preferred here, so this column and the Forecast
              // tab disagreed about the same deals (R39).
              const avgProb = t ? t.avgWinProb : items.length > 0
                ? Math.round(items.reduce((sum, o) => sum + Number(o.winProb ?? 0), 0) / items.length)
                : null;
              const folded = closed && closedFolded;
              return (
                <div
                  key={s.id}
                  className={`${folded ? "w-12" : "w-72"} shrink-0 bg-secondary/40 border rounded-lg flex flex-col`}
                  onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes(DEAL_DRAG_TYPE)) e.preventDefault(); }}
                  onDrop={(e) => {
                    const id = droppedDealId(e.dataTransfer);
                    if (id) requestMove(id, s.id);
                  }}
                >
                  {folded ? (
                    // A folded closed column: its name and count, still a drop target.
                    <button type="button" aria-expanded={false} aria-label={`Show the ${s.label} column (${count})`} title={`Show ${s.label}`}
                      onClick={toggleClosedFolded} className="flex flex-col items-center gap-2 py-3 min-h-[60vh] hover:bg-muted/60 rounded-lg">
                      <ChevronsLeftRight className="size-3.5 text-muted-foreground" />
                      <span className="text-xs font-medium [writing-mode:vertical-rl]">{s.label} · {count}</span>
                    </button>
                  ) : (<>
                  <div className="px-3 py-2 border-b flex items-center gap-2">
                    <div className="text-sm font-medium">{s.label}</div>
                    <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{count} · {fmt$(total)}</span>
                      {avgProb !== null && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">avg {avgProb}%</Badge>
                      )}
                      {closed && (
                        <button type="button" aria-expanded={true} aria-label={`Fold the closed columns`} title="Fold the closed columns"
                          onClick={toggleClosedFolded} className="p-0.5 rounded hover:bg-muted">
                          <ChevronsRightLeft className="size-3.5" />
                        </button>
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
                        onMove={(toStage) => requestMove(o.id, toStage)}
                        stages={STAGES}
                      />
                    ))}
                    {count > items.length && (
                      <p className="px-1 pt-1 text-[11px] text-muted-foreground">The latest {items.length} of {count.toLocaleString()} shown. Export CSV has them all.</p>
                    )}
                    {/* The next page of a closed column (CRMP's server paging). */}
                    {closed && count > items.length && closedLimit < BOARD_CLOSED_MAX && (
                      <button type="button" className="w-full rounded border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={() => setClosedLimit((n) => Math.min(n + BOARD_CLOSED_STEP, BOARD_CLOSED_MAX))}>
                        Show {Math.min(BOARD_CLOSED_STEP, count - items.length)} more
                      </button>
                    )}
                  </div>
                  </>)}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <NewOpportunityDialog open={addOpen} onOpenChange={setAddOpen} stages={STAGES} pipelineId={pipelineId} />
      {lostPrompt.dialog}
      {celebrate > 0 && <WonConfetti />}

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
