/**
 * SelectionToolbar — the action shelf shown when one or more people rows are
 * selected, matching Apollo's selected-state toolbar:
 *
 *   Clear N selected · Save · Email · Sequence▾ · Workflow▾ · Add to list▾ ·
 *   Export · Enrich▾ · Research with AI▾ · Push to CRM/ATS · ⋯
 *
 * Wired to real backends where Velocity already has them:
 *   - Sequence  → sequences.bulkEnroll(prospectIds)
 *   - Add to list → recordLists.list / create / addMembers(prospectIds)
 * The rest (Save, Email, Export, Enrich, Push to CRM, More menu) are clean
 * placeholders that toast — no backend exists for them yet. Horizontally
 * scrollable so it never wraps at desktop widths.
 */
import { useMemo, useState, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
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
  X, Save, Mail, Send, Workflow as WorkflowIcon, ListPlus, Download, Sparkles, Upload,
  MoreHorizontal, Search, ChevronDown, Plus, Loader2, Activity, Building2, Copy, ListChecks,
  CheckSquare, Tag, UserX, Trash2, ListX,
} from "lucide-react";
import { ResearchAiMenu } from "./ResearchAiMenu";
import { WorkflowSelectionMenu } from "./CreateWorkflowMenu";
import { confirmAction } from "@/components/usip/Common";

const CSV_COLS: Array<{ key: string; label: string }> = [
  { key: "firstName", label: "First name" }, { key: "lastName", label: "Last name" },
  { key: "title", label: "Title" }, { key: "company", label: "Company" },
  { key: "email", label: "Email" }, { key: "phone", label: "Phone" },
  { key: "linkedinUrl", label: "LinkedIn" }, { key: "city", label: "City" },
  { key: "state", label: "State" }, { key: "country", label: "Country" },
  { key: "industry", label: "Industry" }, { key: "seniority", label: "Seniority" },
];
function toCsv(rows: any[]): string {
  const esc = (v: any) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [CSV_COLS.map((c) => c.label).join(","), ...rows.map((r) => CSV_COLS.map((c) => esc(r[c.key])).join(","))].join("\n");
}

export function SelectionToolbar({
  selectedIds,
  onClear,
}: {
  selectedIds: number[];
  onClear: () => void;
}) {
  const n = selectedIds.length;
  const utils = trpc.useUtils();
  const [exporting, setExporting] = useState(false);
  const soon = (what: string) => toast.info(`${what} — coming soon for ${n} selected ${n === 1 ? "person" : "people"}`);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const rows = (await utils.prospects.exportSelected.fetch({ prospectIds: selectedIds } as any)) as any[];
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
        <X className="size-3.5" /> Clear {n} selected
      </Button>
      <span className="mx-1 h-5 w-px bg-border shrink-0" />

      <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={() => soon("Save")}>
        <Save className="size-4" /> Save
      </Button>
      <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => soon("Email")}>
        <Mail className="size-4" /> Email
      </Button>

      <SequenceMenu selectedIds={selectedIds} />

      <CreateTasksMenu selectedIds={selectedIds} />

      <WorkflowSelectionMenu
        trigger={
          <Button variant="ghost" size="sm" className="gap-1.5">
            <WorkflowIcon className="size-4" /> Workflow <ChevronDown className="size-3 opacity-60" />
          </Button>
        }
      />

      <AddToListMenu selectedIds={selectedIds} />

      <Button variant="ghost" size="sm" className="gap-1.5" disabled={exporting} onClick={exportCsv}>
        {exporting ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Export
      </Button>

      <EnrichMenu selectedIds={selectedIds} />

      <ResearchAiMenu compact />

      <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => soon("Push to CRM/ATS")}>
        <Upload className="size-4" /> Push to CRM/ATS
      </Button>

      <MoreMenu selectedIds={selectedIds} onClear={onClear} onPick={soon} />
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
      else toast.info("No one enrolled");
      utils.sequences.getEnrollmentStats.invalidate({ sequenceId: vars.sequenceId });
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
                onClick={() => bulkEnroll.mutate({ sequenceId: s.id, prospectIds: selectedIds })}
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

/* ───────────────────────── Create tasks (functional) ──────────────────── */

function CreateTasksMenu({ selectedIds }: { selectedIds: number[] }) {
  const n = selectedIds.length;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("Follow up");
  const [type, setType] = useState("follow_up");
  const [priority, setPriority] = useState("normal");
  const [dueInDays, setDueInDays] = useState(2);
  const bulk = trpc.tasks.bulkCreateForProspects.useMutation({
    onSuccess: (r: any) => { toast.success(`Created ${r?.created ?? n} task${(r?.created ?? n) === 1 ? "" : "s"}`); setOpen(false); },
    onError: (e: any) => toast.error(e?.message ?? "Could not create tasks"),
  });
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
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" className="h-8 w-full rounded-md border bg-background px-2 text-[13px] outline-none" />
        <div className="grid grid-cols-2 gap-2">
          <select value={type} onChange={(e) => setType(e.target.value)} className={sel}>
            <option value="follow_up">Follow up</option>
            <option value="call">Call</option>
            <option value="manual_email">Email</option>
            <option value="social_touch">Social touch</option>
            <option value="meeting_prep">Meeting prep</option>
            <option value="todo">To-do</option>
          </select>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className={sel}>
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
        <Button size="sm" className="w-full" disabled={!title.trim() || bulk.isPending} onClick={() => bulk.mutate({ prospectIds: selectedIds, title: title.trim(), type, priority, dueInDays } as any)}>
          {bulk.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null} Create {n} task{n === 1 ? "" : "s"}
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
export function AddToListMenu({ selectedIds, trigger }: { selectedIds: number[]; trigger?: ReactNode }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<(typeof LIST_TABS)[number]["id"]>("all");
  const [picked, setPicked] = useState<number | null>(null);
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
    onSuccess: (r: any) => {
      utils.recordLists.list.invalidate();
      setPicked(r.id);
      toast.success("List created");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const doAdd = () => {
    if (picked == null) return;
    addMembers.mutate({ listId: picked, recordType: "prospect", recordIds: selectedIds });
  };
  const doCreate = () => {
    const name = q.trim() || "New list";
    createList.mutate({ name, entityType: "people" });
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setPicked(null); setQ(""); } }}>
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
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="flex-1 bg-transparent outline-none text-[13px] min-w-0" />
          </div>
        </div>
        <div className="flex items-center gap-4 px-3 pt-2 border-b text-[13px]">
          {LIST_TABS.map((t) => (
            <button
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
        <div className="border-t p-2 flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={doCreate} disabled={createList.isPending}>
            {createList.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Create new list
          </Button>
          <Button size="sm" onClick={doAdd} disabled={picked == null || addMembers.isPending}>
            {addMembers.isPending ? <Loader2 className="size-3.5 animate-spin mr-1" /> : null} Add to list
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ───────────────────────────── Enrich / More ──────────────────────────── */

function EnrichMenu({ selectedIds }: { selectedIds: number[] }) {
  // Real backend: the compliant LinkedIn enrichment orchestrator refreshes each
  // selected person's profile (title/company/location/photo) — which also feeds
  // job-change detection → the Job Change Autopilot. Health-gated server-side.
  const run = trpc.linkedinEnrichment.run.useMutation({
    onSuccess: (r: any) => toast.success(`Enrichment started for ${r?.total ?? selectedIds.length} ${selectedIds.length === 1 ? "person" : "people"}`),
    onError: (e: any) => toast.error(e?.message ?? "Could not start enrichment"),
  });
  const start = () => run.mutate({ prospectIds: selectedIds, triggerType: "people_bulk_action" } as any);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          {run.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Enrich <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem disabled={run.isPending} onClick={start}><Activity className="size-4 mr-2" /> Refresh LinkedIn data</DropdownMenuItem>
        <DropdownMenuItem disabled={run.isPending} onClick={start}><Mail className="size-4 mr-2" /> Detect job changes</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MoreMenu({ selectedIds, onClear, onPick }: { selectedIds: number[]; onClear: () => void; onPick: (what: string) => void }) {
  const n = selectedIds.length;
  const utils = trpc.useUtils();
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
  const items = [
    { label: "View Companies", icon: Building2 },
    { label: "Merge duplicates", icon: Copy },
    { label: "Change Stage", icon: ListChecks },
    { label: "Remove from lists", icon: ListX },
    { label: "Set Custom Field", icon: Tag },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="px-2">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {items.map((it) => (
          <DropdownMenuItem key={it.label} onClick={() => onPick(it.label)}>
            <it.icon className="size-4 mr-2" /> {it.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem disabled={optOut.isPending} onClick={() => { confirmAction({ title: `Opt out ${n} selected ${n === 1 ? "person" : "people"} from all outreach?` }, () => { optOut.mutate({ prospectIds: selectedIds } as any); }); }}>
          <UserX className="size-4 mr-2" /> Opt Out
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-rose-600 focus:text-rose-600"
          disabled={bulkDelete.isPending}
          onClick={() => { confirmAction({ title: `Delete ${n} selected ${n === 1 ? "person" : "people"}? This cannot be undone.` }, () => { bulkDelete.mutate({ prospectIds: selectedIds } as any); }); }}
        >
          <Trash2 className="size-4 mr-2" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
