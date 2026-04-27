/**
 * Email Suppressions (Opt-Out Management) Page
 *
 * Allows admins to:
 * - View all suppressed email addresses with reason, date, linked draft/contact
 * - Filter by reason (unsubscribe / bounce / spam_complaint / manual)
 * - Manually add a suppression
 * - Remove a suppression (re-enable sending to that address)
 * - See summary counts by reason
 */
import { useState } from "react";
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
  Mail,
  MailX,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UserX,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";

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

  const LIMIT = 50;

  const utils = trpc.useUtils();

  const { data: summary } = trpc.emailSuppressions.summary.useQuery();
  const { data: rows, isLoading } = trpc.emailSuppressions.list.useQuery({
    reason: reasonFilter as any,
    limit: LIMIT,
    offset,
  });

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

  const removeMutation = trpc.emailSuppressions.remove.useMutation({
    onSuccess: () => {
      toast.success("Suppression removed — sending re-enabled for this address");
      setRemoveTarget(null);
      utils.emailSuppressions.list.invalidate();
      utils.emailSuppressions.summary.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const filtered = (rows ?? []).filter((r) =>
    search ? r.email.toLowerCase().includes(search.toLowerCase()) : true
  );

  const summaryCards = [
    { key: "total", label: "Total Suppressed", icon: Ban, value: summary?.total ?? 0, color: "text-slate-600" },
    { key: "unsubscribe", label: "Unsubscribed", icon: UserX, value: summary?.unsubscribe ?? 0, color: "text-yellow-600" },
    { key: "bounce", label: "Bounced", icon: MailX, value: summary?.bounce ?? 0, color: "text-red-600" },
    { key: "spam_complaint", label: "Spam Complaints", icon: AlertTriangle, value: summary?.spam_complaint ?? 0, color: "text-orange-600" },
  ];

  return (
    <Shell>
      <PageHeader title="Email Suppressions" description="Manage opt-outs, bounces, and spam complaints. Suppressed addresses are automatically skipped during send." pageKey="email-suppressions">
        <Button onClick={() => setAddOpen(true)} size="sm">
          <Plus className="w-4 h-4 mr-1" />
          Add Suppression
        </Button>
      </PageHeader>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {summaryCards.map((c) => (
          <Card key={c.key} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => { setReasonFilter(c.key === "total" ? "all" : c.key); setOffset(0); }}>
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
          <Input
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
              ) : filtered.length === 0 ? (
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
                filtered.map((row) => {
                  const meta = REASON_LABELS[row.reason] ?? { label: row.reason, color: "" };
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-sm">{row.email}</TableCell>
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
      {(rows?.length ?? 0) === LIMIT && (
        <div className="flex justify-end gap-2 mt-3">
          <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>Previous</Button>
          <Button variant="outline" size="sm" onClick={() => setOffset(offset + LIMIT)}>Next</Button>
        </div>
      )}

      {/* Add Suppression Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Email Suppression</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Email Address</Label>
              <Input
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
              <Textarea
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

      {/* Remove Confirmation Dialog */}
      <Dialog open={removeTarget !== null} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <DialogContent className="max-w-sm">
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
