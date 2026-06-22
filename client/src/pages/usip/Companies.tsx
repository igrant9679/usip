/**
 * Companies — the redesigned "Prospect and enrich → Companies" surface
 * (/v2/companies). The company counterpart to the People page, built on the
 * same pattern: the LEFT FILTER RAIL is the fulcrum — every change reshapes the
 * results table + stats strip; a right detail panel opens for the selected
 * company; an AI empty-state with quick filters shows when there's nothing.
 *
 * Data source: `trpc.accounts.list`, which returns the full account array (no
 * server pagination, only an optional `search`). So filtering, faceting,
 * sorting and pagination all happen client-side here — and the filter facets
 * (industry / employee band / revenue band / region) are derived dynamically
 * from the data with live counts, rather than hard-coded.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  Upload,
  ChevronDown,
  ChevronRight,
  Filter,
  X,
  Sparkles,
  Plus,
  Save,
  ArrowUpDown,
  SlidersHorizontal,
  Settings2,
  Globe,
  ExternalLink,
  Building2,
  MapPin,
  Pin,
  PinOff,
  Users,
  Briefcase,
  DollarSign,
  BarChart3,
  CheckCircle2,
  Workflow,
  Lock,
  Wand2,
  Bookmark,
  UserCircle2,
  StickyNote,
} from "lucide-react";

/* ───────────────────────── helpers ────────────────────────────────────── */

/** Compact money (ARR). */
function fmtMoney(n: number) {
  if (!n) return "$0";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

/** Compact human number for the stats strip. */
function fmtNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
  return Number.isFinite(n) ? n : 0;
}

/** Distinct value → count facet over a list, sorted by count desc. */
function facet<T>(list: T[], get: (x: T) => string | null | undefined): [string, number][] {
  const m = new Map<string, number>();
  for (const x of list) {
    const v = (get(x) ?? "").trim();
    if (v) m.set(v, (m.get(v) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/* ─────────────────────────── filter rail ──────────────────────────────── */

function FilterGroup({
  id,
  label,
  icon: Icon,
  count,
  open,
  pinned,
  locked,
  onToggle,
  onPin,
  children,
}: {
  id: string;
  label: string;
  icon: any;
  count?: number;
  open: boolean;
  pinned?: boolean;
  locked?: boolean;
  onToggle: (id: string) => void;
  onPin?: (id: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/60">
      <div className="group/grp flex items-center gap-1.5 px-3 py-1.5">
        <button
          type="button"
          onClick={() => !locked && onToggle(id)}
          className="flex flex-1 items-center gap-2 text-[13px] font-medium text-foreground min-w-0"
          aria-expanded={open}
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-left">{label}</span>
          {count ? (
            <span
              className="ml-0.5 inline-flex items-center justify-center rounded-full text-white text-[10px] font-semibold size-4 shrink-0"
              style={{ backgroundColor: "var(--co-accent, hsl(var(--foreground)))" }}
            >
              {count}
            </span>
          ) : null}
        </button>
        {locked ? (
          <Lock className="size-3.5 shrink-0 text-muted-foreground/70" />
        ) : (
          <>
            {onPin && (
              <button
                type="button"
                onClick={() => onPin(id)}
                title={pinned ? "Unpin filter" : "Pin filter"}
                className={cn(
                  "shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground transition-opacity",
                  pinned ? "opacity-100 text-foreground" : "opacity-0 group-hover/grp:opacity-100",
                )}
              >
                {pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
              </button>
            )}
            <button
              type="button"
              onClick={() => onToggle(id)}
              className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
              aria-label={open ? "Collapse" : "Expand"}
            >
              <ChevronDown className={cn("size-4 transition-transform", !open && "-rotate-90")} />
            </button>
          </>
        )}
      </div>
      {open && !locked && children && <div className="px-3 pb-2 pt-0 space-y-1.5">{children}</div>}
    </div>
  );
}

function CheckRow({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint?: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-[13px] text-foreground py-0.5">
      <Checkbox checked={checked} onCheckedChange={onChange} className="size-3.5" />
      <span className="flex-1 truncate" title={label}>{label}</span>
      {hint && <span className="text-[11px] text-muted-foreground tabular-nums">{hint}</span>}
    </label>
  );
}

/** A facet group: search box + checkbox list of distinct values with counts. */
function FacetList({
  options,
  selected,
  onToggle,
  emptyLabel,
}: {
  options: [string, number][];
  selected: Set<string>;
  onToggle: (v: string) => void;
  emptyLabel: string;
}) {
  const [q, setQ] = useState("");
  const filtered = q ? options.filter(([v]) => v.toLowerCase().includes(q.toLowerCase())) : options;
  if (options.length === 0) return <p className="text-[12px] text-muted-foreground">{emptyLabel}</p>;
  return (
    <div className="space-y-1.5">
      {options.length > 6 && (
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="h-7 text-[13px]" />
      )}
      <div className="max-h-44 overflow-y-auto space-y-0.5 pr-0.5">
        {filtered.map(([v, c]) => (
          <CheckRow key={v} checked={selected.has(v)} onChange={() => onToggle(v)} label={v} hint={String(c)} />
        ))}
        {filtered.length === 0 && <p className="text-[12px] text-muted-foreground">No matches</p>}
      </div>
    </div>
  );
}

/* ─────────────────────────────── types ────────────────────────────────── */

type Account = {
  id: number;
  name: string;
  domain?: string | null;
  industry?: string | null;
  employeeBand?: string | null;
  revenueBand?: string | null;
  region?: string | null;
  ownerUserId?: number | null;
  arr?: string | number | null;
  color?: string | null;
  notes?: string | null;
  parentAccountId?: number | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
};

/* ─────────────────────────────── page ─────────────────────────────────── */

export default function Companies() {
  const [, setLocation] = useLocation();
  const accent = useAccentColor();

  // filters (all client-side)
  const [search, setSearch] = useState("");
  const [industries, setIndustries] = useState<Set<string>>(new Set());
  const [employeeBands, setEmployeeBands] = useState<Set<string>>(new Set());
  const [revenueBands, setRevenueBands] = useState<Set<string>>(new Set());
  const [regions, setRegions] = useState<Set<string>>(new Set());
  const [hasDomain, setHasDomain] = useState(false);
  const [owner, setOwner] = useState<"all" | "assigned" | "unassigned">("all");
  const [arrMin, setArrMin] = useState("");
  const [arrMax, setArrMax] = useState("");
  const [sort, setSort] = useState("arr_desc");

  // view state
  const [page, setPage] = useState(1);
  const perPage = 50;
  const [hideFilters, setHideFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [pinned, setPinned] = useState<Set<string>>(new Set(["industry", "employees"]));
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(["quick", "industry", "employees", "arr"]));

  const toggleGroup = (id: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const togglePin = (id: string) =>
    setPinned((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleIn = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    setter(next);
    setPage(1);
  };

  const { data, isLoading, error, refetch } = trpc.accounts.list.useQuery();
  const all = (data ?? []) as Account[];

  // dynamic facets over the full dataset
  const industryFacet = useMemo(() => facet(all, (a) => a.industry), [all]);
  const employeeFacet = useMemo(() => facet(all, (a) => a.employeeBand), [all]);
  const revenueFacet = useMemo(() => facet(all, (a) => a.revenueBand), [all]);
  const regionFacet = useMemo(() => facet(all, (a) => a.region), [all]);

  // filter + sort
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = arrMin ? toNum(arrMin) : null;
    const max = arrMax ? toNum(arrMax) : null;
    const out = all.filter((a) => {
      if (q) {
        const hay = `${a.name} ${a.domain ?? ""} ${a.industry ?? ""} ${a.region ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (industries.size && !industries.has((a.industry ?? "").trim())) return false;
      if (employeeBands.size && !employeeBands.has((a.employeeBand ?? "").trim())) return false;
      if (revenueBands.size && !revenueBands.has((a.revenueBand ?? "").trim())) return false;
      if (regions.size && !regions.has((a.region ?? "").trim())) return false;
      if (hasDomain && !a.domain) return false;
      if (owner === "assigned" && !a.ownerUserId) return false;
      if (owner === "unassigned" && a.ownerUserId) return false;
      const arr = toNum(a.arr);
      if (min !== null && arr < min) return false;
      if (max !== null && arr > max) return false;
      return true;
    });
    const cmp: Record<string, (a: Account, b: Account) => number> = {
      arr_desc: (a, b) => toNum(b.arr) - toNum(a.arr),
      arr_asc: (a, b) => toNum(a.arr) - toNum(b.arr),
      name_asc: (a, b) => a.name.localeCompare(b.name),
      updated_desc: (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
    };
    return [...out].sort(cmp[sort] ?? cmp.arr_desc);
  }, [all, search, industries, employeeBands, revenueBands, regions, hasDomain, owner, arrMin, arrMax, sort]);

  const selected = useMemo(() => all.find((a) => a.id === selectedId) ?? null, [all, selectedId]);

  // stats
  const totalARR = useMemo(() => rows.reduce((s, a) => s + toNum(a.arr), 0), [rows]);
  const newCount = useMemo(() => {
    const weekAgo = new Date().getTime() - 7 * 864e5;
    return all.filter((a) => a.createdAt && new Date(a.createdAt).getTime() >= weekAgo).length;
  }, [all]);

  // active filter count
  const activeCount =
    (search ? 1 : 0) +
    industries.size +
    employeeBands.size +
    revenueBands.size +
    regions.size +
    (hasDomain ? 1 : 0) +
    (owner !== "all" ? 1 : 0) +
    (arrMin ? 1 : 0) +
    (arrMax ? 1 : 0);

  const clearAll = () => {
    setSearch(""); setIndustries(new Set()); setEmployeeBands(new Set()); setRevenueBands(new Set());
    setRegions(new Set()); setHasDomain(false); setOwner("all"); setArrMin(""); setArrMax("");
    setPage(1);
  };

  // client-side pagination over filtered rows
  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const pageClamped = Math.min(page, totalPages);
  const pageRows = rows.slice((pageClamped - 1) * perPage, pageClamped * perPage);
  const rangeStart = rows.length === 0 ? 0 : (pageClamped - 1) * perPage + 1;
  const rangeEnd = Math.min(pageClamped * perPage, rows.length);

  const allOnPageChecked = pageRows.length > 0 && pageRows.every((r) => checked.has(r.id));
  const toggleAll = () =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (allOnPageChecked) pageRows.forEach((r) => next.delete(r.id));
      else pageRows.forEach((r) => next.add(r.id));
      return next;
    });

  // pinned groups render first
  const groupOrder = ["quick", "industry", "employees", "revenue", "region", "arr", "owner", "contactInfo"];
  const orderedGroups = [...groupOrder].sort((a, b) => Number(pinned.has(b)) - Number(pinned.has(a)));

  const renderGroup = (id: string) => {
    const common = { id, open: openGroups.has(id), pinned: pinned.has(id), onToggle: toggleGroup, onPin: togglePin };
    switch (id) {
      case "quick":
        return (
          <FilterGroup key={id} {...common} label="Quick search" icon={Search} onPin={undefined}>
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="Company name or domain…" className="h-7 text-[13px]" />
          </FilterGroup>
        );
      case "industry":
        return (
          <FilterGroup key={id} {...common} label="Industry" icon={Briefcase} count={industries.size}>
            <FacetList options={industryFacet} selected={industries} onToggle={(v) => toggleIn(industries, setIndustries, v)} emptyLabel="No industries on these accounts." />
          </FilterGroup>
        );
      case "employees":
        return (
          <FilterGroup key={id} {...common} label="# Employees" icon={Users} count={employeeBands.size}>
            <FacetList options={employeeFacet} selected={employeeBands} onToggle={(v) => toggleIn(employeeBands, setEmployeeBands, v)} emptyLabel="No employee bands set." />
          </FilterGroup>
        );
      case "revenue":
        return (
          <FilterGroup key={id} {...common} label="Revenue" icon={BarChart3} count={revenueBands.size}>
            <FacetList options={revenueFacet} selected={revenueBands} onToggle={(v) => toggleIn(revenueBands, setRevenueBands, v)} emptyLabel="No revenue bands set." />
          </FilterGroup>
        );
      case "region":
        return (
          <FilterGroup key={id} {...common} label="Location" icon={MapPin} count={regions.size}>
            <FacetList options={regionFacet} selected={regions} onToggle={(v) => toggleIn(regions, setRegions, v)} emptyLabel="No regions set." />
          </FilterGroup>
        );
      case "arr":
        return (
          <FilterGroup key={id} {...common} label="ARR" icon={DollarSign} count={(arrMin ? 1 : 0) + (arrMax ? 1 : 0)}>
            <div className="flex items-center gap-2">
              <Input value={arrMin} onChange={(e) => { setArrMin(e.target.value.replace(/[^0-9]/g, "")); setPage(1); }} placeholder="Min" inputMode="numeric" className="h-7 text-[13px]" />
              <span className="text-muted-foreground text-xs">–</span>
              <Input value={arrMax} onChange={(e) => { setArrMax(e.target.value.replace(/[^0-9]/g, "")); setPage(1); }} placeholder="Max" inputMode="numeric" className="h-7 text-[13px]" />
            </div>
          </FilterGroup>
        );
      case "owner":
        return (
          <FilterGroup key={id} {...common} label="Owner" icon={UserCircle2} count={owner !== "all" ? 1 : 0}>
            <div className="space-y-0.5">
              {([
                { v: "all", l: "Any" },
                { v: "assigned", l: "Assigned to a rep" },
                { v: "unassigned", l: "Unassigned" },
              ] as const).map((o) => (
                <CheckRow key={o.v} checked={owner === o.v} onChange={() => { setOwner(o.v); setPage(1); }} label={o.l} />
              ))}
            </div>
          </FilterGroup>
        );
      case "contactInfo":
        return (
          <FilterGroup key={id} {...common} label="Web presence" icon={Globe} count={hasDomain ? 1 : 0}>
            <CheckRow checked={hasDomain} onChange={() => { setHasDomain(!hasDomain); setPage(1); }} label="Has a website / domain" />
          </FilterGroup>
        );
      default:
        return null;
    }
  };

  const LOCKED = [
    { id: "technologies", label: "Technologies", icon: Settings2 },
    { id: "funding", label: "Funding", icon: DollarSign },
    { id: "headcount", label: "Headcount growth", icon: BarChart3 },
    { id: "intent", label: "Buying intent", icon: CheckCircle2 },
    { id: "lookalikes", label: "Lookalikes", icon: Building2 },
  ];

  return (
    <Shell title="Companies">
      <div className="flex flex-col h-full min-h-0" style={{ ["--co-accent" as any]: accent }}>
        {/* compact title row */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Building2 className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Find companies</h1>
          <div className="flex-1" />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 gap-1.5">
                <Upload className="size-3.5" /> Import <ChevronDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setLocation("/import")}><Upload className="size-4 mr-2" /> Import a CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setLocation("/accounts")}><Building2 className="size-4 mr-2" /> Manage accounts</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setLocation("/find-prospects")}><Search className="size-4 mr-2" /> Discover prospects</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* filter rail */}
          {!hideFilters && (
            <aside className="w-72 shrink-0 border-r border-border flex flex-col min-h-0 bg-card/30">
              <div className="grid grid-cols-3 gap-px bg-border/60 shrink-0">
                {[
                  { l: "Total", v: fmtNum(all.length) },
                  { l: "New 7d", v: fmtNum(newCount) },
                  { l: "ARR", v: fmtMoney(totalARR) },
                ].map((s) => (
                  <div key={s.l} className="bg-card px-2 py-1.5 text-center leading-tight" style={{ backgroundImage: `linear-gradient(180deg, ${accent}1f, transparent)` }}>
                    <div className="text-[13px] font-bold tabular-nums" style={{ color: accent }}>{s.v}</div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.l}</div>
                  </div>
                ))}
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                {orderedGroups.map((id) => renderGroup(id))}
                <div className="px-3 pt-2 pb-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">Advanced (upgrade)</div>
                {LOCKED.map((f) => (
                  <FilterGroup key={f.id} id={f.id} label={f.label} icon={f.icon} locked open={false} onToggle={() => {}} />
                ))}
              </div>

              <div className="shrink-0 border-t border-border flex items-center justify-between px-3 py-2 bg-card">
                <button type="button" onClick={clearAll} disabled={activeCount === 0} className="text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-40 inline-flex items-center gap-1">
                  <X className="size-3.5" /> Clear all{activeCount ? ` (${activeCount})` : ""}
                </button>
                <button type="button" onClick={() => setMoreOpen(true)} className="text-[12px] font-medium text-foreground hover:underline inline-flex items-center gap-1">
                  <SlidersHorizontal className="size-3.5" /> More filters
                </button>
              </div>
            </aside>
          )}

          {/* centre column */}
          <section className="flex-1 min-w-0 flex flex-col min-h-0">
            <div className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-1.5 flex-wrap bg-card/40 [&_button]:h-7">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5">Default view <ChevronDown className="size-3.5 opacity-60" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem>Default view</DropdownMenuItem>
                  <DropdownMenuItem>Top ARR accounts</DropdownMenuItem>
                  <DropdownMenuItem>New this week</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem><Plus className="size-4 mr-2" /> Save current as view</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setHideFilters((v) => !v)}>
                <Filter className="size-4" /> {hideFilters ? "Show" : "Hide"} filters{activeCount ? ` (${activeCount})` : ""}
              </Button>

              <div className="flex items-center gap-2 px-2.5 h-7 rounded-md border bg-background text-sm min-w-0 flex-1 max-w-xs">
                <Search className="size-4 text-muted-foreground shrink-0" />
                <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className="bg-transparent outline-none flex-1 min-w-0 text-[13px]" placeholder="Search companies" />
                {search && <button onClick={() => setSearch("")}><X className="size-3.5 text-muted-foreground" /></button>}
              </div>

              <div className="flex-1" />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5"><Wand2 className="size-4" /> Research with AI <ChevronDown className="size-3.5 opacity-60" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem>Run custom AI prompt</DropdownMenuItem>
                  <DropdownMenuItem>Generate AI formula</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setLocation("/v2/ai-assistant")}><Sparkles className="size-4 mr-2" /> Use Velocity Assistant</DropdownMenuItem>
                  <DropdownMenuItem>Start with a template</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5"><Workflow className="size-4" /> Create workflow <ChevronDown className="size-3.5 opacity-60" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setLocation("/segments")}>Auto-add to segment</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setLocation("/v2/lists")}>Auto-add to lists</DropdownMenuItem>
                  <DropdownMenuItem>Auto-update records</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setLocation("/workflows")}>Create from scratch</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button variant="ghost" size="sm" className="gap-1.5"><Save className="size-4" /> Save search</Button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" title="Sort"><ArrowUpDown className="size-4" /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
                    <DropdownMenuRadioItem value="arr_desc">ARR (high → low)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="arr_asc">ARR (low → high)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="name_asc">Name (A → Z)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="updated_desc">Recently updated</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button variant="ghost" size="icon-sm" title="Search settings"><Settings2 className="size-4" /></Button>
            </div>

            {checked.size > 0 && (
              <div className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-3 text-white text-[13px]" style={{ backgroundColor: accent }}>
                <span className="font-medium">{checked.size} selected</span>
                <Button variant="secondary" size="sm" className="h-7" onClick={() => setLocation("/segments")}>Add to segment</Button>
                <Button variant="secondary" size="sm" className="h-7" onClick={() => setLocation("/v2/lists")}>Add to list</Button>
                <div className="flex-1" />
                <button onClick={() => setChecked(new Set())} className="opacity-80 hover:opacity-100 inline-flex items-center gap-1"><X className="size-3.5" /> Clear</button>
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-auto">
              {isLoading ? (
                <div className="p-3 space-y-2">
                  {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-12 rounded-md bg-muted/50 animate-pulse" />)}
                </div>
              ) : error ? (
                <div className="text-center py-20 px-4">
                  <p className="text-sm text-muted-foreground">Couldn’t load companies. {error.message}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>Retry</Button>
                </div>
              ) : all.length === 0 ? (
                <AiEmptyState
                  prompt={aiPrompt}
                  setPrompt={setAiPrompt}
                  onImport={() => setLocation("/import")}
                  onManage={() => setLocation("/accounts")}
                  quick={{
                    hasDomain: () => { setHasDomain(true); setPage(1); },
                    hasArr: () => { setArrMin("1"); setPage(1); },
                    byArr: () => setSort("arr_desc"),
                    topIndustry: () => { if (industryFacet[0]) { setIndustries(new Set([industryFacet[0][0]])); setPage(1); } },
                  }}
                />
              ) : rows.length === 0 ? (
                <div className="text-center py-20 px-4">
                  <div className="mx-auto size-12 rounded-full bg-secondary flex items-center justify-center mb-3"><Filter className="size-5 text-muted-foreground" /></div>
                  <h3 className="text-sm font-semibold">No companies match these filters</h3>
                  <p className="text-sm text-muted-foreground mt-1">Try loosening the filters on the left.</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={clearAll}>Clear all filters</Button>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-card border-b border-border">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="w-10 px-3 py-1.5"><Checkbox checked={allOnPageChecked} onCheckedChange={toggleAll} className="size-3.5" /></th>
                      <th className="px-2 py-1.5 font-medium">Company</th>
                      <th className="px-2 py-1.5 font-medium">Industry</th>
                      <th className="px-2 py-1.5 font-medium">Employees</th>
                      <th className="px-2 py-1.5 font-medium">Revenue</th>
                      <th className="px-2 py-1.5 font-medium">Location</th>
                      <th className="px-2 py-1.5 font-medium text-right">ARR</th>
                      <th className="w-8 px-2 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((a) => (
                      <tr key={a.id} onClick={() => setSelectedId(a.id)} className={cn("border-b border-border/60 cursor-pointer hover:bg-muted/50", selectedId === a.id && "bg-muted")}>
                        <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={checked.has(a.id)}
                            onCheckedChange={() => setChecked((prev) => { const n = new Set(prev); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n; })}
                            className="size-3.5"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="shrink-0 size-6 rounded flex items-center justify-center text-[10px] font-bold text-white" style={{ backgroundColor: a.color || accent }}>
                              {a.name.slice(0, 1).toUpperCase()}
                            </span>
                            <div className="min-w-0">
                              <div className="font-medium truncate max-w-[180px]" title={a.name}>{a.name}</div>
                              {a.domain && (
                                <a href={`https://${a.domain.replace(/^https?:\/\//, "")}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-[11px] text-blue-600 hover:underline inline-flex items-center gap-0.5">
                                  <Globe className="size-2.5" /> {a.domain}
                                </a>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-1.5"><div className="max-w-[140px] truncate" title={a.industry ?? undefined}>{a.industry ?? "—"}</div></td>
                        <td className="px-2 py-1.5 text-xs">{a.employeeBand ?? "—"}</td>
                        <td className="px-2 py-1.5 text-xs">{a.revenueBand ?? "—"}</td>
                        <td className="px-2 py-1.5 text-xs text-muted-foreground"><div className="max-w-[120px] truncate">{a.region ?? "—"}</div></td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-medium">{toNum(a.arr) ? fmtMoney(toNum(a.arr)) : <span className="text-muted-foreground font-normal">—</span>}</td>
                        <td className="px-2 py-1.5 text-right"><ChevronRight className="size-4 text-muted-foreground" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {rows.length > 0 && (
              <div className="shrink-0 border-t border-border px-3 py-2 flex items-center justify-between text-[13px] bg-card/40">
                <span className="text-muted-foreground tabular-nums">{rangeStart}–{rangeEnd} of {fmtNum(rows.length)}{rows.length !== all.length && <span className="ml-1">· {fmtNum(all.length)} total</span>}</span>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" disabled={pageClamped <= 1} onClick={() => { setPage((p) => Math.max(1, p - 1)); setChecked(new Set()); }}>Prev</Button>
                  <span className="px-2 text-muted-foreground tabular-nums">{pageClamped} / {totalPages}</span>
                  <Button variant="outline" size="sm" disabled={pageClamped >= totalPages} onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setChecked(new Set()); }}>Next</Button>
                </div>
              </div>
            )}
          </section>

          {/* detail panel */}
          {selected && (
            <DetailPanel
              a={selected}
              accent={accent}
              onClose={() => setSelectedId(null)}
              onOpenFull={() => setLocation(`/accounts/${selected.id}`)}
            />
          )}
        </div>
      </div>

      <MoreFiltersDialog open={moreOpen} onClose={() => setMoreOpen(false)} count={rows.length} />
    </Shell>
  );
}

/* ───────────────────────── detail panel ───────────────────────────────── */

function DetailPanel({ a, accent, onClose, onOpenFull }: { a: Account; accent: string; onClose: () => void; onOpenFull: () => void }) {
  const arr = toNum(a.arr);
  return (
    <aside className="w-96 shrink-0 border-l border-border flex flex-col min-h-0 bg-card shadow-sm">
      <div className="relative shrink-0 flex items-start gap-3 px-4 py-3 border-b border-border">
        <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
        <span className="shrink-0 size-9 rounded-lg flex items-center justify-center text-sm font-bold text-white" style={{ backgroundColor: a.color || accent }}>
          {a.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold truncate" title={a.name}>{a.name}</div>
          {a.domain ? (
            <a href={`https://${a.domain.replace(/^https?:\/\//, "")}`} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline truncate inline-flex items-center gap-1">
              <Globe className="size-3.5" /> {a.domain}
            </a>
          ) : <div className="text-sm text-muted-foreground">No website</div>}
        </div>
        <button onClick={onClose} className="shrink-0 p-1 text-muted-foreground hover:text-foreground" aria-label="Close"><X className="size-4" /></button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          {arr > 0 && <Badge variant="secondary" className="text-[11px]" style={{ backgroundColor: `${accent}1f`, color: accent }}>{fmtMoney(arr)} ARR</Badge>}
          {a.industry && <Badge variant="outline" className="text-[11px]">{a.industry}</Badge>}
        </div>

        <div className="space-y-2">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Firmographics</div>
          <Field icon={Briefcase} label="Industry" value={a.industry} />
          <Field icon={Users} label="Employees" value={a.employeeBand} />
          <Field icon={BarChart3} label="Revenue band" value={a.revenueBand} />
          <Field icon={MapPin} label="Location" value={a.region} />
          <Field icon={DollarSign} label="ARR" value={arr > 0 ? fmtMoney(arr) : null} />
        </div>

        {a.notes && (
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1"><StickyNote className="size-3" /> Notes</div>
            <p className="text-[13px] text-muted-foreground whitespace-pre-wrap line-clamp-6">{a.notes}</p>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border p-3 space-y-2">
        <Button className="w-full gap-1.5" onClick={onOpenFull}><ExternalLink className="size-4" /> Open full record</Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="sm" className="gap-1.5"><Users className="size-4" /> Contacts</Button>
          <Button variant="outline" size="sm" className="gap-1.5"><Bookmark className="size-4" /> Save</Button>
        </div>
      </div>
    </aside>
  );
}

function Field({ icon: Icon, label, value }: { icon: any; label: string; value?: string | null }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className="truncate">{value || <span className="text-muted-foreground">—</span>}</div>
      </div>
    </div>
  );
}

/* ───────────────────────── AI empty state ─────────────────────────────── */

function AiEmptyState({
  prompt,
  setPrompt,
  quick,
  onImport,
  onManage,
}: {
  prompt: string;
  setPrompt: (s: string) => void;
  quick: { hasDomain: () => void; hasArr: () => void; byArr: () => void; topIndustry: () => void };
  onImport: () => void;
  onManage: () => void;
}) {
  return (
    <div className="max-w-2xl mx-auto px-4 py-14 text-center">
      <div className="mx-auto size-12 rounded-xl text-white flex items-center justify-center mb-4 shadow-sm" style={{ backgroundColor: "var(--co-accent, hsl(var(--foreground)))" }}>
        <Building2 className="size-6" />
      </div>
      <h2 className="text-lg font-semibold">Use Velocity AI to find the right accounts</h2>
      <p className="text-sm text-muted-foreground mt-1">Describe the companies you want to target, or import accounts to get started.</p>

      <div className="mt-5 flex items-center gap-2 rounded-xl border bg-background p-2 shadow-sm">
        <Wand2 className="size-4 text-muted-foreground ml-1 shrink-0" />
        <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. Mid-market SaaS companies in North America with $1M+ ARR" className="flex-1 bg-transparent outline-none text-sm min-w-0" />
        <Button size="sm" className="gap-1.5"><Sparkles className="size-4" /> Find companies</Button>
      </div>

      <div className="mt-6 rounded-xl border bg-card/50 p-4 text-left">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Quick filters</div>
        <div className="flex flex-wrap gap-2">
          <QuickChip icon={Globe} label="Has a website" onClick={quick.hasDomain} />
          <QuickChip icon={DollarSign} label="Has ARR" onClick={quick.hasArr} />
          <QuickChip icon={BarChart3} label="Sort by ARR" onClick={quick.byArr} />
          <QuickChip icon={Briefcase} label="Top industry" onClick={quick.topIndustry} />
        </div>
      </div>

      <div className="mt-6 flex items-center justify-center gap-2">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onImport}><Upload className="size-4" /> Import accounts</Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onManage}><Building2 className="size-4" /> Manage accounts</Button>
      </div>
    </div>
  );
}

function QuickChip({ icon: Icon, label, onClick }: { icon: any; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-[13px] hover:bg-muted transition-colors">
      <Icon className="size-3.5 text-muted-foreground" /> {label}
    </button>
  );
}

/* ──────────────────────── More Filters dialog ─────────────────────────── */

function MoreFiltersDialog({ open, onClose, count }: { open: boolean; onClose: () => void; count: number }) {
  const COLUMNS: { title: string; items: { label: string; locked?: boolean }[] }[] = [
    {
      title: "Firmographics",
      items: [
        { label: "Industry" }, { label: "# Employees" }, { label: "Revenue" },
        { label: "Location" }, { label: "ARR" }, { label: "Founded year", locked: true },
      ],
    },
    {
      title: "Company info",
      items: [
        { label: "Web presence" }, { label: "Owner" }, { label: "Technologies", locked: true },
        { label: "Funding", locked: true }, { label: "SIC & NAICS", locked: true }, { label: "Headcount growth", locked: true },
      ],
    },
    {
      title: "Signals & intent",
      items: [
        { label: "Buying intent", locked: true }, { label: "Job postings", locked: true }, { label: "News", locked: true },
        { label: "Lookalikes", locked: true }, { label: "Website visitors", locked: true },
      ],
    },
  ];
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>More filters</DialogTitle>
          <DialogDescription>Pin any filter to keep it in the rail. Locked filters are part of an upgraded plan.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 py-1">
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">{col.title}</div>
              <div className="space-y-1">
                {col.items.map((it) => (
                  <div key={it.label} className={cn("flex items-center justify-between rounded-md px-2 py-1.5 text-[13px]", it.locked ? "text-muted-foreground" : "hover:bg-muted cursor-pointer")}>
                    <span>{it.label}</span>
                    {it.locked ? <Lock className="size-3.5" /> : <Plus className="size-3.5 text-muted-foreground" />}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t pt-3">
          <span className="text-[13px] text-muted-foreground tabular-nums">{fmtNum(count)} companies</span>
          <Button onClick={onClose}>Apply filters</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
