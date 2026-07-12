/**
 * Calls — the Engage → "Calls" surface (/v2/calls).
 *
 * Velocity has no standalone dialer, but it does model calls: tasks can be
 * type `call`, and call outcomes are logged as activities on a record. This
 * page is the rep's call queue — the call-type tasks across the workspace —
 * tied to the existing `tasks.list` / `tasks.setStatus` endpoints. Calls are
 * scheduled/logged from a contact, lead or account record.
 */
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Phone, Check, Link as LinkIcon, CalendarClock, AlertTriangle, PhoneOff,
  AudioLines, PhoneIncoming, PhoneOutgoing, ChevronDown, Settings2,
} from "lucide-react";

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

// Matches the tasks.priority enum: low | normal | high | urgent.
const PRIORITY_TONE: Record<string, string> = {
  urgent: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
  high: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  normal: "bg-secondary text-muted-foreground",
  low: "bg-secondary text-muted-foreground",
};

const VOICE_STATUS_TONE: Record<string, string> = {
  completed: "text-emerald-600 dark:text-emerald-400",
  in_progress: "text-sky-600 dark:text-sky-400",
  ringing: "text-sky-600 dark:text-sky-400",
  failed: "text-rose-600 dark:text-rose-400",
  no_answer: "text-amber-600 dark:text-amber-400",
  queued: "text-muted-foreground",
};

function fmtDuration(sec?: number | null): string {
  if (sec == null) return "—";
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** Grok voice agents strip + inbound/outbound agent call log (voice_calls). */
function VoiceAgentsPanel({ accent }: { accent: string }) {
  const [, setLocation] = useLocation();
  const agents = trpc.voiceAgents.list.useQuery();
  const calls = trpc.voiceAgents.listCalls.useQuery({ limit: 50 });
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const agentRows = (agents.data ?? []) as Record<string, any>[];
  const callRows = (calls.data ?? []) as Record<string, any>[];

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <AudioLines className="size-4" style={{ color: accent }} /> AI voice agents
        </h2>
        <div className="flex-1" />
        <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => setLocation("/v2/settings/voice-agents")}>
          <Settings2 className="size-3.5" /> Manage agents
        </Button>
      </div>

      {agents.isLoading ? (
        <div className="h-16 rounded-xl bg-muted/50 animate-pulse" />
      ) : agentRows.length === 0 ? (
        <div className="rounded-xl border bg-card px-4 py-6 text-center shadow-sm">
          <div className="text-sm font-medium">No voice agents configured</div>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            Grok voice agents answer prospect call-backs on a team member's behalf and will place automated
            outreach calls. Set up the xAI connection and your first agent in Settings.
          </p>
          <Button size="sm" className="mt-3" onClick={() => setLocation("/v2/settings/voice-agents")}>
            Set up voice agents
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {agentRows.map((a) => (
              <div key={a.id} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm">
                <span className={cn(
                  "flex size-6 items-center justify-center rounded-md",
                  a.purpose === "callback_receptionist"
                    ? "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                    : "bg-secondary text-muted-foreground",
                )}>
                  {a.purpose === "callback_receptionist" ? <PhoneIncoming className="size-3.5" /> : <PhoneOutgoing className="size-3.5" />}
                </span>
                <div className="leading-tight">
                  <div className="flex items-center gap-1.5 text-[13px] font-medium">
                    {a.name}
                    <span className={cn("size-1.5 rounded-full", a.status === "active" ? "bg-emerald-500" : "bg-muted-foreground/40")} />
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {a.purpose === "callback_receptionist"
                      ? `Answers for ${a.owner?.name ?? "member"}`
                      : "Outreach"}
                    {a.phoneNumber ? ` · ${a.phoneNumber}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 rounded-xl border bg-card overflow-hidden shadow-sm">
            <div className="border-b border-border/60 px-3 py-2 text-[12px] font-medium text-muted-foreground">
              Agent call log
            </div>
            {calls.isLoading ? (
              <div className="p-3 space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-9 rounded bg-muted/50 animate-pulse" />)}</div>
            ) : callRows.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-muted-foreground">
                No agent calls yet. When a prospect calls back a registered number, the call and its
                transcript summary appear here.
              </div>
            ) : (
              callRows.map((c) => (
                <div key={c.id} className="border-b border-border/60 last:border-0">
                  <button
                    type="button"
                    onClick={() => setExpandedId((cur) => (cur === c.id ? null : c.id))}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
                  >
                    {c.direction === "inbound"
                      ? <PhoneIncoming className="size-4 shrink-0 text-sky-600" />
                      : <PhoneOutgoing className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate text-sm">
                      <span className="font-medium">{c.agentName}</span>
                      <span className="text-muted-foreground"> · {c.fromNumber ?? "unknown"} → {c.toNumber ?? "—"}</span>
                    </span>
                    <span className={cn("shrink-0 text-[12px] font-medium capitalize", VOICE_STATUS_TONE[c.status] ?? "text-muted-foreground")}>
                      {String(c.status).replace("_", " ")}
                    </span>
                    <span className="shrink-0 w-12 text-right text-[12px] tabular-nums text-muted-foreground">{fmtDuration(c.durationSec)}</span>
                    <span className="shrink-0 w-28 text-right text-[11px] text-muted-foreground">
                      {c.createdAt ? new Date(c.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}
                    </span>
                    <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expandedId === c.id && "rotate-180")} />
                  </button>
                  {expandedId === c.id && (
                    <div className="border-t border-border/40 bg-muted/30 px-4 py-3">
                      {c.outcome ? (
                        <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/90">{c.outcome}</pre>
                      ) : (
                        <p className="text-[12px] text-muted-foreground">No transcript or notes recorded for this call.</p>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </section>
  );
}

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

          <VoiceAgentsPanel accent={accent} />

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
