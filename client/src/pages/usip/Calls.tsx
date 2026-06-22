/**
 * Calls — the Engage → "Calls" surface (/v2/calls).
 *
 * Velocity has no standalone dialer, but it does model calls: tasks can be
 * type `call`, and call outcomes are logged as activities on a record. This
 * page is the rep's call queue — the call-type tasks across the workspace —
 * tied to the existing `tasks.list` / `tasks.setStatus` endpoints. Calls are
 * scheduled/logged from a contact, lead or account record.
 */
import { useMemo } from "react";
import { Link, useLocation } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Phone, Check, Link as LinkIcon, CalendarClock, AlertTriangle, PhoneOff } from "lucide-react";

type Task = {
  id: number;
  title: string;
  type?: string | null;
  status: string;
  priority?: string | null;
  dueAt?: string | Date | null;
  relatedType?: string | null;
  relatedId?: number | null;
};

function recordHref(t: Task): string | null {
  if (!t.relatedType || !t.relatedId) return null;
  switch (t.relatedType) {
    case "account": return `/accounts/${t.relatedId}`;
    case "contact": return `/contacts/${t.relatedId}`;
    case "lead": return `/leads/${t.relatedId}`;
    case "opportunity": return `/opportunities/${t.relatedId}`;
    case "prospect": return `/prospects/${t.relatedId}`;
    default: return null;
  }
}

function fmtDue(d?: string | Date | null): string {
  if (!d) return "No due date";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const PRIORITY_TONE: Record<string, string> = {
  high: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  low: "bg-secondary text-muted-foreground",
};

export default function Calls() {
  const [, setLocation] = useLocation();
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  const { data, isLoading, error, refetch } = trpc.tasks.list.useQuery({});
  const setStatus = trpc.tasks.setStatus.useMutation({ onSuccess: () => utils.tasks.list.invalidate() });

  const calls = useMemo(() => ((data ?? []) as Task[]).filter((t) => (t.type ?? "").toLowerCase() === "call"), [data]);

  const now = new Date().getTime();
  const startOfTomorrow = new Date(); startOfTomorrow.setHours(24, 0, 0, 0);
  const open = calls.filter((c) => c.status === "open");
  const done = calls.filter((c) => c.status === "done");
  const dueToday = open.filter((c) => c.dueAt && new Date(c.dueAt).getTime() < startOfTomorrow.getTime());
  const overdue = open.filter((c) => c.dueAt && new Date(c.dueAt).getTime() < now);

  // open queue sorted by due date (nulls last)
  const queue = [...open].sort((a, b) => {
    const ta = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const tb = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    return ta - tb;
  });

  const stat = (label: string, value: number, tone?: "danger" | "warning") => (
    <div className="rounded-lg border bg-card p-3 shadow-sm" style={{ borderLeft: `3px solid ${tone === "danger" ? "#e11d48" : tone === "warning" ? "#d97706" : accent}` }}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums mt-0.5" style={{ color: tone === "danger" ? "#e11d48" : tone === "warning" ? "#d97706" : accent }}>{value}</div>
    </div>
  );

  const Row = ({ c }: { c: Task }) => {
    const href = recordHref(c);
    const isOverdue = c.status === "open" && c.dueAt && new Date(c.dueAt).getTime() < now;
    return (
      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-border/60 last:border-0 hover:bg-muted/40">
        <button
          onClick={() => setStatus.mutate({ id: c.id, status: c.status === "done" ? "open" : "done" })}
          title={c.status === "done" ? "Mark as open" : "Mark as done"}
          className={cn("shrink-0 size-5 rounded-full border flex items-center justify-center transition-colors", c.status === "done" ? "text-white" : "hover:bg-muted")}
          style={c.status === "done" ? { backgroundColor: accent, borderColor: accent } : undefined}
        >
          {c.status === "done" && <Check className="size-3" />}
        </button>
        <span className="shrink-0 size-7 rounded-full flex items-center justify-center" style={{ backgroundColor: `${accent}1f`, color: accent }}>
          <Phone className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className={cn("text-sm truncate", c.status === "done" ? "line-through text-muted-foreground" : "font-medium")}>{c.title}</div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {href ? <Link href={href} className="inline-flex items-center gap-1 hover:underline"><LinkIcon className="size-3" /> {c.relatedType}</Link> : <span>No linked record</span>}
          </div>
        </div>
        {c.priority && <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", PRIORITY_TONE[c.priority] ?? PRIORITY_TONE.low)}>{c.priority}</span>}
        <div className={cn("shrink-0 text-[11px] w-28 text-right tabular-nums", isOverdue ? "text-rose-600 font-medium" : "text-muted-foreground")}>
          {isOverdue && <AlertTriangle className="size-3 inline mr-0.5" />}{fmtDue(c.dueAt)}
        </div>
      </div>
    );
  };

  return (
    <Shell title="Calls">
      <div className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Phone className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Calls</h1>
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => setLocation("/contacts")}>Find someone to call</Button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {stat("Open calls", open.length)}
            {stat("Due today", dueToday.length, dueToday.length ? "warning" : undefined)}
            {stat("Overdue", overdue.length, overdue.length ? "danger" : undefined)}
            {stat("Completed", done.length)}
          </div>

          <section>
            <h2 className="text-sm font-semibold mb-2 flex items-center gap-2"><CalendarClock className="size-4" style={{ color: accent }} /> Call queue</h2>
            <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
              {isLoading ? (
                <div className="p-3 space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-10 rounded bg-muted/50 animate-pulse" />)}</div>
              ) : error ? (
                <div className="text-center py-12 px-4">
                  <p className="text-sm text-muted-foreground">Couldn’t load calls. {error.message}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>Retry</Button>
                </div>
              ) : queue.length === 0 ? (
                <div className="text-center py-14 px-4">
                  <PhoneOff className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
                  <div className="text-sm font-medium">No calls scheduled</div>
                  <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">Schedule a call task on a contact, lead or account and it'll show up here. Outcomes you log are saved to that record's timeline.</p>
                  <Button size="sm" className="mt-3" onClick={() => setLocation("/contacts")}>Go to contacts</Button>
                </div>
              ) : (
                queue.map((c) => <Row key={c.id} c={c} />)
              )}
            </div>
          </section>

          {done.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2 text-muted-foreground"><Check className="size-4" /> Completed ({done.length})</h2>
              <div className="rounded-xl border bg-card overflow-hidden shadow-sm opacity-80">
                {done.slice(0, 10).map((c) => <Row key={c.id} c={c} />)}
              </div>
            </section>
          )}
        </div>
      </div>
    </Shell>
  );
}
