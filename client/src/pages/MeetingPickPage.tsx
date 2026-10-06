/**
 * MeetingPickPage — /m/:token, where a proposal email's time links land
 * (owner ask 2026-10-06: "No event until accepted").
 *
 * Opening it books nothing: mail scanners open every link. The visitor picks
 * a time (the link they clicked is preselected, ?t=index) and presses
 * Confirm; only that puts the meeting on the host's calendar and sends the
 * calendar invite. Times show in the visitor's own zone, with the host's
 * zone alongside. No Shell, no sign-in.
 */
import { useMemo, useState } from "react";
import { useRoute, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { CalendarCheck, CheckCircle2, Clock, Loader2, Video } from "lucide-react";

export default function MeetingPickPage() {
  const [, params] = useRoute("/m/:token");
  const token = params?.token ?? "";
  const search = useSearch();
  const view = trpc.meetingPicks.get.useQuery({ token }, { enabled: token.length >= 16, retry: false, refetchOnWindowFocus: false });
  const confirm = trpc.meetingPicks.confirm.useMutation({
    onSuccess: () => { setError(null); void view.refetch(); },
    onError: (e) => { setError(e.message); void view.refetch(); },
    meta: { silentError: true },
  });
  const [error, setError] = useState<string | null>(null);

  const times = view.data?.times ?? [];
  const linked = useMemo(() => {
    const i = Number(new URLSearchParams(search).get("t"));
    return Number.isInteger(i) && i >= 0 && i < times.length ? times[i]?.iso ?? null : null;
  }, [search, times]);
  const [picked, setPicked] = useState<string | null>(null);
  const firstAvailable = times.find((t) => t.available)?.iso ?? null;
  const chosen = picked ?? (linked && times.find((t) => t.iso === linked)?.available ? linked : firstAvailable);

  const localZone = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ""; }
  }, []);
  const fmtLocal = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const fmtHost = (iso: string, tz: string) => {
    try { return new Date(iso).toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", timeZoneName: "short" }); } catch { return ""; }
  };

  const d = view.data;
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-lg rounded-2xl border bg-card shadow-sm p-6">
        {view.isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : !d ? (
          <div className="text-center py-12">
            <div className="text-sm font-medium">This link isn't valid any more</div>
            <p className="text-xs text-muted-foreground mt-1">Reply to the email you received to find a time.</p>
          </div>
        ) : d.state === "confirmed" && d.scheduledAt ? (
          <div className="text-center py-10">
            <CheckCircle2 className="size-11 mx-auto text-emerald-500 mb-3" />
            <div className="text-lg font-semibold">You're confirmed</div>
            <p className="text-sm text-muted-foreground mt-1.5">
              {d.title} with {d.ownerName}{d.company ? ` (${d.company})` : ""} is set for<br />
              <span className="font-medium text-foreground">{fmtLocal(d.scheduledAt)}</span>.
            </p>
            <p className="text-xs text-muted-foreground mt-3">The calendar invite is on its way to your inbox.</p>
            {d.meetingUrl && (
              <a href={d.meetingUrl} target="_blank" rel="noreferrer" className="inline-block mt-4">
                <Button variant="outline" size="sm" className="gap-1.5"><Video className="size-4" /> Meeting link</Button>
              </a>
            )}
          </div>
        ) : d.state === "expired" ? (
          <div className="text-center py-12">
            <div className="text-sm font-medium">These times have passed</div>
            <p className="text-xs text-muted-foreground mt-1">Reply to {d.ownerName}'s email to find another time.</p>
          </div>
        ) : d.state === "closed" ? (
          <div className="text-center py-12">
            <div className="text-sm font-medium">This invitation is no longer open</div>
            <p className="text-xs text-muted-foreground mt-1">Reply to {d.ownerName}'s email if you'd still like to meet.</p>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-start gap-3">
              <span className="shrink-0 size-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center"><CalendarCheck className="size-5" /></span>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold tracking-tight">{d.title}</h1>
                <p className="text-sm text-muted-foreground">
                  with {d.ownerName}{d.company ? ` · ${d.company}` : ""} · <Clock className="inline size-3.5 -mt-0.5" /> {d.durationMin} min
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <div className="text-[13px] font-medium">Pick a time{localZone ? <span className="font-normal text-muted-foreground"> (shown in your time, {localZone})</span> : null}</div>
              {times.map((t) => (
                <button
                  key={t.iso}
                  type="button"
                  disabled={!t.available || confirm.isPending}
                  onClick={() => { setPicked(t.iso); setError(null); }}
                  className={
                    "w-full text-left rounded-lg border px-3.5 py-2.5 transition-colors " +
                    (!t.available ? "opacity-50 cursor-not-allowed line-through" : chosen === t.iso ? "border-primary ring-2 ring-primary/30 bg-primary/5" : "hover:bg-muted")
                  }
                >
                  <div className="text-sm font-medium">{fmtLocal(t.iso)}</div>
                  <div className="text-[11.5px] text-muted-foreground">
                    {t.available ? `${fmtHost(t.iso, d.timezone)} for ${d.ownerName}` : "No longer available"}
                  </div>
                </button>
              ))}
            </div>
            {error && <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-300">{error}</div>}
            {chosen ? (
              <Button className="w-full" disabled={confirm.isPending} onClick={() => confirm.mutate({ token, time: chosen })}>
                {confirm.isPending ? <Loader2 className="size-4 animate-spin mr-1.5" /> : null}
                Confirm {fmtLocal(chosen)}
              </Button>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">None of these times are available any more. Reply to {d.ownerName}'s email to find another.</p>
            )}
            <p className="text-[11.5px] text-muted-foreground text-center">Confirming sends you a calendar invite. None of these work? Just reply to the email.</p>
          </div>
        )}
      </div>
    </div>
  );
}
