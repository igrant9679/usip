/**
 * ScoreFilterControl — People-toolbar popover for filtering + sorting by the
 * primary person Fit score. Filtering/sorting is applied server-side by
 * prospects.list (so it spans the whole dataset, not just the loaded page).
 */
import { Gauge, Check, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type MinRating = "" | "fair" | "good" | "excellent";
export type ScoreSort = "" | "asc" | "desc";

const RATING_OPTS: { v: MinRating; label: string }[] = [
  { v: "", label: "Any rating" },
  { v: "fair", label: "Fair or better" },
  { v: "good", label: "Good or better" },
  { v: "excellent", label: "Excellent only" },
];
const SORT_OPTS: { v: ScoreSort; label: string }[] = [
  { v: "", label: "Default order" },
  { v: "desc", label: "Highest score first" },
  { v: "asc", label: "Lowest score first" },
];

export function ScoreFilterControl({
  minRating, onMinRating, hideDisqualified, onHideDisqualified, sort, onSort,
}: {
  minRating: MinRating; onMinRating: (r: MinRating) => void;
  hideDisqualified: boolean; onHideDisqualified: (v: boolean) => void;
  sort: ScoreSort; onSort: (s: ScoreSort) => void;
}) {
  const active = !!minRating || hideDisqualified || !!sort;
  const Row = ({ selected, label, onClick }: { selected: boolean; label: string; onClick: () => void }) => (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex w-full items-center justify-between rounded px-2 py-1 text-[12px] hover:bg-muted", selected && "font-medium")}
    >
      <span>{label}</span>
      {selected && <Check className="size-3.5 text-primary" />}
    </button>
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={active ? "default" : "outline"} size="sm" className="gap-1.5">
          <Gauge className="size-4" /> Score{active ? " •" : ""}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2 space-y-2">
        <div>
          <div className="px-2 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Minimum rating</div>
          {RATING_OPTS.map((o) => (
            <Row key={o.v} selected={minRating === o.v} label={o.label} onClick={() => onMinRating(o.v)} />
          ))}
        </div>
        <div className="border-t pt-2">
          <Row selected={hideDisqualified} label="Hide disqualified" onClick={() => onHideDisqualified(!hideDisqualified)} />
        </div>
        <div className="border-t pt-2">
          <div className="px-2 pb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground"><ArrowUpDown className="size-3" /> Sort by score</div>
          {SORT_OPTS.map((o) => (
            <Row key={o.v} selected={sort === o.v} label={o.label} onClick={() => onSort(o.v)} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
