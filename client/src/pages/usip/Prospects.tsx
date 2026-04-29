/**
 * Prospects page — Clodura.ai prospect search, ingestion, and management.
 *
 * Layout:
 *   PageHeader + "Search Clodura" button
 *   Prospect table (ingested prospects)
 *   Right-side Sheet: Clodura search panel with filters, results, bulk ingest
 */
import { useState, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Search,
  UserPlus,
  Download,
  MoreHorizontal,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Bookmark,
  Trash2,
  ExternalLink,
  Mail,
  Phone,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

/* ─── Types ────────────────────────────────────────────────────────────────── */
type SearchFilters = {
  firstName?: string;
  lastName?: string;
  personTitle?: string[];
  seniority?: string[];
  functional?: string[];
  company?: string[];
  companyDomain?: string[];
  industry?: string[];
  technology?: string[];
  city?: string[];
  state?: string[];
  country?: string[];
  employeeSize?: string[];
  revenue?: string[];
  linkedinUrl?: string;
};

type CloduraResult = {
  personId: string;
  firstName: string;
  lastName: string;
  personTitle?: string;
  seniority?: string[];
  functional?: string[];
  linkedinUrl?: string;
  personCity?: string;
  personState?: string;
  personCountry?: string;
  organizationName?: string;
  organizationId?: string;
  companyDomain?: string[];
  industry?: string[];
  contactEmailStatus?: string;
};

/* ─── Helpers ──────────────────────────────────────────────────────────────── */
function emailStatusBadge(status?: string | null) {
  if (!status) return null;
  const map: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    verified: { label: "Verified", variant: "default" },
    unverified: { label: "Unverified", variant: "secondary" },
    unavailable: { label: "Unavailable", variant: "outline" },
  };
  const s = map[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={s.variant} className="text-xs">{s.label}</Badge>;
}

function MultiTagInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const trimmed = draft.trim();
    if (trimmed && !value.includes(trimmed)) {
      onChange([...value, trimmed]);
    }
    setDraft("");
  };
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex gap-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder ?? `Add ${label.toLowerCase()}…`}
          className="h-8 text-sm"
        />
        <Button size="sm" variant="outline" onClick={add} className="h-8 px-2">+</Button>
      </div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {value.map((v) => (
            <Badge key={v} variant="secondary" className="text-xs gap-1 cursor-pointer" onClick={() => onChange(value.filter((x) => x !== v))}>
              {v} ×
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Clodura Search Panel (inside Sheet) ──────────────────────────────────── */
function CloduraSearchPanel({ onClose }: { onClose: () => void }) {
  const [filters, setFilters] = useState<SearchFilters>({});
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState<25 | 50 | 100>(25);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [hasSearched, setHasSearched] = useState(false);
  const [saveSearchName, setSaveSearchName] = useState("");
  const [showSaveInput, setShowSaveInput] = useState(false);

  const utils = trpc.useUtils();

  // Lazy search — only fires when user clicks Search
  const [searchParams, setSearchParams] = useState<{ filters: SearchFilters; page: number; perPage: number } | null>(null);

  const { data, isFetching, error } = trpc.clodura.search.useQuery(
    searchParams ?? { filters: {}, page: 1, perPage: 25 },
    { enabled: !!searchParams, retry: false },
  );

  const ingest = trpc.clodura.ingestProspects.useMutation({
    onSuccess: (res) => {
      toast.success(`Ingested ${res.created} prospect${res.created !== 1 ? "s" : ""}${res.skipped ? ` (${res.skipped} already existed)` : ""}`);
      setSelectedIds(new Set());
      utils.clodura.listProspects.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const savedSearches = trpc.clodura.savedSearches.useQuery();
  const saveSearch = trpc.clodura.saveSearch.useMutation({
    onSuccess: () => { toast.success("Search saved"); setShowSaveInput(false); setSaveSearchName(""); savedSearches.refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const deleteSearch = trpc.clodura.deleteSavedSearch.useMutation({
    onSuccess: () => savedSearches.refetch(),
  });

  const credits = trpc.clodura.credits.useQuery(undefined, { retry: false });

  const handleSearch = () => {
    setPage(1);
    setSelectedIds(new Set());
    setSearchParams({ filters, page: 1, perPage });
    setHasSearched(true);
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    setSearchParams((p) => p ? { ...p, page: newPage } : null);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!data?.data) return;
    if (selectedIds.size === data.data.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(data.data.map((r: CloduraResult) => r.personId)));
    }
  };

  const handleIngest = () => {
    if (!data?.data) return;
    const toIngest = data.data.filter((r: CloduraResult) => selectedIds.has(r.personId));
    ingest.mutate({ people: toIngest });
  };

  const setFilter = <K extends keyof SearchFilters>(key: K, val: SearchFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: val }));
  };

  const clearFilters = () => {
    setFilters({});
    setSearchParams(null);
    setHasSearched(false);
    setSelectedIds(new Set());
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <SheetHeader className="px-6 pt-6 pb-4 border-b">
        <div className="flex items-center justify-between">
          <div>
            <SheetTitle className="text-lg">Search Clodura</SheetTitle>
            <SheetDescription className="text-xs mt-0.5">
              Find and ingest prospects from the Clodura.ai database
            </SheetDescription>
          </div>
          {credits.data && (
            <div className="text-right">
              <div className="text-xs text-muted-foreground">Credits remaining</div>
              <div className="text-sm font-semibold tabular-nums">{credits.data.remaining.toLocaleString()}</div>
            </div>
          )}
        </div>
      </SheetHeader>

      <div className="flex-1 overflow-y-auto">
        {/* Saved searches */}
        {savedSearches.data && savedSearches.data.length > 0 && (
          <div className="px-6 py-3 border-b">
            <div className="text-xs font-medium text-muted-foreground mb-2">Saved searches</div>
            <div className="flex flex-wrap gap-1">
              {savedSearches.data.map((s) => (
                <div key={s.id} className="flex items-center gap-0.5">
                  <Badge
                    variant="outline"
                    className="cursor-pointer text-xs hover:bg-accent"
                    onClick={() => { setFilters(s.filters as SearchFilters); }}
                  >
                    {s.name}
                  </Badge>
                  <button
                    className="text-muted-foreground hover:text-destructive ml-0.5"
                    onClick={() => deleteSearch.mutate({ id: s.id })}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="px-6 py-4 space-y-3 border-b">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Filters</div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">First Name</Label>
              <Input
                value={filters.firstName ?? ""}
                onChange={(e) => setFilter("firstName", e.target.value || undefined)}
                placeholder="e.g. John"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Last Name</Label>
              <Input
                value={filters.lastName ?? ""}
                onChange={(e) => setFilter("lastName", e.target.value || undefined)}
                placeholder="e.g. Smith"
                className="h-8 text-sm"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">LinkedIn URL</Label>
            <Input
              value={filters.linkedinUrl ?? ""}
              onChange={(e) => setFilter("linkedinUrl", e.target.value || undefined)}
              placeholder="https://linkedin.com/in/..."
              className="h-8 text-sm"
            />
          </div>

          <MultiTagInput
            label="Job Title"
            value={filters.personTitle ?? []}
            onChange={(v) => setFilter("personTitle", v.length ? v : undefined)}
            placeholder="e.g. VP of Sales"
          />

          <MultiTagInput
            label="Seniority"
            value={filters.seniority ?? []}
            onChange={(v) => setFilter("seniority", v.length ? v : undefined)}
            placeholder="e.g. Director"
          />

          <MultiTagInput
            label="Functional Area"
            value={filters.functional ?? []}
            onChange={(v) => setFilter("functional", v.length ? v : undefined)}
            placeholder="e.g. Sales"
          />

          <MultiTagInput
            label="Company"
            value={filters.company ?? []}
            onChange={(v) => setFilter("company", v.length ? v : undefined)}
            placeholder="e.g. Acme Corp"
          />

          <MultiTagInput
            label="Company Domain (max 10)"
            value={filters.companyDomain ?? []}
            onChange={(v) => setFilter("companyDomain", v.length ? v.slice(0, 10) : undefined)}
            placeholder="e.g. acme.com"
          />

          <MultiTagInput
            label="Industry"
            value={filters.industry ?? []}
            onChange={(v) => setFilter("industry", v.length ? v : undefined)}
            placeholder="e.g. SaaS"
          />

          <MultiTagInput
            label="Technology"
            value={filters.technology ?? []}
            onChange={(v) => setFilter("technology", v.length ? v : undefined)}
            placeholder="e.g. Salesforce"
          />

          <div className="grid grid-cols-3 gap-2">
            <MultiTagInput
              label="City"
              value={filters.city ?? []}
              onChange={(v) => setFilter("city", v.length ? v : undefined)}
              placeholder="e.g. Austin"
            />
            <MultiTagInput
              label="State"
              value={filters.state ?? []}
              onChange={(v) => setFilter("state", v.length ? v : undefined)}
              placeholder="e.g. TX"
            />
            <MultiTagInput
              label="Country"
              value={filters.country ?? []}
              onChange={(v) => setFilter("country", v.length ? v : undefined)}
              placeholder="e.g. US"
            />
          </div>

          <MultiTagInput
            label="Employee Size"
            value={filters.employeeSize ?? []}
            onChange={(v) => setFilter("employeeSize", v.length ? v : undefined)}
            placeholder="e.g. 51-200"
          />

          <MultiTagInput
            label="Revenue"
            value={filters.revenue ?? []}
            onChange={(v) => setFilter("revenue", v.length ? v : undefined)}
            placeholder="e.g. $1M-$10M"
          />

          {/* Per-page */}
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground whitespace-nowrap">Results per page</Label>
            <Select value={String(perPage)} onValueChange={(v) => setPerPage(Number(v) as 25 | 50 | 100)}>
              <SelectTrigger className="h-8 w-24 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 pt-1">
            <Button onClick={handleSearch} disabled={isFetching} className="flex-1">
              {isFetching ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Search className="h-4 w-4 mr-2" />}
              Search
            </Button>
            <Button variant="outline" onClick={clearFilters} className="px-3">
              Clear
            </Button>
            <Button
              variant="outline"
              size="icon"
              title="Save this search"
              onClick={() => setShowSaveInput((v) => !v)}
            >
              <Bookmark className="h-4 w-4" />
            </Button>
          </div>

          {showSaveInput && (
            <div className="flex gap-2">
              <Input
                value={saveSearchName}
                onChange={(e) => setSaveSearchName(e.target.value)}
                placeholder="Search name…"
                className="h-8 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveSearch.mutate({ name: saveSearchName, filters: filters as Record<string, unknown> });
                }}
              />
              <Button
                size="sm"
                onClick={() => saveSearch.mutate({ name: saveSearchName, filters: filters as Record<string, unknown> })}
                disabled={!saveSearchName.trim() || saveSearch.isPending}
              >
                Save
              </Button>
            </div>
          )}
        </div>

        {/* Results */}
        {error && (
          <div className="px-6 py-4 flex items-center gap-2 text-destructive text-sm">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {error.message}
          </div>
        )}

        {data && (
          <div className="px-6 py-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm text-muted-foreground">
                {data.total.toLocaleString()} result{data.total !== 1 ? "s" : ""}
                {data.cacheHit && <span className="ml-2 text-xs text-muted-foreground">(cached)</span>}
              </div>
              {selectedIds.size > 0 && (
                <Button
                  size="sm"
                  onClick={handleIngest}
                  disabled={ingest.isPending}
                  className="gap-1"
                >
                  {ingest.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />}
                  Ingest {selectedIds.size} selected
                </Button>
              )}
            </div>

            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <Checkbox
                        checked={data.data.length > 0 && selectedIds.size === data.data.length}
                        onCheckedChange={toggleAll}
                      />
                    </TableHead>
                    <TableHead className="text-xs">Name</TableHead>
                    <TableHead className="text-xs">Title / Company</TableHead>
                    <TableHead className="text-xs">Location</TableHead>
                    <TableHead className="text-xs">Email</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.data.map((r: CloduraResult) => (
                    <TableRow key={r.personId} className="cursor-pointer hover:bg-muted/50" onClick={() => toggleSelect(r.personId)}>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(r.personId)}
                          onCheckedChange={() => toggleSelect(r.personId)}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium text-sm">{r.firstName} {r.lastName}</div>
                        {r.linkedinUrl && (
                          <a
                            href={r.linkedinUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:underline flex items-center gap-0.5"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink className="h-2.5 w-2.5" /> LinkedIn
                          </a>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{r.personTitle}</div>
                        <div className="text-xs text-muted-foreground">{r.organizationName}</div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {[r.personCity, r.personState, r.personCountry].filter(Boolean).join(", ")}
                      </TableCell>
                      <TableCell>
                        {emailStatusBadge(r.contactEmailStatus)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {data.data.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground text-sm py-8">
                        No results found. Try adjusting your filters.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {data.total > perPage && (
              <div className="flex items-center justify-between mt-3">
                <div className="text-xs text-muted-foreground">
                  Page {page} of {Math.ceil(data.total / perPage)}
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(page - 1)}
                    disabled={page <= 1}
                    className="h-7 px-2"
                  >
                    <ChevronLeft className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(page + 1)}
                    disabled={page >= Math.ceil(data.total / perPage)}
                    className="h-7 px-2"
                  >
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {!hasSearched && !isFetching && (
          <div className="px-6 py-12 text-center text-muted-foreground">
            <Search className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Set filters above and click Search to find prospects.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Main Prospects Page ───────────────────────────────────────────────────── */
export default function ProspectsPage() {
  const [, setLocation] = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [perPage] = useState(50);
  const [emailStatusFilter, setEmailStatusFilter] = useState<string>("all");
  const [promotedFilter, setPromotedFilter] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const utils = trpc.useUtils();

  const { data, isLoading, refetch } = trpc.clodura.listProspects.useQuery({
    page,
    perPage,
    emailStatus: emailStatusFilter !== "all" ? emailStatusFilter : undefined,
    promoted: promotedFilter === "promoted" ? true : promotedFilter === "not_promoted" ? false : undefined,
  });

  const promote = trpc.clodura.promoteToContact.useMutation({
    onSuccess: (res) => {
      toast.success(res.created ? "Promoted to contact" : "Linked to existing contact");
      utils.clodura.listProspects.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const revealEmail = trpc.clodura.revealEmail.useMutation({
    onSuccess: () => toast.success("Email reveal requested — you'll be notified when it's ready"),
    onError: (e) => toast.error(e.message),
  });

  const revealPhone = trpc.clodura.revealPhone.useMutation({
    onSuccess: () => toast.success("Phone reveal requested — you'll be notified when it's ready"),
    onError: (e) => toast.error(e.message),
  });

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!data?.data) return;
    if (selectedIds.size === data.data.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(data.data.map((r) => r.id)));
    }
  };

  const handleBulkPromote = async () => {
    const ids = Array.from(selectedIds);
    let promoted = 0;
    for (const id of ids) {
      try {
        await promote.mutateAsync({ prospectId: id });
        promoted++;
      } catch {
        // continue
      }
    }
    toast.success(`Promoted ${promoted} prospect${promoted !== 1 ? "s" : ""} to contacts`);
    setSelectedIds(new Set());
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Prospects"
        description="Outbound prospects sourced from Clodura.ai. Search, ingest, and promote to contacts."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setSearchOpen(true)}>
              <Zap className="h-4 w-4 mr-2" />
              Search Clodura
            </Button>
          </div>
        }
      />

      <div className="flex-1 overflow-hidden flex flex-col p-6 gap-4">
        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-wrap">
          <Select value={emailStatusFilter} onValueChange={setEmailStatusFilter}>
            <SelectTrigger className="h-8 w-40 text-sm">
              <SelectValue placeholder="Email status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All email statuses</SelectItem>
              <SelectItem value="verified">Verified</SelectItem>
              <SelectItem value="unverified">Unverified</SelectItem>
              <SelectItem value="unavailable">Unavailable</SelectItem>
            </SelectContent>
          </Select>

          <Select value={promotedFilter} onValueChange={setPromotedFilter}>
            <SelectTrigger className="h-8 w-40 text-sm">
              <SelectValue placeholder="Promoted" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All prospects</SelectItem>
              <SelectItem value="promoted">Promoted to contact</SelectItem>
              <SelectItem value="not_promoted">Not yet promoted</SelectItem>
            </SelectContent>
          </Select>

          {selectedIds.size > 0 && (
            <>
              <Separator orientation="vertical" className="h-6" />
              <Button size="sm" variant="outline" onClick={handleBulkPromote} disabled={promote.isPending}>
                <UserPlus className="h-4 w-4 mr-2" />
                Promote {selectedIds.size} to contacts
              </Button>
            </>
          )}

          <div className="ml-auto text-sm text-muted-foreground">
            {data?.total ? `${data.total.toLocaleString()} prospect${data.total !== 1 ? "s" : ""}` : ""}
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox
                    checked={!!data?.data?.length && selectedIds.size === data.data.length}
                    onCheckedChange={toggleAll}
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && data?.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                    <div className="flex flex-col items-center gap-3">
                      <Search className="h-10 w-10 opacity-30" />
                      <p className="text-sm">No prospects yet.</p>
                      <Button size="sm" onClick={() => setSearchOpen(true)}>
                        <Zap className="h-4 w-4 mr-2" />
                        Search Clodura to get started
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {data?.data?.map((p) => (
                <TableRow key={p.id} className="hover:bg-muted/50">
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(p.id)}
                      onCheckedChange={() => toggleSelect(p.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">{p.firstName} {p.lastName}</div>
                    {p.linkedinUrl && (
                      <a
                        href={p.linkedinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline flex items-center gap-0.5"
                      >
                        <ExternalLink className="h-2.5 w-2.5" /> LinkedIn
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{p.title}</TableCell>
                  <TableCell className="text-sm">{p.company}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {[p.city, p.state, p.country].filter(Boolean).join(", ")}
                  </TableCell>
                  <TableCell>
                    {p.email ? (
                      <div className="flex items-center gap-1">
                        <Mail className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs">{p.email}</span>
                        {emailStatusBadge(p.emailStatus)}
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-blue-600 hover:text-blue-700 px-1"
                        onClick={() => revealEmail.mutate({ prospectId: p.id })}
                        disabled={revealEmail.isPending}
                      >
                        <Mail className="h-3 w-3 mr-1" /> Reveal
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    {p.phone ? (
                      <div className="flex items-center gap-1">
                        <Phone className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs">{p.phone}</span>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs text-blue-600 hover:text-blue-700 px-1"
                        onClick={() => revealPhone.mutate({ prospectId: p.id })}
                        disabled={revealPhone.isPending}
                      >
                        <Phone className="h-3 w-3 mr-1" /> Reveal
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    {p.linkedContactId ? (
                      <Badge variant="default" className="text-xs gap-1">
                        <CheckCircle2 className="h-3 w-3" /> Promoted
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">Prospect</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {!p.linkedContactId && (
                          <DropdownMenuItem onClick={() => promote.mutate({ prospectId: p.id })}>
                            <UserPlus className="h-4 w-4 mr-2" />
                            Promote to contact
                          </DropdownMenuItem>
                        )}
                        {p.linkedContactId && (
                          <DropdownMenuItem onClick={() => setLocation(`/contacts/${p.linkedContactId}`)}>
                            <ExternalLink className="h-4 w-4 mr-2" />
                            View contact
                          </DropdownMenuItem>
                        )}
                        {!p.email && (
                          <DropdownMenuItem onClick={() => revealEmail.mutate({ prospectId: p.id })}>
                            <Mail className="h-4 w-4 mr-2" />
                            Reveal email
                          </DropdownMenuItem>
                        )}
                        {!p.phone && (
                          <DropdownMenuItem onClick={() => revealPhone.mutate({ prospectId: p.id })}>
                            <Phone className="h-4 w-4 mr-2" />
                            Reveal phone
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        {data && data.total > perPage && (
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              Page {page} of {Math.ceil(data.total / perPage)}
            </div>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= Math.ceil(data.total / perPage)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Clodura Search Slide-Over */}
      <Sheet open={searchOpen} onOpenChange={setSearchOpen}>
        <SheetContent side="right" className="w-[600px] max-w-full p-0 flex flex-col">
          <CloduraSearchPanel onClose={() => setSearchOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}
