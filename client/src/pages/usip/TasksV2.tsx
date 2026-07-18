/**
 * TasksV2 — the Engage → "Tasks" surface (/v2/tasks).
 *
 * The workspace task queue plus the AI **Task Autopilot**: the autonomous
 * next-best-action engine. Autopilot has three modes (per workspace):
 *   • Off       — fully manual.
 *   • Approve   — AI proposes tasks as drafts; a human approves them here.
 *   • Autopilot — AI creates & assigns live tasks automatically (no human step).
 *
 * Backed by the `tasks.*` tRPC procedures (list/stats/create/complete/snooze/
 * bulk + generateDrafts/approveDraft/approveAllDrafts/dismissDraft +
 * get/setAutopilotSettings). Drafts are excluded from the normal queue and
 * reviewed in their own section. The v1 /tasks page (pages/usip/Tasks.tsx,
 * which also exports RelatedTasks) is left untouched.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Phone, Mail, CalendarClock, Link2, ListTodo, Repeat, Database, Sparkles, Check, Clock,
  AlertTriangle, Plus, Zap, MoreHorizontal, X, Bot, CheckCheck, Inbox,
} from "lucide-react";

type Task = {
  id: number;
  title: string;
  description?: string | null;
  type?: string | null;
  status: string;
  priority?: string | null;
  dueAt?: string | Date | null;
  disposition?: string | null;
  source?: string | null;
  aiReasoning?: string | null;
  aiConfidence?: number | null;
  relatedType?: string | null;
  relatedId?: number | null;
};

const TYPE_ICON: Record<string, typeof Phone> = {
  call: Phone,
  email: Mail,
  manual_email: Mail,
  meeting: CalendarClock,
  meeting_prep: CalendarClock,
  linkedin: Link2,
  social_touch: Link2,
  follow_up: Repeat,
  crm_update: Database,
  todo: ListTodo,
  generic_action: ListTodo,
};

const PRIORITY_TONE: Record<string, string> = {
  urgent: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
  high: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  normal: "bg-secondary text-muted-foreground",
  low: "bg-secondary text-muted-foreground",
};

const TASK_TYPE_OPTIONS = [
  { value: "todo", label: "To-do" },
  { value: "call", label: "Call" },
  { value: "manual_email", label: "Email" },
  { value: "social_touch", label: "LinkedIn / social" },
  { value: "follow_up", label: "Follow-up" },
  { value: "meeting_prep", label: "Meeting prep" },
  { value: "crm_update", label: "CRM update" },
  { value: "generic_action", label: "Other" },
];

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
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function plusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

const MODE_META: Record<string, { label: string; blurb: string }> = {
  off: { label: "Autopilot off", blurb: "AI won't create tasks. Everything is manual." },
  approval: { label: "Autopilot: Approve", blurb: "AI proposes next-best-action tasks for your review before they go live." },
  auto: { label: "Autopilot: Autonomous", blurb: "AI creates and assigns live tasks automatically — no approval needed." },
};

export default function TasksV2() {
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  const active = trpc.tasks.list.useQuery({});
  const drafts = trpc.tasks.list.useQuery({ status: "draft" });
  const stats = trpc.tasks.stats.useQuery();
  const autopilot = trpc.tasks.getAutopilotSettings.useQuery();

  const invalidateAll = () => {
    utils.tasks.list.invalidate();
    utils.tasks.stats.invalidate();
  };

  const setMode = trpc.tasks.setAutopilotSettings.useMutation({
    onSuccess: () => { utils.tasks.getAutopilotSettings.invalidate(); toast.success("Autopilot updated"); },
    onError: (e) => toast.error(e.message.includes("FORBIDDEN") ? "Only admins can change Autopilot" : e.message),
  });
  const generate = trpc.tasks.generateDrafts.useMutation({
    onSuccess: (r) => {
      invalidateAll();
      if (r.created === 0) toast.info(r.skipped > 0 ? "No new tasks — top prospects already have active tasks" : "No candidates to action right now");
      else toast.success(`AI created ${r.created} task${r.created === 1 ? "" : "s"}${r.drafts ? ` (${r.drafts} to review)` : ""}`);
    },
    onError: (e) => toast.error(e.message),
  });
  const approveDraft = trpc.tasks.approveDraft.useMutation({ onSuccess: invalidateAll });
  const dismissDraft = trpc.tasks.dismissDraft.useMutation({ onSuccess: invalidateAll });
  const approveAll = trpc.tasks.approveAllDrafts.useMutation({
    onSuccess: (r) => { invalidateAll(); toast.success(`Approved ${r.approved} task${r.approved === 1 ? "" : "s"}`); },
  });
  const complete = trpc.tasks.complete.useMutation({ onSuccess: invalidateAll });
  const snooze = trpc.tasks.snooze.useMutation({ onSuccess: invalidateAll });
  const create = trpc.tasks.create.useMutation({
    onSuccess: () => { invalidateAll(); toast.success("Task created"); setNewOpen(false); },
    onError: (e) => toast.error(e.message),
  });

  const [newOpen, setNewOpen] = useState(false);

  const mode = autopilot.data?.mode ?? "off";
  const activeTasks = (active.data ?? []) as Task[];
  const draftTasks = (drafts.data ?? []) as Task[];
  const s = stats.data ?? { open: 0, dueToday: 0, overdue: 0, completed: 0, draftsPending: 0, snoozed: 0, aiOpen: 0 };

  // Queue: open / in_progress / snoozed, sorted by due date (nulls last).
  const queue = useMemo(() => {
    return activeTasks
      .filter((t) => t.status === "open" || t.status === "in_progress" || t.status === "snoozed")
      .sort((a, b) => {
        const ta = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
        const tb = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
        return ta - tb;
      });
  }, [activeTasks]);
  // "Recently closed" deliberately includes CANCELLED, not just done.
  // Dismissing an AI-drafted task sets status="cancelled" (activities.dismissDraft),
  // and this page rendered neither bucket for it — so the task vanished from
  // the only Tasks page reachable from the nav, with no way to get it back
  // (legacy /tasks, whose "All" tab would show it, is orphaned).
  const done = useMemo(
    () => activeTasks.filter((t) => t.status === "done" || t.status === "cancelled").slice(0, 10),
    [activeTasks],
  );

  const now = Date.now();

  const StatCard = ({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warning" | "ai" }) => {
    const color = tone === "danger" ? "#e11d48" : tone === "warning" ? "#d97706" : tone === "ai" ? "#7c3aed" : accent;
    return (
      <div className="rounded-lg border bg-card p-3 shadow-sm" style={{ borderLeft: `3px solid ${color}` }}>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums mt-0.5" style={{ color }}>{value}</div>
      </div>
    );
  };

  const TypeIcon = ({ type }: { type?: string | null }) => {
    const Icon = TYPE_ICON[(type ?? "todo")] ?? ListTodo;
    return (
      <span className="shrink-0 size-7 rounded-full flex items-center justify-center" style={{ backgroundColor: `${accent}1f`, color: accent }}>
        <Icon className="size-3.5" />
      </span>
    );
  };

  const QueueRow = ({ t }: { t: Task }) => {
    const href = recordHref(t);
    const isOverdue = t.dueAt && new Date(t.dueAt).getTime() < now;
    const isCall = t.type === "call";
    return (
      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-border/60 last:border-0 hover:bg-muted/40">
        <button
          onClick={() => complete.mutate({ id: t.id })}
          title="Mark complete"
          className="shrink-0 size-5 rounded-full border flex items-center justify-center hover:bg-muted transition-colors"
        />
        <TypeIcon type={t.type} />
        <div className="min-w-0 flex-1">
          <div className="text-sm truncate font-medium flex items-center gap-1.5">
            {t.title}
            {t.source === "ai" && <Sparkles className="size-3 shrink-0" style={{ color: "#7c3aed" }} />}
            {t.status === "snoozed" && <Clock className="size-3 shrink-0 text-muted-foreground" />}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            {href
              ? <Link href={href} className="inline-flex items-center gap-1 hover:underline"><Link2 className="size-3" /> {t.relatedType}</Link>
              : <span>No linked record</span>}
            {t.aiReasoning && <span className="truncate italic">· {t.aiReasoning}</span>}
          </div>
        </div>
        {t.priority && <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", PRIORITY_TONE[t.priority] ?? PRIORITY_TONE.normal)}>{t.priority}</span>}
        <div className={cn("shrink-0 text-[11px] w-24 text-right tabular-nums", isOverdue ? "text-rose-600 font-medium" : "text-muted-foreground")}>
          {isOverdue && <AlertTriangle className="size-3 inline mr-0.5" />}{fmtDue(t.dueAt)}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7 shrink-0"><MoreHorizontal className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => complete.mutate({ id: t.id })}><Check className="size-3.5 mr-2" /> Complete</DropdownMenuItem>
            {isCall && <>
              <DropdownMenuItem onClick={() => complete.mutate({ id: t.id, disposition: "meeting_booked" })}>✓ Complete — meeting booked</DropdownMenuItem>
              <DropdownMenuItem onClick={() => complete.mutate({ id: t.id, disposition: "no_answer" })}>Complete — no answer</DropdownMenuItem>
              <DropdownMenuItem onClick={() => complete.mutate({ id: t.id, disposition: "left_voicemail" })}>Complete — left voicemail</DropdownMenuItem>
            </>}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase text-muted-foreground">Snooze</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => snooze.mutate({ id: t.id, snoozedUntil: plusDays(1) })}>Tomorrow</DropdownMenuItem>
            <DropdownMenuItem onClick={() => snooze.mutate({ id: t.id, snoozedUntil: plusDays(3) })}>In 3 days</DropdownMenuItem>
            <DropdownMenuItem onClick={() => snooze.mutate({ id: t.id, snoozedUntil: plusDays(7) })}>Next week</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  const DraftRow = ({ t }: { t: Task }) => {
    const href = recordHref(t);
    const Icon = TYPE_ICON[(t.type ?? "todo")] ?? ListTodo;
    return (
      <div className="flex items-start gap-3 px-3 py-2.5 border-b border-border/60 last:border-0">
        <span className="shrink-0 size-7 rounded-full flex items-center justify-center mt-0.5" style={{ backgroundColor: "#7c3aed1f", color: "#7c3aed" }}>
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium flex items-center gap-1.5">
            {t.title}
            {typeof t.aiConfidence === "number" && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">{t.aiConfidence}% conf.</span>}
          </div>
          {t.aiReasoning && <div className="text-[12px] text-muted-foreground mt-0.5">{t.aiReasoning}</div>}
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
            <span className="capitalize">{(t.type ?? "todo").replace(/_/g, " ")}</span>
            {href && <Link href={href} className="inline-flex items-center gap-1 hover:underline">· <Link2 className="size-3" /> {t.relatedType}</Link>}
            <span>· {fmtDue(t.dueAt)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => approveDraft.mutate({ id: t.id })}><Check className="size-3.5" /> Approve</Button>
          <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" title="Dismiss" onClick={() => dismissDraft.mutate({ id: t.id })}><X className="size-4" /></Button>
        </div>
      </div>
    );
  };

  return (
    <Shell title="Tasks">
      <div className="flex flex-col h-full min-h-0">
        {/* Header */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <ListTodo className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Tasks</h1>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <Bot className="size-3.5 text-muted-foreground" />
            <Select value={mode} onValueChange={(v) => setMode.mutate({ mode: v as "off" | "approval" | "auto" })}>
              <SelectTrigger className="h-7 w-[168px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Autopilot: Off</SelectItem>
                <SelectItem value="approval">Autopilot: Approve</SelectItem>
                <SelectItem value="auto">Autopilot: Autonomous</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={generate.isPending} onClick={() => generate.mutate({ limit: 10 })}>
            <Sparkles className="size-3.5" /> {generate.isPending ? "Generating…" : "Generate with AI"}
          </Button>
          <Button size="sm" className="h-7 gap-1.5" onClick={() => setNewOpen(true)}><Plus className="size-3.5" /> New task</Button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-5">
          {/* Autopilot status strip */}
          <div className="rounded-lg border bg-card px-4 py-2.5 flex items-center gap-3 shadow-sm">
            <span className="shrink-0 size-8 rounded-full flex items-center justify-center" style={{ backgroundColor: mode === "off" ? "hsl(var(--muted))" : "#7c3aed1f", color: mode === "off" ? undefined : "#7c3aed" }}>
              {mode === "auto" ? <Zap className="size-4" /> : <Bot className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{MODE_META[mode]?.label}</div>
              <div className="text-[12px] text-muted-foreground">{MODE_META[mode]?.blurb}</div>
            </div>
            {autopilot.data?.lastRunAt && (
              <div className="shrink-0 text-[11px] text-muted-foreground hidden sm:block">Last run {fmtDue(autopilot.data.lastRunAt)}</div>
            )}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Open" value={s.open} />
            <StatCard label="Due today" value={s.dueToday} tone={s.dueToday ? "warning" : undefined} />
            <StatCard label="Overdue" value={s.overdue} tone={s.overdue ? "danger" : undefined} />
            <StatCard label="AI drafts" value={s.draftsPending} tone={s.draftsPending ? "ai" : undefined} />
            <StatCard label="Completed" value={s.completed} />
          </div>

          {/* AI drafts to review */}
          {draftTasks.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold flex items-center gap-2"><Sparkles className="size-4" style={{ color: "#7c3aed" }} /> AI drafts to review ({draftTasks.length})</h2>
                <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={approveAll.isPending} onClick={() => approveAll.mutate()}>
                  <CheckCheck className="size-3.5" /> Approve all
                </Button>
              </div>
              <div className="rounded-xl border bg-card overflow-hidden shadow-sm" style={{ borderColor: "#7c3aed40" }}>
                {draftTasks.map((t) => <DraftRow key={t.id} t={t} />)}
              </div>
            </section>
          )}

          {/* Queue */}
          <section>
            <h2 className="text-sm font-semibold mb-2 flex items-center gap-2"><CalendarClock className="size-4" style={{ color: accent }} /> Task queue</h2>
            <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
              {active.isLoading ? (
                <div className="p-3 space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-10 rounded bg-muted/50 animate-pulse" />)}</div>
              ) : active.error ? (
                <div className="text-center py-12 px-4">
                  <p className="text-sm text-muted-foreground">Couldn’t load tasks. {active.error.message}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => active.refetch()}>Retry</Button>
                </div>
              ) : queue.length === 0 ? (
                <div className="text-center py-14 px-4">
                  <Inbox className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
                  <div className="text-sm font-medium">Your queue is clear</div>
                  <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                    Create a task, or let AI find the next best actions for your top prospects.
                  </p>
                  <div className="flex items-center justify-center gap-2 mt-3">
                    <Button size="sm" variant="outline" className="gap-1.5" disabled={generate.isPending} onClick={() => generate.mutate({ limit: 10 })}><Sparkles className="size-3.5" /> Generate with AI</Button>
                    <Button size="sm" className="gap-1.5" onClick={() => setNewOpen(true)}><Plus className="size-3.5" /> New task</Button>
                  </div>
                </div>
              ) : (
                queue.map((t) => <QueueRow key={t.id} t={t} />)
              )}
            </div>
          </section>

          {/* Completed */}
          {done.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2 text-muted-foreground"><Check className="size-4" /> Recently closed</h2>
              <div className="rounded-xl border bg-card overflow-hidden shadow-sm opacity-80">
                {done.map((t) => {
                  const cancelled = t.status === "cancelled";
                  return (
                  <div key={t.id} className="flex items-center gap-3 px-3 py-2 border-b border-border/60 last:border-0">
                    <span
                      className="shrink-0 size-5 rounded-full flex items-center justify-center text-white"
                      style={{ backgroundColor: cancelled ? "hsl(var(--muted-foreground))" : accent }}
                    >
                      {cancelled ? <X className="size-3" /> : <Check className="size-3" />}
                    </span>
                    <TypeIcon type={t.type} />
                    <div className="min-w-0 flex-1"><div className="text-sm truncate line-through text-muted-foreground">{t.title}</div></div>
                    {cancelled && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-secondary text-muted-foreground">Dismissed</span>}
                    {t.disposition && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-secondary text-muted-foreground capitalize">{t.disposition.replace(/_/g, " ")}</span>}
                  </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>

      {/* New task dialog */}
      <NewTaskDialog open={newOpen} onOpenChange={setNewOpen} onCreate={(v) => create.mutate(v)} pending={create.isPending} />
    </Shell>
  );
}

function NewTaskDialog({
  open, onOpenChange, onCreate, pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreate: (v: { title: string; description?: string; type: string; priority: string; dueAt?: string }) => void;
  pending: boolean;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("todo");
  const [priority, setPriority] = useState("normal");
  const [due, setDue] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    onCreate({
      title: title.trim(),
      description: description.trim() || undefined,
      type,
      priority,
      dueAt: due ? new Date(due).toISOString() : undefined,
    });
    setTitle(""); setDescription(""); setType("todo"); setPriority("normal"); setDue("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>Add a task to your queue.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Call Jane about renewal" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TASK_TYPE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-due">Due</Label>
            <Input id="task-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-desc">Notes</Label>
            <Textarea id="task-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Optional instructions" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={pending || !title.trim()} onClick={submit}>{pending ? "Creating…" : "Create task"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
