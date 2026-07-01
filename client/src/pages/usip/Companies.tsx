/**
 * Companies (/v2/companies) — Apollo-style company/account discovery + management.
 *
 * Server-side search via `companies.search` (filters + sort + pagination +
 * per-row contact counts + logos). The left rail carries only FUNCTIONAL
 * filters (search, industry, location, has-contacts, score rating, employees,
 * revenue) — no fake locked filters. Rows show a CompanyAvatar (logo → favicon →
 * initials), links, linked-contact count, employees, Velocity score and
 * industry; clicking a company opens its full profile. Companies here include
 * those auto-created/linked from uploaded prospects.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { CompanyAvatar } from "@/components/usip/company/CompanyAvatar";
import {
  Search, Upload, ChevronDown, Filter, X, Building2, Globe, Link2, Users, Briefcase,
  MapPin, DollarSign, BarChart3, ArrowUpDown, RefreshCw, GitMerge, ListPlus, Sparkles, Gauge,
} from "lucide-react";

const RATING_STYLE: Record<string, string> = {
  excellent: "bg-emerald-100 text-emerald-800", good: "bg-blue-100 text-blue-800",
  fair: "bg-amber-100 text-amber-800", not_a_fit: "bg-gray-100 text-gray-600",
};
function fmtNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function facet<T>(list: T[], get: (x: T) => string | null | undefined): [string, number][] {
  const m = new Map<string, number>();
  for (const x of list) { const v = (get(x) ?? "").trim(); if (v) m.set(v, (m.get(v) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function FilterGroup({ label, icon: Icon, count, open, onToggle, children }: {
  label: string; icon: any; count?: number; open: boolean; onToggle: () => void; children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/60">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-1.5 text-[13px] font-medium">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 text-left truncate">{label}</span>
        {count ? <span className="inline-flex items-center justify-center rounded-full text-white text-[10px] font-semibold size-4" style={{ backgroundColor: "var(--co-accent)" }}>{count}</span> : null}
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </button>
      {open && children && <div className="px-3 pb-2 space-y-1.5">{children}</div>}
    </div>
  );
}
function FacetList({ options, selected, onToggle, empty }: { options: [string, number][]; selected: Set<string>; onToggle: (v: string) => void; empty: string }) {
  const [q, setQ] = useState("");
  if (!options.length) return <p className="text-[12px] text-muted-foreground">{empty}</p>;
  const filtered = q ? options.filter(([v]) => v.toLowerCase().includes(q.toLowerCase())) : options;
  return (
    <div className="space-y-1.5">
      {options.length > 6 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="h-7 text-[13px]" />}
      <div className="max-h-44 overflow-y-auto space-y-0.5 pr-0.5">
        {filtered.map(([v, c]) => (
          <label key={v} className="flex items-center gap-2 cursor-pointer text-[13px] py-0.5">
            <Checkbox checked={selected.has(v)} onCheckedChange={() => onToggle(v)} className="size-3.5" />
            <span className="flex-1 truncate" title={v}>{v}</span>
            <span className="text-[11px] text-muted-foreground tabular-nums">{c}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export default function Companies() {
  const [, setLocation] = useLocation();
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  // filters
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [industries, setIndustries] = useState<Set<string>>(new Set());
  const [locations, setLocations] = useState<Set<string>>(new Set());
  const [hasContacts, setHasContacts] = useState(false);
  const [minRating, setMinRating] = useState<"" | "fair" | "good" | "excellent">("");
  const [empMin, setEmpMin] = useState(""); const [empMax, setEmpMax] = useState("");
  const [sort, setSort] = useState<{ field: any; direction: "asc" | "desc" }>({ field: "contactCount", direction: "desc" });
  const [page, setPage] = useState(1);
  const perPage = 50;

  const [hideFilters, setHideFilters] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set(["quick", "industry", "location", "score"]));
  const toggleGroup = (g: string) => setOpenGroups((p) => { const n = new Set(p); n.has(g) ? n.delete(g) : n.add(g); return n; });
  const toggleIn = (s: Set<string>, setter: (x: Set<string>) => void, v: string) => { const n = new Set(s); n.has(v) ? n.delete(v) : n.add(v); setter(n); setPage(1); };

  useEffect(() => { const t = setTimeout(() => { setQ(searchInput); setPage(1); }, 300); return () => clearTimeout(t); }, [searchInput]);

  // Facet source (all accounts — lightweight) for the industry/location checkboxes.
  const { data: facetSrc } = trpc.accounts.list.useQuery();
  const industryFacet = useMemo(() => facet((facetSrc ?? []) as any[], (a) => a.industry), [facetSrc]);
  const locationFacet = useMemo(() => facet((facetSrc ?? []) as any[], (a) => a.hqState || a.region || a.hqCountry), [facetSrc]);

  const filters = {
    q: q || undefined,
    industries: industries.size ? [...industries] : undefined,
    locations: locations.size ? [...locations] : undefined,
    hasContacts: hasContacts || undefined,
    minRating: minRating || undefined,
    employeeMin: empMin ? Number(empMin) : undefined,
    employeeMax: empMax ? Number(empMax) : undefined,
  };
  const { data, isLoading, error, refetch } = trpc.companies.search.useQuery({ filters, sort, page, perPage });
  const rows = (data?.data ?? []) as any[];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / perPage));

  const activeCount = (q ? 1 : 0) + industries.size + locations.size + (hasContacts ? 1 : 0) + (minRating ? 1 : 0) + (empMin ? 1 : 0) + (empMax ? 1 : 0);
  const clearAll = () => { setSearchInput(""); setQ(""); setIndustries(new Set()); setLocations(new Set()); setHasContacts(false); setMinRating(""); setEmpMin(""); setEmpMax(""); setPage(1); };

  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));
  const toggleAll = () => setChecked((prev) => { const n = new Set(prev); if (allChecked) rows.forEach((r) => n.delete(r.id)); else rows.forEach((r) => n.add(r.id)); return n; });

  const bulkEnrich = trpc.companies.bulkEnrich.useMutation({
    onSuccess: (r) => { toast.success(`Enriched ${r.ok}/${r.processed} companies`); utils.companies.search.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const merge = trpc.companies.merge.useMutation({
    onSuccess: () => { toast.success("Companies merged"); setChecked(new Set()); utils.companies.search.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const backfill = trpc.companies.backfill.useMutation({
    onSuccess: (r) => { toast.success(`Synced companies — ${r.created} created, ${r.linked} linked from prospects`); utils.companies.search.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const doMerge = () => {
    const ids = [...checked];
    if (ids.length !== 2) { toast.error("Select exactly two companies to merge"); return; }
    if (confirm("Merge the second company into the first? Contacts, prospects and deals move to the first.")) merge.mutate({ primaryAccountId: ids[0], duplicateAccountId: ids[1] });
  };

  return (
    <Shell title="Companies">
      <div className="flex flex-col h-full min-h-0" style={{ ["--co-accent" as any]: accent }}>
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Building2 className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Find companies</h1>
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={backfill.isPending} onClick={() => backfill.mutate({})} title="Create/link companies from uploaded prospects">
            <RefreshCw className={`size-3.5 ${backfill.isPending ? "animate-spin" : ""}`} /> Sync from prospects
          </Button>
          <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => setLocation("/import")}><Upload className="size-3.5" /> Import</Button>
        </div>

        <div className="flex flex-1 min-h-0">
          {!hideFilters && (
            <aside className="w-72 shrink-0 border-r border-border flex flex-col min-h-0 bg-card/30">
              <div className="grid grid-cols-2 gap-px bg-border/60 shrink-0">
                {[{ l: "Total", v: fmtNum(total) }, { l: "With contacts", v: fmtNum(rows.filter((r) => r.contactCount > 0).length) }].map((s) => (
                  <div key={s.l} className="bg-card px-2 py-1.5 text-center" style={{ backgroundImage: `linear-gradient(180deg, ${accent}1f, transparent)` }}>
                    <div className="text-[13px] font-bold tabular-nums" style={{ color: accent }}>{s.v}</div>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.l}</div>
                  </div>
                ))}
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                <FilterGroup label="Quick search" icon={Search} open={openGroups.has("quick")} onToggle={() => toggleGroup("quick")}>
                  <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Company name or domain…" className="h-7 text-[13px]" />
                </FilterGroup>
                <FilterGroup label="Industry" icon={Briefcase} count={industries.size} open={openGroups.has("industry")} onToggle={() => toggleGroup("industry")}>
                  <FacetList options={industryFacet} selected={industries} onToggle={(v) => toggleIn(industries, setIndustries, v)} empty="No industries yet." />
                </FilterGroup>
                <FilterGroup label="Location" icon={MapPin} count={locations.size} open={openGroups.has("location")} onToggle={() => toggleGroup("location")}>
                  <FacetList options={locationFacet} selected={locations} onToggle={(v) => toggleIn(locations, setLocations, v)} empty="No locations yet." />
                </FilterGroup>
                <FilterGroup label="Score" icon={Gauge} count={minRating ? 1 : 0} open={openGroups.has("score")} onToggle={() => toggleGroup("score")}>
                  {([["", "Any rating"], ["fair", "Fair or better"], ["good", "Good or better"], ["excellent", "Excellent only"]] as const).map(([v, l]) => (
                    <label key={v} className="flex items-center gap-2 cursor-pointer text-[13px] py-0.5">
                      <Checkbox checked={minRating === v} onCheckedChange={() => { setMinRating(v); setPage(1); }} className="size-3.5" /><span>{l}</span>
                    </label>
                  ))}
                </FilterGroup>
                <FilterGroup label="# Employees" icon={Users} count={(empMin ? 1 : 0) + (empMax ? 1 : 0)} open={openGroups.has("emp")} onToggle={() => toggleGroup("emp")}>
                  <div className="flex items-center gap-2">
                    <Input value={empMin} onChange={(e) => { setEmpMin(e.target.value.replace(/[^0-9]/g, "")); setPage(1); }} placeholder="Min" inputMode="numeric" className="h-7 text-[13px]" />
                    <span className="text-muted-foreground text-xs">–</span>
                    <Input value={empMax} onChange={(e) => { setEmpMax(e.target.value.replace(/[^0-9]/g, "")); setPage(1); }} placeholder="Max" inputMode="numeric" className="h-7 text-[13px]" />
                  </div>
                </FilterGroup>
                <FilterGroup label="Has contacts" icon={Users} count={hasContacts ? 1 : 0} open={openGroups.has("hasc")} onToggle={() => toggleGroup("hasc")}>
                  <label className="flex items-center gap-2 cursor-pointer text-[13px] py-0.5">
                    <Checkbox checked={hasContacts} onCheckedChange={() => { setHasContacts(!hasContacts); setPage(1); }} className="size-3.5" /><span>Only companies with linked people</span>
                  </label>
                </FilterGroup>
              </div>
              <div className="shrink-0 border-t border-border flex items-center px-3 py-2 bg-card">
                <button type="button" onClick={clearAll} disabled={!activeCount} className="text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-40 inline-flex items-center gap-1"><X className="size-3.5" /> Clear all{activeCount ? ` (${activeCount})` : ""}</button>
              </div>
            </aside>
          )}

          <section className="flex-1 min-w-0 flex flex-col min-h-0">
            <div className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-1.5 flex-wrap bg-card/40 [&_button]:h-7">
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setHideFilters((v) => !v)}><Filter className="size-4" /> {hideFilters ? "Show" : "Hide"} filters{activeCount ? ` (${activeCount})` : ""}</Button>
              <div className="flex items-center gap-2 px-2.5 h-7 rounded-md border bg-background text-sm min-w-0 flex-1 max-w-xs">
                <Search className="size-4 text-muted-foreground shrink-0" />
                <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} className="bg-transparent outline-none flex-1 min-w-0 text-[13px]" placeholder="Search companies" />
                {searchInput && <button onClick={() => setSearchInput("")}><X className="size-3.5 text-muted-foreground" /></button>}
              </div>
              <div className="flex-1" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="gap-1.5"><ArrowUpDown className="size-4" /> Sort</Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={`${sort.field}_${sort.direction}`} onValueChange={(v) => { const i = v.lastIndexOf("_"); setSort({ field: v.slice(0, i), direction: v.slice(i + 1) as any }); setPage(1); }}>
                    <DropdownMenuRadioItem value="contactCount_desc">Most contacts</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="name_asc">Name (A → Z)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="employeeCount_desc">Employees (high → low)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="score_desc">Score (high → low)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="lastEnriched_desc">Recently enriched</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="createdAt_desc">Recently added</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {checked.size > 0 && (
              <div className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-2 text-white text-[13px]" style={{ backgroundColor: accent }}>
                <span className="font-medium">{checked.size} selected</span>
                <Button variant="secondary" size="sm" className="h-7 gap-1" disabled={bulkEnrich.isPending} onClick={() => bulkEnrich.mutate({ accountIds: [...checked] })}><RefreshCw className="size-3.5" /> Enrich</Button>
                <Button variant="secondary" size="sm" className="h-7 gap-1" onClick={() => setLocation("/v2/lists")}><ListPlus className="size-3.5" /> Add to list</Button>
                <Button variant="secondary" size="sm" className="h-7 gap-1" disabled={checked.size !== 2} onClick={doMerge}><GitMerge className="size-3.5" /> Merge</Button>
                <div className="flex-1" />
                <button onClick={() => setChecked(new Set())} className="opacity-80 hover:opacity-100 inline-flex items-center gap-1"><X className="size-3.5" /> Clear</button>
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-auto">
              {isLoading ? (
                <div className="p-3 space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-12 rounded-md bg-muted/50 animate-pulse" />)}</div>
              ) : error ? (
                <div className="text-center py-20"><p className="text-sm text-muted-foreground">Couldn’t load companies. {error.message}</p><Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>Retry</Button></div>
              ) : total === 0 ? (
                <div className="text-center py-20 px-4">
                  <div className="mx-auto size-12 rounded-full bg-secondary flex items-center justify-center mb-3"><Building2 className="size-5 text-muted-foreground" /></div>
                  <h3 className="text-sm font-semibold">{activeCount ? "No companies match these filters" : "No companies yet"}</h3>
                  <p className="text-sm text-muted-foreground mt-1">{activeCount ? "Try loosening the filters." : "Companies are created automatically from your uploaded prospects."}</p>
                  {activeCount ? <Button variant="outline" size="sm" className="mt-3" onClick={clearAll}>Clear filters</Button>
                    : <Button size="sm" className="mt-3 gap-1.5" disabled={backfill.isPending} onClick={() => backfill.mutate({})}><Sparkles className="size-4" /> Sync companies from prospects</Button>}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-card border-b border-border">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="w-10 px-3 py-1.5"><Checkbox checked={allChecked} onCheckedChange={toggleAll} className="size-3.5" /></th>
                      <th className="px-2 py-1.5 font-medium">Company</th>
                      <th className="px-2 py-1.5 font-medium">Links</th>
                      <th className="px-2 py-1.5 font-medium text-right">Contacts</th>
                      <th className="px-2 py-1.5 font-medium text-right">Employees</th>
                      <th className="px-2 py-1.5 font-medium">Score</th>
                      <th className="px-2 py-1.5 font-medium">Industry</th>
                      <th className="px-2 py-1.5 font-medium">Location</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((a) => {
                      const loc = [a.hqCity, a.hqState, a.hqCountry].filter(Boolean).join(", ") || a.region;
                      return (
                        <tr key={a.id} className="border-b border-border/60 hover:bg-muted/50 cursor-pointer" onClick={() => setLocation(`/v2/companies/${a.id}`)}>
                          <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                            <Checkbox checked={checked.has(a.id)} onCheckedChange={() => setChecked((p) => { const n = new Set(p); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n; })} className="size-3.5" />
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <CompanyAvatar name={a.name} logoUrl={a.logo?.url} faviconUrl={a.logo?.faviconUrl} size="md" />
                              <div className="min-w-0">
                                <div className="font-medium truncate max-w-[190px]" title={a.name}>{a.name}</div>
                                {a.domain && <span className="text-[11px] text-muted-foreground truncate block max-w-[190px]">{a.domain}</span>}
                              </div>
                            </div>
                          </td>
                          <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1.5 text-muted-foreground">
                              {a.domain ? <a href={`https://${a.domain}`} target="_blank" rel="noopener noreferrer" title="Website" className="hover:text-foreground"><Globe className="size-3.5" /></a> : <span className="opacity-30"><Globe className="size-3.5" /></span>}
                              {a.linkedinCompanyUrl ? <a href={a.linkedinCompanyUrl.startsWith("http") ? a.linkedinCompanyUrl : `https://${a.linkedinCompanyUrl}`} target="_blank" rel="noopener noreferrer" title="LinkedIn" className="hover:text-foreground"><Link2 className="size-3.5" /></a> : <span className="opacity-30"><Link2 className="size-3.5" /></span>}
                            </div>
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{a.contactCount > 0 ? <span className="font-medium">{a.contactCount}</span> : <span className="text-muted-foreground">—</span>}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{a.employeeCount ? a.employeeCount.toLocaleString() : (a.employeeBand || <span className="text-muted-foreground">—</span>)}</td>
                          <td className="px-2 py-1.5">{a.accountRating ? <span className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium ${RATING_STYLE[a.accountRating] ?? RATING_STYLE.not_a_fit}`}>{a.accountScore != null ? Math.round(a.accountScore) : "–"}</span> : <span className="text-muted-foreground">—</span>}</td>
                          <td className="px-2 py-1.5"><div className="max-w-[150px] truncate" title={a.industry ?? undefined}>{a.industry ?? "—"}</div></td>
                          <td className="px-2 py-1.5 text-muted-foreground"><div className="max-w-[140px] truncate">{loc || "—"}</div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {total > 0 && (
              <div className="shrink-0 border-t border-border px-3 py-2 flex items-center justify-between text-[13px] bg-card/40">
                <span className="text-muted-foreground tabular-nums">{(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {fmtNum(total)}</span>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => { setPage((p) => Math.max(1, p - 1)); setChecked(new Set()); }}>Prev</Button>
                  <span className="px-2 text-muted-foreground tabular-nums">{page} / {totalPages}</span>
                  <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setChecked(new Set()); }}>Next</Button>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </Shell>
  );
}
