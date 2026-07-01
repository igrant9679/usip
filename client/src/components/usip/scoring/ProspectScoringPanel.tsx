/**
 * ProspectScoringPanel — the full explainable scoring section for a person or
 * company, shown in the People open-drawer and the full profile.
 *
 * Surfaces: the primary Fit score + Velocity Priority Score (badges), the six
 * weighted priority components (bars), the matched / detracting / disqualifying
 * / not-matched criteria, the score-change history timeline, the model name +
 * last-calculated time, and a Recalculate button (manager+).
 */
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { RefreshCw, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { ScoreBadge, type Rating, type ObjectType } from "./ScoreBadge";

const RANK: Record<string, number> = { super_admin: 4, admin: 3, manager: 2, rep: 1 };

function Bar({ label, value, weight }: { label: string; value: number | null; weight: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-28 shrink-0 text-muted-foreground">{label}<span className="ml-1 text-[9px] opacity-60">{weight}</span></span>
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-primary/70" style={{ width: `${value == null ? 0 : Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="w-8 text-right tabular-nums">{value == null ? "—" : Math.round(value)}</span>
    </div>
  );
}

export function ProspectScoringPanel({ objectType, objectId }: { objectType: ObjectType; objectId: number }) {
  const auth = useAuth();
  const canRecalc = (RANK[(auth.user as any)?.role ?? "rep"] ?? 0) >= RANK.manager;
  const utils = trpc.useUtils();

  const result = trpc.scoring.getResult.useQuery({ objectType, objectId }, { staleTime: 30_000 });
  const bd = trpc.scoring.getBreakdown.useQuery({ objectType, objectId }, { staleTime: 30_000 });
  const history = trpc.scoring.getHistory.useQuery({ objectType, objectId }, { staleTime: 30_000 });
  const models = trpc.scoring.listModels.useQuery(undefined, { staleTime: 60_000 });

  const recalc = trpc.scoring.calculate.useMutation({
    onSuccess: () => {
      utils.scoring.getResult.invalidate({ objectType, objectId });
      utils.scoring.getBreakdown.invalidate({ objectType, objectId });
      utils.scoring.getHistory.invalidate({ objectType, objectId });
      utils.scoring.scoreMap.invalidate();
    },
  });

  const fit = result.data?.fit as any;
  const prio = result.data?.priority as any;
  const b = bd.data;
  const modelName = models.data?.models.find((m: any) => m.id === result.data?.modelId)?.name;
  const calculatedAt = fit?.calculatedAt ? new Date(fit.calculatedAt).toLocaleString() : null;

  if (result.isLoading) return <div className="text-[11px] text-muted-foreground p-2">Loading score…</div>;

  const noModel = !result.data?.modelId;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scoring</div>
        {canRecalc && (
          <Button variant="outline" size="sm" className="h-7 gap-1 text-[11px]"
            disabled={recalc.isPending}
            onClick={() => recalc.mutate({ objectType, objectId })}>
            <RefreshCw className={`size-3 ${recalc.isPending ? "animate-spin" : ""}`} /> Recalculate
          </Button>
        )}
      </div>

      {noModel ? (
        <div className="rounded border bg-muted/30 p-2 text-[11px] text-muted-foreground">
          No primary {objectType} score model is active. An admin can install or activate one in scoring settings.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-4">
            <div>
              <div className="text-[10px] uppercase text-muted-foreground">Fit score</div>
              <ScoreBadge score={fit?.normalizedScore} rating={fit?.rating as Rating} showLabel muted />
            </div>
            <div>
              <div className="text-[10px] uppercase text-muted-foreground">Priority</div>
              <ScoreBadge score={prio?.priorityScore} rating={prio?.priorityRating as Rating} showLabel muted />
            </div>
          </div>
          {(modelName || calculatedAt) && (
            <div className="text-[10px] text-muted-foreground">
              {modelName ? `Model: ${modelName}` : ""}{modelName && calculatedAt ? " · " : ""}{calculatedAt ? `Updated ${calculatedAt}` : ""}
            </div>
          )}

          {prio && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Velocity Priority Score</div>
              <Bar label="Person fit" value={prio.personFitScore == null ? null : Number(prio.personFitScore)} weight="35%" />
              <Bar label="Company fit" value={prio.companyFitScore == null ? null : Number(prio.companyFitScore)} weight="30%" />
              <Bar label="Intent" value={prio.intentScore == null ? null : Number(prio.intentScore)} weight="15%" />
              <Bar label="Engagement" value={prio.engagementScore == null ? null : Number(prio.engagementScore)} weight="10%" />
              <Bar label="Data quality" value={prio.dataQualityScore == null ? null : Number(prio.dataQualityScore)} weight="5%" />
              <Bar label="Seq. readiness" value={prio.sequenceReadinessScore == null ? null : Number(prio.sequenceReadinessScore)} weight="5%" />
            </div>
          )}

          {b?.disqualifiers && b.disqualifiers.length > 0 && (
            <div className="rounded border border-red-200 bg-red-50 p-2">
              <div className="text-[10px] font-semibold uppercase text-red-700">Disqualified</div>
              {b.disqualifiers.map((d, i) => <div key={i} className="text-[11px] text-red-700">{d}</div>)}
            </div>
          )}

          {b && b.matched.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Contributing</div>
              {b.matched.map((m, i) => (
                <div key={i} className="flex items-start justify-between gap-2 text-[11px]">
                  <span className="text-emerald-700 font-medium tabular-nums">+{m.points}</span>
                  <span className="flex-1 text-right text-muted-foreground">{m.explanation.replace(/^\+?\d+\s*/, "")}</span>
                </div>
              ))}
            </div>
          )}

          {b && b.negative.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Detracting</div>
              {b.negative.map((m, i) => (
                <div key={i} className="flex items-start justify-between gap-2 text-[11px]">
                  <span className="text-red-600 font-medium tabular-nums">{m.points}</span>
                  <span className="flex-1 text-right text-muted-foreground">{m.explanation.replace(/^-?\d+\s*/, "")}</span>
                </div>
              ))}
            </div>
          )}

          {b && b.missed.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground">Not matched ({b.missed.length})</summary>
              <div className="mt-1 space-y-0.5">
                {b.missed.map((m, i) => <div key={i} className="text-[11px] text-muted-foreground/70">{m.explanation}</div>)}
              </div>
            </details>
          )}

          {history.data && history.data.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground">History ({history.data.length})</summary>
              <div className="mt-1 space-y-1">
                {history.data.map((h: any) => {
                  const prev = h.previousScore == null ? null : Number(h.previousScore);
                  const next = Number(h.newScore);
                  const Icon = prev == null || next === prev ? Minus : next > prev ? TrendingUp : TrendingDown;
                  const color = prev == null || next === prev ? "text-muted-foreground" : next > prev ? "text-emerald-600" : "text-red-600";
                  return (
                    <div key={h.id} className="flex items-center gap-2 text-[11px]">
                      <Icon className={`size-3 ${color}`} />
                      <span className="tabular-nums">{prev == null ? "—" : Math.round(prev)} → {Math.round(next)}</span>
                      <span className="text-muted-foreground">{h.newRating}</span>
                      <span className="ml-auto text-muted-foreground/60">{new Date(h.changedAt).toLocaleDateString()}</span>
                    </div>
                  );
                })}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
