/**
 * Prospects page — outbound prospect list (manual CSV import + promote).
 *
 * Layout:
 *   PageHeader + "Import CSV" button (wizard TBD)
 *   Filter toolbar (email status, promoted)
 *   Prospect table with row actions: Promote to contact, Delete
 *
 * Sourcing: prospects are loaded via CSV upload (e.g. LeadRocks exports).
 * The previous Clodura.ai search/reveal/credits surface has been removed.
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
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

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

/* ─── Main Prospects Page ───────────────────────────────────────────────────── */
export default function ProspectsPage() {
  const [, setLocation] = useLocation();
  const [page, setPage] = useState(1);
  const [perPage] = useState(50);
  const [emailStatusFilter, setEmailStatusFilter] = useState<string>("all");
  const [promotedFilter, setPromotedFilter] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const utils = trpc.useUtils();

  const { data, isLoading, refetch } = trpc.prospects.list.useQuery({
    page,
    perPage,
    emailStatus: emailStatusFilter !== "all" ? emailStatusFilter : undefined,
    promoted: promotedFilter === "promoted" ? true : promotedFilter === "not_promoted" ? false : undefined,
  });

  const promote = trpc.prospects.promoteToContact.useMutation({
    onSuccess: (res) => {
      toast.success(res.created ? "Promoted to contact" : "Linked to existing contact");
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

  const handleImportClick = () => {
    // TODO: open CSV import wizard (LeadRocks-aware mapping, Reoon verification)
    toast.info("CSV import wizard coming soon.");
  };

  return (
    <Shell title="Prospects">
      <PageHeader
        title="Prospects"
        description="Outbound prospects imported from CSV (e.g. LeadRocks exports)."
        pageKey="prospects"
        icon={<Zap className="size-5" />}
      >
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
              <Button
                size="sm"
                variant="outline"
                className="text-destructive border-destructive/40 hover:bg-destructive/10"
                onClick={() => {
                  const ids = Array.from(selectedIds);
                  if (confirm(`Delete ${ids.length} prospect${ids.length !== 1 ? "s" : ""}? Promoted contacts will be kept.`)) {
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
                      <Button size="sm" onClick={handleImportClick}>
                        <Upload className="h-4 w-4 mr-2" />
                        Import a CSV to get started
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
                      <span className="text-xs text-muted-foreground">—</span>
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
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => {
                            const label = `${p.firstName} ${p.lastName}`.trim() || "this prospect";
                            const warn = p.linkedContactId
                              ? `Delete ${label}? They've been promoted to a contact — the contact row will be kept.`
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
    </Shell>
  );
}
