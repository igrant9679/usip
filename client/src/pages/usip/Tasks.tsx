/**
 * /tasks — full task surface.
 *
 * Tabs: Today · Upcoming · Overdue · Done · All.
 * Filters: assignee, related entity type.
 * New-task dialog supports assignee picker + related-record picker.
 *
 * The same trpc.tasks.* router powers the embedded RelatedTasks widget
 * exported from this file for use inside CRM detail pages.
 */
import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Field, FormDialog, SelectField, TextareaField, StatusPill, fmtDate } from "@/components/usip/Common";
import { EmptyState, PageHeader, QueryError, Shell, TableSkeleton } from "@/components/usip/Shell";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { Check, ListChecks, Plus, X, CheckSquare, User, LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { useWorkspaceTimezone } from "@/hooks/useWorkspaceTimezone";
import { RelatedRecordPicker, type RelatedRecord } from "@/components/usip/RelatedRecordPicker";
import { recentlyClosed, seesAllTasks, taskDueState, WORKABLE_TASK_STATUSES } from "@shared/taskRules";
import { SHOW_MORE_STEP, useShowMore } from "@/hooks/useShowMore";

type TaskRow = {
  id: number;
  title: string;
  description: string | null;
  status: "open" | "done" | "cancelled" | "in_progress" | "snoozed" | "draft";
  completedAt?: string | Date | null;
  updatedAt?: string | Date | null;
  priority: "low" | "normal" | "high" | "urgent";
  type: string;
  dueAt: string | Date | null;
  ownerUserId: number | null;
  relatedType: string | null;
  relatedId: number | null;
};

const PRIORITY_TONE: Record<string, "default" | "success" | "warning" | "danger" | "muted"> = {
  urgent: "danger", high: "danger", normal: "warning", low: "muted",
};

/**
 * Today / Upcoming / Overdue by the rule /v2/tasks and the server's counts use
 * (@shared/taskRules, audit 2026-10-20, R72): overdue from the moment a task
 * is due, "today" up to midnight in the workspace's zone. This counted overdue
 * only from the start of today on the viewer's clock.
 */
export function bucketize(rows: TaskRow[], timeZone: string, nowMs: number = Date.now()) {
  const today: TaskRow[] = [];
  const upcoming: TaskRow[] = [];
  const overdue: TaskRow[] = [];
  for (const t of rows) {
    if (!(WORKABLE_TASK_STATUSES as readonly string[]).includes(t.status)) continue;
    const due = taskDueState(t.dueAt, nowMs, timeZone);
    if (due === "overdue") overdue.push(t);
    else if (due === "today") today.push(t);
    else upcoming.push(t);
  }
  return { today, upcoming, overdue };
}

function entityHref(t: TaskRow): string | null {
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

function TaskItem({ t, onToggle, onCancel, members }: { t: TaskRow; onToggle: () => void; onCancel: () => void; members: { userId: number; name: string | null }[] }) {
  const owner = members.find((m) => m.userId === t.ownerUserId);
  const href = entityHref(t);
  return (
    <li className="p-3 flex items-center gap-3">
      <button aria-label={t.status === "done" ? "Mark not done" : "Mark done"} onClick={onToggle} className="size-5 rounded border flex items-center justify-center shrink-0">
        {t.status === "done" && <Check className="size-3" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className={`text-sm ${t.status === "done" ? "line-through text-muted-foreground" : "font-medium"}`}>{t.title}</div>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
          {owner && <span className="flex items-center gap-1"><User className="size-3" />{owner.name ?? "—"}</span>}
          {href && <Link href={href} className="flex items-center gap-1 hover:underline"><LinkIcon className="size-3" />{t.relatedType}</Link>}
          {t.type && t.type !== "todo" && <span>{t.type}</span>}
        </div>
        {t.description && <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{t.description}</div>}
      </div>
      <StatusPill tone={PRIORITY_TONE[t.priority] ?? "muted"}>{t.priority}</StatusPill>
      <div className="text-xs text-muted-foreground w-24 text-right">{fmtDate(t.dueAt as any)}</div>
      <button onClick={onCancel} className="text-muted-foreground hover:text-foreground" title="Cancel">
        <X className="size-4" />
      </button>
    </li>
  );
}

/* ─── Public: embed-anywhere tasks block ────────────────────────────── */
export function RelatedTasks({ entityType, entityId }: { entityType: string; entityId: number }) {
  const utils = trpc.useUtils();
  const { data: tasks } = trpc.tasks.list.useQuery({ relatedType: entityType, relatedId: entityId });
  const { data: members } = trpc.team.list.useQuery();
  const memberOpts = useMemo(() => (members ?? []).map((m: any) => ({ userId: m.userId as number, name: m.name as string | null })), [members]);
  const setStatus = trpc.tasks.setStatus.useMutation({ onSuccess: () => utils.tasks.list.invalidate({ relatedType: entityType, relatedId: entityId }), onError: (e) => toast.error(e.message) });
  const [open, setOpen] = useState(false);
  const create = trpc.tasks.create.useMutation({
    onSuccess: () => { utils.tasks.list.invalidate({ relatedType: entityType, relatedId: entityId }); setOpen(false); toast.success("Task created"); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Card><CardContent className="pt-4">
      <div className="flex items-center justify-between mb-2">
        <div className="font-medium text-sm flex items-center gap-2"><ListChecks className="size-4" /> Tasks <Badge variant="outline">{tasks?.length ?? 0}</Badge></div>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus className="size-3.5 mr-1" /> New</Button>
      </div>
      {!tasks || tasks.length === 0 ? <div className="text-xs text-muted-foreground">No tasks.</div> :
        <ul className="divide-y rounded-md border">
          {(tasks as TaskRow[]).map((t) => (
            <TaskItem key={t.id} t={t} members={memberOpts}
              onToggle={() => setStatus.mutate({ id: t.id, status: t.status === "done" ? "open" : "done" })}
              onCancel={() => setStatus.mutate({ id: t.id, status: "cancelled" })} />
          ))}
        </ul>
      }
      <FormDialog open={open} onOpenChange={setOpen} title="New task" isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          title: String(f.get("title")),
          description: String(f.get("description") ?? "") || undefined,
          // The day picked, "YYYY-MM-DD" — the server makes it the END of that
          // day in the workspace's zone. toISOString() sent UTC midnight, which
          // west of Greenwich is yesterday evening: overdue at creation (R29).
          dueAt: String(f.get("dueAt") ?? "") || undefined,
          priority: f.get("priority") as any,
          ownerUserId: f.get("ownerUserId") ? Number(f.get("ownerUserId")) : undefined,
          relatedType: entityType,
          relatedId: entityId,
        })}>
        <Field name="title" label="Title" required />
        <TextareaField name="description" label="Description" />
        <div className="grid grid-cols-2 gap-3">
          <Field name="dueAt" label="Due" type="date" />
          <SelectField name="priority" label="Priority" options={["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: p }))} defaultValue="normal" />
        </div>
        <SelectField name="ownerUserId" label="Assignee"
          options={[{ value: "", label: "— Me —" }, ...memberOpts.map((m) => ({ value: String(m.userId), label: m.name ?? `User ${m.userId}` }))]} />
      </FormDialog>
    </CardContent></Card>
  );
}

/* ─── Page ──────────────────────────────────────────────────────────── */

export default function Tasks() {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<"today" | "upcoming" | "overdue" | "done" | "all">("today");
  const [assigneeFilter, setAssigneeFilter] = useState<string>(""); // "" = any
  const [relTypeFilter, setRelTypeFilter] = useState<string>(""); // "" = any
  const [open, setOpen] = useState(false);
  const [related, setRelated] = useState<RelatedRecord | null>(null);
  const { current } = useWorkspace();
  const { timezone } = useWorkspaceTimezone();
  // One scope on both task pages (R72): a rep sees their own, a manager everyone's.
  const seesAll = seesAllTasks(current?.role);

  const { data: rawAll, isLoading: allLoading, error: allError, refetch: allRefetch } = trpc.tasks.list.useQuery({ mine: true });
  const { data: members } = trpc.team.list.useQuery();
  const memberOpts = useMemo(() => (members ?? []).map((m: any) => ({ userId: m.userId as number, name: m.name as string | null })), [members]);

  const all = (rawAll ?? []) as TaskRow[];
  const filtered = useMemo(() => {
    return all.filter((t) => {
      if (assigneeFilter && String(t.ownerUserId ?? "") !== assigneeFilter) return false;
      if (relTypeFilter && t.relatedType !== relTypeFilter) return false;
      return true;
    });
  }, [all, assigneeFilter, relTypeFilter]);

  const buckets = useMemo(() => bucketize(filtered, timezone), [filtered, timezone]);
  // Done tasks, latest first (R72); this tab never held cancelled ones.
  const done = useMemo(() => recentlyClosed(filtered.filter((t) => t.status === "done")), [filtered]);

  const setStatus = trpc.tasks.setStatus.useMutation({ onSuccess: () => utils.tasks.list.invalidate(), onError: (e) => toast.error(e.message) });
  const create = trpc.tasks.create.useMutation({
    onSuccess: () => { utils.tasks.list.invalidate(); setOpen(false); setRelated(null); toast.success("Task created"); },
    onError: (e) => toast.error(e.message),
  });

  const visible: TaskRow[] =
    tab === "today" ? buckets.today :
    tab === "upcoming" ? buckets.upcoming :
    tab === "overdue" ? buckets.overdue :
    tab === "done" ? done :
    filtered;
  // 50 rows at a time (audit 2026-10-20, X4.2): /tasks drew every task at
  // once, about 9,000 DOM nodes on a busy workspace. A new tab or filter
  // starts over at 50; the tab counts stay whole.
  const rowsShown = useShowMore(visible, { tab, assigneeFilter, relTypeFilter });

  return (
    <Shell title="Tasks">
      <PageHeader title="Tasks" description="Create, assign, and track tasks across every deal, account, and customer record."
        icon={<CheckSquare className="size-5" />}>
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New task</Button>
      </PageHeader>
      <div className="p-4 md:p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* A rep's list is their own tasks, so there is no one else to pick. */}
          {seesAll && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Assignee</span>
            <select aria-label="Assignee" className="bg-secondary rounded px-2 py-1" value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
              <option value="">Any</option>
              {memberOpts.map((m) => <option key={m.userId} value={String(m.userId)}>{m.name ?? `User ${m.userId}`}</option>)}
            </select>
          </div>
          )}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Related</span>
            <select aria-label="Related" className="bg-secondary rounded px-2 py-1" value={relTypeFilter} onChange={(e) => setRelTypeFilter(e.target.value)}>
              <option value="">Any</option>
              {["account", "contact", "lead", "opportunity", "prospect"].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
          <TabsList>
            <TabsTrigger value="today">Today <Badge variant="outline" className="ml-1.5">{buckets.today.length}</Badge></TabsTrigger>
            <TabsTrigger value="upcoming">Upcoming <Badge variant="outline" className="ml-1.5">{buckets.upcoming.length}</Badge></TabsTrigger>
            <TabsTrigger value="overdue">Overdue <Badge variant="outline" className="ml-1.5">{buckets.overdue.length}</Badge></TabsTrigger>
            <TabsTrigger value="done">Done</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
          <TabsContent value={tab} className="pt-4">
            {allError ? <QueryError message={allError.message} onRetry={() => allRefetch()} /> : allLoading ? <TableSkeleton rows={6} /> : visible.length === 0 ? <EmptyState icon={ListChecks} title="No tasks" description="You're all caught up. Tasks created from a deal, contact, or lead — and your follow-ups — show up here." /> :
              <ul className="divide-y rounded-lg border bg-card">
                {rowsShown.shown.map((t) => (
                  <TaskItem key={t.id} t={t} members={memberOpts}
                    onToggle={() => setStatus.mutate({ id: t.id, status: t.status === "done" ? "open" : "done" })}
                    onCancel={() => setStatus.mutate({ id: t.id, status: "cancelled" })} />
                ))}
                {rowsShown.remaining > 0 && (
                  <li>
                    <button type="button" onClick={rowsShown.showMore} className="w-full px-3 py-2 text-center text-xs font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground">
                      Show {Math.min(rowsShown.remaining, SHOW_MORE_STEP)} more tasks ({rowsShown.remaining.toLocaleString()} not shown)
                    </button>
                  </li>
                )}
              </ul>
            }
          </TabsContent>
        </Tabs>
      </div>

      <FormDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setRelated(null); }} title="New task" isPending={create.isPending}
        onSubmit={(f) => {
          create.mutate({
            title: String(f.get("title")),
            description: String(f.get("description") ?? "") || undefined,
            // The day picked, "YYYY-MM-DD" — the server makes it the END of that
            // day in the workspace's zone. toISOString() sent UTC midnight, which
            // west of Greenwich is yesterday evening: overdue at creation (R29).
            dueAt: String(f.get("dueAt") ?? "") || undefined,
            priority: f.get("priority") as any,
            ownerUserId: f.get("ownerUserId") ? Number(f.get("ownerUserId")) : undefined,
            relatedType: related?.type,
            relatedId: related?.id,
          });
        }}>
        <Field name="title" label="Title" required />
        <TextareaField name="description" label="Description" />
        <div className="grid grid-cols-2 gap-3">
          <Field name="dueAt" label="Due" type="date" />
          <SelectField name="priority" label="Priority" options={["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: p }))} defaultValue="normal" />
        </div>
        <SelectField name="ownerUserId" label="Assignee"
          options={[{ value: "", label: "— Me —" }, ...memberOpts.map((m) => ({ value: String(m.userId), label: m.name ?? `User ${m.userId}` }))]} />
        {/* Found by name (R104): this asked for a raw "Related ID" that
            appears nowhere in the app. */}
        <RelatedRecordPicker value={related} onChange={setRelated} idPrefix="task-related" />
      </FormDialog>
    </Shell>
  );
}
