/**
 * BookingManagePage — /m/b/:token, a booking's own page (audit 2026-10-20,
 * F47). The booking confirmation and the calendar invite link here, so the
 * person who booked can move the meeting to another open time, cancel it, or
 * save it to their calendar, without writing in. No Shell, no sign-in.
 *
 * Opening it changes nothing (mail scanners open every link): moving and
 * cancelling are buttons, each confirmed. Times show in the visitor's zone.
 */
import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CalendarCheck, CalendarX, CheckCircle2, Clock, Download, Loader2, Video } from "lucide-react";
import { usePageTitle } from "@/lib/usePageTitle";
import { downloadIcs } from "@/lib/icsDownload";

export default function BookingManagePage() {
  const [, params] = useRoute("/m/b/:token");
  const token = params?.token ?? "";
  const view = trpc.bookingLinks.manageGet.useQuery({ token }, { enabled: token.length >= 32, retry: false, refetchOnWindowFocus: false });
  usePageTitle(view.data?.title ?? "Your booking");
  const [mode, setMode] = useState<"view" | "move" | "cancel">("view");
  const [picked, setPicked] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reschedule = trpc.bookingLinks.manageReschedule.useMutation({
    onSuccess: () => { setError(null); setMode("view"); setPicked(null); setNotice("Your meeting has been moved. The host has been told."); void view.refetch(); },
    onError: (e) => { setError(e.message); void view.refetch(); },
    meta: { silentError: true },
  });
  const cancel = trpc.bookingLinks.manageCancel.useMutation({
    onSuccess: () => { setError(null); setMode("view"); setNotice(null); void view.refetch(); },
    onError: (e) => { setError(e.message); void view.refetch(); },
    meta: { silentError: true },
  });

  const fmtFull = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const d = view.data;

  // Open times grouped by the visitor's local day, as on the booking page.
  const days = useMemo(() => {
    const groups = new Map<string, { label: string; times: string[] }>();
    for (const iso of d?.slots ?? []) {
      const t = new Date(iso);
      if (Number.isNaN(t.getTime())) continue;
      const key = t.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      if (!groups.has(key)) groups.set(key, { label: key, times: [] });
      groups.get(key)!.times.push(iso);
    }
    return Array.from(groups.values());
  }, [d?.slots]);

  const saveToCalendar = () => {
    if (!d?.scheduledAt) return;
    downloadIcs({
      uid: d.icsUid, title: d.title, startAt: new Date(d.scheduledAt), durationMin: d.durationMin,
      description: `With ${d.hostName}.`, url: typeof window !== "undefined" ? window.location.href : null,
    });
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-lg rounded-2xl border bg-card shadow-sm p-6">
        {view.isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : !d ? (
          <div className="text-center py-12">
            <h1 className="text-sm font-medium">This booking link isn't valid any more</h1>
            <p className="text-xs text-muted-foreground mt-1">Reply to your confirmation email to reach the host.</p>
          </div>
        ) : d.state === "cancelled" ? (
          <div className="text-center py-12">
            <CalendarX className="size-10 mx-auto text-muted-foreground mb-3" />
            <h1 className="text-base font-semibold">This meeting is cancelled</h1>
            <p className="text-xs text-muted-foreground mt-1">{d.hostName} has been told. You're welcome to book again from their booking page.</p>
          </div>
        ) : d.state !== "open" ? (
          <div className="text-center py-12">
            <h1 className="text-sm font-medium">{d.state === "past" ? "This meeting has already happened" : "This meeting can no longer be changed here"}</h1>
            <p className="text-xs text-muted-foreground mt-1">Reply to your confirmation email to reach {d.hostName}.</p>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-start gap-3">
              <span className="shrink-0 size-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center"><CalendarCheck className="size-5" /></span>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold tracking-tight">{d.title}</h1>
                <p className="text-sm text-muted-foreground">
                  with {d.hostName} · <Clock className="inline size-3.5 -mt-0.5" /> {d.durationMin} min
                </p>
                {d.scheduledAt && <p className="text-sm font-medium mt-1.5">{fmtFull(d.scheduledAt)}</p>}
              </div>
            </div>
            {notice && <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-[12.5px] text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5"><CheckCircle2 className="size-4" /> {notice}</div>}
            {error && <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-[12.5px] text-amber-800 dark:text-amber-300">{error}</div>}

            {mode === "view" && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={saveToCalendar}><Download className="size-4" /> Add to calendar (.ics)</Button>
                {d.meetingUrl && (
                  <a href={d.meetingUrl} target="_blank" rel="noreferrer"><Button variant="outline" size="sm" className="gap-1.5"><Video className="size-4" /> Meeting link</Button></a>
                )}
                {d.canReschedule && <Button variant="outline" size="sm" onClick={() => { setMode("move"); setError(null); setNotice(null); }}>Reschedule</Button>}
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => { setMode("cancel"); setError(null); setNotice(null); }}>Cancel meeting</Button>
              </div>
            )}

            {mode === "move" && (
              <div className="space-y-3">
                <div className="text-[13px] font-medium">Pick a new time</div>
                {days.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No other times are open in the next two weeks. Reply to your confirmation to find one with {d.hostName}.</p>
                ) : (
                  <div className="space-y-3 max-h-[45vh] overflow-auto pr-1">
                    {days.map((g) => (
                      <div key={g.label}>
                        <div className="text-xs font-semibold text-muted-foreground mb-1.5">{g.label}</div>
                        <div className="grid grid-cols-3 gap-2">
                          {g.times.map((iso) => (
                            <button key={iso} type="button" onClick={() => setPicked(iso)} aria-pressed={picked === iso}
                              className={"rounded-lg border px-2 py-2 text-[13px] font-medium transition-colors " + (picked === iso ? "border-primary ring-2 ring-primary/30 bg-primary/5" : "hover:border-primary hover:text-primary")}>
                              {fmtTime(iso)}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" size="sm" disabled={reschedule.isPending} onClick={() => { setMode("view"); setPicked(null); }}>Back</Button>
                  <Button size="sm" disabled={!picked || reschedule.isPending} onClick={() => picked && reschedule.mutate({ token, startAt: picked })}>
                    {reschedule.isPending ? <Loader2 className="size-4 animate-spin mr-1.5" /> : null}
                    {picked ? `Move to ${fmtFull(picked)}` : "Pick a time"}
                  </Button>
                </div>
              </div>
            )}

            {mode === "cancel" && (
              <div className="rounded-lg border p-3 space-y-2">
                <label htmlFor="bm-reason" className="text-[12.5px] font-medium">Cancel this meeting with {d.hostName}?</label>
                <Textarea id="bm-reason" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional: a note for them" />
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => setMode("view")}>Keep it</Button>
                  <Button variant="destructive" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate({ token, reason: reason.trim() || undefined })}>
                    {cancel.isPending ? <Loader2 className="size-4 animate-spin mr-1.5" /> : null}
                    Cancel meeting
                  </Button>
                </div>
              </div>
            )}
            <p className="text-[10px] text-center text-muted-foreground">Powered by Velocity</p>
          </div>
        )}
      </div>
    </div>
  );
}
