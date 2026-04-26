import { useState, useMemo } from "react";
import { useLocation, useParams, Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  ArrowLeft,
  CalendarCheck,
  ClipboardList,
  Building2,
  Calendar,
  DollarSign,
  FileText,
  Clock,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Eye,
  Sparkles,
  Save,
  Plus,
  Trash2,
  Link2,
  Copy,
  Check,
  MessageSquare,
  Edit2,
  Files,
  Send,
  Globe,
  Mail,
  History,
  TrendingUp,
  User,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Unlink,
  ExternalLink,
  RefreshCw,
  MousePointerClick,
  AlertCircle,
  Timer,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
} from "recharts";
import { Shell } from "@/components/usip/Shell";

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

const SECTION_KEYS = [
  { key: "executive_summary", label: "Executive Summary" },
  { key: "firm_overview", label: "Firm Overview" },
  { key: "our_approach", label: "Our Approach" },
  { key: "timeline_narrative", label: "Timeline Narrative" },
  { key: "pricing", label: "Pricing" },
  { key: "case_studies", label: "Case Studies" },
  { key: "references", label: "References" },
  { key: "terms", label: "Terms & Conditions" },
];

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

// ── Overview Tab ─────────────────────────────────────────────────────────────
function OverviewTab({ proposal, onRefetch }: { proposal: any; onRefetch: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    title: proposal.title,
    clientName: proposal.clientName,
    clientEmail: proposal.clientEmail ?? "",
    clientWebsite: proposal.clientWebsite ?? "",
    orgAbbr: proposal.orgAbbr ?? "",
    projectType: proposal.projectType ?? "",
    rfpDeadline: proposal.rfpDeadline ? new Date(proposal.rfpDeadline).toISOString().slice(0, 10) : "",
    completionDate: proposal.completionDate ? new Date(proposal.completionDate).toISOString().slice(0, 10) : "",
    expiresAt: proposal.expiresAt ? new Date(proposal.expiresAt).toISOString().slice(0, 10) : "",
    skipAutoExtend: proposal.skipAutoExtend ?? false,
    budget: proposal.budget ? String(proposal.budget) : "",
    description: proposal.description ?? "",
  });

  const updateMutation = trpc.proposals.update.useMutation({
    onSuccess: () => { toast.success("Proposal updated"); setEditing(false); onRefetch(); },
    onError: (e) => toast.error(e.message),
  });

  const updateStatusMutation = trpc.proposals.updateStatus.useMutation({
    onSuccess: () => { toast.success("Status updated"); onRefetch(); },
    onError: (e) => toast.error(e.message),
  });

  if (editing) {
    return (
      <div className="space-y-4 max-w-2xl">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold">Edit Proposal Details</h3>
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
        <div>
          <Label>Title</Label>
          <Input value={form.title} onChange={(e) => setForm(f => ({ ...f, title: e.target.value }))} className="mt-1" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Client Name</Label>
            <Input value={form.clientName} onChange={(e) => setForm(f => ({ ...f, clientName: e.target.value }))} className="mt-1" />
          </div>
          <div>
            <Label>Org Abbreviation</Label>
            <Input value={form.orgAbbr} maxLength={32} onChange={(e) => setForm(f => ({ ...f, orgAbbr: e.target.value }))} className="mt-1" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Client Email</Label>
            <Input type="email" value={form.clientEmail} onChange={(e) => setForm(f => ({ ...f, clientEmail: e.target.value }))} className="mt-1" />
          </div>
          <div>
            <Label>Client Website</Label>
            <Input value={form.clientWebsite} onChange={(e) => setForm(f => ({ ...f, clientWebsite: e.target.value }))} className="mt-1" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>RFP Deadline</Label>
            <Input type="date" value={form.rfpDeadline} onChange={(e) => setForm(f => ({ ...f, rfpDeadline: e.target.value }))} className="mt-1" />
          </div>
          <div>
            <Label>Completion Date</Label>
            <Input type="date" value={form.completionDate} onChange={(e) => setForm(f => ({ ...f, completionDate: e.target.value }))} className="mt-1" />
          </div>
        </div>
        <div>
          <Label>Proposal Expiry Date <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
          <Input type="date" value={form.expiresAt} onChange={(e) => setForm(f => ({ ...f, expiresAt: e.target.value }))} className="mt-1" />
          <p className="text-xs text-muted-foreground mt-1">Auto-marks as Not Accepted when this date passes.</p>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <input
            type="checkbox"
            id="skipAutoExtend"
            checked={form.skipAutoExtend}
            onChange={(e) => setForm(f => ({ ...f, skipAutoExtend: e.target.checked }))}
            className="size-4 rounded border-border accent-teal-500 cursor-pointer"
          />
          <label htmlFor="skipAutoExtend" className="text-sm text-foreground cursor-pointer select-none">
            Skip auto-extend for this proposal
          </label>
          <span className="text-xs text-muted-foreground">(overrides workspace setting)</span>
        </div>
        <div>
          <Label>Budget ($)</Label>
          <Input type="number" value={form.budget} onChange={(e) => setForm(f => ({ ...f, budget: e.target.value }))} className="mt-1" />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} className="mt-1 min-h-[80px]" />
        </div>
        <Button
          onClick={() => updateMutation.mutate({ id: proposal.id, ...form, budget: form.budget ? parseFloat(form.budget) : null, rfpDeadline: form.rfpDeadline || null, completionDate: form.completionDate || null, expiresAt: form.expiresAt || null, skipAutoExtend: form.skipAutoExtend })}
          disabled={updateMutation.isPending}
          className="bg-teal-600 hover:bg-teal-700 text-white"
        >
          <Save className="size-4 mr-1.5" />
          {updateMutation.isPending ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">{proposal.title}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Created {new Date(proposal.createdAt).toLocaleDateString()}
            {" · "}Updated {new Date(proposal.updatedAt).toLocaleDateString()}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="gap-1.5">
          <Edit2 className="size-3.5" />
          Edit
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <InfoCard label="Client" value={`${proposal.clientName}${proposal.orgAbbr ? ` (${proposal.orgAbbr})` : ""}`} icon={Building2} />
        {proposal.clientEmail && (
          <InfoCard label="Client Email" value={proposal.clientEmail} icon={Mail} href={`mailto:${proposal.clientEmail}`} />
        )}
        {proposal.clientWebsite && (
          <InfoCard
            label="Client Website"
            value={proposal.clientWebsite.replace(/^https?:\/\//, "")}
            icon={Globe}
            href={proposal.clientWebsite.startsWith("http") ? proposal.clientWebsite : `https://${proposal.clientWebsite}`}
          />
        )}
        {proposal.projectType && <InfoCard label="Project Type" value={proposal.projectType} icon={FileText} />}
        {proposal.budget && (
          <InfoCard
            label={proposal.linkedOpportunityId ? "Budget (synced to pipeline)" : "Budget"}
            value={`$${Number(proposal.budget).toLocaleString()}`}
            icon={DollarSign}
          />
        )}
        {proposal.rfpDeadline && <InfoCard label="RFP Deadline" value={new Date(proposal.rfpDeadline).toLocaleDateString()} icon={Calendar} />}
        {proposal.completionDate && <InfoCard label="Completion Date" value={new Date(proposal.completionDate).toLocaleDateString()} icon={Calendar} />}
        {proposal.sentAt && (
          <InfoCard label="Sent to Client" value={new Date(proposal.sentAt).toLocaleString()} icon={Send} />
        )}
        {proposal.emailOpenedAt && (
          <InfoCard label="Email First Opened" value={new Date(proposal.emailOpenedAt).toLocaleString()} icon={Mail} />
        )}
        {proposal.emailClickedAt && (
          <InfoCard label="Link First Clicked" value={new Date(proposal.emailClickedAt).toLocaleString()} icon={MousePointerClick} />
        )}
        {proposal.expiresAt && (() => {
          const expDate = new Date(proposal.expiresAt);
          const now = Date.now();
          const msLeft = expDate.getTime() - now;
          const isExpired = msLeft < 0;
          const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
          const label = isExpired
            ? "Expired"
            : daysLeft <= 1
            ? "Expires today"
            : `Expires in ${daysLeft}d`;
          return (
            <div className={`bg-muted/40 rounded-lg p-3 border ${isExpired ? "border-red-500/40" : daysLeft <= 7 ? "border-orange-500/40" : "border-border"}`}>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
                <Timer className="size-3" />
                Proposal Expiry
              </div>
              <div className={`text-sm font-medium ${isExpired ? "text-red-400" : daysLeft <= 7 ? "text-orange-400" : "text-foreground"}`}>
                {expDate.toLocaleDateString()}
                <span className="ml-2 text-xs font-normal opacity-80">({label})</span>
              </div>
            </div>
          );
        })()}
      </div>
      {proposal.skipAutoExtend && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/40 border border-border rounded-lg px-3 py-2">
          <AlertTriangle className="size-3.5 text-amber-400 shrink-0" />
          Auto-extend is <span className="font-medium text-amber-400">disabled</span> for this proposal (workspace rule overridden).
        </div>
      )}
      {/* ── Pipeline Integration Panel ── */}
      <PipelinePanel proposal={proposal} onRefetch={onRefetch} />
      {proposal.description && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">Description</p>
          <p className="text-sm text-foreground leading-relaxed">{proposal.description}</p>
        </div>
      )}

      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Update Status</p>
        <div className="flex flex-wrap gap-2">
          {Object.entries(STATUS_CONFIG).map(([k, v]) => {
            const Icon = v.icon;
            const isActive = proposal.status === k;
            return (
              <button
                key={k}
                onClick={() => !isActive && updateStatusMutation.mutate({ id: proposal.id, status: k as ProposalStatus })}
                disabled={isActive || updateStatusMutation.isPending}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-all",
                  isActive ? cn(v.color, "ring-2 ring-offset-1 ring-current") : "border-border text-muted-foreground hover:border-teal-500/50 hover:text-foreground",
                )}
              >
                <Icon className="size-3" />
                {v.label}
              </button>
            );
          })}
        </div>
      </div>
      {/* ── Activity Feed ── */}
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Activity</p>
        <ActivityFeed proposalId={proposal.id} />
      </div>
    </div>
  );
}

function InfoCard({
  label,
  value,
  icon: Icon,
  href,
}: {
  label: string;
  value: string;
  icon: any;
  href?: string;
}) {
  return (
    <div className="bg-muted/40 rounded-lg p-3 border border-border">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
        <Icon className="size-3" />
        {label}
      </div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-teal-400 hover:text-teal-300 hover:underline truncate block"
        >
          {value}
        </a>
      ) : (
        <div className="text-sm font-medium text-foreground">{value}</div>
      )}
    </div>
  );
}

// ── Content Tab ───────────────────────────────────────────────────────────────
function ContentTab({ proposal, sections, onRefetch }: { proposal: any; sections: any[]; onRefetch: () => void }) {
  const [activeSection, setActiveSection] = useState(SECTION_KEYS[0].key);
  const [editContent, setEditContent] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const sectionMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const s of sections) m[s.sectionKey] = s.content;
    return m;
  }, [sections]);

  const currentContent = editContent ?? sectionMap[activeSection] ?? "";

  const saveRevision = trpc.proposals.saveRevision.useMutation();
  const updateSection = trpc.proposals.updateSection.useMutation({
    onSuccess: () => {
      toast.success("Section saved");
      onRefetch();
      // Snapshot revision after save
      if (editContent !== null) {
        saveRevision.mutate({ proposalId: proposal.id, sectionKey: activeSection, content: editContent });
      }
      setEditContent(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const generateContent = trpc.proposals.generateSectionContent.useMutation({
    onSuccess: (data) => { setEditContent(data.content); setGenerating(false); },
    onError: (e) => { toast.error(e.message); setGenerating(false); },
  });

  function handleGenerate() {
    setGenerating(true);
    generateContent.mutate({
      proposalId: proposal.id,
      sectionKey: activeSection,
      context: {
        clientName: proposal.clientName,
        orgAbbr: proposal.orgAbbr ?? undefined,
        projectType: proposal.projectType ?? undefined,
        description: proposal.description ?? undefined,
        budget: proposal.budget ? Number(proposal.budget) : undefined,
      },
    });
  }

  function handleSave() {
    if (editContent === null) return;
    updateSection.mutate({ proposalId: proposal.id, sectionKey: activeSection, content: editContent });
  }

  return (
    <div className="flex gap-4 h-full">
      {/* Section nav */}
      <div className="w-44 shrink-0 space-y-0.5">
        {SECTION_KEYS.map((s) => {
          const hasContent = !!sectionMap[s.key];
          return (
            <button
              key={s.key}
              onClick={() => { setActiveSection(s.key); setEditContent(null); }}
              className={cn(
                "w-full text-left px-3 py-2 rounded-lg text-sm transition-all flex items-center justify-between gap-1",
                activeSection === s.key
                  ? "bg-teal-500/15 text-teal-400 font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              )}
            >
              <span className="truncate">{s.label}</span>
              {hasContent && <div className="size-1.5 rounded-full bg-teal-500 shrink-0" />}
            </button>
          );
        })}
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col gap-3 min-w-0">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-foreground">
            {SECTION_KEYS.find((s) => s.key === activeSection)?.label}
          </h3>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleGenerate}
              disabled={generating}
              className="gap-1.5 text-purple-400 border-purple-500/30 hover:bg-purple-500/10"
            >
              <Sparkles className="size-3.5" />
              {generating ? "Generating..." : "AI Generate"}
            </Button>
            {editContent !== null && (
              <Button
                size="sm"
                onClick={handleSave}
                disabled={updateSection.isPending}
                className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5"
              >
                <Save className="size-3.5" />
                {updateSection.isPending ? "Saving..." : "Save"}
              </Button>
            )}
          </div>
        </div>
        <Textarea
          value={currentContent}
          onChange={(e) => setEditContent(e.target.value)}
          placeholder={`Write the ${SECTION_KEYS.find((s) => s.key === activeSection)?.label} section here, or use AI Generate to create a draft...`}
          className="flex-1 min-h-[400px] resize-none font-mono text-sm"
        />
        {editContent !== null && editContent !== (sectionMap[activeSection] ?? "") && (
          <p className="text-xs text-amber-400">Unsaved changes</p>
        )}
      </div>
    </div>
  );
}

// ── Timeline Tab ──────────────────────────────────────────────────────────────
function TimelineTab({ proposal, milestones, onRefetch }: { proposal: any; milestones: any[]; onRefetch: () => void }) {
  const [addOpen, setAddOpen] = useState(false);
  const [editMilestone, setEditMilestone] = useState<any | null>(null);
  const [form, setForm] = useState({ name: "", milestoneDate: "", description: "", owner: "lsi_media" as const });

  const upsert = trpc.proposals.upsertMilestone.useMutation({
    onSuccess: () => { toast.success("Milestone saved"); onRefetch(); setAddOpen(false); setEditMilestone(null); resetForm(); },
    onError: (e) => toast.error(e.message),
  });

  const deleteMilestone = trpc.proposals.deleteMilestone.useMutation({
    onSuccess: () => { toast.success("Milestone deleted"); onRefetch(); },
    onError: (e) => toast.error(e.message),
  });

  function resetForm() {
    setForm({ name: "", milestoneDate: "", description: "", owner: "lsi_media" });
  }

  function openEdit(m: any) {
    setEditMilestone(m);
    setForm({
      name: m.name,
      milestoneDate: m.milestoneDate ? new Date(m.milestoneDate).toISOString().slice(0, 10) : "",
      description: m.description ?? "",
      owner: m.owner,
    });
    setAddOpen(true);
  }

  function handleSubmit() {
    upsert.mutate({
      proposalId: proposal.id,
      id: editMilestone?.id,
      name: form.name,
      milestoneDate: form.milestoneDate || undefined,
      description: form.description || undefined,
      owner: form.owner,
      sortOrder: editMilestone?.sortOrder ?? milestones.length,
    });
  }

  const ownerColors = { lsi_media: "bg-teal-500/15 text-teal-400", client: "bg-blue-500/15 text-blue-400", both: "bg-purple-500/15 text-purple-400" };
  const ownerLabels = { lsi_media: "LSI Media", client: "Client", both: "Both" };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Project Milestones</h3>
        <Button
          size="sm"
          onClick={() => { resetForm(); setEditMilestone(null); setAddOpen(true); }}
          className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5"
        >
          <Plus className="size-3.5" />
          Add Milestone
        </Button>
      </div>

      {milestones.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Calendar className="size-10 mx-auto mb-3 opacity-30" />
          <p>No milestones yet. Add your first milestone to build the project timeline.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {milestones.map((m, idx) => (
            <div key={m.id} className="flex items-start gap-3 bg-card border border-border rounded-lg px-4 py-3">
              <div className="flex flex-col items-center gap-1 shrink-0">
                <div className="size-7 rounded-full bg-teal-500/20 text-teal-400 flex items-center justify-center text-xs font-bold">
                  {idx + 1}
                </div>
                {idx < milestones.length - 1 && <div className="w-px h-4 bg-border" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-medium text-sm">{m.name}</span>
                  <span className={cn("text-xs px-1.5 py-0.5 rounded-full", ownerColors[m.owner as keyof typeof ownerColors])}>
                    {ownerLabels[m.owner as keyof typeof ownerLabels]}
                  </span>
                </div>
                {m.milestoneDate && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Calendar className="size-3" />
                    {new Date(m.milestoneDate).toLocaleDateString()}
                  </p>
                )}
                {m.description && <p className="text-xs text-muted-foreground mt-0.5">{m.description}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button variant="ghost" size="icon" className="size-7" onClick={() => openEdit(m)}>
                  <Edit2 className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-red-400 hover:text-red-300"
                  onClick={() => deleteMilestone.mutate({ proposalId: proposal.id, milestoneId: m.id })}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={(o) => { if (!o) { setAddOpen(false); setEditMilestone(null); resetForm(); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editMilestone ? "Edit Milestone" : "Add Milestone"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Milestone Name *</Label>
              <Input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} className="mt-1" placeholder="e.g. Kickoff Meeting" />
            </div>
            <div>
              <Label>Date</Label>
              <Input type="date" value={form.milestoneDate} onChange={(e) => setForm(f => ({ ...f, milestoneDate: e.target.value }))} className="mt-1" />
            </div>
            <div>
              <Label>Owner</Label>
              <Select value={form.owner} onValueChange={(v: any) => setForm(f => ({ ...f, owner: v }))}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="lsi_media">LSI Media</SelectItem>
                  <SelectItem value="client">Client</SelectItem>
                  <SelectItem value="both">Both</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Description</Label>
              <Textarea value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} className="mt-1" placeholder="Optional notes..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setAddOpen(false); setEditMilestone(null); resetForm(); }}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              disabled={!form.name.trim() || upsert.isPending}
              className="bg-teal-600 hover:bg-teal-700 text-white"
            >
              {upsert.isPending ? "Saving..." : editMilestone ? "Update" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Feedback Tab ──────────────────────────────────────────────────────────────
function FeedbackTab({ feedback }: { feedback: any[] }) {
  return (
    <div className="space-y-4">
      <h3 className="font-semibold">Client Feedback</h3>
      {feedback.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <MessageSquare className="size-10 mx-auto mb-3 opacity-30" />
          <p>No feedback received yet. Share the proposal link with your client to collect feedback.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {feedback.map((f) => (
            <div key={f.id} className="bg-card border border-border rounded-lg px-4 py-3">
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <div className="size-7 rounded-full bg-teal-500/20 text-teal-400 flex items-center justify-center text-xs font-bold">
                    {f.authorName.slice(0, 1).toUpperCase()}
                  </div>
                  <div>
                    <span className="text-sm font-medium">{f.authorName}</span>
                    {f.authorEmail && <span className="text-xs text-muted-foreground ml-1.5">{f.authorEmail}</span>}
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(f.createdAt).toLocaleDateString()}
                </span>
              </div>
              <p className="text-sm text-foreground leading-relaxed">{f.message}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Share Tab ─────────────────────────────────────────────────────────────────
function ShareTab({ proposal, onRefetch }: { proposal: any; onRefetch: () => void }) {
  const [copied, setCopied] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [personalMessage, setPersonalMessage] = useState("");

  const generateLink = trpc.proposals.generateShareLink.useMutation({
    onSuccess: () => { toast.success("Share link generated"); onRefetch(); },
    onError: (e) => toast.error(e.message),
  });

  const sendToClient = trpc.proposals.sendToClient.useMutation({
    onSuccess: (data) => {
      if (data.emailSent) {
        toast.success(data.deliveryNote ?? `Email sent to ${proposal.clientEmail}`);
      } else {
        toast.info(data.deliveryNote ?? "Proposal marked as sent.");
      }
      setSendDialogOpen(false);
      setPersonalMessage("");
      onRefetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const shareUrl = proposal.shareToken
    ? `${window.location.origin}/p/${proposal.shareToken}`
    : null;

  function handleCopy() {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleSendToClient() {
    sendToClient.mutate({
      id: proposal.id,
      origin: window.location.origin,
      message: personalMessage || undefined,
      sendingAccountId: selectedAccountId !== "auto" ? (selectedAccountId as number) : undefined,
    });
  }

  const hasClientEmail = !!proposal.clientEmail;
  const previewHtml = [
    '<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827;background:#fff">',
    '<div style="margin-bottom:16px"><span style="font-size:12px;font-weight:600;color:#14b8a6;text-transform:uppercase">LSI Media</span></div>',
    '<h2 style="margin:0 0 8px;font-size:18px;font-weight:700">You have a new proposal to review</h2>',
    `<p style="margin:0 0 12px;color:#6b7280">Hi ${proposal.clientName},</p>`,
    `<p style="margin:0 0 12px;color:#374151">A proposal has been shared: <strong>${proposal.title}</strong>.</p>`,
    personalMessage ? `<p style="padding:10px 14px;background:#f9fafb;border-left:3px solid #14b8a6;border-radius:4px;font-style:italic;color:#374151">${personalMessage}</p>` : "",
    `<p style="margin:16px 0"><a href="${shareUrl ?? "#"}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">View Proposal</a></p>`,
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">',
    '<p style="color:#9ca3af;font-size:11px">You can view the proposal without creating an account.</p>',
    '</div>',
  ].join("");

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className="font-semibold mb-1">Client Portal Link</h3>
        <p className="text-sm text-muted-foreground">
          Share this link with your client. They can view the proposal and submit feedback without needing an account.
        </p>
      </div>

      {shareUrl ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Input value={shareUrl} readOnly className="font-mono text-xs" />
            <Button
              variant="outline"
              size="icon"
              onClick={handleCopy}
              className={cn(copied && "text-emerald-400 border-emerald-500/30")}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => setSendDialogOpen(true)}
              disabled={!hasClientEmail}
              className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5"
              title={hasClientEmail ? undefined : "Add a client email in the Overview tab first"}
            >
              <Send className="size-3.5" />
              Send to Client
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => generateLink.mutate({ id: proposal.id })}
              disabled={generateLink.isPending}
              className="gap-1.5 text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
            >
              <RotateCcw className="size-3.5" />
              Regenerate Link
            </Button>
          </div>
          {!hasClientEmail && (
            <p className="text-xs text-amber-400">
              Add a client email address in the Overview tab to enable "Send to Client".
            </p>
          )}
          {proposal.sentAt && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
              Last sent {new Date(proposal.sentAt).toLocaleString()}
              {proposal.clientEmail && (
                <span className="text-muted-foreground/60">to {proposal.clientEmail}</span>
              )}
              <button
                type="button"
                onClick={() => setSendDialogOpen(true)}
                disabled={!hasClientEmail}
                className="ml-1 text-teal-400 hover:text-teal-300 underline underline-offset-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Resend
              </button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Regenerating the link will invalidate the old one.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <Button
            onClick={() => generateLink.mutate({ id: proposal.id })}
            disabled={generateLink.isPending}
            className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5"
          >
            <Link2 className="size-4" />
            {generateLink.isPending ? "Generating..." : "Generate Share Link"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Generate a link first, then you can send it directly to the client.
          </p>
        </div>
      )}

      <div className="bg-muted/40 rounded-lg border border-border p-4 text-sm space-y-2">
        <p className="font-medium text-foreground">What the client sees:</p>
        <ul className="text-muted-foreground space-y-1 text-xs">
          <li>• Proposal title, client info, and project details</li>
          <li>• All content sections (Executive Summary, Approach, Pricing, etc.)</li>
          <li>• Project timeline milestones</li>
          <li>• A feedback form to submit questions or comments</li>
        </ul>
      </div>

      {/* Send to Client dialog */}
      <Dialog open={sendDialogOpen} onOpenChange={(open) => { setSendDialogOpen(open); if (!open) { setPersonalMessage(""); setSelectedAccountId("auto"); setShowPreview(false); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Send Proposal to Client</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Recipient */}
            <div className="bg-muted/40 rounded-lg p-3 border border-border text-sm">
              <p className="text-muted-foreground text-xs mb-1">Sending to</p>
              <p className="font-medium">{proposal.clientName}</p>
              <p className="text-teal-400 text-xs">{proposal.clientEmail}</p>
            </div>
            {/* Sending account picker */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1.5 block">Send from</Label>
              <Select
                value={String(selectedAccountId)}
                onValueChange={(v) => setSelectedAccountId(v === "auto" ? "auto" : Number(v))}
              >
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {sendingAccounts && sendingAccounts.length > 0
                      ? `Auto (${sendingAccounts[0].fromEmail})`
                      : "Auto (workspace default)"}
                  </SelectItem>
                  {sendingAccounts?.map((acc) => (
                    <SelectItem key={acc.id} value={String(acc.id)}>
                      {acc.name} — {acc.fromEmail}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(!sendingAccounts || sendingAccounts.length === 0) && (
                <p className="text-xs text-amber-400 mt-1">
                  No connected accounts found. Connect one in My Mailbox or configure SMTP in Settings.
                </p>
              )}
            </div>
            {/* Personal message */}
            <div>
              <Label>Personal message (optional)</Label>
              <Textarea
                value={personalMessage}
                onChange={(e) => setPersonalMessage(e.target.value)}
                className="mt-1 min-h-[80px]"
                placeholder="Add a personal note to include in the email..."
              />
            </div>
            {/* Email preview toggle */}
            <div>
              <button
                type="button"
                className="flex items-center gap-1.5 text-xs text-teal-400 hover:text-teal-300 transition-colors"
                onClick={() => setShowPreview(!showPreview)}
              >
                <Eye className="size-3.5" />
                {showPreview ? "Hide preview" : "Preview email"}
              </button>
              {showPreview && (
                <div className="mt-2 border border-border rounded-lg overflow-hidden max-h-64 overflow-y-auto">
                  <iframe
                    srcDoc={previewHtml}
                    className="w-full"
                    style={{ height: "240px", border: "none" }}
                    title="Email preview"
                  />
                </div>
              )}
            </div>
            {/* Info */}
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-300">
              <p className="font-medium mb-1">This will also:</p>
              <ul className="space-y-0.5 text-blue-300/80">
                <li>• Mark the proposal status as <strong>Sent</strong></li>
                <li>• Send an email with the portal link to the client</li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setSendDialogOpen(false); setPersonalMessage(""); setSelectedAccountId("auto"); setShowPreview(false); }}>
              Cancel
            </Button>
            <Button
              onClick={handleSendToClient}
              disabled={sendToClient.isPending}
              className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5"
            >
              <Send className="size-3.5" />
              {sendToClient.isPending ? "Sending..." : "Send Proposal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Main detail page ──────────────────────────────────────────────────────────
function EngagementScoreBadge({ score }: { score: number }) {
  const { label, className } = score >= 80
    ? { label: "Hot", className: "bg-red-500/20 text-red-400 border-red-500/30" }
    : score >= 40
    ? { label: "Warm", className: "bg-amber-500/20 text-amber-400 border-amber-500/30" }
    : { label: "Cold", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${className}`}
      title={`Engagement score: ${score}/100`}
    >
      <span className="size-2 rounded-full bg-current opacity-80" />
      {label} · {score}/100
    </span>
  );
}


// ── Score Sparkline ───────────────────────────────────────────────────────────
function ScoreSparkline({ proposalId }: { proposalId: number }) {
  const { current } = useWorkspace();
  const { data: history } = trpc.proposals.getScoreHistory.useQuery(
    { proposalId },
    { enabled: !!current && proposalId > 0 },
  );
  const snapshotMutation = trpc.proposals.snapshotScore.useMutation();

  // Auto-snapshot once per day (if no entry today)
  const today = new Date().toDateString();
  const lastEntry = history?.[0];
  const lastEntryDate = lastEntry ? new Date(lastEntry.createdAt).toDateString() : null;
  if (history !== undefined && lastEntryDate !== today) {
    // Only trigger once per render cycle
    if (!snapshotMutation.isPending && !snapshotMutation.isSuccess) {
      snapshotMutation.mutate({ proposalId });
    }
  }

  if (!history || history.length < 2) return null;

  // Reverse to chronological order for the chart
  const chartData = [...history].reverse().map((h, i) => ({
    day: i + 1,
    score: h.score,
    date: new Date(h.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
  }));

  return (
    <div className="flex items-center gap-1.5" title="Engagement score trend (last 30 days)">
      <span className="text-xs text-muted-foreground hidden sm:block">Trend</span>
      <div className="w-20 h-6">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
            <Line
              type="monotone"
              dataKey="score"
              stroke="#14b8a6"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <RechartsTooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as { date: string; score: number };
                return (
                  <div className="bg-popover border border-border rounded px-2 py-1 text-xs shadow-md">
                    <span className="text-muted-foreground">{d.date}</span>
                    <span className="ml-2 font-semibold text-teal-400">{d.score}/100</span>
                  </div>
                );
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
export default function ProposalDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { current } = useWorkspace();
  const proposalId = parseInt(params.id ?? "0", 10);

  const { data, isLoading, refetch } = trpc.proposals.get.useQuery(
    { id: proposalId },
    { enabled: !!current && proposalId > 0 },
  );

  const duplicateMutation = trpc.proposals.duplicate.useMutation({
    onSuccess: (result) => {
      toast.success("Proposal duplicated");
      navigate(`/proposals/${result.id}`);
    },
    onError: (e) => toast.error(e.message),
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center p-6">
        <ClipboardList className="size-12 text-muted-foreground/30 mb-3" />
        <p className="text-muted-foreground">Proposal not found</p>
        <Button variant="outline" className="mt-3" onClick={() => navigate("/proposals")}>
          Back to Proposals
        </Button>
      </div>
    );
  }

  const { proposal, sections, milestones, feedback } = data;

  return (
    <Shell title="Proposal">
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/proposals")}
          className="size-8"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold truncate">{proposal.title}</h1>
            <StatusBadge status={proposal.status as ProposalStatus} />
            {(proposal as any).engagementScore > 0 && (
              <EngagementScoreBadge score={(proposal as any).engagementScore} />
            )}
            {(proposal as any).extensionCount > 0 && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-full px-2 py-0.5"
                title={`${(proposal as any).extensionCount} approved extension${(proposal as any).extensionCount === 1 ? "" : "s"}`}
              >
                <CalendarCheck className="size-3" />
                {(proposal as any).extensionCount === 1 ? "1 Extension" : `${(proposal as any).extensionCount} Extensions`}
              </span>
            )}
          </div>
          <ScoreSparkline proposalId={proposal.id} />
          <p className="text-xs text-muted-foreground mt-0.5">
            {proposal.clientName}
            {proposal.orgAbbr && ` · ${proposal.orgAbbr}`}
            {proposal.projectType && ` · ${proposal.projectType}`}
          </p>
        </div>
        {/* Header actions */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => duplicateMutation.mutate({ id: proposal.id })}
          disabled={duplicateMutation.isPending}
          className="gap-1.5 shrink-0"
          title="Duplicate this proposal as a new draft"
        >
          <Files className="size-3.5" />
          {duplicateMutation.isPending ? "Duplicating..." : "Duplicate"}
        </Button>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
        <TabsList className="px-6 border-b border-border rounded-none bg-transparent justify-start h-auto pb-0 gap-0 shrink-0">
          {[
            { value: "overview", label: "Overview" },
            { value: "content", label: "Content" },
            { value: "timeline", label: "Timeline" },
            { value: "feedback", label: `Feedback${feedback.length > 0 ? ` (${feedback.length})` : ""}` },
            { value: "history", label: "History" },
            { value: "share", label: "Share" },
          ].map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-teal-500 data-[state=active]:text-teal-400 data-[state=active]:bg-transparent px-4 py-2.5 text-sm"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="flex-1 overflow-y-auto p-6">
          <TabsContent value="overview" className="mt-0">
            <OverviewTab proposal={proposal} onRefetch={refetch} />
          </TabsContent>
          <TabsContent value="content" className="mt-0 h-full">
            <ContentTab proposal={proposal} sections={sections} onRefetch={refetch} />
          </TabsContent>
          <TabsContent value="timeline" className="mt-0">
            <TimelineTab proposal={proposal} milestones={milestones} onRefetch={refetch} />
          </TabsContent>
          <TabsContent value="feedback" className="mt-0">
            <FeedbackTab feedback={feedback} />
          </TabsContent>
          <TabsContent value="history" className="mt-0">
            <HistoryTab proposalId={proposal.id} />
          </TabsContent>
          <TabsContent value="share" className="mt-0">
            <ShareTab proposal={proposal} onRefetch={refetch} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
    </Shell>
  );
}

// ── Pipeline Panel (in OverviewTab) ──────────────────────────────────────────
function PipelinePanel({ proposal, onRefetch }: { proposal: any; onRefetch: () => void }) {
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [search, setSearch] = useState("");
  const utils = trpc.useUtils();
  const { data: opportunities } = trpc.opportunities.list.useQuery(undefined, { enabled: linkDialogOpen });
  const linkOpp = trpc.proposals.linkOpportunity.useMutation({
    onSuccess: () => {
      toast.success("Opportunity linked");
      utils.proposals.get.invalidate({ id: proposal.id });
      onRefetch();
      setLinkDialogOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });
  const unlinkOpp = trpc.proposals.linkOpportunity.useMutation({
    onSuccess: () => {
      toast.success("Opportunity unlinked");
      utils.proposals.get.invalidate({ id: proposal.id });
      onRefetch();
    },
    onError: (e) => toast.error(e.message),
  });
  const createAndLink = trpc.proposals.acceptProposal.useMutation({
    onSuccess: (data) => {
      if (data.opportunityId) {
        toast.success(`Pipeline opportunity created and linked (#${data.opportunityId})`);
        utils.proposals.get.invalidate({ id: proposal.id });
        onRefetch();
      }
    },
    onError: (e) => toast.error(e.message),
  });
  const filtered = (opportunities ?? []).filter((o: any) =>
    !search || o.name.toLowerCase().includes(search.toLowerCase())
  );
  const hasLinked = !!proposal.linkedOpportunityId;
  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="size-4 text-teal-400" />
          <span className="text-sm font-medium">Pipeline Integration</span>
        </div>
        {hasLinked && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground gap-1 h-6 px-2"
            onClick={() => unlinkOpp.mutate({ proposalId: proposal.id, opportunityId: null })}
            disabled={unlinkOpp.isPending}
          >
            <Unlink className="size-3" />
            Unlink
          </Button>
        )}
      </div>
      {hasLinked ? (
        <div className="flex items-center gap-3 bg-teal-500/10 border border-teal-500/20 rounded-lg p-3">
          <div className="size-8 rounded-full bg-teal-500/20 flex items-center justify-center shrink-0">
            <TrendingUp className="size-4 text-teal-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Opportunity #{proposal.linkedOpportunityId}</p>
            <p className="text-xs text-muted-foreground">Linked pipeline deal</p>
          </div>
          <a
            href="/pipeline"
            className="inline-flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300 transition-colors"
          >
            <ExternalLink className="size-3" />
            View
          </a>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            No pipeline deal linked. Link an existing opportunity or create a new one.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => setLinkDialogOpen(true)}
            >
              <Link2 className="size-3.5" />
              Link Existing
            </Button>
            {proposal.accountId && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 text-xs text-teal-400 border-teal-500/30 hover:bg-teal-500/10"
                onClick={() => createAndLink.mutate({ id: proposal.id })}
                disabled={createAndLink.isPending}
              >
                <Plus className="size-3.5" />
                {createAndLink.isPending ? "Creating..." : "Create & Link"}
              </Button>
            )}
          </div>
        </div>
      )}
      {/* Link Opportunity Dialog */}
      <Dialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Link Pipeline Opportunity</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Search opportunities..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="text-sm"
            />
            <div className="space-y-1 max-h-60 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">No opportunities found</p>
              ) : (
                filtered.map((opp: any) => (
                  <button
                    key={opp.id}
                    className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/40 text-left transition-colors"
                    onClick={() => linkOpp.mutate({ proposalId: proposal.id, opportunityId: opp.id })}
                    disabled={linkOpp.isPending}
                  >
                    <div className="size-7 rounded-full bg-teal-500/15 flex items-center justify-center shrink-0">
                      <TrendingUp className="size-3.5 text-teal-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{opp.name}</p>
                      <p className="text-xs text-muted-foreground capitalize">{opp.stage} · ${Number(opp.value).toLocaleString()}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setLinkDialogOpen(false)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Activity Feed ────────────────────────────────────────────────────────────
function ActivityFeed({ proposalId }: { proposalId: number }) {
  const { workspaceId } = useWorkspace();
  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [approveOpen, setApproveOpen] = useState(false);
  const [denyOpen, setDenyOpen] = useState(false);
  const [approveDate, setApproveDate] = useState("");
  const [approveNote, setApproveNote] = useState("");
  const [denyReason, setDenyReason] = useState("");
  const utils = trpc.useUtils();
  const approveMutation = trpc.proposals.approveExtension.useMutation({
    onSuccess: () => {
      toast.success("Extension approved — client notified");
      setApproveOpen(false);
      setApproveDate("");
      setApproveNote("");
      utils.proposals.listActivity.invalidate({ proposalId });
      utils.proposals.get.invalidate({ id: proposalId });
    },
    onError: (e) => toast.error(e.message),
  });
  const denyMutation = trpc.proposals.denyExtension.useMutation({
    onSuccess: () => {
      toast.success("Extension request declined");
      setDenyOpen(false);
      setDenyReason("");
      utils.proposals.listActivity.invalidate({ proposalId });
    },
    onError: (e) => toast.error(e.message),
  });
  const { data: events, isLoading } = trpc.proposals.listActivity.useQuery(
    { proposalId },
    { enabled: !!workspaceId },
  );
  const ACTIVITY_ICONS: Record<string, any> = {
    system: Clock,
    email: Send,
    note: MessageSquare,
    call: User,
    meeting: Calendar,
    stage_change: TrendingUp,
  };
  function getIcon(type: string, subject: string) {
    const s = subject.toLowerCase();
    if (s.includes("opened the proposal email")) return Mail;
    if (s.includes("clicked the proposal link")) return MousePointerClick;
    if (s.includes("sent")) return Send;
    if (s.includes("accepted")) return CheckCircle2;
    if (s.includes("created")) return Plus;
    if (s.includes("updated")) return Edit2;
    if (s.includes("status")) return RotateCcw;
    if (s.includes("restored")) return History;
    if (s.includes("revision")) return AlertCircle;
    if (s.includes("opportunity") || s.includes("pipeline") || s.includes("deal")) return TrendingUp;
    if (type === "note") return MessageSquare;
    if (type === "email") return Send;
    return ACTIVITY_ICONS[type] ?? Clock;
  }
  function getIconColor(type: string, subject: string) {
    const s = subject.toLowerCase();
    if (s.includes("accepted")) return "text-emerald-400";
    if (s.includes("opened") || s.includes("clicked")) return "text-blue-400";
    if (s.includes("revision") || s.includes("not_accepted")) return "text-amber-400";
    if (s.includes("opportunity") || s.includes("pipeline")) return "text-purple-400";
    if (type === "note") return "text-sky-400";
    return "text-teal-400";
  }
  function isPipelineEvent(subject: string) {
    const s = subject.toLowerCase();
    return s.includes("opportunity") || s.includes("pipeline") || s.includes("deal");
  }
  const FILTER_CHIPS = [
    { key: "all", label: "All" },
    { key: "views", label: "Views" },
    { key: "email", label: "Email" },
    { key: "note", label: "Notes" },
    { key: "system", label: "System" },
    { key: "stage_change", label: "Stage" },
  ];
  const isViewEvent = (ev: any) => {
    const s = (ev.subject ?? "").toLowerCase();
    return s.includes("opened the proposal email") || s.includes("clicked the proposal link");
  };
  const filtered = events
    ? activeFilter === "all"
      ? events
      : activeFilter === "views"
      ? events.filter(isViewEvent)
      : events.filter((ev: any) => ev.type === activeFilter)
    : [];
  if (isLoading) return (
    <div className="space-y-2">
      {[1,2,3].map(i => <Skeleton key={i} className="h-12 rounded-lg" />)}
    </div>
  );
  if (!events || events.length === 0) return (
    <div className="text-center py-6 text-muted-foreground text-sm">
      <Clock className="size-8 mx-auto mb-2 opacity-30" />
      <p>No activity recorded yet.</p>
      <p className="text-xs mt-1">Events like sends, status changes, and edits will appear here.</p>
    </div>
  );
  return (
    <div className="space-y-3">
      {/* Filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {FILTER_CHIPS.map(chip => {
          const count = chip.key === "all"
            ? events.length
            : chip.key === "views"
            ? events.filter(isViewEvent).length
            : events.filter((ev: any) => ev.type === chip.key).length;
          if (chip.key !== "all" && count === 0) return null;
          return (
            <button
              key={chip.key}
              onClick={() => setActiveFilter(chip.key)}
              className={cn(
                "inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border transition-all",
                activeFilter === chip.key
                  ? "bg-teal-500/20 border-teal-500/50 text-teal-300"
                  : "border-border text-muted-foreground hover:border-teal-500/30 hover:text-foreground",
              )}
            >
              {chip.label}
              <span className="opacity-60">{count}</span>
            </button>
          );
        })}
      </div>
      {filtered.length === 0 ? (
        <div className="text-center py-4 text-muted-foreground text-xs">
          No {activeFilter} events recorded.
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map((ev: any, idx: number) => {
            const Icon = getIcon(ev.type, ev.subject ?? "");
            const iconColor = getIconColor(ev.type, ev.subject ?? "");
            return (
              <div key={ev.id} className="flex gap-3 group">
                {/* Timeline spine */}
                <div className="flex flex-col items-center">
                  <div className="size-7 rounded-full bg-muted/60 border border-border flex items-center justify-center shrink-0 mt-0.5">
                    <Icon className={cn("size-3.5", iconColor)} />
                  </div>
                  {idx < filtered.length - 1 && (
                    <div className="w-px flex-1 bg-border mt-1 mb-1 min-h-[12px]" />
                  )}
                </div>
                {/* Content */}
                <div className="pb-3 min-w-0 flex-1">
                  {isPipelineEvent(ev.subject ?? "") ? (
                    <Link href="/pipeline" className="text-sm text-teal-400 hover:text-teal-300 hover:underline underline-offset-2 leading-snug inline-flex items-center gap-1">
                      {ev.subject}
                      <ExternalLink className="size-3 shrink-0" />
                    </Link>
                  ) : (
                    <p className="text-sm text-foreground leading-snug">{ev.subject}</p>
                  )}
                  {ev.body && (
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{ev.body}</p>
                  )}
                  {(ev.subject ?? "").toLowerCase().includes("extension requested") && (
                    <div className="flex gap-2 mt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1.5 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10"
                        onClick={() => setApproveOpen(true)}
                      >
                        <CheckCircle2 className="size-3" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1.5 border-red-500/40 text-red-400 hover:bg-red-500/10"
                        onClick={() => setDenyOpen(true)}
                      >
                        <XCircle className="size-3" />
                        Decline
                      </Button>
                    </div>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-muted-foreground/70">
                      {new Date(ev.occurredAt).toLocaleString()}
                    </span>
                    {ev.actorName && ev.actorName !== "System" && (
                      <>
                        <span className="text-muted-foreground/40 text-xs">·</span>
                        <span className="text-xs text-muted-foreground/70">{ev.actorName}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    {/* Approve Extension Dialog */}
    <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Approve Extension Request</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label>New Expiry Date</Label>
            <Input type="date" value={approveDate} onChange={(e) => setApproveDate(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>Note to Client <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
            <Textarea
              value={approveNote}
              onChange={(e) => setApproveNote(e.target.value)}
              placeholder="e.g. We have extended the deadline to accommodate your review timeline."
              className="mt-1 min-h-[70px]"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setApproveOpen(false)}>Cancel</Button>
          <Button
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
            disabled={!approveDate || approveMutation.isPending}
            onClick={() => approveMutation.mutate({ proposalId, newExpiresAt: approveDate, note: approveNote || undefined })}
          >
            {approveMutation.isPending ? "Approving..." : "Approve & Notify Client"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {/* Deny Extension Dialog */}
    <Dialog open={denyOpen} onOpenChange={setDenyOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Decline Extension Request</DialogTitle>
        </DialogHeader>
        <div className="py-2">
          <Label>Reason <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
          <Textarea
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
            placeholder="e.g. The proposal terms are time-sensitive and cannot be extended."
            className="mt-1 min-h-[70px]"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDenyOpen(false)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={denyMutation.isPending}
            onClick={() => denyMutation.mutate({ proposalId, reason: denyReason || undefined })}
          >
            {denyMutation.isPending ? "Declining..." : "Decline & Notify Client"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </div>
  );
}
// ── History Tab ───────────────────────────────────────────────────────────────
const SECTION_LABELS: Record<string, string> = {
  executive_summary: "Executive Summary",
  problem_statement: "Problem Statement",
  proposed_solution: "Proposed Solution",
  scope_of_work: "Scope of Work",
  pricing: "Pricing",
  why_us: "Why Us",
};

function ExpandedRevision({ rev, proposalId, onRestored }: { rev: any; proposalId: number; onRestored: () => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const utils = trpc.useUtils();
  const restore = trpc.proposals.restoreRevision.useMutation({
    onSuccess: (data) => {
      toast.success(`Section "${data.sectionKey.replace(/_/g, " ")}" restored`);
      utils.proposals.get.invalidate({ id: proposalId });
      utils.proposals.listRevisions.invalidate({ proposalId });
      setConfirmOpen(false);
      onRestored();
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <>
      <div className="border-t border-border bg-muted/20 p-3 space-y-2">
        <pre className="text-xs text-foreground whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">
          {rev.content || <span className="text-muted-foreground italic">(empty)</span>}
        </pre>
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-amber-400 border-amber-500/30 hover:bg-amber-500/10 text-xs h-7"
            onClick={() => setConfirmOpen(true)}
          >
            <RotateCcw className="size-3" />
            Restore this version
          </Button>
        </div>
      </div>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-400" />
              Restore Revision?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will overwrite the current content of the <strong>{rev.sectionKey.replace(/_/g, " ")}</strong> section
            with this version from <strong>{new Date(rev.createdAt).toLocaleString()}</strong>.
            A new revision will be saved to preserve the restore point.
          </p>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              onClick={() => restore.mutate({ revisionId: rev.id })}
              disabled={restore.isPending}
              className="bg-amber-600 hover:bg-amber-700 text-white gap-1.5"
            >
              <RotateCcw className="size-3.5" />
              {restore.isPending ? "Restoring..." : "Restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function HistoryTab({ proposalId }: { proposalId: number }) {
  const { data: revisions, isLoading, refetch } = trpc.proposals.listRevisions.useQuery({ proposalId });
  const [expanded, setExpanded] = useState<number | null>(null);
  function onRestored() { refetch(); }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (!revisions || revisions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="size-12 rounded-full bg-muted/40 flex items-center justify-center mb-3">
          <History className="size-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">No revision history yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Revisions are saved automatically each time you save a content section.
        </p>
      </div>
    );
  }

  // Group by sectionKey for display
  const grouped: Record<string, typeof revisions> = {};
  for (const r of revisions) {
    if (!grouped[r.sectionKey]) grouped[r.sectionKey] = [];
    grouped[r.sectionKey].push(r);
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h3 className="font-semibold mb-0.5">Revision History</h3>
        <p className="text-sm text-muted-foreground">
          Every time a content section is saved, a snapshot is recorded here. Click any entry to view its content.
        </p>
      </div>
      <div className="space-y-2">
        {revisions.map((rev) => (
          <div
            key={rev.id}
            className="border border-border rounded-lg overflow-hidden"
          >
            <button
              className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/30 transition-colors"
              onClick={() => setExpanded(expanded === rev.id ? null : rev.id)}
            >
              <div className="size-7 rounded-full bg-teal-500/15 flex items-center justify-center shrink-0">
                <FileText className="size-3.5 text-teal-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">
                    {SECTION_LABELS[rev.sectionKey] ?? rev.sectionKey}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {new Date(rev.createdAt).toLocaleString()}
                  </span>
                </div>
                {rev.savedByName && (
                  <div className="flex items-center gap-1 mt-0.5">
                    <User className="size-3 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">{rev.savedByName}</span>
                  </div>
                )}
              </div>
              {expanded === rev.id ? (
                <ChevronDown className="size-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronRight className="size-4 text-muted-foreground shrink-0" />
              )}
            </button>
            {expanded === rev.id && (
              <ExpandedRevision rev={rev} proposalId={proposalId} onRestored={onRestored} />
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Showing {revisions.length} revision{revisions.length !== 1 ? "s" : ""} across {Object.keys(grouped).length} section{Object.keys(grouped).length !== 1 ? "s" : ""}.
      </p>
    </div>
  );
}
