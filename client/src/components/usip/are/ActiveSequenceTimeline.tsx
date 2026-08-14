/**
 * The live state of an enrolled prospect's sequence, shown inline in the
 * campaign's Sequences tab (owner ask 2026-08-14: "make sure the current
 * active sequence is visualized in the Active tab").
 *
 * The steps were only ever visible behind a click into the side drawer, and
 * even there they were the STORED copy — what the sequence says, never where
 * it has got to. This joins the two: each generated step against its execution
 * queue row, so a glance answers the question an Active tab is actually asked —
 * what has gone out, what is next, and when.
 *
 * The join is on `stepIndexOf` from @shared/areSequenceSteps, the one rule the
 * engine and the A/B metadata already share. A step index derived a second time
 * here is a join key that agrees only by luck — which is precisely how the
 * opener's variant card once ended up empty beside a phantom cell.
 */
import { stepIndexOf } from "@shared/areSequenceSteps";
import { cn } from "@/lib/utils";
import { Check, Clock, Ban, AlertTriangle, Pause } from "lucide-react";

export interface ExecRow {
  prospectQueueId: number;
  stepIndex: number;
  channel: string;
  status: "scheduled" | "sent" | "failed" | "skipped" | "paused";
  scheduledAt: string | Date | null;
  sentAt?: string | Date | null;
}

const STATE = {
  sent: { icon: Check, cls: "text-emerald-600 dark:text-emerald-400", ring: "border-emerald-500/40 bg-emerald-500/10" },
  scheduled: { icon: Clock, cls: "text-muted-foreground", ring: "border-border bg-muted/40" },
  paused: { icon: Pause, cls: "text-amber-600 dark:text-amber-400", ring: "border-amber-500/40 bg-amber-500/10" },
  failed: { icon: AlertTriangle, cls: "text-rose-600 dark:text-rose-400", ring: "border-rose-500/40 bg-rose-500/10" },
  skipped: { icon: Ban, cls: "text-muted-foreground/70", ring: "border-border bg-muted/20" },
} as const;

function when(d: string | Date | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ActiveSequenceTimeline({
  steps,
  exec,
  className,
}: {
  /** The prospect's stored generatedSequence. */
  steps: unknown[];
  /** That prospect's execution-queue rows. */
  exec: ExecRow[];
  className?: string;
}) {
  if (!Array.isArray(steps) || steps.length === 0) return null;

  const byIndex = new Map<number, ExecRow>();
  for (const e of exec) if (!byIndex.has(e.stepIndex)) byIndex.set(e.stepIndex, e);

  // The next thing that will actually happen: earliest still-scheduled step.
  const upcoming = exec
    .filter((e) => e.status === "scheduled" && e.scheduledAt)
    .sort((a, b) => new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime())[0];

  const sent = exec.filter((e) => e.status === "sent").length;

  return (
    <div className={cn("rounded-md border border-border/70 bg-muted/20 px-2.5 py-2", className)}>
      <div className="mb-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-medium text-foreground/80">Sequence progress</span>
        <span className="tabular-nums">{sent}/{steps.length} sent</span>
        {upcoming && (
          <span className="ml-auto">
            next: step {upcoming.stepIndex + 1} · {when(upcoming.scheduledAt)}
          </span>
        )}
      </div>
      <ol className="flex flex-wrap items-stretch gap-1">
        {steps.map((raw, pos) => {
          const idx = stepIndexOf(raw, pos);
          const row = byIndex.get(idx);
          const s = (raw ?? {}) as Record<string, unknown>;
          // No execution row yet = enrolled but not scheduled to here, which is
          // a real state, not an error. Shown as pending rather than invented.
          const state = STATE[(row?.status ?? "scheduled") as keyof typeof STATE] ?? STATE.scheduled;
          const Icon = state.icon;
          const isNext = !!upcoming && row === upcoming;
          const subject = String(s.subject ?? "").trim();
          return (
            <li
              key={pos}
              className={cn(
                "flex min-w-0 flex-1 basis-[120px] flex-col gap-0.5 rounded border px-1.5 py-1",
                state.ring,
                isNext && "ring-1 ring-sky-400",
              )}
              title={subject || `Step ${idx + 1}`}
            >
              <span className={cn("flex items-center gap-1 text-[10px] font-medium", state.cls)}>
                <Icon className="size-3 shrink-0" />
                Step {idx + 1}
                {row && <span className="ml-auto font-normal">{when(row.sentAt ?? row.scheduledAt)}</span>}
              </span>
              {subject && <span className="truncate text-[10px] text-muted-foreground">{subject}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
