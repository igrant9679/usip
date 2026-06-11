/**
 * Prospects page — outbound prospect list (manual CSV import + scraper).
 *
 * Layout:
 *   PageHeader + Reoon balance + "Import CSV" button (wizard TBD)
 *   Filter toolbar (email status, promoted)
 *   Prospect table with row actions: Find contact info, Promote, Delete
 *   Enrichment detail dialog — shows scraper output for one prospect
 *
 * Sourcing: prospects are loaded via CSV upload (e.g. LeadRocks exports).
 * The previous Clodura.ai search/reveal/credits surface has been removed.
 * Contact info (emails / phones / social URLs) is found via the company-site
 * scraper + Reoon email pattern verification — see server/services/scraper.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Search,
  UserPlus,
  MoreHorizontal,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Trash2,
  ExternalLink,
  Mail,
  Phone,
  Loader2,
  CheckCircle2,
  Upload,
  Zap,
  Sparkles,
  Info,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { ProspectImportDialog } from "./ProspectImportDialog";

/* ─── Types ────────────────────────────────────────────────────────────────── */
type EnrichmentData = {
  scrapedDomain: string | null;
  scrapedAt: string;
  emailsFound: string[];
  phonesFound: string[];
  socialUrls: string[];
  patternsVerified: Array<{
    email: string;
    pattern: "first.last" | "flast" | "firstlast";
    status: "valid" | "accept_all" | "risky" | "invalid" | "unknown";
    overallScore?: number;
    mode: "quick" | "power";
  }>;
  skipReason?: string;
};

/* ─── Helpers ──────────────────────────────────────────────────────────────── */
function emailStatusBadge(status?: string | null) {
  if (!status) return null;
  const map: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
    valid: { label: "Valid", variant: "default" },
    verified: { label: "Valid", variant: "default" },
    accept_all: { label: "Accept-All", variant: "secondary" },
    risky: { label: "Risky", variant: "secondary" },
    invalid: { label: "Invalid", variant: "destructive" },
    unverified: { label: "Unverified", variant: "secondary" },
    unavailable: { label: "Unavailable", variant: "outline" },
  };
  const s = map[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={s.variant} className="text-xs">{s.label}</Badge>;
}

/** ICP-fit badge from a 0–100 confidence score. */
function fitBadge(score?: number | null) {
  if (score === null || score === undefined) return <span className="text-xs text-muted-foreground">—</span>;
  const color = score >= 70 ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300"
    : score >= 40 ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
    : "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300";
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums ${color}`} title="ICP-fit confidence score">{score}</span>;
}

/* ─── Enrichment detail dialog ─────────────────────────────────────────────── */
function EnrichmentDialog({
  open,
  onClose,
  data,
  prospectName,
}: {
  open: boolean;
  onClose: () => void;
  data: EnrichmentData | null;
  prospectName: string;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Contact info — {prospectName}</DialogTitle>
          <DialogDescription>
            {data?.scrapedDomain
              ? `Scraped ${data.scrapedDomain} on ${data.scrapedAt.slice(0, 10)}`
              : "No domain scraped"}
          </DialogDescription>
        </DialogHeader>
        {!data ? (
          <div className="text-sm text-muted-foreground">
            No enrichment data yet. Click "Find contact info" on this prospect.
          </div>
        ) : (
          <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-2">
            {data.skipReason && (
              <div className="rounded-md bg-yellow-50 border border-yellow-200 px-3 py-2 text-xs text-yellow-800">
                Skip reason: <code>{data.skipReason}</code>
              </div>
            )}

            <Section title="Email patterns tried">
              {data.patternsVerified.length === 0 ? (
                <div className="text-xs text-muted-foreground">None.</div>
              ) : (
                <div className="space-y-1">
                  {data.patternsVerified.map((p, i) => (
                    <div key={`${p.email}-${p.mode}-${i}`} className="flex items-center gap-2 text-sm">
                      <span className="font-mono">{p.email}</span>
                      <span className="text-xs text-muted-foreground">({p.pattern})</span>
                      <Badge
                        variant="outline"
                        className={`text-xs ${p.mode === "power" ? "border-purple-300 text-purple-700" : "border-slate-300 text-slate-600"}`}
                      >
                        {p.mode}
                      </Badge>
                      {emailStatusBadge(p.status)}
                      {p.overallScore !== undefined && (
                        <span className="text-xs text-muted-foreground ml-auto">
                          score {p.overallScore}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title={`Emails on company site (${data.emailsFound.length})`}>
              {data.emailsFound.length === 0 ? (
                <div className="text-xs text-muted-foreground">None.</div>
              ) : (
                <ul className="text-sm space-y-0.5">
                  {data.emailsFound.map((e) => (
                    <li key={e}>
                      <a href={`mailto:${e}`} className="text-blue-600 hover:underline font-mono">
                        {e}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={`Phones on company site (${data.phonesFound.length})`}>
              {data.phonesFound.length === 0 ? (
                <div className="text-xs text-muted-foreground">None.</div>
              ) : (
                <ul className="text-sm space-y-0.5">
                  {data.phonesFound.map((p) => (
                    <li key={p}>
                      <a href={`tel:${p}`} className="text-blue-600 hover:underline font-mono">
                        {p}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={`Social URLs (${data.socialUrls.length})`}>
              {data.socialUrls.length === 0 ? (
                <div className="text-xs text-muted-foreground">None.</div>
              ) : (
                <ul className="text-sm space-y-0.5">
                  {data.socialUrls.map((u) => (
                    <li key={u}>
                      <a
                        href={u}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline flex items-center gap-1"
                      >
                        <ExternalLink className="h-3 w-3" />
                        <span className="truncate">{u}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
        {title}
      </div>
      {children}
    </div>
  );
}

/* ─── Main Prospects Page ───────────────────────────────────────────────────── */
export default function ProspectsPage() {
  const [, setLocation] = useLocation();
  const [page, setPage] = useState(1);
  const [perPage] = useState(50);
  const [emailStatusFilter, setEmailStatusFilterRaw] = useState<string>("all");
  // Default to hiding prospects that have already been promoted to a lead:
  // once promoted, the record lives on the Leads page, so it drops out of the
  // default Prospects view. Still reachable via the "Converted to lead" / "All
  // prospects" filter options below (the linked-lead back-link is preserved).
  const [promotedFilter, setPromotedFilterRaw] = useState<string>("not_promoted");
  // Changing a filter must reset pagination — keeping page N against a
  // smaller filtered set shows an empty table even when matches exist.
  const setEmailStatusFilter = (v: string) => { setEmailStatusFilterRaw(v); setPage(1); };
  const setPromotedFilter = (v: string) => { setPromotedFilterRaw(v); setPage(1); };
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [enrichOpenFor, setEnrichOpenFor] = useState<{
    name: string;
    data: EnrichmentData | null;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const utils = trpc.useUtils();

  const { data, isLoading, refetch } = trpc.prospects.list.useQuery({
    page,
    perPage,
    emailStatus: emailStatusFilter !== "all" ? emailStatusFilter : undefined,
    promoted: promotedFilter === "promoted" ? true : promotedFilter === "not_promoted" ? false : undefined,
  });

  const reoonBalance = trpc.prospects.reoonBalance.useQuery(undefined, {
    refetchInterval: 5 * 60 * 1000, // refresh every 5 min so users see credit drain
    retry: false,
  });

  const promote = trpc.prospects.promoteToLead.useMutation({
    onSuccess: (res) => {
      toast.success(res.created ? "Converted to lead" : "Linked to existing lead");
      utils.prospects.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteProspect = trpc.prospects.delete.useMutation({
    onSuccess: (res) => {
      toast.success(
        res.hadLinkedContact
          ? "Prospect deleted (linked contact kept — delete via Contacts if you want it gone too)"
          : "Prospect deleted",
      );
      utils.prospects.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bulkDelete = trpc.prospects.bulkDelete.useMutation({
    onSuccess: (res) => {
      toast.success(
        res.hadLinkedContacts > 0
          ? `${res.deleted} prospects deleted (${res.hadLinkedContacts} had linked contacts — kept intact)`
          : `${res.deleted} prospects deleted`,
      );
      setSelectedIds(new Set());
      utils.prospects.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const findContact = trpc.prospects.findContactInfo.useMutation({
    onSuccess: (res) => {
      const creditMsg = `${res.reoonCreditsQuick} instant + ${res.reoonCreditsPower} daily`;
      if (res.email) {
        toast.success(`Found ${res.emailStatus} email: ${res.email}`, {
          description: `Used ${creditMsg}`,
        });
      } else {
        toast(res.message, {
          description: res.enrichment.scrapedDomain
            ? `${res.enrichment.scrapedDomain} · ${creditMsg}`
            : creditMsg,
        });
      }
      utils.prospects.list.invalidate();
      void reoonBalance.refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const findContactBatch = trpc.prospects.findContactInfoBatch.useMutation({
    onSuccess: (res) => {
      toast.success(
        `Scanned ${res.processed} prospects — ${res.withEmail} got emails, ${res.withoutEmail} did not`,
        {
          description: `Used ${res.reoonCreditsQuick} instant + ${res.reoonCreditsPower} daily Reoon credits`,
        },
      );
      setSelectedIds(new Set());
      utils.prospects.list.invalidate();
      void reoonBalance.refetch();
    },
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
    toast.success(`Converted ${promoted} prospect${promoted !== 1 ? "s" : ""} to leads`);
    setSelectedIds(new Set());
  };

  const handleBulkFindContact = () => {
    const ids = Array.from(selectedIds);
    if (ids.length > 25) {
      toast.error(`Pick 25 or fewer prospects per batch (you selected ${ids.length})`);
      return;
    }
    if (!confirm(
      `Find contact info for ${ids.length} prospect${ids.length !== 1 ? "s" : ""}?\n\n` +
      `For each prospect: scrape the company site, then verify up to 3 email ` +
      `patterns via Reoon (quick pre-filter → power confirmation on survivors).\n\n` +
      `Worst-case spend: ~${ids.length * 3} instant + ~${ids.length * 3} daily ` +
      `credits. Typical spend is much lower (early-stop on first valid hit).`
    )) return;
    findContactBatch.mutate({ prospectIds: ids, skipIfHasEmail: true });
  };

  const handleImportClick = () => {
    setImportOpen(true);
  };

  return (
    <Shell title="Prospects">
      <PageHeader
        title="Prospects"
        description="Outbound prospects imported from CSV (e.g. LeadRocks exports)."
        pageKey="prospects"
        icon={<Zap className="size-5" />}
      >
        {reoonBalance.data && reoonBalance.data.api_status === "success" && (
          <div
            className="text-right pr-2 hidden md:block"
            title="Daily = mode=power (full SMTP), Instant = mode=quick (cached). The scraper uses quick as a pre-filter, then power on survivors."
          >
            <div className="text-xs text-muted-foreground">Reoon credits</div>
            <div className="text-sm font-semibold tabular-nums leading-tight">
              {reoonBalance.data.remaining_daily_credits.toLocaleString()}
              <span className="text-xs font-normal text-muted-foreground"> daily</span>
              {" · "}
              {reoonBalance.data.remaining_instant_credits.toLocaleString()}
              <span className="text-xs font-normal text-muted-foreground"> instant</span>
            </div>
          </div>
        )}
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
        <Button size="sm" onClick={handleImportClick}>
          <Upload className="h-4 w-4 mr-2" />
          Import CSV
        </Button>
      </PageHeader>

      <div className="flex-1 overflow-hidden flex flex-col p-6 gap-4">
        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-wrap">
          <Select value={emailStatusFilter} onValueChange={setEmailStatusFilter}>
            <SelectTrigger className="h-8 w-40 text-sm">
              <SelectValue placeholder="Email status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All email statuses</SelectItem>
              <SelectItem value="valid">Valid</SelectItem>
              <SelectItem value="accept_all">Accept-All</SelectItem>
              <SelectItem value="risky">Risky</SelectItem>
              <SelectItem value="invalid">Invalid</SelectItem>
            </SelectContent>
          </Select>

          <Select value={promotedFilter} onValueChange={setPromotedFilter}>
            <SelectTrigger className="h-8 w-40 text-sm">
              <SelectValue placeholder="Promoted" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All prospects</SelectItem>
              <SelectItem value="promoted">Converted to lead</SelectItem>
              <SelectItem value="not_promoted">Not yet converted</SelectItem>
            </SelectContent>
          </Select>

          {selectedIds.size > 0 && (
            <>
              <Separator orientation="vertical" className="h-6" />
              <Button
                size="sm"
                variant="outline"
                onClick={handleBulkFindContact}
                disabled={findContactBatch.isPending || selectedIds.size > 25}
              >
                {findContactBatch.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-2" />
                )}
                Find contact info ({selectedIds.size})
              </Button>
              <Button size="sm" variant="outline" onClick={handleBulkPromote} disabled={promote.isPending}>
                <UserPlus className="h-4 w-4 mr-2" />
                Convert to lead ({selectedIds.size})
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive border-destructive/40 hover:bg-destructive/10"
                onClick={() => {
                  const ids = Array.from(selectedIds);
                  if (confirm(`Delete ${ids.length} prospect${ids.length !== 1 ? "s" : ""}? Converted leads will be kept.`)) {
                    bulkDelete.mutate({ prospectIds: ids });
                  }
                }}
                disabled={bulkDelete.isPending}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete {selectedIds.size}
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
                <TableHead className="w-12">Fit</TableHead>
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
                  <TableCell colSpan={10} className="text-center py-12">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && data?.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                    <div className="flex flex-col items-center gap-3">
                      <Search className="h-10 w-10 opacity-30" />
                      <p className="text-sm">No prospects yet.</p>
                      <Button size="sm" onClick={handleImportClick}>
                        <Upload className="h-4 w-4 mr-2" />
                        Import a CSV to get started
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {data?.data?.map((p) => {
                const enrichment = (p.enrichmentData as EnrichmentData | null) ?? null;
                const isWorkingOnThisRow =
                  findContact.isPending && findContact.variables?.prospectId === p.id;
                return (
                  <TableRow key={p.id} className="hover:bg-muted/50">
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(p.id)}
                        onCheckedChange={() => toggleSelect(p.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => setLocation(`/prospects/${p.id}`)}
                        className="font-medium text-sm text-left hover:underline"
                      >
                        {p.firstName} {p.lastName}
                      </button>
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
                    <TableCell className="text-sm"><div className="max-w-[150px] truncate" title={p.title ?? undefined}>{p.title}</div></TableCell>
                    <TableCell>{fitBadge((p as any).confidenceScore)}</TableCell>
                    <TableCell className="text-sm"><div className="max-w-[150px] truncate" title={p.company ?? undefined}>{p.company}</div></TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {[p.city, p.state, p.country].filter(Boolean).join(", ")}
                    </TableCell>
                    <TableCell>
                      {p.email ? (
                        <div className="flex items-center gap-1 max-w-[220px]">
                          <Mail className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="text-xs truncate min-w-0" title={p.email ?? undefined}>{p.email}</span>
                          {emailStatusBadge(p.emailStatus)}
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-xs text-blue-600 hover:text-blue-700 px-1"
                          onClick={() =>
                            findContact.mutate({ prospectId: p.id, skipIfHasEmail: true })
                          }
                          disabled={isWorkingOnThisRow}
                        >
                          {isWorkingOnThisRow ? (
                            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          ) : (
                            <Sparkles className="h-3 w-3 mr-1" />
                          )}
                          Find
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
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {p.linkedLeadId ? (
                          <Badge variant="default" className="text-xs gap-1">
                            <CheckCircle2 className="h-3 w-3" /> Lead
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs">Prospect</Badge>
                        )}
                        {enrichment && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5"
                            title="View enrichment details"
                            onClick={() =>
                              setEnrichOpenFor({
                                name: `${p.firstName} ${p.lastName}`.trim(),
                                data: enrichment,
                              })
                            }
                          >
                            <Info className="h-3 w-3 text-muted-foreground" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              findContact.mutate({ prospectId: p.id, skipIfHasEmail: true })
                            }
                            disabled={isWorkingOnThisRow}
                          >
                            <Sparkles className="h-4 w-4 mr-2" />
                            Find contact info
                          </DropdownMenuItem>
                          {enrichment && (
                            <DropdownMenuItem
                              onClick={() =>
                                setEnrichOpenFor({
                                  name: `${p.firstName} ${p.lastName}`.trim(),
                                  data: enrichment,
                                })
                              }
                            >
                              <Info className="h-4 w-4 mr-2" />
                              View enrichment details
                            </DropdownMenuItem>
                          )}
                          {!p.linkedLeadId && (
                            <DropdownMenuItem onClick={() => promote.mutate({ prospectId: p.id })}>
                              <UserPlus className="h-4 w-4 mr-2" />
                              Convert to lead
                            </DropdownMenuItem>
                          )}
                          {p.linkedLeadId && (
                            <DropdownMenuItem onClick={() => setLocation(`/leads/${p.linkedLeadId}`)}>
                              <ExternalLink className="h-4 w-4 mr-2" />
                              View lead
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => {
                              const label = `${p.firstName} ${p.lastName}`.trim() || "this prospect";
                              const warn = p.linkedLeadId
                                ? `Delete ${label}? They've been converted to a lead — the lead row will be kept.`
                                : `Delete ${label}?`;
                              if (confirm(warn)) deleteProspect.mutate({ prospectId: p.id });
                            }}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
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

      <EnrichmentDialog
        open={!!enrichOpenFor}
        onClose={() => setEnrichOpenFor(null)}
        data={enrichOpenFor?.data ?? null}
        prospectName={enrichOpenFor?.name ?? ""}
      />

      <ProspectImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          void refetch();
        }}
      />
    </Shell>
  );
}
