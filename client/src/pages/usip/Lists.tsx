/**
 * Lists — the Prospect & enrich → "Lists" surface (/v2/lists).
 *
 * Modelled on Apollo's "My lists" index: a search/sort toolbar plus two
 * collapsible groups — People and Companies — each showing saved lists (or an
 * empty state), with a "Create a list" dialog (object picker + name).
 *
 * Data: People lists are backed by the existing `segments` router
 * (audienceSegments — named contact lists with a live contactCount). A new
 * People list is created as an empty segment (matchType "any", no rules → 0
 * records, mirroring Apollo's "0 records" new list). Companies lists have no
 * backend yet, so that group is a scaffold.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import {
  ListChecks,
  Plus,
  Search,
  ArrowUpDown,
  Settings2,
  SlidersHorizontal,
  ChevronDown,
  ChevronUp,
  Users,
  Building2,
  MoreHorizontal,
  Trash2,
  ExternalLink,
  ListFilter,
  X,
} from "lucide-react";

type Segment = {
  id: number;
  name: string;
  description?: string | null;
  contactCount?: number | null;
  lastEvaluatedAt?: string | Date | null;
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
  if (diff < 2 * day) return "Yesterday";
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/* ── one list row ── */
function ListRow({ s, accent, onOpen, onDelete }: { s: Segment; accent: string; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className="group/row flex items-center gap-3 px-3 py-2.5 border-b border-border/60 last:border-0 hover:bg-muted/40 cursor-pointer" onClick={onOpen}>
      <span className="shrink-0 size-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accent}1f`, color: accent }}>
        <ListChecks className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium truncate">{s.name}</div>
        {s.description ? <div className="text-[11px] text-muted-foreground truncate">{s.description}</div> : null}
      </div>
      <div className="shrink-0 text-[12px] text-muted-foreground tabular-nums w-20 text-right">{(s.contactCount ?? 0).toLocaleString()} {(s.contactCount ?? 0) === 1 ? "record" : "records"}</div>
      <div className="shrink-0 text-[12px] text-muted-foreground w-24 text-right">{fmtWhen(s.lastEvaluatedAt ?? s.updatedAt ?? s.createdAt)}</div>
      <div onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover/row:opacity-100"><MoreHorizontal className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onOpen}><ExternalLink className="size-4 mr-2" /> Open in Segments</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive"><Trash2 className="size-4 mr-2" /> Delete list</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/* ── collapsible section ── */
function Section({
  title,
  icon: Icon,
  count,
  accent,
  open,
  onToggle,
  children,
}: {
  title: string;
  icon: any;
  count: number;
  accent: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-muted/40 transition-colors">
        <Icon className="size-4" style={{ color: accent }} />
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-[11px] font-medium tabular-nums px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${accent}1f`, color: accent }}>{count}</span>
        <div className="flex-1" />
        {open ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
      </button>
      {open && <div className="border-t border-border/60">{children}</div>}
    </div>
  );
}

function SectionEmpty({ onReset, hasQuery }: { onReset: () => void; hasQuery: boolean }) {
  return (
    <div className="text-center py-12 px-4">
      <div className="mx-auto size-11 rounded-full bg-secondary flex items-center justify-center mb-2">
        <Search className="size-5 text-muted-foreground" />
      </div>
      <div className="text-sm font-medium">No lists match your criteria</div>
      <p className="text-xs text-muted-foreground mt-1">{hasQuery ? "Try adjusting your search to find what you're looking for." : "Create a list to get started."}</p>
      {hasQuery && <Button variant="outline" size="sm" className="mt-3" onClick={onReset}>Reset filters</Button>}
    </div>
  );
}

export default function Lists() {
  const [, setLocation] = useLocation();
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.segments.list.useQuery();
  const segments = (data ?? []) as Segment[];

  const createMut = trpc.segments.create.useMutation({
    onSuccess: () => { utils.segments.list.invalidate(); setCreateOpen(false); setNewName(""); },
  });
  const deleteMut = trpc.segments.delete.useMutation({ onSuccess: () => utils.segments.list.invalidate() });

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("modified");
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(["People", "Companies"]));
  const [createOpen, setCreateOpen] = useState(false);
  const [newObject, setNewObject] = useState<"People" | "Companies">("People");
  const [newName, setNewName] = useState("");

  const toggleSection = (k: string) => setOpenSections((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const peopleLists = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? segments.filter((s) => s.name.toLowerCase().includes(q)) : segments;
    const cmp: Record<string, (a: Segment, b: Segment) => number> = {
      modified: (a, b) => new Date(b.lastEvaluatedAt ?? b.updatedAt ?? 0).getTime() - new Date(a.lastEvaluatedAt ?? a.updatedAt ?? 0).getTime(),
      name: (a, b) => a.name.localeCompare(b.name),
      records: (a, b) => (b.contactCount ?? 0) - (a.contactCount ?? 0),
    };
    return [...filtered].sort(cmp[sort] ?? cmp.modified);
  }, [segments, search, sort]);

  const create = () => {
    if (newObject !== "People" || !newName.trim()) return;
    createMut.mutate({ name: newName.trim(), matchType: "any", rules: [] });
  };

  return (
    <Shell title="Lists">
      <div className="flex flex-col h-full min-h-0">
        {/* header */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <ListChecks className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Lists</h1>
          <div className="flex-1" />
          <Button size="sm" className="h-7 gap-1.5" style={{ backgroundColor: accent }} onClick={() => { setNewObject("People"); setNewName(""); setCreateOpen(true); }}>
            <Plus className="size-3.5" /> Create a list
          </Button>
        </div>

        {/* toolbar */}
        <div className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-1.5 flex-wrap bg-card/40 [&_button]:h-7">
          <Button variant="ghost" size="sm" className="gap-1.5"><SlidersHorizontal className="size-4" /> Show filters</Button>
          <div className="flex items-center gap-2 px-2.5 h-7 rounded-md border bg-background text-sm min-w-0 flex-1 max-w-xs">
            <Search className="size-4 text-muted-foreground shrink-0" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} className="bg-transparent outline-none flex-1 min-w-0 text-[13px]" placeholder="Search lists" />
            {search && <button onClick={() => setSearch("")}><X className="size-3.5 text-muted-foreground" /></button>}
          </div>
          <div className="flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5"><ArrowUpDown className="size-4" /> {sort === "name" ? "Name" : sort === "records" ? "Records" : "Last modified"}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
                <DropdownMenuRadioItem value="modified">Last modified</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="name">Name (A → Z)</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="records">Records (most first)</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon-sm" title="View settings"><Settings2 className="size-4" /></Button>
        </div>

        {/* sections */}
        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-4">
          <Section title="People" icon={Users} count={peopleLists.length} accent={accent} open={openSections.has("People")} onToggle={() => toggleSection("People")}>
            {isLoading ? (
              <div className="p-3 space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 rounded bg-muted/50 animate-pulse" />)}</div>
            ) : peopleLists.length === 0 ? (
              <SectionEmpty hasQuery={!!search} onReset={() => setSearch("")} />
            ) : (
              peopleLists.map((s) => (
                <ListRow key={s.id} s={s} accent={accent} onOpen={() => setLocation("/segments")} onDelete={() => { if (confirm(`Delete list "${s.name}"?`)) deleteMut.mutate({ id: s.id }); }} />
              ))
            )}
          </Section>

          <Section title="Companies" icon={Building2} count={0} accent={accent} open={openSections.has("Companies")} onToggle={() => toggleSection("Companies")}>
            <div className="text-center py-12 px-4">
              <div className="mx-auto size-11 rounded-full bg-secondary flex items-center justify-center mb-2"><ListFilter className="size-5 text-muted-foreground" /></div>
              <div className="text-sm font-medium">No company lists yet</div>
              <p className="text-xs text-muted-foreground mt-1">Company lists are coming soon — for now, save and segment accounts from the Companies page.</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setLocation("/v2/companies")}>Go to Companies</Button>
            </div>
          </Section>
        </div>
      </div>

      {/* create list dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New list</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div>
              <div className="text-[13px] font-medium mb-1.5">Select an object</div>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { v: "People", icon: Users, hint: "Save contacts & prospects" },
                  { v: "Companies", icon: Building2, hint: "Coming soon" },
                ] as const).map((o) => {
                  const Icon = o.icon;
                  const active = newObject === o.v;
                  const disabled = o.v === "Companies";
                  return (
                    <button
                      key={o.v}
                      type="button"
                      disabled={disabled}
                      onClick={() => setNewObject(o.v)}
                      className={cn("rounded-lg border p-3 text-center transition-colors", disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-muted", active && !disabled && "ring-2")}
                      style={active && !disabled ? { borderColor: accent, ["--tw-ring-color" as any]: `${accent}66`, backgroundColor: `${accent}0f` } : undefined}
                    >
                      <Icon className="size-5 mx-auto mb-1" style={{ color: active && !disabled ? accent : undefined }} />
                      <div className="text-[13px] font-medium">{o.v}</div>
                      <div className="text-[10px] text-muted-foreground">{o.hint}</div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="text-[13px] font-medium mb-1.5">List name</div>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name this list" autoFocus onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={!newName.trim() || newObject !== "People" || createMut.isPending} style={{ backgroundColor: accent }}>
              {createMut.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
