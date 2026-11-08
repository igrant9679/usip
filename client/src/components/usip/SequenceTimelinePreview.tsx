/**
 * SequenceTimelinePreview — when this sequence's steps really happen for
 * someone who enrols now, or at a time you pick (audit 2026-10-20, U4).
 *
 * Projected on the server with the engine's own rules (@shared/sequenceTimeline):
 * waits counted once, the sequence's window in its zone, weekends, the
 * workspace send window that holds LinkedIn steps and auto-send, and with
 * recipient time on, an example person's zone. Each row says why a step is
 * later than you might expect. Read only.
 */
import { useMemo, useState } from "react";
import { CalendarClock, Info, PauseCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

function fmt(ms: number | null | undefined, zone: string): string {
  if (ms == null) return "—";
  return new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
}

/** A local datetime-input value ("YYYY-MM-DDTHH:MM") for an instant, in the browser's zone. */
function localInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function SequenceTimelinePreview({ sequenceId, accent, className }: { sequenceId: number; accent: string; className?: string }) {
  // Enrol "now" by default; a picked start stays put while you look.
  const [start, setStart] = useState<string>("");
  const startAt = useMemo(() => (start ? new Date(start).toISOString() : undefined), [start]);
  const q = trpc.sequenceTimeline.preview.useQuery({ sequenceId, ...(startAt ? { startAt } : {}) }, { retry: false, enabled: Number.isFinite(sequenceId) });
  const data = q.data;
  return (
    <section className={cn("rounded-xl border bg-card shadow-sm p-4 space-y-3", className)} aria-label="Timeline preview">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarClock className="size-4" style={{ color: accent }} />
        <h2 className="text-sm font-semibold">Timeline preview</h2>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          If someone enrols
          <input
            aria-label="Enrolment time for the preview"
            type="datetime-local"
            value={start || (data ? localInput(data.startMs) : "")}
            onChange={(e) => setStart(e.target.value)}
            className="h-7 rounded-md border bg-background px-1.5 text-[11.5px]"
          />
        </label>
        {start ? <button type="button" className="text-[11.5px] underline" onClick={() => setStart("")}>Now</button> : null}
      </div>

      {q.isLoading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-8 rounded bg-muted/50 animate-pulse" />)}</div>
      ) : q.error ? (
        <p className="text-[12px] text-muted-foreground">Couldn't project the timeline: {q.error.message}</p>
      ) : !data || data.entries.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">Add a step to see when it would go out.</p>
      ) : (
        <>
          <p className="text-[11.5px] text-muted-foreground">
            Times in {data.emailZone}
            {data.recipient ? ` (${data.recipient.label}'s zone, from ${data.recipient.source === "stored" ? "their People record" : data.recipient.source === "location" ? "their state or province" : "the sequence"})` : data.zoneSource === "sequence" ? " (the sequence's own zone)" : " (the workspace's zone)"}
            . Emails are drafted {data.sequenceWindow.start}–{data.sequenceWindow.end}{data.sequenceWindow.skipWeekends ? ", weekdays" : ", every day"}; LinkedIn steps and auto-send wait for the workspace window ({data.workspaceWindow}).
          </p>
          {data.outboundPaused ? (
            <div role="status" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <PauseCircle className="size-3.5 mt-0.5 shrink-0" />
              Outbound is paused in this workspace: nothing goes out until it is switched off. The dates below are for once it is.
            </div>
          ) : null}
          <ol className="space-y-1.5">
            {data.entries.map((e) => (
              <li key={e.index} className={cn("rounded-md border px-3 py-2 text-[12.5px]", e.skipped && "opacity-60")}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[11px] tabular-nums text-muted-foreground w-6">{e.index + 1}.</span>
                  <span className="font-medium">{e.label}</span>
                  <span className="ml-auto tabular-nums text-muted-foreground">
                    {e.type === "wait"
                      ? `until ${fmt(e.untilMs, data.emailZone)}`
                      : e.type === "email" && !e.skipped
                        ? `drafted ${fmt(e.atMs, data.emailZone)}${e.sentAtMs != null && e.sentAtMs !== e.atMs ? ` · sent ${fmt(e.sentAtMs, data.emailZone)}` : ""}`
                        : fmt(e.atMs, data.emailZone)}
                  </span>
                </div>
                {e.notes.length > 0 && <div className="pl-8 text-[11px] text-muted-foreground">{e.notes.join(" ")}</div>}
              </li>
            ))}
          </ol>
          <ul className="space-y-0.5 text-[11px] text-muted-foreground">
            {data.assumptions.map((a) => (
              <li key={a} className="flex items-start gap-1.5"><Info className="size-3 mt-0.5 shrink-0" />{a}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
