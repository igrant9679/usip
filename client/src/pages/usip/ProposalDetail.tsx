import { useState, useMemo } from "react";
import { useLocation, useParams } from "wouter";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
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
          <Label>Budget ($)</Label>
          <Input type="number" value={form.budget} onChange={(e) => setForm(f => ({ ...f, budget: e.target.value }))} className="mt-1" />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea value={form.description} onChange={(e) => setForm(f => ({ ...f, description: e.target.value }))} className="mt-1 min-h-[80px]" />
        </div>
        <Button
          onClick={() => updateMutation.mutate({ id: proposal.id, ...form, budget: form.budget ? parseFloat(form.budget) : null, rfpDeadline: form.rfpDeadline || null, completionDate: form.completionDate || null })}
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
        {proposal.budget && <InfoCard label="Budget" value={`$${Number(proposal.budget).toLocaleString()}`} icon={DollarSign} />}
        {proposal.rfpDeadline && <InfoCard label="RFP Deadline" value={new Date(proposal.rfpDeadline).toLocaleDateString()} icon={Calendar} />}
        {proposal.completionDate && <InfoCard label="Completion Date" value={new Date(proposal.completionDate).toLocaleDateString()} icon={Calendar} />}
      </div>

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

  const updateSection = trpc.proposals.updateSection.useMutation({
    onSuccess: () => { toast.success("Section saved"); onRefetch(); setEditContent(null); },
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
        toast.success("Proposal sent to client via email");
      } else {
        toast.success("Proposal marked as sent. Email delivery requires SMTP configuration in Settings → Email Delivery.");
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
    });
  }

  const hasClientEmail = !!proposal.clientEmail;

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
      <Dialog open={sendDialogOpen} onOpenChange={setSendDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send Proposal to Client</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-muted/40 rounded-lg p-3 border border-border text-sm">
              <p className="text-muted-foreground text-xs mb-1">Sending to</p>
              <p className="font-medium">{proposal.clientName}</p>
              <p className="text-teal-400 text-xs">{proposal.clientEmail}</p>
            </div>
            <div>
              <Label>Personal message (optional)</Label>
              <Textarea
                value={personalMessage}
                onChange={(e) => setPersonalMessage(e.target.value)}
                className="mt-1 min-h-[100px]"
                placeholder="Add a personal note to include in the email..."
              />
            </div>
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3 text-xs text-blue-300">
              <p className="font-medium mb-1">This will also:</p>
              <ul className="space-y-0.5 text-blue-300/80">
                <li>• Mark the proposal status as <strong>Sent</strong></li>
                <li>• Send an email with the portal link to the client</li>
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setSendDialogOpen(false); setPersonalMessage(""); }}>
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
          </div>
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
          <TabsContent value="share" className="mt-0">
            <ShareTab proposal={proposal} onRefetch={refetch} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
    </Shell>
  );
}
