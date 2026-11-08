/**
 * BookingPage — hosted, unauthenticated self-serve meeting scheduler at /b/:slug.
 *
 * Loads the rep's open availability (bookingLinks.getPublic) and books a chosen
 * slot (bookingLinks.book), which creates an inbound lead + a real calendar
 * event on the rep's calendar. No Shell, no auth — standalone page. Slots come
 * as ISO strings and are shown in the visitor's local timezone.
 */
import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CalendarCheck, CheckCircle2, Clock, Download, Loader2, ChevronLeft } from "lucide-react";
import { downloadIcs } from "@/lib/icsDownload";
import ChatLauncher from "@/components/ChatLauncher";
import { usePageTitle } from "@/lib/usePageTitle";
import { nextOpenAfter } from "@shared/availability";

export default function BookingPage() {
  const [, params] = useRoute("/b/:slug");
  const slug = params?.slug ?? "";

  const link = trpc.bookingLinks.getPublic.useQuery({ slug }, { enabled: !!slug, retry: false });
  usePageTitle(link.data?.title);
  const book = trpc.bookingLinks.book.useMutation();

  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [done, setDone] = useState(false);
  const [calendarBooked, setCalendarBooked] = useState(false);
  // No invite went and a confirmation email did instead (tracker item 10).
  const [confirmationSent, setConfirmationSent] = useState(false);
  // The booking's own page, to reschedule or cancel (F47).
  const [manageUrl, setManageUrl] = useState<string | null>(null);
  const [icsUid, setIcsUid] = useState<string | null>(null);

  const tz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "your local time"; }
  }, []);

  // Group ISO slots by local day for a clean picker.
  const days = useMemo(() => {
    const slots: string[] = Array.isArray(link.data?.slots) ? (link.data!.slots as string[]) : [];
    const groups = new Map<string, { label: string; times: string[] }>();
    for (const iso of slots) {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) continue;
      const key = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      if (!groups.has(key)) groups.set(key, { label: key, times: [] });
      groups.get(key)!.times.push(iso);
    }
    return [...groups.values()];
  }, [link.data]);

  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const fmtFull = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

  // The slot was taken (or the calendar now shows it busy) between loading the
  // page and booking (G42): the list is read again and the next open times
  // after the one they wanted are offered here, keeping what they typed.
  const [nextFree, setNextFree] = useState<string[] | null>(null);
  const onBook = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const wanted = selected;
    setNextFree(null);
    book.mutate({ slug, startAt: wanted, name, email, notes: notes || undefined }, {
      onSuccess: (r: any) => { setCalendarBooked(!!r?.calendarBooked); setConfirmationSent(!!r?.confirmationSent); setManageUrl(typeof r?.manageUrl === "string" ? r.manageUrl : null); setIcsUid(typeof r?.icsUid === "string" ? r.icsUid : null); setDone(true); },
      onError: (err) => {
        if (err.data?.code !== "CONFLICT") return;
        void link.refetch().then((r) => {
          const slots: string[] = Array.isArray(r.data?.slots) ? (r.data!.slots as string[]) : [];
          setNextFree(nextOpenAfter(slots, wanted, 3));
        });
      },
    });
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-lg rounded-2xl border bg-card shadow-sm p-6">
        {link.isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : !link.data ? (
          <div className="text-center py-12">
            <div className="text-sm font-medium">Booking link not available</div>
            <p className="text-xs text-muted-foreground mt-1">This link may have been paused or removed.</p>
          </div>
        ) : done ? (
          <div className="text-center py-12">
            <CheckCircle2 className="size-11 mx-auto text-emerald-500 mb-3" />
            <div className="text-lg font-semibold">You're booked!</div>
            <p className="text-sm text-muted-foreground mt-1.5">
              Your meeting with {link.data.ownerName} is set for<br />
              <span className="font-medium text-foreground">{selected ? fmtFull(selected) : ""}</span>.
            </p>
            <p className="text-xs text-muted-foreground mt-3">
              {/* Each line says only what happened. "Will confirm shortly" was the
                  whole answer whenever no invite went, and nothing followed it. */}
              {calendarBooked
                ? <>A calendar invite is on its way to {email}.</>
                : confirmationSent
                  ? <>A confirmation email is on its way to {email}.</>
                  : <>We've noted your details, but no email could be sent to you — {link.data.ownerName} will be in touch to confirm.</>}
            </p>
            {/* F47: save it, or change it, without writing in. */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {selected && (
                <Button variant="outline" size="sm" className="gap-1.5"
                  onClick={() => downloadIcs({ uid: icsUid ?? `booking-${slug}-${selected}`, title: link.data!.title, startAt: new Date(selected), durationMin: link.data!.durationMin, description: `With ${link.data!.ownerName}.`, url: manageUrl })}>
                  <Download className="size-4" /> Add to calendar (.ics)
                </Button>
              )}
              {manageUrl && (
                <a href={manageUrl} className="text-xs text-muted-foreground underline hover:text-foreground">Reschedule or cancel</a>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-start gap-3">
              <span className="shrink-0 size-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center"><CalendarCheck className="size-5" /></span>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold tracking-tight">{link.data.title}</h1>
                <p className="text-sm text-muted-foreground">
                  with {link.data.ownerName} · <Clock className="inline size-3.5 -mt-0.5" /> {link.data.durationMin} min
                </p>
                {link.data.description && <p className="text-sm text-muted-foreground mt-1">{link.data.description}</p>}
              </div>
            </div>

            {!selected ? (
              <>
                {days.length === 0 ? (
                  <div className="text-center py-10 text-sm text-muted-foreground">No open times in the next two weeks. Please check back soon.</div>
                ) : (
                  <div className="space-y-4 max-h-[52vh] overflow-auto pr-1">
                    <p className="text-[11px] text-muted-foreground">Times shown in {tz}</p>
                    {days.map((d) => (
                      <div key={d.label}>
                        <div className="text-xs font-semibold text-muted-foreground mb-1.5">{d.label}</div>
                        <div className="grid grid-cols-3 gap-2">
                          {d.times.map((iso) => (
                            <button key={iso} onClick={() => setSelected(iso)}
                              className="rounded-lg border px-2 py-2 text-[13px] font-medium hover:border-primary hover:text-primary transition-colors">
                              {fmtTime(iso)}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <form onSubmit={onBook} className="space-y-4">
                <button type="button" onClick={() => { setSelected(null); setNextFree(null); book.reset(); }} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <ChevronLeft className="size-3.5" /> Back to times
                </button>
                <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm font-medium flex items-center gap-2">
                  <CalendarCheck className="size-4 text-primary" /> {fmtFull(selected)}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="b-name">Your name *</Label>
                  <Input id="b-name" required value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="b-email">Email *</Label>
                  <Input id="b-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="b-notes">Anything to share? (optional)</Label>
                  <Textarea id="b-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>
                {book.error && <p className="text-xs text-rose-600">{book.error.message}</p>}
                {nextFree && (
                  nextFree.length > 0 ? (
                    <div className="space-y-1.5" aria-live="polite">
                      <div className="text-xs font-medium">The next open times:</div>
                      <div className="grid grid-cols-1 gap-1.5">
                        {nextFree.map((iso) => (
                          <button key={iso} type="button" onClick={() => { setSelected(iso); setNextFree(null); book.reset(); }}
                            className="rounded-lg border px-2 py-1.5 text-[13px] font-medium text-left hover:border-primary hover:text-primary transition-colors">
                            {fmtFull(iso)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No later times are open in the next two weeks. Go back to see every open time.</p>
                  )
                )}
                <Button type="submit" className="w-full" disabled={book.isPending}>
                  {book.isPending ? <><Loader2 className="size-4 animate-spin mr-1.5" /> Booking…</> : "Confirm booking"}
                </Button>
              </form>
            )}
            <p className="text-[10px] text-center text-muted-foreground">Powered by Velocity</p>
          </div>
        )}
      </div>

      {/* Hesitation on a booking page is a question nobody is there to answer. */}
      <ChatLauncher slug={link.data?.chatSlug} />
    </div>
  );
}
