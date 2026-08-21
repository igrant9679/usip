/**
 * One workflow card in the enrichment-job builder: rounded, thin border,
 * subtle shadow, centered icon + label. A real <button>, so keyboard
 * activation, focus-visible rings and disabled semantics come from the
 * platform instead of a re-implementation.
 *
 * States: disabled (locked until the prior step completes), todo (plus icon),
 * completed (check + the chosen value), and `active` while its picker dialog
 * is open. Hover/press are Tailwind transitions on the enabled states.
 */
import { Check, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export function ActionCard({
  label,
  sublabel,
  completed,
  disabled,
  active,
  onClick,
}: {
  label: string;
  /** Shown under the label — the chosen value once completed. */
  sublabel?: string | null;
  completed: boolean;
  disabled: boolean;
  /** True while this card's picker is open. */
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-disabled={disabled}
      aria-label={`${label}${completed && sublabel ? ` — ${sublabel}` : disabled ? " — locked until the previous step is set" : ""}`}
      onClick={onClick}
      className={cn(
        "w-full rounded-xl border bg-card px-4 py-3.5 shadow-sm",
        "flex flex-col items-center gap-1.5 text-center select-none",
        "transition-all duration-150 outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        disabled
          ? "opacity-50 cursor-not-allowed"
          : "cursor-pointer hover:shadow-md hover:border-primary/40 active:scale-[0.99]",
        completed && "border-emerald-500/40 bg-emerald-500/5",
        active && "ring-2 ring-sky-400/70 border-sky-400/50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-7 items-center justify-center rounded-full border transition-colors",
          completed
            ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "border-border bg-muted/40 text-muted-foreground",
        )}
      >
        {completed ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
      </span>
      <span className="text-[13px] font-medium leading-tight">{label}</span>
      {sublabel && (
        <span className={cn("text-[11px] leading-tight", completed ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
          {sublabel}
        </span>
      )}
    </button>
  );
}
