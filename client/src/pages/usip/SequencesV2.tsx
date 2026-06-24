/**
 * SequencesV2 — the Engage → "Sequences" surface (/v2/sequences).
 *
 * Modelled on Apollo's Sequences index: header tabs (All Sequences / Analytics
 * / Diagnostics), a left filter rail (Starred, Owned by, Tags, Status,
 * Performance, Folders, Shared by) and a sequences table with an empty state.
 * Wired to the existing sequences router (list + create). The full multi-step
 * create-sequence builder is a follow-up; "Create sequence" makes a draft here.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import {
  Send, Plus, Search, Filter, Save, ArrowUpDown, Settings2, ChevronDown,
  Star, UserCircle2, Tag, Activity, BarChart3, Folder, Share2, X,
  MoreHorizontal, ExternalLink, Layers, Users,
} from "lucide-react";

type Sequence = {
  id: number;
  name: string;
  status: string;
  steps?: any[] | null;
  enrolledCount?: number | null;
  ownerUserId?: number | null;
  updatedAt?: string | Date | null;
  createdAt?: string | Date | null;
};

function fmtWhen(d?: string | Date | null): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  const day = 864e5;
  if (diff < day) return "Today";
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function statusBadge(s: string) {
  const map: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    paused: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    draft: "bg-secondary text-muted-foreground",
    archived: "bg-muted text-muted-foreground",
  };
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", map[s] ?? map.draft)}>{s}</span>;
}

/* collapsible filter group */
function FGroup({ label, icon: Icon, open, onToggle, count, children }: { label: string; icon: any; open: boolean; onToggle: () => void; count?: number; children?: React.ReactNode }) {
  return (
    <div className="border-b border-border/60">
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2 text-[13px] font-medium hover:bg-muted/40">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-left">{label}</span>
        {count ? <span className="text-[10px] font-semibold size-4 rounded-full inline-flex items-center justify-center text-white" style={{ backgroundColor: "var(--seq-accent)" }}>{count}</span> : null}
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </button>
      {open && <div className="px-3 pb-2.5 space-y-1">{children}</div>}
    </div>
  );
}

const STATUSES = ["active", "paused", "draft", "archived"] as const;
const TABS = ["All Sequences", "Analytics", "Diagnostics"] as const;
type Tab = (typeof TABS)[number];

export default function SequencesV2() {
  const [, setLocation] = useLocation();
  const accent = useAccentColor();
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.sequences.list.useQuery();
  const sequences = (data ?? []) as Sequence[];
  const createMut = trpc.sequences.create.useMutation({
    onSuccess: () => { utils.sequences.list.invalidate(); setCreateOpen(false); setNewName(""); },
  });

  const [tab, setTab] = useState<Tab>("All Sequences");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updated");
  const [statusSel, setStatusSel] = useState<Set<string>>(new Set());
  const [ownerMine, setOwnerMine] = useState(false);
  const [hideFilters, setHideFilters] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(["Status", "Owned by"]));
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const toggleGroup = (k: string) => setOpenGroups((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleStatus = (s: string) => setStatusSel((p) => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n; });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = sequences.filter((s) => {
      if (q && !s.name.toLowerCase().includes(q)) return false;
      if (statusSel.size && !statusSel.has(s.status)) return false;
      if (ownerMine && s.ownerUserId !== user?.id) return false;
      return true;
    });
    const cmp: Record<string, (a: Sequence, b: Sequence) => number> = {
      updated: (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
      name: (a, b) => a.name.localeCompare(b.name),
      enrolled: (a, b) => (b.enrolledCount ?? 0) - (a.enrolledCount ?? 0),
    };
    return [...out].sort(cmp[sort] ?? cmp.updated);
  }, [sequences, search, statusSel, ownerMine, sort, user?.id]);

  const activeCount = statusSel.size + (ownerMine ? 1 : 0) + (search ? 1 : 0);
  const clearFilters = () => { setStatusSel(new Set()); setOwnerMine(false); setSearch(""); };

  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));
  const toggleAll = () => setChecked((p) => { const n = new Set(p); if (allChecked) rows.forEach((r) => n.delete(r.id)); else rows.forEach((r) => n.add(r.id)); return n; });

  return (
    <Shell title="Sequences">
      <div className="flex flex-col h-full min-h-0" style={{ ["--seq-accent" as any]: accent }}>
        {/* header + tabs */}
        <div className="relative shrink-0 px-4 pt-2 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <div className="flex items-center gap-2">
            <Send className="size-4" style={{ color: accent }} />
            <h1 className="text-[15px] font-semibold tracking-tight">Sequences</h1>
            <div className="flex-1" />
            <Button size="sm" className="h-7 gap-1.5" style={{ backgroundColor: accent }} onClick={() => { setNewName(""); setCreateOpen(true); }}><Plus className="size-3.5" /> Create sequence</Button>
          </div>
          <div className="flex items-center gap-1 mt-1.5">
            {TABS.map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cn("relative px-3 py-2 text-[13px] transition-colors", tab === t ? "font-semibold" : "text-muted-foreground hover:text-foreground")} style={tab === t ? { color: accent } : undefined}>
                {t}
                {tab === t && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full" style={{ backgroundColor: accent }} />}
              </button>
            ))}
          </div>
        </div>

        {tab === "All Sequences" ? (
          <>
            {/* toolbar */}
            <div className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-1.5 flex-wrap bg-card/40 [&_button]:h-7">
              <Button variant="outline" size="sm" className="gap-1.5">All Sequences <ChevronDown className="size-3.5 opacity-60" /></Button>
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setHideFilters((v) => !v)}><Filter className="size-4" /> {hideFilters ? "Show" : "Hide"} filters{activeCount ? ` (${activeCount})` : ""}</Button>
              <div className="flex items-center gap-2 px-2.5 h-7 rounded-md border bg-background text-sm min-w-0 flex-1 max-w-xs">
                <Search className="size-4 text-muted-foreground shrink-0" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} className="bg-transparent outline-none flex-1 min-w-0 text-[13px]" placeholder="Search sequences…" />
                {search && <button onClick={() => setSearch("")}><X className="size-3.5 text-muted-foreground" /></button>}
              </div>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" className="gap-1.5"><Save className="size-4" /> Save as new view</Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="gap-1.5"><ArrowUpDown className="size-4" /> Sort</Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
                    <DropdownMenuRadioItem value="updated">Last updated</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="name">Name (A → Z)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="enrolled">Enrolled (most)</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="ghost" size="icon-sm" title="View options"><Settings2 className="size-4" /></Button>
            </div>

            <div className="flex flex-1 min-h-0">
              {/* filter rail */}
              {!hideFilters && (
                <aside className="w-60 shrink-0 border-r border-border flex flex-col min-h-0 bg-card/30">
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <FGroup label="Starred" icon={Star} open={openGroups.has("Starred")} onToggle={() => toggleGroup("Starred")}>
                      <p className="text-[12px] text-muted-foreground">Star sequences to pin them here.</p>
                    </FGroup>
                    <FGroup label="Owned by" icon={UserCircle2} open={openGroups.has("Owned by")} onToggle={() => toggleGroup("Owned by")} count={ownerMine ? 1 : 0}>
                      <label className="flex items-center gap-2 text-[13px] cursor-pointer py-0.5"><Checkbox checked={ownerMine} onCheckedChange={() => setOwnerMine((v) => !v)} className="size-3.5" /> Owned by me</label>
                    </FGroup>
                    <FGroup label="Tags" icon={Tag} open={openGroups.has("Tags")} onToggle={() => toggleGroup("Tags")}>
                      <p className="text-[12px] text-muted-foreground">No tags yet.</p>
                    </FGroup>
                    <FGroup label="Status" icon={Activity} open={openGroups.has("Status")} onToggle={() => toggleGroup("Status")} count={statusSel.size}>
                      {STATUSES.map((s) => (
                        <label key={s} className="flex items-center gap-2 text-[13px] cursor-pointer py-0.5 capitalize"><Checkbox checked={statusSel.has(s)} onCheckedChange={() => toggleStatus(s)} className="size-3.5" /> {s}</label>
                      ))}
                    </FGroup>
                    <FGroup label="Performance" icon={BarChart3} open={openGroups.has("Performance")} onToggle={() => toggleGroup("Performance")}>
                      <p className="text-[12px] text-muted-foreground">Filter by open / reply rate (coming soon).</p>
                    </FGroup>
                    <FGroup label="Folders" icon={Folder} open={openGroups.has("Folders")} onToggle={() => toggleGroup("Folders")}>
                      <p className="text-[12px] text-muted-foreground">No folders yet.</p>
                    </FGroup>
                    <FGroup label="Shared by" icon={Share2} open={openGroups.has("Shared by")} onToggle={() => toggleGroup("Shared by")}>
                      <p className="text-[12px] text-muted-foreground">Shared sequences appear here.</p>
                    </FGroup>
                  </div>
                  <div className="shrink-0 border-t border-border p-2">
                    <Button variant="outline" size="sm" className="w-full h-7" disabled={activeCount === 0} onClick={clearFilters}>Clear filters</Button>
                  </div>
                </aside>
              )}

              {/* table / empty */}
              <div className="flex-1 min-w-0 overflow-auto">
                {isLoading ? (
                  <div className="p-3 space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-11 rounded bg-muted/50 animate-pulse" />)}</div>
                ) : rows.length === 0 ? (
                  <div className="flex flex-col items-center justify-center text-center py-20 px-4">
                    <Send className="size-9 text-muted-foreground opacity-40 mb-3" />
                    <p className="text-sm text-muted-foreground">{sequences.length === 0 ? "No sequences yet!" : "No sequences match your filters."}</p>
                    <p className="text-sm text-muted-foreground">Create a new sequence to start engaging.</p>
                    <div className="mt-4 flex items-center gap-2">
                      <Button size="sm" style={{ backgroundColor: accent }} onClick={() => { setNewName(""); setCreateOpen(true); }}>Create a sequence</Button>
                      {activeCount > 0 && <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button>}
                    </div>
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 z-10 bg-card border-b border-border">
                      <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                        <th className="w-10 px-3 py-1.5"><Checkbox checked={allChecked} onCheckedChange={toggleAll} className="size-3.5" /></th>
                        <th className="px-2 py-1.5 font-medium">Name</th>
                        <th className="px-2 py-1.5 font-medium">Status</th>
                        <th className="px-2 py-1.5 font-medium text-right">Steps</th>
                        <th className="px-2 py-1.5 font-medium text-right">Enrolled</th>
                        <th className="px-2 py-1.5 font-medium">Updated</th>
                        <th className="w-8 px-2 py-1.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((s) => (
                        <tr key={s.id} className="border-b border-border/60 hover:bg-muted/40 cursor-pointer" onClick={() => setLocation("/sequences")}>
                          <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                            <Checkbox checked={checked.has(s.id)} onCheckedChange={() => setChecked((p) => { const n = new Set(p); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; })} className="size-3.5" />
                          </td>
                          <td className="px-2 py-1.5 font-medium"><div className="max-w-[280px] truncate" title={s.name}>{s.name}</div></td>
                          <td className="px-2 py-1.5">{statusBadge(s.status)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground"><span className="inline-flex items-center gap-1 justify-end"><Layers className="size-3" /> {s.steps?.length ?? 0}</span></td>
                          <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground"><span className="inline-flex items-center gap-1 justify-end"><Users className="size-3" /> {(s.enrolledCount ?? 0).toLocaleString()}</span></td>
                          <td className="px-2 py-1.5 text-xs text-muted-foreground">{fmtWhen(s.updatedAt)}</td>
                          <td className="px-2 py-1.5 text-right" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
                              <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => setLocation("/sequences")}><ExternalLink className="size-4 mr-2" /> Open in builder</DropdownMenuItem></DropdownMenuContent>
                            </DropdownMenu>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-6">
            <div className="text-center max-w-md">
              <div className="mx-auto size-12 rounded-full bg-secondary flex items-center justify-center mb-3">{tab === "Analytics" ? <BarChart3 className="size-5 text-muted-foreground" /> : <Activity className="size-5 text-muted-foreground" />}</div>
              <h2 className="text-sm font-semibold">{tab}</h2>
              <p className="text-sm text-muted-foreground mt-1">{tab === "Analytics" ? "Sequence performance — open, reply and meeting rates across your cadences." : "Deliverability diagnostics and step-level health for your sequences."}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setLocation("/sequences")}>Open full sequences</Button>
            </div>
          </div>
        )}
      </div>

      {/* create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>New sequence</DialogTitle></DialogHeader>
          <div className="py-1">
            <div className="text-[13px] font-medium mb-1.5">Sequence name</div>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Q3 outbound — VPs of Sales" autoFocus onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) createMut.mutate({ name: newName.trim(), steps: [] }); }} />
            <p className="text-[11px] text-muted-foreground mt-1.5">Creates a draft you can add steps to.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button disabled={!newName.trim() || createMut.isPending} style={{ backgroundColor: accent }} onClick={() => createMut.mutate({ name: newName.trim(), steps: [] })}>{createMut.isPending ? "Creating…" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
