/**
 * ListDetail — a single record list (/v2/lists/:id).
 *
 * Apollo's list detail: breadcrumb + title + object badge + record count, an
 * "Add records to list" action, a toolbar, and the members table (or the empty
 * state with Find-people / Import / Workflow cards). "Find people/companies"
 * opens a mini-lookup modal to search and add records.
 *
 * Backed by recordLists.get / members / addMembers / removeMember. People lists
 * hold prospects; Companies lists hold accounts.
 */
import { useMemo, useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { LinkedInUpdateIndicator, useEnrichJob } from "@/components/usip/people/LinkedInEnrichment";
import { trpc } from "@/lib/trpc";
import { ResearchAiMenu } from "@/components/usip/people/ResearchAiMenu";
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
  DialogFooter,
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
  Plus,
  ChevronDown,
  Filter,
  Search,
  Upload,
  Wand2,
  Workflow,
  Save,
  Settings2,
  ArrowUpDown,
  Users,
  Building2,
  Sparkles,
  X,
  Trash2,
  ExternalLink,
  Mail,
  Loader2,
  UserPlus,
} from "lucide-react";

function fmtMoney(n: number) {
  if (!n) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}
function toNum(v: unknown) { const n = typeof v === "number" ? v : parseFloat(String(v ?? "0")); return Number.isFinite(n) ? n : 0; }

export default function ListDetail() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = Number(idStr);
  const [, setLocation] = useLocation();
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  const listQ = trpc.recordLists.get.useQuery({ id }, { enabled: Number.isFinite(id) });
  const membersQ = trpc.recordLists.members.useQuery({ id }, { enabled: Number.isFinite(id) });
  const list = listQ.data as { id: number; name: string; entityType: string; description?: string | null } | null | undefined;
  const isCompanies = list?.entityType === "companies";
  const { enrichList, running: enriching } = useEnrichJob();

  const removeMut = trpc.recordLists.removeMember.useMutation({ onSuccess: () => { utils.recordLists.members.invalidate({ id }); utils.recordLists.list.invalidate(); } });
  const addMut = trpc.recordLists.addMembers.useMutation({
    onSuccess: () => { utils.recordLists.members.invalidate({ id }); utils.recordLists.list.invalidate(); setAddOpen(false); setPicked(new Set()); },
  });

  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [sort, setSort] = useState("added");

  const members = (membersQ.data ?? []) as { memberId: number; recordType: string; recordId: number; addedAt: string | Date; record: any }[];

  // Compact LinkedIn change indicators for prospect members (batched — returns
  // only members with unacknowledged updates). Same component as the People tab.
  const memberProspectIds = useMemo(
    () => members.filter((m) => m.recordType === "prospect").map((m) => m.recordId),
    [members],
  );
  const { data: liSummaries } = trpc.linkedinEnrichment.getChangeSummaries.useQuery(
    { prospectIds: memberProspectIds },
    { enabled: memberProspectIds.length > 0 },
  );
  const liSummaryMap = useMemo(
    () => new Map((liSummaries ?? []).map((s: any) => [s.prospect_id, s])),
    [liSummaries],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = members;
    if (q) {
      out = members.filter((m) => {
        const r = m.record ?? {};
        const hay = isCompanies
          ? `${r.name ?? ""} ${r.domain ?? ""} ${r.industry ?? ""}`
          : `${r.firstName ?? ""} ${r.lastName ?? ""} ${r.title ?? ""} ${r.company ?? ""} ${r.email ?? ""}`;
        return hay.toLowerCase().includes(q);
      });
    }
    if (sort === "name") {
      out = [...out].sort((a, b) => {
        const an = isCompanies ? a.record?.name ?? "" : `${a.record?.firstName ?? ""} ${a.record?.lastName ?? ""}`;
        const bn = isCompanies ? b.record?.name ?? "" : `${b.record?.firstName ?? ""} ${b.record?.lastName ?? ""}`;
        return String(an).localeCompare(String(bn));
      });
    }
    return out;
  }, [members, search, sort, isCompanies]);

  return (
    <Shell title={list?.name ?? "List"}>
      <div className="flex flex-col h-full min-h-0">
        {/* header */}
        <div className="relative shrink-0 px-4 pt-2.5 pb-2 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-0.5">
            <Link href="/v2/lists" className="hover:text-foreground hover:underline">Lists</Link>
            <span>›</span>
            <span className="text-foreground truncate max-w-[240px]">{list?.name ?? "…"}</span>
          </div>
          <div className="flex items-center gap-2">
            <h1 className="text-[16px] font-semibold tracking-tight truncate max-w-[280px]">{list?.name ?? "Loading…"}</h1>
            {list && (
              <Badge variant="secondary" className="gap-1 text-[10px]">
                {isCompanies ? <Building2 className="size-3" /> : <Users className="size-3" />} {isCompanies ? "Companies" : "People"}
              </Badge>
            )}
            <span className="text-[12px] text-muted-foreground">{members.length} {members.length === 1 ? "record" : "records"}</span>
            <div className="flex-1" />
            <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => setLocation("/import")}><Upload className="size-3.5" /> Import</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="h-7 gap-1.5" style={{ backgroundColor: accent }}><Plus className="size-3.5" /> Add records to list <ChevronDown className="size-3 opacity-70" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => { setPicked(new Set()); setAddOpen(true); }}>
                  {isCompanies ? <Building2 className="size-4 mr-2" /> : <Users className="size-4 mr-2" />} Find {isCompanies ? "companies" : "people"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLocation(isCompanies ? "/accounts" : "/prospects")}><UserPlus className="size-4 mr-2" /> Create {isCompanies ? "company" : "person"}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* toolbar */}
        <div className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-1.5 flex-wrap bg-card/40 [&_button]:h-7">
          {/* "Default view", "Show filters", "Save as new view" and "View
              options" used to sit here with no onClick and no backing state —
              four buttons that did nothing when clicked. Removed rather than
              left as decoration; the controls that remain all work. */}
          <div className="flex items-center gap-2 px-2.5 h-7 rounded-md border bg-background text-sm min-w-0 flex-1 max-w-xs">
            <Search className="size-4 text-muted-foreground shrink-0" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} className="bg-transparent outline-none flex-1 min-w-0 text-[13px]" placeholder="Search this list" />
            {search && <button onClick={() => setSearch("")}><X className="size-3.5 text-muted-foreground" /></button>}
          </div>
          <div className="flex-1" />
          {!isCompanies && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={enriching || members.length === 0}
              onClick={() => enrichList(id, { enrichAll: true })}
              title="Enrich all eligible people in this list via LinkedIn (Unipile)"
            >
              {enriching ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Enrich all
            </Button>
          )}
          <ResearchAiMenu />
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setLocation("/v2/workflows")}><Workflow className="size-4" /> Create workflow <ChevronDown className="size-3.5 opacity-60" /></Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" title="Sort"><ArrowUpDown className="size-4" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
                <DropdownMenuRadioItem value="added">Recently added</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="name">Name (A → Z)</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* body */}
        <div className="flex-1 min-h-0 overflow-auto">
          {membersQ.isLoading ? (
            <div className="p-3 space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-11 rounded bg-muted/50 animate-pulse" />)}</div>
          ) : members.length === 0 ? (
            <EmptyState isCompanies={!!isCompanies} onFind={() => { setPicked(new Set()); setAddOpen(true); }} onImport={() => setLocation("/import")} onWorkflow={() => setLocation("/v2/workflows")} />
          ) : rows.length === 0 ? (
            <div className="text-center py-16 px-4">
              <p className="text-sm text-muted-foreground">No records match “{search}”.</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setSearch("")}>Clear search</Button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-card border-b border-border">
                <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  {isCompanies ? (
                    <>
                      <th className="px-3 py-1.5 font-medium">Company</th>
                      <th className="px-2 py-1.5 font-medium">Industry</th>
                      <th className="px-2 py-1.5 font-medium">Location</th>
                      <th className="px-2 py-1.5 font-medium text-right">ARR</th>
                    </>
                  ) : (
                    <>
                      <th className="px-3 py-1.5 font-medium">Name</th>
                      <th className="px-2 py-1.5 font-medium">Title</th>
                      <th className="px-2 py-1.5 font-medium">Company</th>
                      <th className="px-2 py-1.5 font-medium">Email</th>
                      <th className="px-2 py-1.5 font-medium">Location</th>
                    </>
                  )}
                  <th className="w-10 px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const r = m.record ?? {};
                  return (
                    <tr key={m.memberId} className="border-b border-border/60 hover:bg-muted/40">
                      {isCompanies ? (
                        <>
                          <td className="px-3 py-1.5">
                            <div className="font-medium truncate max-w-[200px]">{r.name}</div>
                            {r.domain && <div className="text-[11px] text-muted-foreground truncate max-w-[200px]">{r.domain}</div>}
                          </td>
                          <td className="px-2 py-1.5 text-xs">{r.industry ?? "—"}</td>
                          <td className="px-2 py-1.5 text-xs text-muted-foreground">{r.region ?? "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{toNum(r.arr) ? fmtMoney(toNum(r.arr)) : <span className="text-muted-foreground">—</span>}</td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-1.5 font-medium">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate">{r.firstName} {r.lastName}</span>
                              {liSummaryMap.get(m.recordId) ? <LinkedInUpdateIndicator summary={liSummaryMap.get(m.recordId)} /> : null}
                            </div>
                          </td>
                          <td className="px-2 py-1.5"><div className="max-w-[160px] truncate" title={r.title ?? undefined}>{r.title ?? "—"}</div></td>
                          <td className="px-2 py-1.5"><div className="max-w-[150px] truncate" title={r.company ?? undefined}>{r.company ?? "—"}</div></td>
                          <td className="px-2 py-1.5">{r.email ? <span className="text-xs inline-flex items-center gap-1"><Mail className="size-3 text-muted-foreground" /> <span className="truncate max-w-[180px]">{r.email}</span></span> : <span className="text-xs text-muted-foreground">—</span>}</td>
                          <td className="px-2 py-1.5 text-xs text-muted-foreground"><div className="max-w-[140px] truncate">{[r.city, r.state, r.country].filter(Boolean).join(", ") || "—"}</div></td>
                        </>
                      )}
                      <td className="px-2 py-1.5 text-right">
                        <Button variant="ghost" size="icon-sm" title="Remove from list" className="text-muted-foreground hover:text-destructive" onClick={() => removeMut.mutate({ memberId: m.memberId })}><Trash2 className="size-3.5" /></Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {addOpen && (
        <AddRecordsDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
          isCompanies={!!isCompanies}
          accent={accent}
          picked={picked}
          setPicked={setPicked}
          adding={addMut.isPending}
          onAdd={(recordIds) => addMut.mutate({ listId: id, recordType: isCompanies ? "account" : "prospect", recordIds })}
        />
      )}
    </Shell>
  );
}

function EmptyState({ isCompanies, onFind, onImport, onWorkflow }: { isCompanies: boolean; onFind: () => void; onImport: () => void; onWorkflow: () => void }) {
  const cards = [
    { icon: isCompanies ? Building2 : Users, title: `Find ${isCompanies ? "companies" : "people"}`, body: `Search for ${isCompanies ? "accounts" : "prospects"} to add to this list`, onClick: onFind },
    { icon: Upload, title: "Import by CSV", body: "Import records into this list from a CSV file", onClick: onImport },
    { icon: Workflow, title: "Create workflow", body: `Automatically add ${isCompanies ? "companies" : "people"} to this list`, onClick: onWorkflow },
  ];
  return (
    <div className="max-w-2xl mx-auto text-center py-16 px-4">
      <h3 className="text-sm font-semibold">No records</h3>
      <p className="text-sm text-muted-foreground mt-1">No saved {isCompanies ? "companies" : "people"} yet! Add records to this list to get started.</p>
      <div className="mt-5 grid sm:grid-cols-3 gap-3 text-left">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <button key={c.title} onClick={c.onClick} className="rounded-xl border bg-card p-4 hover:bg-muted/40 hover:shadow-sm transition-all text-left">
              <div className="size-8 rounded-lg bg-secondary flex items-center justify-center mb-2"><Icon className="size-4 text-muted-foreground" /></div>
              <div className="text-[13px] font-medium">{c.title}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">{c.body}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Add-records mini-lookup modal ── */
function AddRecordsDialog({
  open, onClose, isCompanies, accent, picked, setPicked, adding, onAdd,
}: {
  open: boolean;
  onClose: () => void;
  isCompanies: boolean;
  accent: string;
  picked: Set<number>;
  setPicked: (s: Set<number>) => void;
  adding: boolean;
  onAdd: (ids: number[]) => void;
}) {
  const [q, setQ] = useState("");
  const prospectsQ = trpc.prospects.list.useQuery({ page: 1, perPage: 100 }, { enabled: open && !isCompanies });
  const accountsQ = trpc.accounts.list.useQuery(undefined, { enabled: open && isCompanies });

  const all: { id: number; primary: string; secondary?: string }[] = useMemo(() => {
    if (isCompanies) {
      return ((accountsQ.data ?? []) as any[]).map((a) => ({ id: a.id, primary: a.name, secondary: [a.industry, a.region].filter(Boolean).join(" · ") || a.domain || "" }));
    }
    return (((prospectsQ.data as any)?.data ?? []) as any[]).map((p) => ({ id: p.id, primary: `${p.firstName} ${p.lastName}`.trim(), secondary: [p.title, p.company].filter(Boolean).join(" · ") }));
  }, [isCompanies, accountsQ.data, prospectsQ.data]);

  const loading = isCompanies ? accountsQ.isLoading : prospectsQ.isLoading;
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? all.filter((r) => `${r.primary} ${r.secondary ?? ""}`.toLowerCase().includes(s)) : all;
  }, [all, q]);

  const toggle = (id: number) => { const n = new Set(picked); n.has(id) ? n.delete(id) : n.add(id); setPicked(n); };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isCompanies ? <Building2 className="size-4" style={{ color: accent }} /> : <Users className="size-4" style={{ color: accent }} />}
            Find {isCompanies ? "companies" : "people"} to add
          </DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 px-2.5 h-9 rounded-md border bg-background">
          <Search className="size-4 text-muted-foreground shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} autoFocus placeholder={`Search ${isCompanies ? "companies" : "people"}…`} className="bg-transparent outline-none flex-1 text-sm" />
        </div>
        <div className="h-80 overflow-y-auto -mx-1 px-1 rounded-md border">
          {loading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground gap-2"><Loader2 className="size-4 animate-spin" /> Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <Sparkles className="size-6 text-muted-foreground opacity-50 mb-2" />
              <p className="text-sm text-muted-foreground">{all.length === 0 ? `No ${isCompanies ? "companies" : "people"} in this workspace yet.` : "Start your search by typing above."}</p>
              {all.length === 0 && <Button variant="outline" size="sm" className="mt-3" onClick={() => (window.location.href = isCompanies ? "/accounts" : "/v2/people")}>Go find some</Button>}
            </div>
          ) : (
            filtered.map((r) => (
              <label key={r.id} className="flex items-center gap-2.5 px-2 py-2 border-b border-border/60 last:border-0 cursor-pointer hover:bg-muted/40">
                <Checkbox checked={picked.has(r.id)} onCheckedChange={() => toggle(r.id)} className="size-4" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium truncate">{r.primary}</div>
                  {r.secondary && <div className="text-[11px] text-muted-foreground truncate">{r.secondary}</div>}
                </div>
              </label>
            ))
          )}
        </div>
        <DialogFooter className="items-center">
          <span className="text-[12px] text-muted-foreground mr-auto">{picked.size} selected</span>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={picked.size === 0 || adding} style={{ backgroundColor: accent }} onClick={() => onAdd([...picked])}>
            {adding ? <Loader2 className="size-4 animate-spin mr-1.5" /> : null} Add to list
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
