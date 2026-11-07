/**
 * Email Suppressions (Opt-Out Management) Page
 *
 * Allows admins to:
 * - View all suppressed email addresses with reason, date, linked draft/contact
 * - Filter by reason (unsubscribe / bounce / spam_complaint / manual)
 * - Manually add a suppression
 * - Remove a suppression (re-enable sending to that address)
 * - See summary counts by reason
 * - Export the list, or import one, as CSV (audit 2026-10-20, F27)
 * - See which person an opt-out is about (F7)
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertTriangle,
  Ban,
  Download,
  Mail,
  MailX,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  UserX,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";
import { pressable } from "@/lib/pressable";

const REASON_LABELS: Record<string, { label: string; color: string }> = {
  unsubscribe: { label: "Unsubscribed", color: "bg-yellow-500/15 text-yellow-700 border-yellow-300" },
  bounce: { label: "Bounced", color: "bg-red-500/15 text-red-700 border-red-300" },
  spam_complaint: { label: "Spam Complaint", color: "bg-orange-500/15 text-orange-700 border-orange-300" },
  manual: { label: "Manual", color: "bg-slate-500/15 text-slate-700 border-slate-300" },
};

export function EmailSuppressions() {
  const { user } = useAuth();
  const [reasonFilter, setReasonFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addReason, setAddReason] = useState<string>("manual");
  const [addNotes, setAddNotes] = useState("");
  const [removeTarget, setRemoveTarget] = useState<number | null>(null);
  // CSV import (F27): the file's text, its name, and the reason for rows that name none.
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importName, setImportName] = useState("");
  const [importReason, setImportReason] = useState<string>("manual");
  const [exporting, setExporting] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

  const LIMIT = 50;

  const utils = trpc.useUtils();

  // Search runs on the server, across every page (audit 2026-10-20, O53);
  // it filtered only the page already fetched. A new search starts at page one.
  const [searchDebounced, setSearchDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => { setSearchDebounced(search.trim()); setOffset(0); }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: summary } = trpc.emailSuppressions.summary.useQuery();
  // One row more than the page, to know whether there is a next page: Next
  // used to show whenever a page was full, and never disabled.
  const { data: fetched, isLoading } = trpc.emailSuppressions.list.useQuery({
    reason: reasonFilter as any,
    limit: LIMIT + 1,
    offset,
    search: searchDebounced || undefined,
  });
  const rows = (fetched ?? []).slice(0, LIMIT);
  const hasMore = (fetched?.length ?? 0) > LIMIT;

  const addMutation = trpc.emailSuppressions.add.useMutation({
    onSuccess: () => {
      toast.success("Suppression added");
      setAddOpen(false);
      setAddEmail("");
      setAddNotes("");
      utils.emailSuppressions.list.invalidate();
      utils.emailSuppressions.summary.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const importMutation = trpc.emailSuppressions.importCsv.useMutation({
    onSuccess: (r) => {
      toast.success(
        `Imported ${r.added} suppression${r.added === 1 ? "" : "s"}` +
          (r.alreadySuppressed ? `; ${r.alreadySuppressed} already on the list` : "") +
          (r.invalid ? `; ${r.invalid} not a valid address` : "") +
          (r.truncated ? `. Only the first ${r.max.toLocaleString()} rows were read; import the rest separately.` : ""),
      );
      setImportOpen(false);
      setImportText("");
      setImportName("");
      utils.emailSuppressions.list.invalidate();
      utils.emailSuppressions.summary.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  /** The whole filtered list as a CSV file, built on the server (F27). */
  async function exportCsv() {
    setExporting(true);
    try {
      const r = await utils.client.emailSuppressions.exportCsv.query({ reason: reasonFilter as any, search: searchDebounced || undefined });
      const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `suppressions-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(r.truncated ? `Exported the newest ${r.count.toLocaleString()} — narrow the filter for the rest.` : `Exported ${r.count.toLocaleString()} suppression${r.count === 1 ? "" : "s"}`);
    } catch (e: any) {
      toast.error("Export failed: " + (e?.message ?? "unknown error"));
    } finally {
      setExporting(false);
    }
  }

  function pickImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 4_500_000) { toast.error("That file is over 4.5 MB. Split it and import the parts."); return; }
    const reader = new FileReader();
    reader.onload = () => { setImportText(String(reader.result ?? "")); setImportName(file.name); };
    reader.readAsText(file);
  }
  const importLines = importText ? importText.split(/\r?\n/).filter((l) => l.trim()).length : 0;

  const removeMutation = trpc.emailSuppressions.remove.useMutation({
    onSuccess: () => {
      toast.success("Suppression removed — sending re-enabled for this address");
      setRemoveTarget(null);
      utils.emailSuppressions.list.invalidate();
      utils.emailSuppressions.summary.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });


  const summaryCards = [
    { key: "total", label: "Total Suppressed", icon: Ban, value: summary?.total ?? 0, color: "text-slate-600" },
    { key: "unsubscribe", label: "Unsubscribed", icon: UserX, value: summary?.unsubscribe ?? 0, color: "text-yellow-600" },
    { key: "bounce", label: "Bounced", icon: MailX, value: summary?.bounce ?? 0, color: "text-red-600" },
    { key: "spam_complaint", label: "Spam Complaints", icon: AlertTriangle, value: summary?.spam_complaint ?? 0, color: "text-orange-600" },
  ];

  return (
    <Shell>
      <PageHeader title="Email Suppressions" description="Manage opt-outs, hard bounces, and global suppression lists to protect your sender reputation. Suppressed addresses are automatically excluded from all future sequences and campaigns." pageKey="email-suppressions"
        icon={<Ban className="size-5" />}
      >
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting}>
          <Download className="w-4 h-4 mr-1" />
          {exporting ? "Exporting..." : "Export CSV"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
          <Upload className="w-4 h-4 mr-1" />
          Import CSV
        </Button>
        <Button onClick={() => setAddOpen(true)} size="sm">
          <Plus className="w-4 h-4 mr-1" />
          Add Suppression
        </Button>
      </PageHeader>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {summaryCards.map((c) => (
          <Card key={c.key} className="cursor-pointer hover:shadow-md transition-shadow" {...pressable(() => { setReasonFilter(c.key === "total" ? "all" : c.key); setOffset(0); })}>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-3">
                <c.icon className={`w-5 h-5 ${c.color}`} />
                <div>
                  <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
                  <div className="text-xs text-muted-foreground">{c.label}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input aria-label="Search by email"
            placeholder="Search by email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={reasonFilter} onValueChange={(v) => { setReasonFilter(v); setOffset(0); }}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Filter by reason" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All reasons</SelectItem>
            <SelectItem value="unsubscribe">Unsubscribed</SelectItem>
            <SelectItem value="bounce">Bounced</SelectItem>
            <SelectItem value="spam_complaint">Spam Complaint</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => { utils.emailSuppressions.list.invalidate(); utils.emailSuppressions.summary.invalidate(); }}>
          <RefreshCw className="w-4 h-4 mr-1" />
          Refresh
        </Button>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email Address</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Draft ID</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-12">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <Mail className="w-8 h-8 opacity-40" />
                      <p className="text-sm">No suppressions found</p>
                      {reasonFilter !== "all" && (
                        <Button variant="ghost" size="sm" onClick={() => setReasonFilter("all")}>Clear filter</Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => {
                  const meta = REASON_LABELS[row.reason] ?? { label: row.reason, color: "" };
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-sm">
                        {row.email}
                        {/* The person this opt-out follows (F7), at any address they have. */}
                        {row.prospectId ? (
                          <Link href={`/prospects/${row.prospectId}`} className="block font-sans text-xs text-primary hover:underline">
                            Person: {row.personName || `#${row.prospectId}`}
                          </Link>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`text-xs ${meta.color}`}>{meta.label}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {row.draftId ? `#${row.draftId}` : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm max-w-[200px] truncate">
                        {row.notes ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(row.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setRemoveTarget(row.id)}
                          title="Remove suppression (re-enable sending)"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pagination */}
      {(offset > 0 || hasMore) && (
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>Previous</Button>
          <Button variant="outline" size="sm" disabled={!hasMore} onClick={() => setOffset(offset + LIMIT)}>Next</Button>
        </div>
      )}

      {/* Add Suppression Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Email Suppression</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Email Address</Label>
              <Input aria-label="Email Address"
                type="email"
                placeholder="user@example.com"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Reason</Label>
              <Select value={addReason} onValueChange={setAddReason}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="unsubscribe">Unsubscribed</SelectItem>
                  <SelectItem value="bounce">Bounced</SelectItem>
                  <SelectItem value="spam_complaint">Spam Complaint</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Notes (optional)</Label>
              <Textarea aria-label="Notes (optional)"
                placeholder="Reason for manual suppression..."
                value={addNotes}
                onChange={(e) => setAddNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              onClick={() => addMutation.mutate({ email: addEmail, reason: addReason as any, notes: addNotes || undefined })}
              disabled={!addEmail || addMutation.isPending}
            >
              {addMutation.isPending ? "Adding..." : "Add Suppression"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import CSV Dialog (F27) */}
      <Dialog open={importOpen} onOpenChange={(o) => { setImportOpen(o); if (!o) { setImportText(""); setImportName(""); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Import suppressions from CSV</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2 text-sm">
            <p className="text-muted-foreground">
              One address per row, in a column headed <span className="font-mono">email</span> (a file of bare addresses works too).
              An optional <span className="font-mono">reason</span> column (unsubscribe, bounce, spam, manual) and <span className="font-mono">notes</span> column are read.
              Addresses already on the list are left alone. Up to 10,000 rows a file.
            </p>
            <div className="space-y-1.5">
              <Label>File</Label>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => importFileRef.current?.click()}>
                  <Upload className="w-4 h-4 mr-1" /> Choose CSV
                </Button>
                <span className="text-xs text-muted-foreground truncate">{importName ? `${importName} — ${importLines.toLocaleString()} line${importLines === 1 ? "" : "s"}` : "No file chosen"}</span>
              </div>
              <input ref={importFileRef} type="file" accept=".csv,text/csv,text/plain" aria-label="CSV file to import" className="hidden" onChange={pickImportFile} />
            </div>
            <div className="space-y-1.5">
              <Label>Reason for rows that name none</Label>
              <Select value={importReason} onValueChange={setImportReason}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual">Manual</SelectItem>
                  <SelectItem value="unsubscribe">Unsubscribed</SelectItem>
                  <SelectItem value="bounce">Bounced</SelectItem>
                  <SelectItem value="spam_complaint">Spam Complaint</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>Cancel</Button>
            <Button
              onClick={() => importMutation.mutate({ csv: importText, defaultReason: importReason as any })}
              disabled={!importText || importMutation.isPending}
            >
              {importMutation.isPending ? "Importing..." : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Confirmation Dialog */}
      <Dialog open={removeTarget !== null} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove Suppression?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will re-enable sending to this address. Only do this if the contact has explicitly re-opted in.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => removeTarget !== null && removeMutation.mutate({ id: removeTarget })}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending ? "Removing..." : "Remove Suppression"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
