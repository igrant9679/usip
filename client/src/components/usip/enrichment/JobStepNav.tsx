/**
 * Two-step navigation (Workflow → Settings), styled like the app's tab strips
 * (DataEnrichment, campaign detail): active step gets darker text + an accent
 * underline bar. Settings is reachable only once the workflow is complete —
 * the same gate as the footer's "Next: Settings" — and selections survive
 * switching because the state lives above this component.
 */
import { cn } from "@/lib/utils";
import type { JobStep } from "./jobFlow";

const STEPS: Array<{ key: JobStep; label: string }> = [
  { key: "workflow", label: "Workflow" },
  { key: "settings", label: "Settings" },
];

export function JobStepNav({
  step,
  onStepChange,
  settingsEnabled,
  accent,
}: {
  step: JobStep;
  onStepChange: (s: JobStep) => void;
  settingsEnabled: boolean;
  accent?: string;
}) {
  return (
    <nav aria-label="Job builder steps" className="flex items-center gap-1 border-b border-border px-4 shrink-0">
      {STEPS.map((s, i) => {
        const isActive = step === s.key;
        const disabled = s.key === "settings" && !settingsEnabled;
        return (
          <button
            key={s.key}
            type="button"
            aria-current={isActive ? "step" : undefined}
            disabled={disabled}
            title={disabled ? "Finish the workflow first" : undefined}
            onClick={() => onStepChange(s.key)}
            className={cn(
              "relative px-3 py-2 text-[13px] transition-colors outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset rounded-sm",
              isActive ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
              disabled && "opacity-50 cursor-not-allowed hover:text-muted-foreground",
            )}
          >
            <span className="mr-1.5 text-[11px] text-muted-foreground tabular-nums">{i + 1}</span>
            {s.label}
            {isActive && (
              <span
                aria-hidden
                className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-foreground"
                style={accent ? { backgroundColor: accent } : undefined}
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}
