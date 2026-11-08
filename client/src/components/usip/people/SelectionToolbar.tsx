/**
 * SelectionToolbar — the action shelf shown when one or more people rows are
 * selected, matching Apollo's selected-state toolbar:
 *
 *   Clear N selected · Add to…▾ · Tasks▾ · AI call▾ · Workflow▾ · Add to list▾ ·
 *   Export · Enrich▾ · Research with AI▾ · ⋯
 *
 * Wired to real backends where Velocity already has them:
 *   - Sequence  → sequences.bulkEnroll(prospectIds)
 *   - Add to list → recordLists.list / create / addMembers(prospectIds)
 *   - Enrich    → linkedinEnrichment.run (LinkedIn refresh / job changes) and
 *                 prospects.enrichFullBulk, a server job (the full
 *                 comprehensive pass — the drawer's "Enrich fully", in bulk;
 *                 audit 2026-10-20, R66)
 *   - "All N matching" (F30): the actions run on the server by the list's
 *     filter, as a job, after a confirmation stating the count; Add to…
 *     gets the matching ids, so its enrolment checks all apply.
 * Only controls that do something are shown (audit 2026-10-20, R60). Save,
 * Email, Push to CRM/ATS and five More items looked like actions and only
 * toasted "coming soon"; they are gone until something backs them. Add to
 * list is the save, and Add to… is the email. Horizontally scrollable so it
 * never wraps at desktop widths.
 */
import { csvCell } from "@shared/csvCell";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { invalidateEnrollmentReads } from "@/lib/enrollmentCache";
import { usePermissions } from "@/hooks/usePermissions";
import { useAuth } from "@/_core/hooks/useAuth";
import { AddToMenu } from "@/components/usip/AddToMenu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  X, Mail, Send, Workflow as WorkflowIcon, ListPlus, Download, Sparkles,
  MoreHorizontal, Search, ChevronDown, Plus, Loader2, Activity, ListChecks,
  CheckSquare, UserX, Trash2, PhoneCall, ShieldCheck,
} from "lucide-react";
import { ResearchAiMenu } from "./ResearchAiMenu";
import { WorkflowSelectionMenu } from "./CreateWorkflowMenu";
import { useEnrichJob } from "./LinkedInEnrichment";
import { confirmAction } from "@/components/usip/Common";
import { confirmPaidLookup, useSourceBudgets } from "@/components/usip/SpendPreview";
import { useWorkspaceRole } from "@/hooks/useWorkspaceRole";
import { formatPhone } from "@shared/phoneFormat";
import { agentNumbers } from "@shared/voiceCapacity";
import { tablistProps, tabProps } from "@/lib/tabs";

const CSV_COLS: Array<{ key: string; label: string }> = [
  { key: "firstName", label: "First name" }, { key: "lastName", label: "Last name" },
  { key: "title", label: "Title" }, { key: "company", label: "Company" },
  { key: "email", label: "Email" }, { key: "phone", label: "Phone" },
  { key: "linkedinUrl", label: "LinkedIn" }, { key: "city", label: "City" },
  { key: "state", label: "State" }, { key: "country", label: "Country" },
  { key: "industry", label: "Industry" }, { key: "seniority", label: "Seniority" },
];
function toCsv(rows: any[]): string {
  // Formula cells neutralised too (audit 2026-10-20, G49).
  const esc = csvCell;
  return [CSV_COLS.map((c) => c.label).join(","), ...rows.map((r) => CSV_COLS.map((c) => esc(r[c.key])).join(","))].join("\n");
}

/**
 * "All N matching" (audit 2026-10-20, F30): the list's filter and its total,
 * instead of the page's ids. Actions then run on the server by that filter,
 * as a job, after a confirmation that states the count.
 */
export type MatchingSelection = { filter: Record<string, unknown>; total: number };

/**
 * Start a bulk job (all matching, or Enrich fully for a selection, R66) and
 * follow it: one toast when it ends, and the People reads refreshed.
 */
export function useBulkJob() {
  const utils = trpc.useUtils();
  const [jobId, setJobId] = useState<number | null>(null);
  const job = trpc.prospects.bulkJob.useQuery({ jobId: jobId ?? 0 }, {
    enabled: jobId != null,
    refetchInterval: (q) => {
      const s = (q.state.data as { status?: string } | undefined)?.status;
      return s === "queued" || s === "running" ? 2500 : false;
    },
  });
  useEffect(() => {
    const j = job.data;
    if (!j || jobId == null || j.id !== jobId || j.status === "queued" || j.status === "running") return;
    if (j.status === "done") toast.success(`${j.message ?? "Done"}${j.failed ? ` · ${j.failed} could not be done` : ""}.`);
    else toast.error(`${j.status === "canceled" ? "Stopped" : "Failed"}${j.message ? `: ${j.message}` : ""}.`);
    utils.prospects.invalidate();
    utils.recordLists.list.invalidate();
    utils.dataHealth.getMetrics.invalidate();
    setJobId(null);
  }, [job.data, jobId]); // eslint-disable-line react-hooks/exhaustive-deps
  const follow = (id: number, total: number, what: string) => {
    setJobId(id);
    toast.info(`${what} ${total.toLocaleString()} ${total === 1 ? "person" : "people"} in the background. You can leave this page.`);
  };
  return { follow, running: jobId != null };
}

export function SelectionToolbar({
  selectedIds,
  onClear,
  matching,
}: {
  selectedIds: number[];
  onClear: () => void;
  /** Set when "Select all N matching" is on (F30). */
  matching?: MatchingSelection;
}) {
  const n = matching ? matching.total : selectedIds.length;
  // Hidden here as UX; prospects.exportSelected, which the file is built from,
  // refuses without export_data too (audit 2026-10-20, R63).
  const { can } = usePermissions();
  const utils = trpc.useUtils();
  const [exporting, setExporting] = useState(false);
  // For the actions that enrol or look up by id (Add to…, AI call, LinkedIn),
  // "all matching" is the matching ids, read by the server from the filter.
  const matchQ = trpc.prospects.matchingIds.useQuery({ filter: (matching?.filter ?? {}) as any }, { enabled: !!matching });
  const actIds = matching ? ((matchQ.data?.ids ?? []) as number[]) : selectedIds;
  const idsReady = !matching || (!!matchQ.data && !matchQ.data.capped && matchQ.data.total === matching.total);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const rows = (matching
        ? await utils.prospects.exportMatching.fetch({ filter: matching.filter as any })
        : await utils.prospects.exportSelected.fetch({ prospectIds: selectedIds } as any)) as any[];
      const blob = new Blob([toCsv(rows ?? [])], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `people-export-${n}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${rows?.length ?? 0} ${(rows?.length ?? 0) === 1 ? "person" : "people"}`);
    } catch (e: any) {
      toast.error(e?.message ?? "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-border bg-card px-3 py-1.5 flex items-center gap-0.5 flex-nowrap overflow-x-auto min-w-0 [&_button]:h-8 [&_button]:shrink-0 [&_button]:whitespace-nowrap [&_button]:text-[13px]">
      <Button variant="ghost" size="sm" className="gap-1.5" onClick={onClear}>
        <X className="size-3.5" /> Clear {n.toLocaleString()} selected
      </Button>
      <span className="mx-1 h-5 w-px bg-border shrink-0" />

      {/* The one outreach action: Campaign · Sequence · List (seams audit, phase 2).
          On "all matching" it gets the matching ids from the server, so every
          enrolment check of its own procedures applies (F30). */}
      {idsReady ? (
        <AddToMenu prospectIds={actIds} label="Add to…" trigger={
          <Button variant="ghost" size="sm" className="gap-1.5"><Send className="size-4" /> Add to… <ChevronDown className="size-3 opacity-60" /></Button>
        } />
      ) : (
        <Button variant="ghost" size="sm" className="gap-1.5" disabled title={matchQ.data?.capped ? "Add to… takes at most 5,000 people; narrow the filters." : "Reading who matches…"}>
          {matchQ.isLoading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Add to…
        </Button>
      )}

      <CreateTasksMenu selectedIds={selectedIds} matching={matching} />

      <QueueAiCallMenu selectedIds={idsReady && actIds.length <= 200 ? actIds : []} tooMany={!!matching && n > 200} />

      <WorkflowSelectionMenu
        trigger={
          <Button variant="ghost" size="sm" className="gap-1.5">
            <WorkflowIcon className="size-4" /> Workflow <ChevronDown className="size-3 opacity-60" />
          </Button>
        }
      />

      <AddToListMenu selectedIds={selectedIds} matching={matching} />

      {can("export_data") && (
        <Button variant="ghost" size="sm" className="gap-1.5" disabled={exporting || (!!matching && n > 5000)} title={matching && n > 5000 ? "An export takes at most 5,000 people; narrow the filters." : undefined} onClick={exportCsv}>
          {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Export
        </Button>
      )}

      <EnrichMenu selectedIds={selectedIds} matching={matching} lookupIds={idsReady && actIds.length <= 500 ? actIds : null} />

      <ResearchAiMenu compact />

      <MoreMenu selectedIds={selectedIds} onClear={onClear} matching={matching} />
    </div>
  );
}

/* ───────────────────────── Sequence (functional) ──────────────────────── */

/** Exported so the People table's row Actions can reuse it with a compact
 *  trigger (single-prospect enroll) — same backend, same popover. */
export function SequenceMenu({ selectedIds, trigger }: { selectedIds: number[]; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const seqQ = trpc.sequences.list.useQuery(undefined, { enabled: open });
  const utils = trpc.useUtils();
  const sequences = useMemo(
    () => ((seqQ.data ?? []) as any[]).filter((s) => s.status !== "archived"),
    [seqQ.data],
  );
  const bulkEnroll = trpc.sequences.bulkEnroll.useMutation({
    onSuccess: (r: any, vars: any) => {
      const name = sequences.find((s) => s.id === vars.sequenceId)?.name ?? "sequence";
      if (r.enrolled > 0) toast.success(`Enrolled ${r.enrolled} in "${name}"`);
      else if (r.skippedAlreadyEnrolled > 0) toast.info(`Already enrolled in "${name}"`);
      else if (r.blockedInvalidEmail > 0) toast.error("Blocked — invalid email on file");
      else if (r.skippedSuppressed > 0) toast.error("Skipped — on a suppression list");
      else toast.info("No one enrolled");
      // A paused or draft sequence holds new enrolments (audit 2026-10-20, O1).
      if (r.enrolled > 0 && r.heldUntilActive) toast.info(`"${name}" is not active — nothing is sent until it is activated`);
      invalidateEnrollmentReads(utils, vars.sequenceId);
      setOpen(false);
    },
    onError: (e: any) => toast.error(e.message),
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="sm" className="gap-1.5">
            <Send className="size-4" /> Sequence <ChevronDown className="size-3 opacity-60" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="px-3 py-2 border-b text-[13px] font-medium">Add to sequence</div>
        <div className="max-h-64 overflow-y-auto py-1">
          {seqQ.isLoading ? (
            <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading…</div>
          ) : sequences.length === 0 ? (
            <p className="px-3 py-4 text-[13px] text-muted-foreground">No sequences yet — create one first.</p>
          ) : (
            sequences.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={bulkEnroll.isPending}
                onClick={() => confirmAction({
                  title: `Enrol ${selectedIds.length} ${selectedIds.length === 1 ? "person" : "people"} in "${s.name}"?`,
                  description: s.status === "active" ? "Each step sends the same message to everyone, on the sequence's schedule." : `It is ${s.status}: nothing is sent until it is active.`,
                  count: { n: selectedIds.length, one: "person", many: "people" },
                  confirmLabel: "Enrol",
                  destructive: false,
                }, () => bulkEnroll.mutate({ sequenceId: s.id, prospectIds: selectedIds }))}
                className="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-muted text-left disabled:opacity-60"
              >
                <Activity className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{s.name}</span>
                <span className="text-[10px] text-muted-foreground capitalize">{s.status}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ───────────────────────── Queue AI call (functional) ─────────────────── */

const SKIP_LABEL: Record<string, string> = {
  no_callable_number: "no North American phone number",
  do_not_call: "on the do-not-call list",
  already_queued: "already queued",
  not_found: "not found",
};

/**
 * Queue the selection for an outbound AI call (owner ask 2026-10-04). This
 * only creates drafts on the Calls page; a manager approves them before
 * anything dials.
 */
function QueueAiCallMenu({ selectedIds, tooMany }: { selectedIds: number[]; tooMany?: boolean }) {
  const n = selectedIds.length;
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const agents = trpc.voiceAgents.list.useQuery(undefined, { enabled: open });
  const callers = ((agents.data ?? []) as any[]).filter((a) => a.purpose === "outbound_outreach" && a.plivoNumber && a.status === "active");
  const chosen = agentId ?? callers[0]?.id ?? null;
  const queue = trpc.aiCalls.queue.useMutation({
    onSuccess: (r) => {
      const why = new Map<string, number>();
      for (const s of r.skipped) why.set(s.reason, (why.get(s.reason) ?? 0) + 1);
      const skipped = Array.from(why.entries()).map(([k, c]) => `${c} ${SKIP_LABEL[k] ?? k}`).join(", ");
      toast.success(`${r.queued} queued for approval on the Calls page${skipped ? `. Skipped: ${skipped}` : ""}`);
      setOpen(false); setNotes("");
    },
    onError: (e: any) => toast.error(e?.message ?? "Could not queue calls"),
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* At most 200 calls are queued at once (aiCalls.queue). */}
        <Button variant="ghost" size="sm" className="gap-1.5" disabled={tooMany || n === 0} title={tooMany ? "Queue up to 200 calls at a time; narrow the filters." : undefined}>
          <PhoneCall className="size-4" /> Queue AI call
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3 space-y-2.5">
        <div className="text-[13px] font-medium">AI call for {n} {n === 1 ? "person" : "people"}</div>
        {agents.isLoading ? (
          <div className="text-[12px] text-muted-foreground">Loading agents…</div>
        ) : callers.length === 0 ? (
          <div className="text-[12px] text-muted-foreground">
            No outreach agent with a Plivo number yet. Set one up in Settings → Voice agents.
          </div>
        ) : (
          <>
            <select aria-label="Agent" value={chosen ?? ""} onChange={(e) => setAgentId(Number(e.target.value))} className="h-8 w-full rounded-md border bg-background px-2 text-[13px]">
              {callers.map((a) => { const nums = agentNumbers(a); return <option key={a.id} value={a.id}>{a.name} · {formatPhone(nums[0])}{nums.length > 1 ? ` + ${nums.length - 1} more` : ""}</option>; })}
            </select>
            <textarea aria-label="Notes for the agent" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1500} rows={3}
              placeholder="Notes for the agent (optional), e.g. mention our October webinar"
              className="w-full rounded-md border bg-background px-2 py-1.5 text-[13px] outline-none" />
            <p className="text-[11.5px] text-muted-foreground">
              Nothing dials yet: the calls wait on the Calls page for a manager's approval, then dial during each person's calling hours.
            </p>
            <Button size="sm" className="w-full" disabled={!chosen || queue.isPending}
              onClick={() => chosen && queue.mutate({ prospectIds: selectedIds, agentId: chosen, ...(notes.trim() ? { callNotes: notes.trim() } : {}) })}>
              {queue.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null} Queue {n} call{n === 1 ? "" : "s"} for approval
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/* ───────────────────────── Create tasks (functional) ──────────────────── */

function CreateTasksMenu({ selectedIds, matching }: { selectedIds: number[]; matching?: MatchingSelection }) {
  const n = matching ? matching.total : selectedIds.length;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("Follow up");
  const [type, setType] = useState("follow_up");
  const [priority, setPriority] = useState("normal");
  const [dueInDays, setDueInDays] = useState(2);
  const bulk = trpc.tasks.bulkCreateForProspects.useMutation({
    onSuccess: (r: any) => { toast.success(`Created ${r?.created ?? n} task${(r?.created ?? n) === 1 ? "" : "s"}`); setOpen(false); },
    onError: (e: any) => toast.error(e?.message ?? "Could not create tasks"),
  });
  // All matching: one job on the server by the filter (F30).
  const job = useBulkJob();
  const byFilter = trpc.prospects.bulkByFilter.useMutation({
    onSuccess: (r) => { setOpen(false); job.follow(r.jobId, r.total, "Creating tasks for"); },
    onError: (e) => toast.error(e.message),
  });
  const submit = () => {
    if (matching) {
      confirmAction({ title: `Create a task for each of ${n.toLocaleString()} people?`, count: { n, one: "person", many: "people" }, description: `"${title.trim()}", due in ${dueInDays} day${dueInDays === 1 ? "" : "s"}, for everyone matching the filters: ${n.toLocaleString()} ${n === 1 ? "person" : "people"}.`, confirmLabel: `Create ${n.toLocaleString()} tasks` },
        () => byFilter.mutate({ action: "tasks", filter: matching.filter as any, expectedTotal: matching.total, params: { title: title.trim(), type, priority: priority as any, dueInDays } }));
      return;
    }
    bulk.mutate({ prospectIds: selectedIds, title: title.trim(), type, priority, dueInDays } as any);
  };
  const sel = "h-8 w-full rounded-md border bg-background px-2 text-[13px]";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          <CheckSquare className="size-4" /> Create tasks <ChevronDown className="size-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3 space-y-2.5">
        <div className="text-[13px] font-medium">New task for {n} {n === 1 ? "person" : "people"}</div>
        <input aria-label="Task title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" className="h-8 w-full rounded-md border bg-background px-2 text-[13px] outline-none" />
        <div className="grid grid-cols-2 gap-2">
          <select aria-label="Task type" value={type} onChange={(e) => setType(e.target.value)} className={sel}>
            <option value="follow_up">Follow up</option>
            <option value="call">Call</option>
            <option value="manual_email">Email</option>
            <option value="social_touch">Social touch</option>
            <option value="meeting_prep">Meeting prep</option>
            <option value="todo">To-do</option>
          </select>
          <select aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)} className={sel}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>
        <label className="flex items-center justify-between text-[13px] text-muted-foreground">
          Due in
          <span className="flex items-center gap-1">
            <input type="number" min={0} max={60} value={dueInDays} onChange={(e) => setDueInDays(Math.max(0, Math.min(60, Number(e.target.value) || 0)))} className="h-8 w-16 rounded-md border bg-background px-2 text-[13px] text-foreground outline-none" /> days
          </span>
        </label>
        <Button size="sm" className="w-full" disabled={!title.trim() || bulk.isPending || byFilter.isPending || job.running} onClick={submit}>
          {bulk.isPending || byFilter.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null} Create {n.toLocaleString()} task{n === 1 ? "" : "s"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/* ───────────────────────── Add to list (functional) ───────────────────── */

const LIST_TABS = [
  { id: "all", label: "All lists" },
  { id: "my", label: "My lists" },
  { id: "team", label: "Team lists" },
] as const;

/** Exported so the People table's row Actions can reuse it with a compact
 *  trigger (single-prospect add) — same backend, same popover. */
export function AddToListMenu({ selectedIds, trigger, matching }: { selectedIds: number[]; trigger?: ReactNode; matching?: MatchingSelection }) {
  const { user } = useAuth();
  const count = matching ? matching.total : selectedIds.length;
  // All matching: added on the server by the filter, as a job (F30).
  const job = useBulkJob();
  const byFilter = trpc.prospects.bulkByFilter.useMutation({
    onSuccess: (r) => { setOpen(false); setPicked(null); job.follow(r.jobId, r.total, "Adding to the list"); },
    onError: (e) => toast.error(e.message),
  });
  const addMatching = (listId: number, name: string) => confirmAction({
    title: `Add ${count.toLocaleString()} people to "${name}"?`,
    count: { n: count, one: "person", many: "people" },
    description: `Everyone matching the filters: ${count.toLocaleString()} ${count === 1 ? "person" : "people"}. Anyone already on the list stays once.`,
    confirmLabel: `Add ${count.toLocaleString()}`,
  }, () => byFilter.mutate({ action: "addToList", filter: matching!.filter as any, expectedTotal: matching!.total, params: { listId } }));
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<(typeof LIST_TABS)[number]["id"]>("all");
  const [picked, setPicked] = useState<number | null>(null);
  // Naming a new list (2026-10-06): it used to be created silently, named
  // after the search text or "New list".
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");
  const utils = trpc.useUtils();

  const listsQ = trpc.recordLists.list.useQuery(undefined, { enabled: open });
  const lists = useMemo(() => {
    const all = ((listsQ.data ?? []) as any[]).filter((l) => l.entityType !== "companies");
    return all.filter((l) => {
      if (q && !String(l.name).toLowerCase().includes(q.toLowerCase())) return false;
      if (tab === "my") return l.createdByUserId === user?.id;
      if (tab === "team") return l.createdByUserId !== user?.id;
      return true;
    });
  }, [listsQ.data, q, tab, user?.id]);

  const addMembers = trpc.recordLists.addMembers.useMutation({
    onSuccess: (r: any) => {
      toast.success(r.added > 0 ? `Added ${r.added} to list` : "Already in list");
      utils.recordLists.list.invalidate();
      setOpen(false);
      setPicked(null);
    },
    onError: (e: any) => toast.error(e.message),
  });
  const createList = trpc.recordLists.create.useMutation({
    onError: (e: any) => toast.error(e.message),
  });

  const doAdd = () => {
    if (picked == null) return;
    if (matching) { addMatching(picked, lists.find((l) => l.id === picked)?.name ?? "the list"); return; }
    addMembers.mutate({ listId: picked, recordType: "prospect", recordIds: selectedIds });
  };
  const startNaming = () => { setNewName(q.trim()); setNaming(true); };
  // Create the named list and add the selection to it in one step.
  const doCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const r = await createList.mutateAsync({ name, entityType: "people" });
      if (matching) {
        utils.recordLists.list.invalidate();
        addMatching(r.id, name);
      } else {
        await addMembers.mutateAsync({ listId: r.id, recordType: "prospect", recordIds: selectedIds });
      }
      setNaming(false);
      setNewName("");
    } catch {
      /* toasted by the mutation */
    }
  };
  const busy = createList.isPending || addMembers.isPending || byFilter.isPending || job.running;

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setPicked(null); setQ(""); setNaming(false); setNewName(""); } }}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ListPlus className="size-4" /> Add to list <ChevronDown className="size-3 opacity-60" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="p-2.5 border-b">
          <div className="flex items-center gap-2 px-2 h-8 rounded-md border bg-background">
            <Search className="size-3.5 text-muted-foreground shrink-0" />
            <input aria-label="Search lists" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="flex-1 bg-transparent outline-none text-[13px] min-w-0" />
          </div>
        </div>
        <div {...tablistProps("Lists")} className="flex items-center gap-4 px-3 pt-2 border-b text-[13px]">
          {LIST_TABS.map((t) => (
            <button {...tabProps(tab === t.id)}
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "pb-2 -mb-px border-b-2 whitespace-nowrap transition-colors",
                tab === t.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="max-h-56 overflow-y-auto py-1">
          {listsQ.isLoading ? (
            <div className="px-3 py-4 text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="size-3 animate-spin" /> Loading…</div>
          ) : lists.length === 0 ? (
            <p className="px-3 py-5 text-center text-[13px] text-muted-foreground">No lists found</p>
          ) : (
            lists.map((l) => (
              <label key={l.id} className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-muted cursor-pointer">
                <input
                  type="radio"
                  name="addtolist"
                  checked={picked === l.id}
                  onChange={() => setPicked(l.id)}
                  className="size-3.5 accent-current"
                />
                <ListChecks className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{l.name}</span>
                <span className="text-[11px] text-muted-foreground tabular-nums">{l.memberCount ?? 0}</span>
              </label>
            ))
          )}
        </div>
        {naming ? (
          <div className="border-t p-2 space-y-2">
            <Input aria-label="New list name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name the new list"
              maxLength={200}
              autoFocus
              className="h-8 text-[13px]"
              onKeyDown={(e) => { if (e.key === "Enter") void doCreate(); if (e.key === "Escape") { e.stopPropagation(); setNaming(false); } }}
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setNaming(false)} disabled={busy}>Cancel</Button>
              <Button size="sm" onClick={() => void doCreate()} disabled={!newName.trim() || busy}>
                {busy ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null} Create and add {count.toLocaleString()}
              </Button>
            </div>
          </div>
        ) : (
          <div className="border-t p-2 flex items-center justify-between">
            <Button variant="outline" size="sm" onClick={startNaming} disabled={busy}>
              <Plus className="size-3.5" /> Create new list
            </Button>
            <Button size="sm" onClick={doAdd} disabled={picked == null || busy}>
              {addMembers.isPending || byFilter.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null} Add to list
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/* ───────────────────────────── Enrich / More ──────────────────────────── */

function EnrichMenu({ selectedIds, matching, lookupIds }: { selectedIds: number[]; matching?: MatchingSelection; lookupIds: number[] | null }) {
  const utils = trpc.useUtils();
  const n = matching ? matching.total : selectedIds.length;
  // Real backend: the compliant LinkedIn enrichment orchestrator refreshes each
  // selected person's profile (title/company/location/photo) — which also feeds
  // job-change detection → the Job Change Autopilot. Health-gated server-side.
  // useEnrichJob polls the job to completion and invalidates prospects.list —
  // fire-and-forget left the table stale, which read as "photos don't stick".
  // On "all matching" it takes the matching ids, up to the 500 one run takes.
  const enrichJob = useEnrichJob();
  const start = () => { if (lookupIds?.length) enrichJob.enrich(lookupIds, "people_bulk_action"); };
  const budgets = useSourceBudgets();

  // The comprehensive pass (LinkedIn data on file → Apollo domain →
  // QuickEnrich → pattern+Reoon → scrape, provenance-merged) — the bulk twin
  // of the drawer's "Enrich fully (all sources)" — runs on the server as one
  // job (audit 2026-10-20, R66): a person at a time under the vendors' caps,
  // then ONE LinkedIn lookup job for the people still without a profile. It
  // went up from the browser ten people a request, so leaving the page
  // stopped it part-way. The confirmation states the most it can spend (F8).
  const fullJob = useBulkJob();
  const enrichFullBulk = trpc.prospects.enrichFullBulk.useMutation({
    onSuccess: (r) => fullJob.follow(r.jobId, r.total, "Enriching"),
    onError: (e) => toast.error(e.message),
  });
  const enrichByFilter = trpc.prospects.bulkByFilter.useMutation({
    onSuccess: (r) => { if (r.verify) { setVerifyJobId(r.jobId); toast.info(`Verifying ${r.total.toLocaleString()} in the background.`); } else fullJob.follow(r.jobId, r.total, "Enriching"); },
    onError: (e) => toast.error(e.message),
  });
  const startFull = () => {
    if (matching) enrichByFilter.mutate({ action: "enrichFull", filter: matching.filter as any, expectedTotal: matching.total });
    else enrichFullBulk.mutate({ ids: selectedIds });
  };
  const fullBusy = fullJob.running || enrichFullBulk.isPending || enrichByFilter.isPending;

  // Verify People in bulk (audit 2026-10-20, F39): one background job through
  // the person page's own Verify, asked first with the credits it can spend
  // (F8). It follows the job, then refreshes People and the Data health counts.
  const { isManager } = useWorkspaceRole();
  const [verifyJobId, setVerifyJobId] = useState<number | null>(null);
  const verifyBulk = trpc.prospects.verifyEmailBulk.useMutation({
    onSuccess: (r) => {
      setVerifyJobId(r.jobId);
      toast.info(r.existing
        ? "These people are already being verified; following that job."
        : `Verifying ${r.queued} ${r.queued === 1 ? "address" : "addresses"} in the background${r.noEmail ? ` (${r.noEmail} with no address skipped)` : ""}.`);
    },
    onError: (e) => toast.error(e.message),
  });
  const verifyJob = trpc.prospects.verifyJob.useQuery({ jobId: verifyJobId ?? 0 }, {
    enabled: verifyJobId != null,
    refetchInterval: (q) => {
      const s = (q.state.data as { status?: string } | undefined)?.status;
      return s === "queued" || s === "running" ? 3000 : false;
    },
  });
  useEffect(() => {
    const j = verifyJob.data;
    if (!j || verifyJobId == null || j.id !== verifyJobId || j.status === "queued" || j.status === "running") return;
    if (j.status === "done") toast.success(`Verified ${j.done} of ${j.total}${j.failed ? ` · ${j.failed} could not be verified` : ""}.`);
    else toast.error(`Verification ${j.status}${j.message ? `: ${j.message}` : ""}. ${j.done} of ${j.total} were verified.`);
    utils.prospects.list.invalidate();
    utils.prospects.get.invalidate();
    utils.dataHealth.getMetrics.invalidate();
    setVerifyJobId(null);
  }, [verifyJob.data, verifyJobId]); // eslint-disable-line react-hooks/exhaustive-deps
  const askVerify = () => confirmPaidLookup({
    title: `Verify the emails of ${n.toLocaleString()} ${n === 1 ? "person" : "people"}?`,
    vendor: "Reoon",
    count: n,
    unit: "daily credit",
    allowance: budgets.data?.reoon.allowance ?? null,
    note: "People with no address are skipped and cost nothing. It runs in the background; each verdict lands on the person and in Data health.",
    confirmLabel: "Verify",
  }, () => (matching
    ? enrichByFilter.mutate({ action: "verify", filter: matching.filter as any, expectedTotal: matching.total })
    : verifyBulk.mutate({ ids: selectedIds })));
  const verifying = verifyBulk.isPending || verifyJobId != null;

  const busy = enrichJob.running || fullBusy || verifying;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Enrich <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {/* Spends QuickEnrich, Reoon and LinkedIn: the most it can use is said first (audit 2026-10-20, F8). */}
        <DropdownMenuItem disabled={busy || n > 5000} onClick={() => confirmAction({
          title: `Enrich ${n.toLocaleString()} ${n === 1 ? "person" : "people"} fully?`,
          description: "It runs on the server in the background; you can leave this page.",
          count: { n, one: "person", many: "people" },
          cost: { kind: "enrichFully", people: n, budgets: budgets.data },
          confirmLabel: "Spend and enrich",
        }, startFull)}><Sparkles className="size-4 mr-2" /> {n > 5000 ? "Enrich fully (5,000 at a time)" : "Enrich fully (all sources)"}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || !lookupIds?.length} onClick={start}><Activity className="size-4 mr-2" /> {lookupIds ? "Refresh LinkedIn data" : "Refresh LinkedIn data (500 at a time)"}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || !lookupIds?.length} onClick={start}><Mail className="size-4 mr-2" /> Detect job changes</DropdownMenuItem>
        {/* Managers and admins, as prospects.verifyEmail requires. */}
        {isManager && (
          <DropdownMenuItem disabled={busy || n > 200} onClick={askVerify}>
            <ShieldCheck className="size-4 mr-2" /> {n > 200 ? "Verify emails (200 at a time)" : "Verify emails"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MoreMenu({ selectedIds, onClear, matching }: { selectedIds: number[]; onClear: () => void; matching?: MatchingSelection }) {
  const n = matching ? matching.total : selectedIds.length;
  const utils = trpc.useUtils();
  // All matching: opt-out and delete run on the server by the filter (F30),
  // after a confirmation that states the count.
  const job = useBulkJob();
  const byFilter = trpc.prospects.bulkByFilter.useMutation({
    onSuccess: (r, vars) => { job.follow(r.jobId, r.total, vars.action === "delete" ? "Deleting" : "Opting out"); if (vars.action === "delete") onClear(); },
    onError: (e) => toast.error(e.message),
  });
  // Real backend: prospects.bulkDelete hard-removes the selected people.
  const bulkDelete = trpc.prospects.bulkDelete.useMutation({
    onSuccess: (r: any) => {
      toast.success(`Deleted ${r?.deleted ?? n} ${n === 1 ? "person" : "people"}`);
      utils.prospects.invalidate();
      onClear();
    },
    onError: (e: any) => toast.error(e?.message ?? "Delete failed"),
  });
  // Real backend: bulk opt-out suppresses the selected people's emails so the
  // autopilots + sequences stop contacting them (compliant autonomy).
  const optOut = trpc.emailSuppressions.addByProspects.useMutation({
    onSuccess: (r: any) => toast.success(`Opted out ${r?.suppressed ?? 0} email${r?.suppressed === 1 ? "" : "s"} — they won't be contacted`),
    onError: (e: any) => toast.error(e?.message ?? "Opt-out failed"),
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="More actions" variant="ghost" size="sm" className="px-2">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem disabled={optOut.isPending || byFilter.isPending || job.running || (!!matching && n > 5000)} onClick={() => { confirmAction({ title: `Opt out ${n.toLocaleString()} ${matching ? "matching" : "selected"} ${n === 1 ? "person" : "people"}?`, count: { n, one: "person", many: "people" }, description: matching ? `Everyone matching the filters: ${n.toLocaleString()}. They'll be suppressed from all outreach.` : "They'll be suppressed from all outreach.", confirmLabel: "Opt out", destructive: false }, () => { if (matching) byFilter.mutate({ action: "optOut", filter: matching.filter as any, expectedTotal: matching.total }); else optOut.mutate({ prospectIds: selectedIds } as any); }); }}>
          <UserX className="size-4 mr-2" /> Opt Out
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-rose-600 focus:text-rose-600"
          disabled={bulkDelete.isPending || byFilter.isPending || job.running || (!!matching && n > 5000)}
          onClick={() => { confirmAction({ title: `Delete ${n.toLocaleString()} ${matching ? "matching" : "selected"} ${n === 1 ? "person" : "people"}?`, count: { n, one: "person", many: "people" }, description: matching ? `Everyone matching the filters: ${n.toLocaleString()} ${n === 1 ? "person" : "people"}. This cannot be undone here; each deleted row is kept in the audit log.` : "This cannot be undone.", confirmLabel: matching ? `Delete ${n.toLocaleString()}` : "Delete" }, () => { if (matching) byFilter.mutate({ action: "delete", filter: matching.filter as any, expectedTotal: matching.total }); else bulkDelete.mutate({ prospectIds: selectedIds } as any); }); }}
        >
          <Trash2 className="size-4 mr-2" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
