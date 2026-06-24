/**
 * Lists — the Prospect & enrich → "Lists" index (/v2/lists).
 *
 * Apollo's "My lists": search/sort toolbar + collapsible People and Companies
 * groups, each showing saved lists with member counts, plus a "Create a list"
 * dialog (object picker + name). Backed by the static `recordLists` router
 * (record_lists / record_list_members) — People lists hold prospects, Companies
 * lists hold accounts. Clicking a list opens its detail at /v2/lists/:id.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  X,
} from "lucide-react";

type RecordList = {
  id: number;
  name: string;
  description?: string | null;
  entityType: string; // people | companies
  memberCount?: number;
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

function ListRow({ l, accent, onOpen, onDelete }: { l: RecordList; accent: string; onOpen: () => void; onDelete: () => void }) {
  const Icon = l.entityType === "companies" ? Building2 : ListChecks;
  return (
    <div className="group/row flex items-center gap-3 px-3 py-2.5 border-b border-border/60 last:border-0 hover:bg-muted/40 cursor-pointer" onClick={onOpen}>
      <span className="shrink-0 size-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accent}1f`, color: accent }}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium truncate">{l.name}</div>
        {l.description ? <div className="text-[11px] text-muted-foreground truncate">{l.description}</div> : null}
      </div>
      <div className="shrink-0 text-[12px] text-muted-foreground tabular-nums w-20 text-right">{(l.memberCount ?? 0).toLocaleString()} {(l.memberCount ?? 0) === 1 ? "record" : "records"}</div>
      <div className="shrink-0 text-[12px] text-muted-foreground w-24 text-right">{fmtWhen(l.updatedAt ?? l.createdAt)}</div>
      <div onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="opacity-0 group-hover/row:opacity-100"><MoreHorizontal className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onOpen}><ExternalLink className="size-4 mr-2" /> Open list</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive"><Trash2 className="size-4 mr-2" /> Delete list</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function Section({ title, icon: Icon, count, accent, open, onToggle, children }: { title: string; icon: any; count: number; accent: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
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

function SectionEmpty({ object, hasQuery, onReset, onCreate }: { object: string; hasQuery: boolean; onReset: () => void; onCreate: () => void }) {
  return (
    <div className="text-center py-12 px-4">
      <div className="mx-auto size-11 rounded-full bg-secondary flex items-center justify-center mb-2">
        <Search className="size-5 text-muted-foreground" />
      </div>
      <div className="text-sm font-medium">{hasQuery ? "No lists match your criteria" : `No ${object.toLowerCase()} lists yet`}</div>
      <p className="text-xs text-muted-foreground mt-1">{hasQuery ? "Try adjusting your search to find what you're looking for." : `Create a ${object.toLowerCase()} list to start saving records.`}</p>
      {hasQuery ? (
        <Button variant="outline" size="sm" className="mt-3" onClick={onReset}>Reset filters</Button>
      ) : (
        <Button variant="outline" size="sm" className="mt-3" onClick={onCreate}><Plus className="size-3.5 mr-1.5" /> Create a list</Button>
      )}
    </div>
  );
}

export default function Lists() {
  const [, setLocation] = useLocation();
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  const { data, isLoading } = trpc.recordLists.list.useQuery();
  const lists = (data ?? []) as RecordList[];

  const createMut = trpc.recordLists.create.useMutation({
    onSuccess: (res: any) => { utils.recordLists.list.invalidate(); setCreateOpen(false); setNewName(""); if (res?.id) setLocation(`/v2/lists/${res.id}`); },
  });
  const deleteMut = trpc.recordLists.delete.useMutation({ onSuccess: () => utils.recordLists.list.invalidate() });

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("modified");
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(["People", "Companies"]));
  const [createOpen, setCreateOpen] = useState(false);
  const [newObject, setNewObject] = useState<"People" | "Companies">("People");
  const [newName, setNewName] = useState("");

  const toggleSection = (k: string) => setOpenSections((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const sortAndFilter = (entityType: string) => {
    const q = search.trim().toLowerCase();
    const subset = lists.filter((l) => l.entityType === entityType && (!q || l.name.toLowerCase().includes(q)));
    const cmp: Record<string, (a: RecordList, b: RecordList) => number> = {
      modified: (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
      name: (a, b) => a.name.localeCompare(b.name),
      records: (a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0),
    };
    return [...subset].sort(cmp[sort] ?? cmp.modified);
  };

  const peopleLists = useMemo(() => sortAndFilter("people"), [lists, search, sort]);
  const companyLists = useMemo(() => sortAndFilter("companies"), [lists, search, sort]);

  const openCreate = (object: "People" | "Companies") => { setNewObject(object); setNewName(""); setCreateOpen(true); };
  const create = () => {
    if (!newName.trim()) return;
    createMut.mutate({ name: newName.trim(), entityType: newObject === "People" ? "people" : "companies" });
  };
  const del = (l: RecordList) => { if (confirm(`Delete list "${l.name}"? This removes the list, not the records.`)) deleteMut.mutate({ id: l.id }); };

  return (
    <Shell title="Lists">
      <div className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <ListChecks className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Lists</h1>
          <div className="flex-1" />
          <Button size="sm" className="h-7 gap-1.5" style={{ backgroundColor: accent }} onClick={() => openCreate("People")}>
            <Plus className="size-3.5" /> Create a list
          </Button>
        </div>

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

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-4">
          <Section title="People" icon={Users} count={peopleLists.length} accent={accent} open={openSections.has("People")} onToggle={() => toggleSection("People")}>
            {isLoading ? (
              <div className="p-3 space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-12 rounded bg-muted/50 animate-pulse" />)}</div>
            ) : peopleLists.length === 0 ? (
              <SectionEmpty object="People" hasQuery={!!search} onReset={() => setSearch("")} onCreate={() => openCreate("People")} />
            ) : (
              peopleLists.map((l) => <ListRow key={l.id} l={l} accent={accent} onOpen={() => setLocation(`/v2/lists/${l.id}`)} onDelete={() => del(l)} />)
            )}
          </Section>

          <Section title="Companies" icon={Building2} count={companyLists.length} accent={accent} open={openSections.has("Companies")} onToggle={() => toggleSection("Companies")}>
            {isLoading ? (
              <div className="p-3 space-y-2">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-12 rounded bg-muted/50 animate-pulse" />)}</div>
            ) : companyLists.length === 0 ? (
              <SectionEmpty object="Companies" hasQuery={!!search} onReset={() => setSearch("")} onCreate={() => openCreate("Companies")} />
            ) : (
              companyLists.map((l) => <ListRow key={l.id} l={l} accent={accent} onOpen={() => setLocation(`/v2/lists/${l.id}`)} onDelete={() => del(l)} />)
            )}
          </Section>
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>New list</DialogTitle></DialogHeader>
          <div className="space-y-4 py-1">
            <div>
              <div className="text-[13px] font-medium mb-1.5">Select an object</div>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { v: "People", icon: Users, hint: "Save prospects & people" },
                  { v: "Companies", icon: Building2, hint: "Save accounts" },
                ] as const).map((o) => {
                  const Icon = o.icon;
                  const active = newObject === o.v;
                  return (
                    <button
                      key={o.v}
                      type="button"
                      onClick={() => setNewObject(o.v)}
                      className={cn("rounded-lg border p-3 text-center transition-colors hover:bg-muted", active && "ring-2")}
                      style={active ? { borderColor: accent, ["--tw-ring-color" as any]: `${accent}66`, backgroundColor: `${accent}0f` } : undefined}
                    >
                      <Icon className="size-5 mx-auto mb-1" style={{ color: active ? accent : undefined }} />
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
            <Button onClick={create} disabled={!newName.trim() || createMut.isPending} style={{ backgroundColor: accent }}>
              {createMut.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
