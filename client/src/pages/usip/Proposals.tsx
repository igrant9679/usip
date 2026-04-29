import { Shell, PageHeader } from "@/components/usip/Shell";
import { useState, useMemo, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  ClipboardList,
  Plus,
  Search,
  Building2,
  Calendar,
  DollarSign,
  ChevronRight,
  FileText,
  Clock,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Eye,
  AlertTriangle,
  Timer,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  CalendarCheck,
  UserCheck,
  ThumbsUp,
  ThumbsDown,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";

// ── Status config ─────────────────────────────────────────────────────────────
const STATUS_CONFIG = {
  draft: { label: "Draft", color: "bg-slate-500/15 text-slate-400 border-slate-500/30", icon: FileText },
  sent: { label: "Sent", color: "bg-blue-500/15 text-blue-400 border-blue-500/30", icon: Eye },
  under_review: { label: "Under Review", color: "bg-amber-500/15 text-amber-400 border-amber-500/30", icon: Clock },
  accepted: { label: "Accepted", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", icon: CheckCircle2 },
  not_accepted: { label: "Not Accepted", color: "bg-red-500/15 text-red-400 border-red-500/30", icon: XCircle },
  revision_requested: { label: "Revision Requested", color: "bg-orange-500/15 text-orange-400 border-orange-500/30", icon: RotateCcw },
} as const;

type ProposalStatus = keyof typeof STATUS_CONFIG;

const PROJECT_TYPES = [
  "Digital Marketing",
  "Brand Strategy",
  "Media Buying",
  "Content Production",
  "SEO / SEM",
  "Social Media Management",
  "PR & Communications",
  "Website Development",
  "Analytics & Reporting",
  "Integrated Campaign",
  "Other",
];

// ── New Proposal Wizard ───────────────────────────────────────────────────────
interface WizardProps {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}

function NewProposalWizard({ open, onClose, onCreated }: WizardProps) {
  const { current } = useWorkspace();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    title: "",
    clientName: "",
    clientEmail: "",
    clientWebsite: "",
    orgAbbr: "",
    projectType: "",
    rfpDeadline: "",
    completionDate: "",
    expiresAt: "",
    budget: "",
    description: "",
  });

  // Contacts search for pre-fill
  const [contactSearch, setContactSearch] = useState("");
  // Track which account id to fetch when a contact with accountId is selected
  const [selectedContactAccountId, setSelectedContactAccountId] = useState<number | null>(null);

  // Use trpc.contacts.list with search param (NOT trpc.contacts.search which doesn't exist)
  const { data: contactResults } = trpc.contacts.list.useQuery(
    { search: contactSearch },
    { enabled: !!current && contactSearch.length >= 2 },
  );

  // Fetch the linked account when a contact with accountId is selected
  const { data: linkedAccount } = trpc.accounts.get.useQuery(
    { id: selectedContactAccountId! },
    { enabled: selectedContactAccountId !== null },
  );

  // When linked account data arrives, fill org name and website into the form
  useEffect(() => {
    if (!linkedAccount) return;
    setForm((f) => ({
      ...f,
      clientName: linkedAccount.name || f.clientName,
      clientWebsite: linkedAccount.domain
        ? `https://${linkedAccount.domain}`
        : f.clientWebsite,
      orgAbbr: f.orgAbbr || linkedAccount.name?.slice(0, 32) || "",
    }));
  }, [linkedAccount]);

  const createMutation = trpc.proposals.create.useMutation({
    onSuccess: (data) => {
      toast.success("Proposal created");
      onCreated(data.id);
      handleClose();
    },
    onError: (e) => toast.error(e.message),
  });

  function handleClose() {
    setStep(1);
    setForm({ title: "", clientName: "", clientEmail: "", clientWebsite: "", orgAbbr: "", projectType: "", rfpDeadline: "", completionDate: "", expiresAt: "", budget: "", description: "" });
    setContactSearch("");
    setSelectedContactAccountId(null);
    onClose();
  }

  function applyContact(c: any) {
    // Pre-fill contact name and email immediately (contacts have firstName, lastName, email, accountId)
    setForm((f) => ({
      ...f,
      clientName: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || f.clientName,
      clientEmail: c.email || f.clientEmail,
    }));
    setContactSearch("");
    // If the contact has a linked account, trigger account lookup for org name + website
    if (c.accountId) {
      setSelectedContactAccountId(c.accountId);
    }
  }

  const step1Valid = form.title.trim() && form.clientName.trim();

  function handleSubmit() {
    createMutation.mutate({
      title: form.title,
      clientName: form.clientName,
      clientEmail: form.clientEmail || undefined,
      clientWebsite: form.clientWebsite || undefined,
      orgAbbr: form.orgAbbr || undefined,
      projectType: form.projectType || undefined,
      rfpDeadline: form.rfpDeadline || undefined,
      completionDate: form.completionDate || undefined,
      expiresAt: form.expiresAt || undefined,
      budget: form.budget ? parseFloat(form.budget) : undefined,
      description: form.description || undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="size-5 text-teal-600" />
            New Proposal — Step {step} of 2
          </DialogTitle>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex gap-2 mb-1">
          {[1, 2].map((s) => (
            <div
              key={s}
              className={cn(
                "h-1 flex-1 rounded-full transition-colors",
                s <= step ? "bg-teal-500" : "bg-muted",
              )}
            />
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-4">
            <div>
              <Label>Proposal Title *</Label>
              <Input
                placeholder="e.g. Q3 Digital Marketing Campaign"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                className="mt-1"
              />
            </div>

            {/* Contact search pre-fill */}
            <div>
              <Label>Search Existing Contact (optional)</Label>
              <Input
                placeholder="Type name or email to search contacts..."
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                className="mt-1"
              />
              {contactResults && contactResults.length > 0 && contactSearch.length >= 2 && (
                <div className="border rounded-md mt-1 max-h-36 overflow-y-auto bg-card">
                  {contactResults.slice(0, 5).map((c: any) => (
                    <button
                      key={c.id}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2"
                      onClick={() => applyContact(c)}
                    >
                      <Building2 className="size-3.5 text-muted-foreground shrink-0" />
                      <span className="font-medium">{c.firstName} {c.lastName}</span>
                      <span className="text-muted-foreground text-xs truncate">{c.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Client / Org Name *</Label>
                <Input
                  placeholder="Acme Corp"
                  value={form.clientName}
                  onChange={(e) => setForm((f) => ({ ...f, clientName: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Org Abbreviation</Label>
                <Input
                  placeholder="ACME"
                  maxLength={32}
                  value={form.orgAbbr}
                  onChange={(e) => setForm((f) => ({ ...f, orgAbbr: e.target.value }))}
                  className="mt-1"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Client Email</Label>
                <Input
                  type="email"
                  placeholder="client@example.com"
                  value={form.clientEmail}
                  onChange={(e) => setForm((f) => ({ ...f, clientEmail: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Client Website</Label>
                <Input
                  placeholder="https://example.com"
                  value={form.clientWebsite}
                  onChange={(e) => setForm((f) => ({ ...f, clientWebsite: e.target.value }))}
                  className="mt-1"
                />
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <Label>Project Type</Label>
              <Select
                value={form.projectType}
                onValueChange={(v) => setForm((f) => ({ ...f, projectType: v }))}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Select project type..." />
                </SelectTrigger>
                <SelectContent>
                  {PROJECT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>RFP Deadline</Label>
                <Input
                  type="date"
                  value={form.rfpDeadline}
                  onChange={(e) => setForm((f) => ({ ...f, rfpDeadline: e.target.value }))}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Completion Date</Label>
                <Input
                  type="date"
                  value={form.completionDate}
                  onChange={(e) => setForm((f) => ({ ...f, completionDate: e.target.value }))}
                  className="mt-1"
                />
              </div>
            </div>
            <div>
              <Label>Proposal Expiry Date <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                type="date"
                value={form.expiresAt}
                onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">If set, the proposal will be automatically marked as Not Accepted after this date.</p>
            </div>

            <div>
              <Label>Estimated Budget ($)</Label>
              <Input
                type="number"
                placeholder="50000"
                value={form.budget}
                onChange={(e) => setForm((f) => ({ ...f, budget: e.target.value }))}
                className="mt-1"
              />
            </div>

            <div>
              <Label>Project Description</Label>
              <Textarea
                placeholder="Brief overview of the project scope and goals..."
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                className="mt-1 min-h-[80px]"
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === 1 ? (
            <>
              <Button variant="ghost" onClick={handleClose}>Cancel</Button>
              <Button
                onClick={() => setStep(2)}
                disabled={!step1Valid}
                className="bg-teal-600 hover:bg-teal-700 text-white"
              >
                Next
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
              <Button
                onClick={handleSubmit}
                disabled={createMutation.isPending}
                className="bg-teal-600 hover:bg-teal-700 text-white"
              >
                {createMutation.isPending ? "Creating..." : "Create Proposal"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: ProposalStatus }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.draft;
  const Icon = cfg.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border", cfg.color)}>
      <Icon className="size-3" />
      {cfg.label}
    </span>
  );
}

function EngagementBadge({ score }: { score: number }) {
  if (score === 0) return null;
  const { label, className } = score >= 80
    ? { label: "Hot", className: "bg-red-500/20 text-red-400 border-red-500/30" }
    : score >= 40
    ? { label: "Warm", className: "bg-amber-500/20 text-amber-400 border-amber-500/30" }
    : { label: "Cold", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" };
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${className}`}
      title={`Engagement score: ${score}/100`}
    >
      <span className="size-1.5 rounded-full bg-current opacity-80" />
      {label} {score}
    </span>
  );
}

// ── Main list page ────────────────────────────────────────────────────────────
export default function Proposals() {
  const [, navigate] = useLocation();
  const searchStr = useSearch();
  const { current } = useWorkspace();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>(() => {
    const params = new URLSearchParams(searchStr);
    const ef = params.get("expiryFilter");
    if (ef === "expired") return "expired_cohort";
    if (ef === "accepted") return "accepted_cohort";
    if (ef === "active") return "active_cohort";
    return "all";
  });
  const [expiryWindow, setExpiryWindow] = useState<number | null>(() => {
    const params = new URLSearchParams(searchStr);
    const w = params.get("window");
    return w ? parseInt(w) : null;
  });
  const [extMgmtOpen, setExtMgmtOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkExpiryOpen, setBulkExpiryOpen] = useState(false);
  const [bulkExpiryDate, setBulkExpiryDate] = useState("");
  const [sortBy, setSortBy] = useState<"none" | "expires_asc" | "expires_desc">("none");

  const { data: list, isLoading, refetch } = trpc.proposals.list.useQuery(undefined, {
    enabled: !!current,
  });
  const bulkSetExpiryMutation = trpc.proposals.bulkSetExpiry.useMutation({
    onSuccess: (data) => {
      toast.success(`Expiry date updated for ${data.updated} proposal${data.updated === 1 ? "" : "s"}`);
      setSelectedIds(new Set());
      setBulkExpiryOpen(false);
      setBulkExpiryDate("");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const { data: extensionPending, refetch: refetchPending } = trpc.proposals.listExtensionPending.useQuery(
    undefined,
    { enabled: !!current },
  );
  const approveExtMutation = trpc.proposals.approveExtension.useMutation({
    onSuccess: () => { toast.success("Extension approved"); refetch(); refetchPending(); },
    onError: (e) => toast.error(e.message),
  });
  const denyExtMutation = trpc.proposals.denyExtension.useMutation({
    onSuccess: () => { toast.success("Extension declined"); refetch(); refetchPending(); },
    onError: (e) => toast.error(e.message),
  });
  const [approveDialogState, setApproveDialogState] = useState<{ proposalId: number; newDate: string; note: string } | null>(null);
  const [denyDialogState, setDenyDialogState] = useState<{ proposalId: number; reason: string } | null>(null);
  function formatPendingSince(requestedAt: Date): { label: string; isOverdue: boolean } {
    const diffMs = Date.now() - new Date(requestedAt).getTime();
    const diffH = Math.floor(diffMs / (1000 * 60 * 60));
    const diffD = Math.floor(diffH / 24);
    const isOverdue = diffH >= 48;
    const label = diffD >= 1 ? `${diffD}d ago` : `${diffH}h ago`;
    return { label, isOverdue };
  }
  function toggleSelect(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleSelectAll() {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((p) => p.id)));
    }
  }

  const filtered = useMemo(() => {
    if (!list) return [];
    const result = list.filter((p) => {
      const matchSearch =
        !search ||
        p.title.toLowerCase().includes(search.toLowerCase()) ||
        p.clientName.toLowerCase().includes(search.toLowerCase());
      const now = Date.now();
      const windowMs = expiryWindow ? expiryWindow * 24 * 60 * 60 * 1000 : null;
      const windowStart = windowMs ? now - windowMs : null;
      const matchStatus =
        statusFilter === "all"
          ? true
          : statusFilter === "stale"
          ? !!(p as any).isStale
          : statusFilter === "expiring_soon"
          ? !!(p as any).isExpiringSoon
          : statusFilter === "expired_cohort"
          ? (p as any).expiresAt &&
            new Date((p as any).expiresAt).getTime() < now &&
            p.status !== "accepted" &&
            (!windowStart || (p.createdAt && new Date(p.createdAt).getTime() >= windowStart))
          : statusFilter === "accepted_cohort"
          ? p.status === "accepted" &&
            (!windowStart || (p.createdAt && new Date(p.createdAt).getTime() >= windowStart))
          : statusFilter === "active_cohort"
          ? (p as any).expiresAt &&
            new Date((p as any).expiresAt).getTime() >= now &&
            p.status !== "accepted" &&
            (!windowStart || (p.createdAt && new Date(p.createdAt).getTime() >= windowStart))
          : p.status === statusFilter;
      return matchSearch && matchStatus;
    });
    if (sortBy === "expires_asc") {
      result.sort((a, b) => {
        const aT = (a as any).expiresAt ? new Date((a as any).expiresAt).getTime() : Infinity;
        const bT = (b as any).expiresAt ? new Date((b as any).expiresAt).getTime() : Infinity;
        return aT - bT;
      });
    } else if (sortBy === "expires_desc") {
      result.sort((a, b) => {
        const aT = (a as any).expiresAt ? new Date((a as any).expiresAt).getTime() : -Infinity;
        const bT = (b as any).expiresAt ? new Date((b as any).expiresAt).getTime() : -Infinity;
        return bT - aT;
      });
    }
    return result;
  }, [list, search, statusFilter, sortBy, expiryWindow]);

  // Summary counts
  const counts = useMemo(() => {
    if (!list) return { total: 0, accepted: 0, pending: 0, drafts: 0 };
    return {
      total: list.length,
      accepted: list.filter((p) => p.status === "accepted").length,
      pending: list.filter((p) => ["sent", "under_review"].includes(p.status)).length,
      drafts: list.filter((p) => p.status === "draft").length,
    };
  }, [list]);

  function handleCreated(id: number) {
    refetch();
    navigate(`/proposals/${id}`);
  }

  return (
    <Shell title="Proposals">
    <div className="flex flex-col h-full">
      <PageHeader title="Proposals" description="Create, send, and track proposals with versioning and e-signature." pageKey="proposals"
        icon={<ClipboardList className="size-5" />}
      >
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={toggleSelectAll}
            className="gap-1.5 text-xs"
          >
            <Checkbox
              checked={filtered.length > 0 && selectedIds.size === filtered.length}
              className="size-3.5 pointer-events-none"
            />
            {selectedIds.size === filtered.length && filtered.length > 0 ? "Deselect All" : "Select All"}
          </Button>
          <Button
            onClick={() => setWizardOpen(true)}
            className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5"
          >
            <Plus className="size-4" />
            New Proposal
          </Button>
        </div>
      </PageHeader>
      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-6 py-2.5 bg-teal-500/10 border-b border-teal-500/30 shrink-0">
          <span className="text-sm font-medium text-teal-600">{selectedIds.size} selected</span>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-xs border-teal-500/40 text-teal-300 hover:bg-teal-500/10"
            onClick={() => setBulkExpiryOpen(true)}
          >
            <Timer className="size-3.5" />
            Set Expiry Date
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-xs text-muted-foreground"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </Button>
        </div>
      )}
      {/* Extension Requests alert bar */}
      {extensionPending && extensionPending.length > 0 && (
        <div className="flex items-center gap-3 px-6 py-2 bg-orange-500/10 border-b border-orange-500/30 shrink-0">
          <CalendarCheck className="size-4 text-orange-400 shrink-0" />
          <span className="text-sm text-orange-300 flex-1">
            <strong>{extensionPending.length}</strong> pending extension request{extensionPending.length === 1 ? "" : "s"}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-xs border-orange-500/40 text-orange-300 hover:bg-orange-500/10"
            onClick={() => setExtMgmtOpen(true)}
          >
            <UserCheck className="size-3.5" />
            Review Requests
          </Button>
        </div>
      )}

      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-4 px-6 py-4 border-b border-border shrink-0">
        {[
          { label: "Total", value: counts.total, color: "text-foreground" },
          { label: "Accepted", value: counts.accepted, color: "text-emerald-600" },
          { label: "Pending Review", value: counts.pending, color: "text-amber-600" },
          { label: "Drafts", value: counts.drafts, color: "text-slate-600" },
        ].map((s) => (
          <div key={s.label} className="bg-card rounded-lg border border-border p-3 text-center">
            <div className={cn("text-2xl font-bold", s.color)}>{s.value}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-2 px-6 py-3 border-b border-border shrink-0">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search by title or client..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setStatusFilter("all")}
            className={cn(
              "px-3 py-1 rounded-full text-xs font-medium border transition-all",
              statusFilter === "all"
                ? "bg-teal-500/20 text-teal-400 border-teal-500/40"
                : "border-border text-muted-foreground hover:border-teal-500/30 hover:text-foreground",
            )}
          >
            All{list ? ` (${list.length})` : ""}
          </button>
          {Object.entries(STATUS_CONFIG).map(([k, v]) => {
            const Icon = v.icon;
            const count = list?.filter((p) => p.status === k).length ?? 0;
            if (count === 0 && statusFilter !== k) return null;
            return (
              <button
                key={k}
                onClick={() => setStatusFilter(statusFilter === k ? "all" : k)}
                className={cn(
                  "inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium border transition-all",
                  statusFilter === k
                    ? cn(v.color, "ring-1 ring-current")
                    : "border-border text-muted-foreground hover:border-teal-500/30 hover:text-foreground",
                )}
              >
                <Icon className="size-3" />
                {v.label} ({count})
              </button>
            );
          })}
          {/* Stale chip */}
          {(() => {
            const staleCount = list?.filter((p) => !!(p as any).isStale).length ?? 0;
            if (staleCount === 0 && statusFilter !== "stale") return null;
            return (
              <button
                onClick={() => setStatusFilter(statusFilter === "stale" ? "all" : "stale")}
                className={cn(
                  "inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium border transition-all",
                  statusFilter === "stale"
                    ? "bg-amber-500/15 text-amber-400 border-amber-500/40 ring-1 ring-amber-400"
                    : "border-border text-muted-foreground hover:border-amber-500/30 hover:text-foreground",
                )}
              >
                <AlertTriangle className="size-3" />
                Stale ({staleCount})
              </button>
            );
          })()}
          {/* Expiring Soon chip */}
          {(() => {
            const expiringCount = list?.filter((p) => !!(p as any).isExpiringSoon).length ?? 0;
            if (expiringCount === 0 && statusFilter !== "expiring_soon") return null;
            return (
              <button
                onClick={() => setStatusFilter(statusFilter === "expiring_soon" ? "all" : "expiring_soon")}
                className={cn(
                  "inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium border transition-all",
                  statusFilter === "expiring_soon"
                    ? "bg-orange-500/15 text-orange-400 border-orange-500/40 ring-1 ring-orange-400"
                    : "border-border text-muted-foreground hover:border-orange-500/30 hover:text-foreground",
                )}
              >
                <Timer className="size-3" />
                Expiring Soon ({expiringCount})
              </button>
            );
          })()}
          {/* Expires sort button */}
          <button
            onClick={() => setSortBy(s => s === "expires_asc" ? "expires_desc" : s === "expires_desc" ? "none" : "expires_asc")}
            className={cn(
              "inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium border transition-all ml-auto",
              sortBy !== "none"
                ? "bg-teal-500/15 text-teal-400 border-teal-500/40 ring-1 ring-teal-400"
                : "border-border text-muted-foreground hover:border-teal-500/30 hover:text-foreground",
            )}
          >
            {sortBy === "expires_asc" ? <ArrowUp className="size-3" /> : sortBy === "expires_desc" ? <ArrowDown className="size-3" /> : <ArrowUpDown className="size-3" />}
            Expires
          </button>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <ClipboardList className="size-12 text-muted-foreground/30 mb-3" />
            <p className="text-muted-foreground font-medium">
              {list?.length === 0 ? "No proposals yet" : "No proposals match your filters"}
            </p>
            {list?.length === 0 && (
              <Button
                onClick={() => setWizardOpen(true)}
                variant="outline"
                className="mt-3 gap-1.5"
              >
                <Plus className="size-4" />
                Create your first proposal
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((p) => (
              <div
                key={p.id}
                className={cn(
                  "w-full text-left bg-card border rounded-lg px-4 py-3 hover:border-teal-500/50 hover:bg-card/80 transition-all group flex items-start gap-2",
                  selectedIds.has(p.id) ? "border-teal-500/60 bg-teal-500/5" : "border-border",
                )}
              >
                <div
                  className="mt-1 shrink-0"
                  onClick={(e) => toggleSelect(p.id, e)}
                >
                  <Checkbox
                    checked={selectedIds.has(p.id)}
                    className="size-4"
                  />
                </div>
                <button
                  className="flex-1 min-w-0 text-left"
                  onClick={() => navigate(`/proposals/${p.id}`)}
                >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-foreground truncate">{p.title}</span>
                      <StatusBadge status={p.status as ProposalStatus} />
                      {(p as any).engagementScore > 0 && (
                        <EngagementBadge score={(p as any).engagementScore} />
                      )}
                      {(p as any).isStale && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30">
                          <AlertTriangle className="size-3" />
                          Stale
                        </span>
                      )}
                      {(p as any).isExpired && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/15 text-red-400 border border-red-500/30">
                          <Timer className="size-3" />
                          Expired
                        </span>
                      )}
                      {!(p as any).isExpired && (p as any).isExpiringSoon && (p as any).expiresAt && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-500/15 text-orange-400 border border-orange-500/30">
                          <Timer className="size-3" />
                          {(() => {
                            const daysLeft = Math.ceil((new Date((p as any).expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                            return daysLeft <= 1 ? "Expires today" : `Expires in ${daysLeft}d`;
                          })()}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Building2 className="size-3" />
                        {p.clientName}
                        {p.orgAbbr && ` (${p.orgAbbr})`}
                      </span>
                      {p.projectType && (
                        <span className="flex items-center gap-1">
                          <FileText className="size-3" />
                          {p.projectType}
                        </span>
                      )}
                      {p.budget && (
                        <span className="flex items-center gap-1">
                          <DollarSign className="size-3" />
                          ${Number(p.budget).toLocaleString()}
                        </span>
                      )}
                      {p.rfpDeadline && (
                        <span className="flex items-center gap-1">
                          <Calendar className="size-3" />
                          Due {new Date(p.rfpDeadline).toLocaleDateString()}
                        </span>
                      )}
                      {(p as any).expiresAt && (
                        <span className={cn("flex items-center gap-1", (p as any).isExpired ? "text-red-500" : (p as any).isExpiringSoon ? "text-orange-500" : "")}>
                          <Timer className="size-3" />
                          Expires {new Date((p as any).expiresAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground">
                      {new Date(p.updatedAt).toLocaleDateString()}
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground group-hover:text-teal-400 transition-colors" />
                  </div>
                </div>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bulk Expiry Date Dialog */}
      <Dialog open={bulkExpiryOpen} onOpenChange={setBulkExpiryOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Timer className="size-4 text-teal-600" />
              Set Expiry Date
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Setting an expiry date on <strong>{selectedIds.size}</strong> proposal{selectedIds.size === 1 ? "" : "s"}.
              Proposals will be automatically marked as <em>Not Accepted</em> once this date passes.
            </p>
            <div>
              <Label>Expiry Date</Label>
              <Input
                type="date"
                value={bulkExpiryDate}
                onChange={(e) => setBulkExpiryDate(e.target.value)}
                className="mt-1"
                min={new Date().toISOString().slice(0, 10)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Leave blank and click "Clear Expiry" to remove the expiry date from all selected proposals.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setBulkExpiryOpen(false)}>Cancel</Button>
            <Button
              variant="outline"
              onClick={() => bulkSetExpiryMutation.mutate({ ids: Array.from(selectedIds), expiresAt: null })}
              disabled={bulkSetExpiryMutation.isPending}
              className="text-muted-foreground"
            >
              Clear Expiry
            </Button>
            <Button
              onClick={() => bulkSetExpiryMutation.mutate({ ids: Array.from(selectedIds), expiresAt: bulkExpiryDate || null })}
              disabled={!bulkExpiryDate || bulkSetExpiryMutation.isPending}
              className="bg-teal-600 hover:bg-teal-700 text-white"
            >
              {bulkSetExpiryMutation.isPending ? "Saving..." : "Set Date"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Extension Management Dialog */}
      <Dialog open={extMgmtOpen} onOpenChange={setExtMgmtOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarCheck className="size-5 text-orange-600" />
              Pending Extension Requests
            </DialogTitle>
          </DialogHeader>
          {!extensionPending || extensionPending.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No pending extension requests.</p>
          ) : (
            <div className="space-y-3 py-2">
              {extensionPending.map((req) => (
                <div key={req.id} className="border border-border rounded-lg p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">{req.title}</p>
                      <p className="text-xs text-muted-foreground">{req.clientName} · {req.clientEmail}</p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1 text-xs border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
                        onClick={() => setApproveDialogState({ proposalId: req.id, newDate: req.expiresAt ? new Date(new Date(req.expiresAt).getTime() + 7 * 86400000).toISOString().slice(0, 10) : "", note: "" })}
                      >
                        <ThumbsUp className="size-3" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1 text-xs border-red-500/40 text-red-400 hover:bg-red-500/10"
                        onClick={() => setDenyDialogState({ proposalId: req.id, reason: "" })}
                      >
                        <ThumbsDown className="size-3" />
                        Decline
                      </Button>
                    </div>
                  </div>
                  {req.reason && (
                    <p className="text-xs text-muted-foreground bg-muted/30 rounded p-2 leading-relaxed">{req.reason}</p>
                  )}
                  <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
                    {req.expiresAt && <span>Current expiry: {new Date(req.expiresAt).toLocaleDateString()}</span>}
                    {(() => {
                      const { label, isOverdue } = formatPendingSince(req.requestedAt);
                      return isOverdue ? (
                        <span className="inline-flex items-center gap-1 text-amber-500 font-medium">
                          <AlertCircle className="size-3" />
                          Overdue — pending {label}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="size-3" />
                          Pending {label}
                        </span>
                      );
                    })()}
                  </div>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setExtMgmtOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Approve Extension Dialog */}
      <Dialog open={!!approveDialogState} onOpenChange={(o) => !o && setApproveDialogState(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ThumbsUp className="size-4 text-emerald-600" />
              Approve Extension
            </DialogTitle>
          </DialogHeader>
          {approveDialogState && (
            <div className="space-y-3 py-2">
              <div>
                <Label>New Expiry Date</Label>
                <Input
                  type="date"
                  value={approveDialogState.newDate}
                  onChange={(e) => setApproveDialogState({ ...approveDialogState, newDate: e.target.value })}
                  className="mt-1"
                  min={new Date().toISOString().slice(0, 10)}
                />
              </div>
              <div>
                <Label>Note to client (optional)</Label>
                <Textarea
                  value={approveDialogState.note}
                  onChange={(e) => setApproveDialogState({ ...approveDialogState, note: e.target.value })}
                  placeholder="We've extended your proposal deadline..."
                  className="mt-1 text-sm"
                  rows={3}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproveDialogState(null)}>Cancel</Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              disabled={!approveDialogState?.newDate || approveExtMutation.isPending}
              onClick={() => {
                if (!approveDialogState) return;
                approveExtMutation.mutate(
                  { proposalId: approveDialogState.proposalId, newExpiresAt: approveDialogState.newDate, note: approveDialogState.note || undefined },
                  { onSuccess: () => { setApproveDialogState(null); setExtMgmtOpen(false); } },
                );
              }}
            >
              {approveExtMutation.isPending ? "Approving..." : "Approve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Decline Extension Dialog */}
      <Dialog open={!!denyDialogState} onOpenChange={(o) => !o && setDenyDialogState(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ThumbsDown className="size-4 text-red-600" />
              Decline Extension
            </DialogTitle>
          </DialogHeader>
          {denyDialogState && (
            <div className="space-y-3 py-2">
              <div>
                <Label>Reason (optional)</Label>
                <Textarea
                  value={denyDialogState.reason}
                  onChange={(e) => setDenyDialogState({ ...denyDialogState, reason: e.target.value })}
                  placeholder="Unfortunately, we cannot extend this proposal..."
                  className="mt-1 text-sm"
                  rows={3}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDenyDialogState(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={denyExtMutation.isPending}
              onClick={() => {
                if (!denyDialogState) return;
                denyExtMutation.mutate(
                  { proposalId: denyDialogState.proposalId, reason: denyDialogState.reason || undefined },
                  { onSuccess: () => { setDenyDialogState(null); setExtMgmtOpen(false); } },
                );
              }}
            >
              {denyExtMutation.isPending ? "Declining..." : "Decline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <NewProposalWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={handleCreated}
      />
    </div>
    </Shell>
  );
}
