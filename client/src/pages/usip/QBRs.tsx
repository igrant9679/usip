import { Button } from "@/components/ui/button";
import { Field, fmtDateTime, FormDialog, Section, SelectField, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, QueryError, Shell, TableSkeleton } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { invalidateCustomerReads } from "@/lib/crmCache";
import { CalendarCheck2, CalendarPlus, Plus, Sparkles, Presentation } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { SHOW_MORE_STEP, useShowMore } from "@/hooks/useShowMore";
import { toast } from "sonner";
import { buildCalendarIcs } from "@shared/ics";
import { groupQbrs, qbrDay, qbrEnd, qbrHasTime, QBR_DURATIONS, type QbrLike } from "@shared/qbrSchedule";

/** The viewer's calendar day, "YYYY-MM-DD". */
function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** "Thu, Nov 20, 2:00 PM (60 min)" for a timed QBR; the day for a day-only one. */
function whenLabel(q: QbrLike): string {
  if (!q.scheduledAt) return "No date";
  if (qbrHasTime(q)) return `${fmtDateTime(q.scheduledAt)} (${q.durationMinutes} min)`;
  const day = qbrDay(q);
  return day ? new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "No date";
}

/**
 * The QBR as an .ics file the person opens in their own calendar (audit
 * 2026-10-20, U27). Built in the browser: no calendar provider is called and
 * nothing is emailed.
 */
function downloadInvite(q: QbrLike & { aiPrep?: unknown }, customerName: string) {
  if (!q.scheduledAt) return;
  const start = new Date(q.scheduledAt);
  const prep = q.aiPrep as { agenda?: string[] } | null | undefined;
  const ics = buildCalendarIcs({
    product: "QBR",
    uid: `qbr-${q.id}@velocity`,
    title: `QBR: ${customerName}`,
    description: prep?.agenda?.length ? `Agenda:\n${prep.agenda.map((a) => `- ${a}`).join("\n")}` : "Quarterly business review",
    start,
    end: qbrHasTime(q) ? qbrEnd(q) : null,
    allDay: !qbrHasTime(q),
    day: qbrHasTime(q) ? null : qbrDay(q),
  });
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `qbr-${customerName.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || q.id}.ics`;
  a.click();
  URL.revokeObjectURL(url);
}

/** A day, and optionally a time and length, from the schedule form. */
function whenFromForm(f: FormData): { scheduledAt: string; durationMinutes?: number } | null {
  const day = String(f.get("scheduledDay") ?? "");
  if (!day) return null;
  const time = String(f.get("scheduledTime") ?? "");
  if (!time) return { scheduledAt: day };
  // The browser's own zone: "2026-11-20T14:00" read as local time.
  const at = new Date(`${day}T${time}`);
  if (Number.isNaN(at.getTime())) return null;
  return { scheduledAt: at.toISOString(), durationMinutes: Number(f.get("durationMinutes") ?? 60) || 60 };
}

/** A group's QBRs, 50 at a time (X4.2): the completed group only ever grows. */
function ShowMoreList<T>({ items, scope, render, noun }: { items: T[]; scope: string; render: (item: T) => ReactNode; noun: string }) {
  const rows = useShowMore(items, scope);
  return (
    <div className="space-y-3">
      {rows.shown.map(render)}
      {rows.remaining > 0 && (
        <button type="button" onClick={rows.showMore} className="w-full rounded-lg border px-3 py-2 text-center text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground">
          Show {Math.min(rows.remaining, SHOW_MORE_STEP)} more {noun} ({rows.remaining.toLocaleString()} not shown)
        </button>
      )}
    </div>
  );
}

const GROUPS = [
  { key: "overdue", title: "Overdue", hint: "Scheduled, and the time has passed with no notes recorded." },
  { key: "upcoming", title: "Upcoming", hint: "Soonest first." },
  { key: "completed", title: "Completed", hint: "Latest first." },
  { key: "cancelled", title: "Cancelled", hint: "" },
] as const;

export default function QBRs() {
  const utils = trpc.useUtils();
  const { data, isLoading, error, refetch } = trpc.cs.listQbrs.useQuery();
  const { data: customers } = trpc.cs.list.useQuery();
  const cMap = new Map((customers ?? []).map((c: any) => [c.id, c]));
  const [open, setOpen] = useState(false);
  const [completeFor, setCompleteFor] = useState<number | null>(null);
  const [moveFor, setMoveFor] = useState<number | null>(null);
  const schedule = trpc.cs.scheduleQbr.useMutation({ onSuccess: () => { invalidateCustomerReads(utils); setOpen(false); toast.success("QBR scheduled"); }, onError: (e) => toast.error(e.message) });
  const reschedule = trpc.cs.rescheduleQbr.useMutation({ onSuccess: () => { invalidateCustomerReads(utils); setMoveFor(null); toast.success("QBR moved"); }, onError: (e) => toast.error(e.message) });
  // Success now means the model wrote it: a failure saves nothing and the
  // server says so, instead of saving canned text under "AI prep" (R74).
  const genPrep = trpc.cs.generateQbrPrep.useMutation({ onSuccess: () => { invalidateCustomerReads(utils); toast.success("AI prep generated"); }, onError: (e) => toast.error(e.message) });
  const complete = trpc.cs.completeQbr.useMutation({ onSuccess: () => { invalidateCustomerReads(utils); setCompleteFor(null); toast.success("QBR completed"); }, onError: (e) => toast.error(e.message) });

  // Upcoming, overdue, completed and cancelled (audit 2026-10-20, U27): one
  // flat list newest first hid the overdue ones among the done ones.
  const groups = useMemo(() => groupQbrs((data ?? []) as Array<QbrLike & Record<string, any>>, new Date(), localToday()), [data]);
  const nameOf = (q: { customerId: number }) => (cMap.get(q.customerId) as any)?.account?.name ?? "Customer";

  const renderQbr = (q: any, overdue: boolean) => {
    const prep: any = q.aiPrep;
    return (
      <Section key={q.id} title={nameOf(q)} description={`${overdue ? "Overdue · " : ""}${q.status} · ${whenLabel(q)}`}
        right={
          <div className="flex flex-wrap gap-1">
            {q.status === "scheduled" && q.scheduledAt && (
              <Button size="sm" variant="ghost" onClick={() => downloadInvite(q, nameOf(q))} title="Download a calendar invite (.ics) to open in your calendar">
                <CalendarPlus className="size-3.5" /> Calendar invite
              </Button>
            )}
            {q.status === "scheduled" && <Button size="sm" variant="ghost" onClick={() => setMoveFor(q.id)}>Move</Button>}
            {q.status !== "completed" && <Button size="sm" variant="ghost" onClick={() => genPrep.mutate({ qbrId: q.id })} disabled={genPrep.isPending}><Sparkles className="size-3.5" /> AI prep</Button>}
            {q.status === "scheduled" && <Button size="sm" onClick={() => setCompleteFor(q.id)}>Complete</Button>}
          </div>
        }>
        {prep ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 text-sm">
            {(["wins", "risks", "asks", "agenda"] as const).map((k) => (
              <div key={k}>
                <div className="text-[11px] uppercase font-semibold text-muted-foreground mb-1">{k}</div>
                <ul className="space-y-1 text-xs">{(prep[k] ?? []).map((x: string, i: number) => <li key={i} className="text-muted-foreground">• {x}</li>)}</ul>
              </div>
            ))}
          </div>
        ) : <div className="p-3 text-xs text-muted-foreground">No prep generated yet.</div>}
        {q.notes && <div className="px-3 pb-3 text-xs text-muted-foreground">Notes: {q.notes}</div>}
        {/* Saved by Complete and shown nowhere until now (R74). */}
        {Array.isArray(q.nextActions) && q.nextActions.length > 0 && (
          <div className="px-3 pb-3 text-xs">
            <div className="text-[11px] uppercase font-semibold text-muted-foreground mb-1">Next actions</div>
            <ul className="space-y-1">{(q.nextActions as string[]).map((a, i) => <li key={i} className="text-muted-foreground">• {a}</li>)}</ul>
          </div>
        )}
      </Section>
    );
  };

  const whenFields = (
    <>
      <Field name="scheduledDay" label="Day" type="date" required />
      <div className="grid grid-cols-2 gap-3">
        <Field name="scheduledTime" label="Time (optional)" type="time" />
        <SelectField name="durationMinutes" label="Length" defaultValue="60" options={QBR_DURATIONS.map((m) => ({ value: String(m), label: `${m} minutes` }))} />
      </div>
      <p className="text-xs text-muted-foreground">With a time, the calendar invite blocks that slot; without one it is an all-day entry. The length applies only with a time.</p>
    </>
  );

  return (
    <Shell title="QBRs">
      <PageHeader title="Quarterly Business Reviews" description="Prepare, schedule, and record Quarterly Business Reviews with AI-generated talking points and health summaries. Share QBR decks with customers and capture action items in one structured workflow." pageKey="qbrs"
        icon={<Presentation className="size-5" />}
      >
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> Schedule QBR</Button>
      </PageHeader>
      <div className="p-4 md:p-5 space-y-5">
        {error ? <QueryError message={error.message} onRetry={() => refetch()} /> : isLoading ? <TableSkeleton rows={5} /> : (data ?? []).length === 0 ? <EmptyState icon={CalendarCheck2} title="No QBRs scheduled" description="Quarterly business reviews you schedule for customers appear here — a good cadence for at-risk and high-value accounts." /> : (
          GROUPS.filter((g) => groups[g.key].length > 0 || g.key === "upcoming").map((g) => (
            <section key={g.key} className="space-y-2" aria-label={`${g.title} QBRs`}>
              <div className="flex items-baseline gap-2">
                <h2 className={`text-sm font-semibold ${g.key === "overdue" ? "text-red-700 dark:text-red-400" : ""}`}>{g.title}</h2>
                <span className="text-xs tabular-nums text-muted-foreground">{groups[g.key].length}</span>
                {g.hint && <span className="text-xs text-muted-foreground">· {g.hint}</span>}
              </div>
              {groups[g.key].length === 0
                ? <p className="text-xs text-muted-foreground">Nothing scheduled ahead.</p>
                : <ShowMoreList items={groups[g.key]} scope={g.key} render={(q) => renderQbr(q, g.key === "overdue")} noun="QBRs" />}
            </section>
          ))
        )}
      </div>

      <FormDialog open={open} onOpenChange={setOpen} title="Schedule QBR" isPending={schedule.isPending}
        onSubmit={(f) => {
          const when = whenFromForm(f);
          if (!when) { toast.error("Pick the QBR's day."); return; }
          schedule.mutate({ customerId: Number(f.get("customerId")), ...when });
        }}>
        <SelectField name="customerId" label="Customer" options={(customers ?? []).map((c: any) => ({ value: String(c.id), label: c.account?.name ?? "Customer" }))} />
        {whenFields}
      </FormDialog>

      <FormDialog open={!!moveFor} onOpenChange={(v) => !v && setMoveFor(null)} title="Move QBR" isPending={reschedule.isPending}
        onSubmit={(f) => {
          const when = whenFromForm(f);
          if (!when || !moveFor) { toast.error("Pick the QBR's day."); return; }
          reschedule.mutate({ id: moveFor, scheduledAt: when.scheduledAt, durationMinutes: when.durationMinutes ?? null });
        }}>
        {whenFields}
      </FormDialog>

      <FormDialog open={!!completeFor} onOpenChange={(v) => !v && setCompleteFor(null)} title="Complete QBR" isPending={complete.isPending}
        onSubmit={(f) => complete.mutate({
          id: completeFor!,
          notes: String(f.get("notes") ?? "") || undefined,
          nextActions: String(f.get("nextActions") ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
        })}>
        <TextareaField name="notes" label="Meeting notes" rows={4} />
        <TextareaField name="nextActions" label="Next actions (one per line)" rows={4} />
      </FormDialog>
    </Shell>
  );
}
