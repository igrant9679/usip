/**
 * Scoring UI — explainable score badges for the Velocity Priority Score system.
 *
 * `ScoreBadge`   — a compact, rating-coloured pill (Excellent / Good / Fair /
 *                  Not a fit) showing the rounded score.
 * `ScorePopover` — wraps a trigger; on open, lazily fetches the fit-model
 *                  breakdown (matched / missed / negative / disqualifiers) plus
 *                  the six Velocity Priority Score components, so every score is
 *                  explainable inline. Used in the People table Score column,
 *                  the open drawer, and full profile.
 *
 * Fetching is lazy (enabled only while open) so a 50-row table doesn't fire 50
 * queries — the table batches scores via trpc.scoring.scoreMap instead and
 * passes them straight into the badge.
 */
import { useState, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";

export type ObjectType = "person" | "company";
export type Rating = "excellent" | "good" | "fair" | "not_a_fit" | null | undefined;

const RATING_STYLE: Record<string, string> = {
  excellent: "bg-emerald-100 text-emerald-800 border-emerald-200",
  good: "bg-blue-100 text-blue-800 border-blue-200",
  fair: "bg-amber-100 text-amber-800 border-amber-200",
  not_a_fit: "bg-gray-100 text-gray-600 border-gray-200",
};
const RATING_LABEL: Record<string, string> = {
  excellent: "Excellent", good: "Good", fair: "Fair", not_a_fit: "Not a fit",
};

export function ScoreBadge({
  score, rating, showLabel = false, className, muted = false,
}: {
  score?: number | string | null;
  rating?: Rating;
  showLabel?: boolean;
  className?: string;
  muted?: boolean;
}) {
  if (score == null || rating == null) {
    return <span className={cn("text-[11px] text-muted-foreground", className)}>{muted ? "—" : "Not scored"}</span>;
  }
  const n = Math.round(Number(score));
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium tabular-nums", RATING_STYLE[rating] ?? RATING_STYLE.not_a_fit, className)}
      title={`${RATING_LABEL[rating] ?? rating} · ${n}`}
    >
      {showLabel && <span>{RATING_LABEL[rating] ?? rating}</span>}
      <span>{n}</span>
    </span>
  );
}

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

export function ScorePopover({
  objectType, objectId, children,
}: {
  objectType: ObjectType;
  objectId: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bd = trpc.scoring.getBreakdown.useQuery({ objectType, objectId }, { enabled: open, staleTime: 30_000 });
  const prio = trpc.scoring.getPriority.useQuery({ objectType, objectId }, { enabled: open, staleTime: 30_000 });
  const b = bd.data;
  const p = prio.data as Record<string, string | null> | null | undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} className="cursor-pointer">{children}</button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 p-0" onClick={(e) => e.stopPropagation()}>
        <div className="border-b px-3 py-2">
          <div className="text-xs font-semibold">Why this score</div>
          {b?.summary && <div className="text-[11px] text-muted-foreground mt-0.5">{b.summary}</div>}
        </div>
        <ScrollArea className="max-h-80">
          <div className="p-3 space-y-3">
            {p && (
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Velocity Priority Score</div>
                <Bar label="Person fit" value={p.personFitScore == null ? null : Number(p.personFitScore)} weight="35%" />
                <Bar label="Company fit" value={p.companyFitScore == null ? null : Number(p.companyFitScore)} weight="30%" />
                <Bar label="Intent" value={p.intentScore == null ? null : Number(p.intentScore)} weight="15%" />
                <Bar label="Engagement" value={p.engagementScore == null ? null : Number(p.engagementScore)} weight="10%" />
                <Bar label="Data quality" value={p.dataQualityScore == null ? null : Number(p.dataQualityScore)} weight="5%" />
                <Bar label="Seq. readiness" value={p.sequenceReadinessScore == null ? null : Number(p.sequenceReadinessScore)} weight="5%" />
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
              <details className="group">
                <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground">Not matched ({b.missed.length})</summary>
                <div className="mt-1 space-y-0.5">
                  {b.missed.slice(0, 20).map((m, i) => (
                    <div key={i} className="text-[11px] text-muted-foreground/70">{m.explanation}</div>
                  ))}
                </div>
              </details>
            )}

            {open && !bd.isLoading && !b?.result && (
              <div className="text-[11px] text-muted-foreground">No score yet — run a recalculation.</div>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

/** Convenience: a Velocity Priority Score badge that opens its explanation. */
export function PriorityScoreCell({
  objectType, objectId, priority, rating,
}: {
  objectType: ObjectType; objectId: number;
  priority?: number | string | null; rating?: Rating;
}) {
  return (
    <ScorePopover objectType={objectType} objectId={objectId}>
      <ScoreBadge score={priority} rating={rating} muted />
    </ScorePopover>
  );
}
