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
 * reviewed in their own section.
 *
 * The one task page (audit 2026-10-20, R72 and X6.3; batch CONB,
 * 2026-11-08). /tasks is retired into this one, folding first: its Today /
 * Upcoming / Overdue / Done / All tabs are the views over the queue below,
 * with its related-record filter, Reopen on a closed task and Cancel on an
 * open one. /tasks redirects here (lib/retiredRoutes.ts); its file is kept,
 * unrouted, and still exports RelatedTasks for the record pages. The overdue,
 * scope and "recently closed" rules are @shared/taskRules.
 */
import { useEffect, useMemo, useState } from "react";
import { SHOW_MORE_STEP, useShowMore } from "@/hooks/useShowMore";
import { forbiddenMessage } from "@/lib/forbidden";
import { Link, useLocation, useSearch } from "wouter";
import { tablistProps, tabProps } from "@/lib/tabs";
import { toast } from "sonner";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc, type RouterInputs } from "@/lib/trpc";
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
  AlertTriangle, Plus, Zap, MoreHorizontal, X, Bot, CheckCheck, Inbox, Trash2, User,
} from "lucide-react";
import { confirmAction, ConfirmButton } from "@/components/usip/Common";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceTimezone } from "@/hooks/useWorkspaceTimezone";
import { RelatedRecordPicker, type RelatedRecord } from "@/components/usip/RelatedRecordPicker";
import { bucketTasks, recentlyClosed, seesAllTasks, taskDueState } from "@shared/taskRules";

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
  /** Who the task belongs to. tasks.list returns whole rows, so this was
   *  always on the wire — this page simply never read it (2026-10-29). */
  ownerUserId?: number | null;
  completedAt?: string | Date | null;
  updatedAt?: string | Date | null;
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

/**
 * The views over the queue. "queue" is what this page always showed; the
 * other five are /tasks' tabs, folded in when /tasks was retired (R72, X6.3).
 * `?view=` opens one, so a link can land on Overdue or Today.
 */
export const TASK_VIEWS = [
  { id: "queue", label: "Queue" },
  { id: "today", label: "Today" },
  { id: "overdue", label: "Overdue" },
  { id: "upcoming", label: "Upcoming" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
] as const;
export type TaskView = (typeof TASK_VIEWS)[number]["id"];

/** The view a `?view=` asks for, or the queue. */
export function taskViewFrom(search: string): TaskView {
  const v = new URLSearchParams(search.replace(/^\?/, "")).get("view");
  return (TASK_VIEWS.find((x) => x.id === v)?.id ?? "queue") as TaskView;
}

/** The record kinds a task links to; /tasks' "Related" filter. */
const RELATED_TYPES = ["account", "contact", "lead", "opportunity", "prospect"] as const;

const MODE_META: Record<string, { label: string; blurb: string }> = {
  off: { label: "Autopilot off", blurb: "AI won't create tasks. Everything is manual." },
  approval: { label: "Autopilot: Approve", blurb: "AI proposes next-best-action tasks for your review before they go live." },
  auto: { label: "Autopilot: Autonomous", blurb: "AI creates and assigns live tasks automatically — no approval needed." },
};

/** "At most N a day from each" for website visits, Deal Autopilot, proposal follow-ups and sequence task steps. */
function AutoTaskCapLine({ cap, saving, onSave }: { cap: number; saving: boolean; onSave: (n: number) => void }) {
  const [value, setValue] = useState(String(cap));
  useEffect(() => { setValue(String(cap)); }, [cap]);
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 0 && n <= 500;
  return (
    <div className="rounded-lg border bg-card px-4 py-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
      <span>Website visits, Deal Autopilot, proposal follow-ups and sequence task steps each file at most</span>
      <Input aria-label="Automatic tasks a day from each source" type="number" min={0} max={500} value={value} onChange={(e) => setValue(e.target.value)} className="h-7 w-20 text-xs" />
      <span>tasks a day; more wait for tomorrow.</span>
      <Button size="sm" variant="outline" className="h-7" disabled={!valid || saving || n === cap} onClick={() => onSave(n)}>Save</Button>
    </div>
  );
}

export default function TasksV2() {
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  // One scope on both task pages, and on the counts above the list (R72): a
  // rep sees their own tasks, a manager everyone's. This listed every
  // owner's tasks to everyone. The AI drafts below stay the workspace's
  // review queue, because "Approve all" approves all of them.
  const { current } = useWorkspace();
  const seesAll = seesAllTasks(current?.role);
  const { timezone } = useWorkspaceTimezone();
  const active = trpc.tasks.list.useQuery({ mine: true });
  const drafts = trpc.tasks.list.useQuery({ status: "draft" });
  const stats = trpc.tasks.stats.useQuery({ mine: true });
  const autopilot = trpc.tasks.getAutopilotSettings.useQuery();

  const invalidateAll = () => {
    utils.tasks.list.invalidate();
    utils.tasks.stats.invalidate();
  };

  const setMode = trpc.tasks.setAutopilotSettings.useMutation({
    onSuccess: () => { utils.tasks.getAutopilotSettings.invalidate(); toast.success("Autopilot updated"); },
    onError: (e) => toast.error(forbiddenMessage(e, "Only admins can change Autopilot")),
  });
  const generate = trpc.tasks.generateDrafts.useMutation({
    onSuccess: (r) => {
      invalidateAll();
      if (r.created === 0) toast.info(r.skipped > 0 ? "No new tasks — top prospects already have active tasks" : "No candidates to action right now");
      else toast.success(`AI created ${r.created} task${r.created === 1 ? "" : "s"}${r.drafts ? ` (${r.drafts} to review)` : ""}`);
    },
    onError: (e) => toast.error(e.message),
  });
  const approveDraft = trpc.tasks.approveDraft.useMutation({ onSuccess: invalidateAll, onError: (e) => toast.error(e.message) });
  const dismissDraft = trpc.tasks.dismissDraft.useMutation({ onSuccess: invalidateAll, onError: (e) => toast.error(e.message) });
  const approveAll = trpc.tasks.approveAllDrafts.useMutation({
    onSuccess: (r) => { invalidateAll(); toast.success(`Approved ${r.approved} task${r.approved === 1 ? "" : "s"}`); },
    onError: (e) => toast.error(e.message),
  });
  const complete = trpc.tasks.complete.useMutation({ onSuccess: invalidateAll, onError: (e) => toast.error(e.message) });
  const remove = trpc.tasks.delete.useMutation({
    onSuccess: () => { invalidateAll(); toast.success("Task deleted"); },
    onError: (e: any) => toast.error(e?.message ?? "Could not delete the task"),
  });
  const snooze = trpc.tasks.snooze.useMutation({ onSuccess: invalidateAll, onError: (e) => toast.error(e.message) });
  // Reopen a closed task and Cancel an open one, as /tasks did (R72, X6.3).
  const setStatus = trpc.tasks.setStatus.useMutation({ onSuccess: invalidateAll, onError: (e) => toast.error(e.message) });
  const create = trpc.tasks.create.useMutation({
    onSuccess: () => { invalidateAll(); toast.success("Task created"); setNewOpen(false); },
    onError: (e) => toast.error(e.message),
  });

  const [newOpen, setNewOpen] = useState(false);

  // Task ownership, ported from the legacy /tasks page (2026-10-29). That page
  // was the ONLY surface that could read or set `tasks.ownerUserId`, while this
  // is the Tasks page the nav points at. The column was never decorative —
  // tasks.create validates it with assertOwnerInWorkspace, defaults it to the
  // caller and notifies the assignee when it is someone else, and tasks.list
  // takes an ownerOnly filter — so until now it was writable by the API and the
  // autopilot and editable by no human. Three things came across: the assignee
  // picker on create, the owner on each row, and the assignee filter.
  // /tasks is NOT retired by this change; that decision is the owner's.
  const { data: members } = trpc.team.list.useQuery();
  const memberOpts = useMemo(
    () => (members ?? []).map((m: { userId: number; name: string | null }) => ({ userId: m.userId, name: m.name })),
    [members],
  );
  const memberName = (userId: number | null | undefined) => {
    if (userId == null) return null;
    return memberOpts.find((m) => m.userId === userId)?.name ?? `User ${userId}`;
  };
  // "" = anyone. Scopes the QUEUE only, which is why it lives in that section's
  // header: the stat cards above come from tasks.stats on the server and count
  // everything this person can see (R72), and a filter that silently re-scoped the list while
  // leaving those numbers alone is how a header ends up counting one population
  // and the list another.
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  // /tasks' "Related" filter: tasks about one kind of record ("" = any).
  const [relTypeFilter, setRelTypeFilter] = useState<string>("");
  // Which view of the list; `?view=` picks one, and a pick writes it back.
  const search = useSearch();
  const [, navigate] = useLocation();
  const [view, setViewState] = useState<TaskView>(() => taskViewFrom(search));
  useEffect(() => { setViewState(taskViewFrom(search)); }, [search]);
  const setView = (v: TaskView) => {
    setViewState(v);
    navigate(v === "queue" ? "/v2/tasks" : `/v2/tasks?view=${v}`, { replace: true });
  };
  const filtersOn = !!assigneeFilter || !!relTypeFilter;
  const passes = (t: Task) =>
    (!assigneeFilter || String(t.ownerUserId ?? "") === assigneeFilter) &&
    (!relTypeFilter || t.relatedType === relTypeFilter);

  const mode = autopilot.data?.mode ?? "off";
  const activeTasks = (active.data ?? []) as Task[];
  const draftTasks = (drafts.data ?? []) as Task[];
  // Approval queues that used to be plain tasks (2026-09-09): chat follow-ups
  // and Social Autopilot invites. Each row sends through the autopilot's own
  // path when approved, so they render as approve-and-send cards, not to-dos.
  const approvalQ = trpc.tasks.approvalQueue.useQuery(undefined, { refetchInterval: 30000 });
  const chatFollowUps = approvalQ.data?.chatFollowUps ?? [];
  const socialInvites = approvalQ.data?.socialInvites ?? [];
  const approvalIds = useMemo(() => new Set([...chatFollowUps, ...socialInvites].map((r) => r.id)), [chatFollowUps, socialInvites]);
  const sendFollowUp = trpc.tasks.sendChatFollowUp.useMutation({ onSuccess: (r) => { invalidateAll(); utils.tasks.approvalQueue.invalidate(); toast.success(r.ok ? r.detail : "Sent"); }, onError: (e) => toast.error(e.message) });
  const sendAllFollowUps = trpc.tasks.sendAllChatFollowUps.useMutation({ onSuccess: (r) => { invalidateAll(); utils.tasks.approvalQueue.invalidate(); toast[r.failed.length ? "warning" : "success"](`${r.sent} sent${r.failed.length ? `, ${r.failed.length} not sent (${r.failed.map((f) => f.reason.replace(/_/g, " ")).join("; ")})` : ""}`); }, onError: (e) => toast.error(e.message) });
  const sendInvite = trpc.tasks.sendSocialInvite.useMutation({ onSuccess: (r) => { invalidateAll(); utils.tasks.approvalQueue.invalidate(); toast.success(r.ok ? r.detail : "Sent"); }, onError: (e) => toast.error(e.message) });
  const sendAllInvites = trpc.tasks.sendAllSocialInvites.useMutation({ onSuccess: (r) => { invalidateAll(); utils.tasks.approvalQueue.invalidate(); toast[r.failed.length ? "warning" : "success"](`${r.sent} invite${r.sent === 1 ? "" : "s"} sent${r.failed.length ? `, ${r.failed.length} not sent (${r.failed.map((f) => f.reason.replace(/_/g, " ")).join("; ")})` : ""}`); }, onError: (e) => toast.error(e.message) });
  const s = stats.data ?? { open: 0, dueToday: 0, overdue: 0, completed: 0, draftsPending: 0, snoozed: 0, aiOpen: 0 };

  // Queue: open / in_progress / snoozed, sorted by due date (nulls last).
  const queueAll = useMemo(() => {
    return activeTasks
      .filter((t) => t.status === "open" || t.status === "in_progress" || t.status === "snoozed")
      .filter((t) => !approvalIds.has(t.id))
      .sort((a, b) => {
        const ta = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
        const tb = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
        return ta - tb;
      });
  }, [activeTasks, approvalIds]);
  // Kept separate from queueAll so the header can say "n of m" rather than
  // quietly showing a shorter list.
  const queue = useMemo(
    () => (filtersOn ? queueAll.filter(passes) : queueAll),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queueAll, assigneeFilter, relTypeFilter],
  );
  const now = Date.now();
  // /tasks' tabs over the same rows and filters (R72, X6.3): Today / Upcoming
  // / Overdue by the shared rule, Done latest first, All everything.
  const scoped = useMemo(
    () => activeTasks.filter((t) => !approvalIds.has(t.id)).filter(passes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTasks, approvalIds, assigneeFilter, relTypeFilter],
  );
  const byDue = (a: Task, b: Task) => (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity);
  const buckets = useMemo(() => {
    const b = bucketTasks(scoped, timezone, now);
    return { today: b.today.sort(byDue), upcoming: b.upcoming.sort(byDue), overdue: b.overdue.sort(byDue) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, timezone]);
  const doneAll = useMemo(() => recentlyClosed(scoped.filter((t) => t.status === "done")), [scoped]);
  const allRows = useMemo(() => [...scoped].sort(byDue), [scoped]);
  const viewCount: Record<TaskView, number> = {
    queue: queue.length, today: buckets.today.length, overdue: buckets.overdue.length,
    upcoming: buckets.upcoming.length, done: doneAll.length, all: allRows.length,
  };
  const listed: Task[] =
    view === "today" ? buckets.today :
    view === "overdue" ? buckets.overdue :
    view === "upcoming" ? buckets.upcoming :
    view === "done" ? doneAll :
    view === "all" ? allRows :
    queue;
  // 50 rows at a time (X4.2): the page rendered every task and draft at once,
  // 19,627 DOM nodes live. A new view or filter starts over at 50.
  const queueRows = useShowMore(listed, { view, assigneeFilter, relTypeFilter });
  const draftRows = useShowMore(draftTasks);
  // "Recently closed" deliberately includes CANCELLED, not just done.
  // Dismissing an AI-drafted task sets status="cancelled" (activities.dismissDraft),
  // and this page rendered neither bucket for it — so the task vanished from
  // the only Tasks page reachable from the nav, with no way to get it back
  // (legacy /tasks, whose "All" tab would show it, is orphaned).
  // The LATEST ten closed (R72): this took the first ten of a list sorted by
  // due date, which were the oldest.
  const done = useMemo(() => recentlyClosed(activeTasks, 10), [activeTasks]);

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
    // The shared rule (R72), the one /tasks and the stat cards use.
    const isOverdue = taskDueState(t.dueAt, now, timezone) === "overdue";
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
            {/* Whose task it is. Absent rather than guessed when the row has no
                owner, or has one who is no longer a workspace member. */}
            {t.ownerUserId != null && (
              <span className="inline-flex items-center gap-1 shrink-0"><User className="size-3" />{memberName(t.ownerUserId)}</span>
            )}
            {t.aiReasoning && <span className="truncate italic">· {t.aiReasoning}</span>}
          </div>
        </div>
        {t.priority && <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", PRIORITY_TONE[t.priority] ?? PRIORITY_TONE.normal)}>{t.priority}</span>}
        <div className={cn("shrink-0 text-[11px] w-24 text-right tabular-nums", isOverdue ? "text-rose-600 font-medium" : "text-muted-foreground")}>
          {isOverdue && <AlertTriangle className="size-3 inline mr-0.5" />}{fmtDue(t.dueAt)}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label="Task actions" variant="ghost" size="icon" className="size-7 shrink-0"><MoreHorizontal className="size-4" /></Button>
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
            <DropdownMenuSeparator />
            {/* /tasks' Cancel (R72, X6.3): closes the task and keeps it in the
                history, where Reopen brings it back; Delete removes it. */}
            <DropdownMenuItem onClick={() => setStatus.mutate({ id: t.id, status: "cancelled" })}><X className="size-3.5 mr-2" /> Cancel task</DropdownMenuItem>
            {/* tasks.delete has existed since the router was written and nothing
                ever called it. Completing a task that should not exist leaves it
                in the done pile skewing every count that reads it. */}
            <DropdownMenuItem
              className="text-rose-600 focus:text-rose-600"
              onClick={() => confirmAction(
                {
                  title: "Delete this task?",
                  description: `"${t.title}" will be permanently deleted. Use Complete instead if the work actually happened — deleting removes it from your history.`,
                  confirmLabel: "Delete",
                  destructive: true,
                },
                () => remove.mutate({ id: t.id }),
              )}
            >
              <Trash2 className="size-3.5 mr-2" /> Delete task
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  /** A done or cancelled task, with /tasks' Reopen (R72, X6.3). */
  const ClosedRow = ({ t }: { t: Task }) => {
    const cancelled = t.status === "cancelled";
    return (
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border/60 last:border-0">
        <span
          className="shrink-0 size-5 rounded-full flex items-center justify-center text-white"
          style={{ backgroundColor: cancelled ? "hsl(var(--muted-foreground))" : accent }}
        >
          {cancelled ? <X className="size-3" /> : <Check className="size-3" />}
        </span>
        <TypeIcon type={t.type} />
        <div className="min-w-0 flex-1"><div className="text-sm truncate line-through text-muted-foreground">{t.title}</div></div>
        {cancelled && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-secondary text-secondary-foreground">Dismissed</span>}
        {t.disposition && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-secondary text-muted-foreground capitalize">{t.disposition.replace(/_/g, " ")}</span>}
        <Button size="sm" variant="ghost" className="h-7 shrink-0 text-xs" disabled={setStatus.isPending}
          onClick={() => setStatus.mutate({ id: t.id, status: "open" })}>Reopen</Button>
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
          <Button size="sm" variant="outline" className="h-7 gap-1"
            title={/linkedin|connection request|connect with/i.test(t.title ?? "")
              ? "Approves the task only — it does NOT send a LinkedIn request. Real invites send from the LinkedIn invites queue above or the person's record."
              : undefined}
            onClick={() => approveDraft.mutate({ id: t.id })}><Check className="size-3.5" /> Approve</Button>
          <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" title="Dismiss" onClick={() => dismissDraft.mutate({ id: t.id })}><X className="size-4" /></Button>
        </div>
      </div>
    );
  };

  return (
    <Shell title="Tasks">
      <div data-tour-id="tasks-list" className="flex flex-col h-full min-h-0">
        {/* Header */}
        <div className="relative shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 min-h-11 py-1.5 border-b border-border bg-card/40">
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
          {/* The other sources that file tasks by themselves keep to a daily cap each (audit L15). */}
          <AutoTaskCapLine
            cap={autopilot.data?.autoTaskDailyCap ?? 25}
            saving={setMode.isPending}
            onSave={(n) => setMode.mutate({ autoTaskDailyCap: n })}
          />

          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Open" value={s.open} />
            <StatCard label="Due today" value={s.dueToday} tone={s.dueToday ? "warning" : undefined} />
            <StatCard label="Overdue" value={s.overdue} tone={s.overdue ? "danger" : undefined} />
            <StatCard label="AI drafts" value={s.draftsPending} tone={s.draftsPending ? "ai" : undefined} />
            <StatCard label="Completed" value={s.completed} />
          </div>

          {/* Waiting for your approval — each card SENDS when approved */}
          {(chatFollowUps.length > 0 || socialInvites.length > 0) && (
            <section>
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2"><Mail className="size-4" style={{ color: "#d97706" }} /> Waiting for your approval ({chatFollowUps.length + socialInvites.length})</h2>
              {chatFollowUps.length > 0 && (
                <div className="rounded-xl border bg-card overflow-hidden shadow-sm mb-3" style={{ borderColor: "#d9770640" }}>
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-amber-500/5">
                    <span className="text-[12px] font-medium">Chat follow-up emails ({chatFollowUps.length})</span>
                    <ConfirmButton size="sm" variant="outline" destructive={false} className="h-7 gap-1.5 text-xs" disabled={sendAllFollowUps.isPending}
                      title={`Send all ${chatFollowUps.length} chat follow-up${chatFollowUps.length === 1 ? "" : "s"}?`}
                      description="Each suggested email is sent to its visitor now, one per second, and the task closes as sent. Emails with no recipient on file are skipped and reported."
                      confirmLabel="Approve & send all" onConfirm={() => sendAllFollowUps.mutate()}>
                      <CheckCheck className="size-3.5" /> Approve & send all
                    </ConfirmButton>
                  </div>
                  {chatFollowUps.map((r) => (
                    <div key={r.id} className="flex items-start gap-3 px-3 py-2.5 border-b border-border/60 last:border-0">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{r.title}</div>
                        <div className="text-[11px] text-muted-foreground truncate">To {r.to ?? "(no recipient on file)"} · Subject: {r.subject ?? "—"}</div>
                        {r.body && <p className="text-[12px] text-muted-foreground mt-1 line-clamp-3 whitespace-pre-wrap">{r.body}</p>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <ConfirmButton size="sm" variant="outline" destructive={false} className="h-7 gap-1 text-xs" disabled={sendFollowUp.isPending || !r.to}
                          title="Send this follow-up now?" description={`Emails "${r.subject ?? ""}" to ${r.to ?? "the visitor"} and closes the task as sent.`}
                          confirmLabel="Approve & send" onConfirm={() => sendFollowUp.mutate({ id: r.id })}>
                          <Mail className="size-3.5" /> Approve & send
                        </ConfirmButton>
                        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" title="Dismiss without sending" onClick={() => complete.mutate({ id: r.id, disposition: "not_sent" })}><X className="size-4" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {socialInvites.length > 0 && (
                <div className="rounded-xl border bg-card overflow-hidden shadow-sm" style={{ borderColor: "#d9770640" }}>
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-amber-500/5">
                    <span className="text-[12px] font-medium">LinkedIn invites ({socialInvites.length})</span>
                    <ConfirmButton size="sm" variant="outline" destructive={false} className="h-7 gap-1.5 text-xs" disabled={sendAllInvites.isPending}
                      title={`Send all ${socialInvites.length} LinkedIn invite${socialInvites.length === 1 ? "" : "s"}?`}
                      description="Each invite goes out from the owning rep's connected LinkedIn account (or the workspace's account when that rep has none connected), with an AI-written note, within the account's daily limits; it stops when a limit is reached. Tasks close as sent."
                      confirmLabel="Approve & send all" onConfirm={() => sendAllInvites.mutate()}>
                      <CheckCheck className="size-3.5" /> Approve & send all
                    </ConfirmButton>
                  </div>
                  {socialInvites.map((r) => (
                    <div key={r.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-border/60 last:border-0">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{r.title}</div>
                        <a href={r.linkedinUrl ?? "#"} target="_blank" rel="noreferrer" className="text-[11px] text-muted-foreground truncate hover:underline">{r.linkedinUrl}</a>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <ConfirmButton size="sm" variant="outline" destructive={false} className="h-7 gap-1 text-xs" disabled={sendInvite.isPending}
                          title="Send this LinkedIn invite now?" description="Sends a connection request with an AI-written note from the owning rep's connected LinkedIn account (or the workspace's account when that rep has none connected) and closes the task as sent."
                          confirmLabel="Approve & send" onConfirm={() => sendInvite.mutate({ id: r.id })}>
                          <Link2 className="size-3.5" /> Approve & send
                        </ConfirmButton>
                        <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" title="Dismiss without sending" onClick={() => complete.mutate({ id: r.id, disposition: "not_sent" })}><X className="size-4" /></Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* AI drafts to review */}
          {draftTasks.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold flex items-center gap-2"><Sparkles className="size-4" style={{ color: "#7c3aed" }} /> AI drafts to review ({draftTasks.length})</h2>
                <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={approveAll.isPending}
                  onClick={() => confirmAction({
                    title: `Approve all ${draftTasks.length} AI draft task${draftTasks.length === 1 ? "" : "s"}?`,
                    description: "Every draft becomes an open task in your queue. Nothing is sent to anyone.",
                    confirmLabel: "Approve all", destructive: false,
                  }, () => approveAll.mutate())}>
                  <CheckCheck className="size-3.5" /> Approve all ({draftTasks.length})
                </Button>
              </div>
              <div className="rounded-xl border bg-card overflow-hidden shadow-sm" style={{ borderColor: "#7c3aed40" }}>
                {draftRows.shown.map((t) => <DraftRow key={t.id} t={t} />)}
                {draftRows.remaining > 0 && (
                  <button type="button" onClick={draftRows.showMore} className="w-full border-t px-3 py-2 text-center text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                    Show {Math.min(draftRows.remaining, SHOW_MORE_STEP)} more drafts ({draftRows.remaining.toLocaleString()} not shown)
                  </button>
                )}
              </div>
            </section>
          )}

          {/* Queue */}
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold flex items-center gap-2"><CalendarClock className="size-4" style={{ color: accent }} /> Task queue</h2>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {/* Says what it is scoping, so the unfiltered stat cards above
                    cannot be read as describing this list. */}
                {filtersOn && view === "queue" && (
                  <span className="text-muted-foreground tabular-nums">
                    {queue.length} of {queueAll.length} in queue
                  </span>
                )}
                {/* /tasks' "Related" filter (R72, X6.3). */}
                <label htmlFor="queue-related" className="text-muted-foreground">Related</label>
                <select
                  id="queue-related"
                  className="rounded border bg-background px-2 py-1"
                  value={relTypeFilter}
                  onChange={(e) => setRelTypeFilter(e.target.value)}
                >
                  <option value="">Any</option>
                  {RELATED_TYPES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                {/* Only a manager's queue holds other people's tasks (R72). */}
                {seesAll && <>
                <label htmlFor="queue-assignee" className="text-muted-foreground">Assignee</label>
                <select
                  id="queue-assignee"
                  className="rounded border bg-background px-2 py-1"
                  value={assigneeFilter}
                  onChange={(e) => setAssigneeFilter(e.target.value)}
                >
                  <option value="">Anyone</option>
                  {memberOpts.map((m) => (
                    <option key={m.userId} value={String(m.userId)}>{m.name ?? `User ${m.userId}`}</option>
                  ))}
                </select>
                </>}
              </div>
            </div>
            {/* /tasks' tabs, folded in (R72, X6.3). Counts are this list's,
                with the filters above applied. */}
            <div {...tablistProps("Task views")} className="mb-2 flex flex-wrap items-center gap-1">
              {TASK_VIEWS.map((v) => (
                <button {...tabProps(view === v.id)} key={v.id} type="button" onClick={() => setView(v.id)}
                  className={cn("rounded-md px-2.5 py-1 text-xs transition-colors", view === v.id ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
                  {v.label} <span className="tabular-nums text-muted-foreground">{viewCount[v.id]}</span>
                </button>
              ))}
            </div>
            <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
              {active.isLoading ? (
                <div className="p-3 space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-10 rounded bg-muted/50 animate-pulse" />)}</div>
              ) : active.error ? (
                <div className="text-center py-12 px-4">
                  <p className="text-sm text-muted-foreground">Couldn’t load tasks. {active.error.message}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => active.refetch()}>Retry</Button>
                </div>
              ) : view !== "queue" ? (
                listed.length === 0 ? (
                  <div className="text-center py-14 px-4">
                    <Inbox className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
                    <div className="text-sm font-medium">No tasks in {TASK_VIEWS.find((v) => v.id === view)?.label}</div>
                    {filtersOn && <p className="text-xs text-muted-foreground mt-1">The filters above narrow this list.</p>}
                  </div>
                ) : (
                  <>
                    {queueRows.shown.map((t) => (t.status === "done" || t.status === "cancelled" ? <ClosedRow key={t.id} t={t} /> : <QueueRow key={t.id} t={t} />))}
                    {queueRows.remaining > 0 && (
                      <button type="button" onClick={queueRows.showMore} className="w-full border-t px-3 py-2 text-center text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                        Show {Math.min(queueRows.remaining, SHOW_MORE_STEP)} more tasks ({queueRows.remaining.toLocaleString()} not shown)
                      </button>
                    )}
                  </>
                )
              ) : queue.length === 0 && assigneeFilter ? (
                // Nothing for THIS assignee is not the same as nothing at all,
                // and the queue is not "clear" while queueAll still has rows.
                <div className="text-center py-14 px-4">
                  <Inbox className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
                  <div className="text-sm font-medium">Nothing assigned to {memberName(Number(assigneeFilter)) ?? "them"}</div>
                  <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                    {queueAll.length} task{queueAll.length === 1 ? "" : "s"} in the queue{queueAll.length ? " belong to someone else" : ""}.
                  </p>
                  <div className="flex items-center justify-center gap-2 mt-3">
                    <Button size="sm" variant="outline" onClick={() => setAssigneeFilter("")}>Show anyone</Button>
                  </div>
                </div>
              ) : queue.length === 0 && relTypeFilter ? (
                <div className="text-center py-14 px-4">
                  <Inbox className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
                  <div className="text-sm font-medium">Nothing in the queue about a {relTypeFilter}</div>
                  <div className="flex items-center justify-center gap-2 mt-3">
                    <Button size="sm" variant="outline" onClick={() => setRelTypeFilter("")}>Any record</Button>
                  </div>
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
                <>
                  {queueRows.shown.map((t) => <QueueRow key={t.id} t={t} />)}
                  {queueRows.remaining > 0 && (
                    <button type="button" onClick={queueRows.showMore} className="w-full border-t px-3 py-2 text-center text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                      Show {Math.min(queueRows.remaining, SHOW_MORE_STEP)} more tasks ({queueRows.remaining.toLocaleString()} not shown)
                    </button>
                  )}
                </>
              )}
            </div>
          </section>

          {/* Completed */}
          {done.length > 0 && view === "queue" && (
            <section>
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2 text-muted-foreground"><Check className="size-4" /> Recently closed</h2>
              <div className="rounded-xl border bg-card overflow-hidden shadow-sm opacity-80">
                {done.map((t) => <ClosedRow key={t.id} t={t} />)}
              </div>
            </section>
          )}
        </div>
      </div>

      {/* New task dialog */}
      {/* The dialog clears once the task is SAVED (R104): it emptied itself
          on submit, so a refused save lost everything typed. */}
      <NewTaskDialog open={newOpen} onOpenChange={setNewOpen} onCreate={(v, saved) => create.mutate(v, { onSuccess: saved })} pending={create.isPending} members={memberOpts} />
    </Shell>
  );
}

/** What tasks.create takes: its type and priority lists, not any string. */
type NewTask = RouterInputs["tasks"]["create"];

function NewTaskDialog({
  open, onOpenChange, onCreate, pending, members,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** `saved` runs once the task is stored; the form clears then, not before. */
  onCreate: (v: NewTask, saved: () => void) => void;
  pending: boolean;
  members: { userId: number; name: string | null }[];
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<NewTask["type"]>("todo");
  const [priority, setPriority] = useState<NewTask["priority"]>("normal");
  const [due, setDue] = useState("");
  // "" means "leave it to the server", which defaults the owner to the caller
  // (activities.ts) — the same contract the legacy page's "— Me —" relied on.
  // Never send 0 or a guessed id.
  const [ownerUserId, setOwnerUserId] = useState<string>("");
  // The record the task is about, found by name (R104): this page could not
  // link a task to anything.
  const [related, setRelated] = useState<RelatedRecord | null>(null);

  const submit = () => {
    if (!title.trim()) return;
    onCreate({
      title: title.trim(),
      description: description.trim() || undefined,
      type,
      priority,
      dueAt: due ? new Date(due).toISOString() : undefined,
      ownerUserId: ownerUserId ? Number(ownerUserId) : undefined,
      relatedType: related?.type,
      relatedId: related?.id,
    }, () => {
      setTitle(""); setDescription(""); setType("todo"); setPriority("normal"); setDue(""); setOwnerUserId(""); setRelated(null);
    });
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
              <Select value={type} onValueChange={(v) => setType(v as NewTask["type"])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{TASK_TYPE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as NewTask["priority"])}>
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
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-due">Due</Label>
              <Input id="task-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-owner">Assignee</Label>
              {/* A plain select, not Radix: "" has to be a selectable value and
                  Radix's SelectItem rejects an empty string. "Me" is the
                  server's default, so it sends nothing. */}
              <select
                id="task-owner"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={ownerUserId}
                onChange={(e) => setOwnerUserId(e.target.value)}
              >
                <option value="">Me</option>
                {members.map((m) => (
                  <option key={m.userId} value={String(m.userId)}>{m.name ?? `User ${m.userId}`}</option>
                ))}
              </select>
            </div>
          </div>
          <RelatedRecordPicker value={related} onChange={setRelated} idPrefix="task-v2-related" />
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
