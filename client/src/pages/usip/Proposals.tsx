import { Shell } from "@/components/usip/Shell";
import { useState, useMemo, useEffect } from "react";
import { useLocation } from "wouter";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

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
    setForm({ title: "", clientName: "", clientEmail: "", clientWebsite: "", orgAbbr: "", projectType: "", rfpDeadline: "", completionDate: "", budget: "", description: "" });
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
      budget: form.budget ? parseFloat(form.budget) : undefined,
      description: form.description || undefined,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="size-5 text-teal-400" />
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

// ── Status badge ──────────────────────────────────────────────────────────────
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

// ── Main list page ────────────────────────────────────────────────────────────
export default function Proposals() {
  const [, navigate] = useLocation();
  const { current } = useWorkspace();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data: list, isLoading, refetch } = trpc.proposals.list.useQuery(undefined, {
    enabled: !!current,
  });

  const filtered = useMemo(() => {
    if (!list) return [];
    return list.filter((p) => {
      const matchSearch =
        !search ||
        p.title.toLowerCase().includes(search.toLowerCase()) ||
        p.clientName.toLowerCase().includes(search.toLowerCase());
      const matchStatus = statusFilter === "all" || p.status === statusFilter;
      return matchSearch && matchStatus;
    });
  }, [list, search, statusFilter]);

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
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <ClipboardList className="size-5 text-teal-400" />
            Proposals
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Create, manage, and track client proposals
          </p>
        </div>
        <Button
          onClick={() => setWizardOpen(true)}
          className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5"
        >
          <Plus className="size-4" />
          New Proposal
        </Button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-4 px-6 py-4 border-b border-border shrink-0">
        {[
          { label: "Total", value: counts.total, color: "text-foreground" },
          { label: "Accepted", value: counts.accepted, color: "text-emerald-400" },
          { label: "Pending Review", value: counts.pending, color: "text-amber-400" },
          { label: "Drafts", value: counts.drafts, color: "text-slate-400" },
        ].map((s) => (
          <div key={s.label} className="bg-card rounded-lg border border-border p-3 text-center">
            <div className={cn("text-2xl font-bold", s.color)}>{s.value}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border shrink-0">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search proposals..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {Object.entries(STATUS_CONFIG).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
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
              <button
                key={p.id}
                onClick={() => navigate(`/proposals/${p.id}`)}
                className="w-full text-left bg-card border border-border rounded-lg px-4 py-3 hover:border-teal-500/50 hover:bg-card/80 transition-all group"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-foreground truncate">{p.title}</span>
                      <StatusBadge status={p.status as ProposalStatus} />
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
            ))}
          </div>
        )}
      </div>

      <NewProposalWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={handleCreated}
      />
    </div>
    </Shell>
  );
}
