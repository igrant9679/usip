import { useState } from "react";
import { Shell, PageHeader } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sparkles,
  CheckCircle,
  XCircle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Loader2,
  Star,
  Users,
  BarChart2,
  Mail,
  Play,
  ThumbsUp,
  Megaphone,
  GitBranch,
  Layers,
  Link2,
} from "lucide-react";
import { EntityPicker } from "@/components/usip/EntityPicker";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

type Preset = "more_formal" | "shorter" | "stronger_cta" | "different_angle";

const PRESET_LABELS: Record<Preset, string> = {
  more_formal: "More Formal",
  shorter: "Shorter",
  stronger_cta: "Stronger CTA",
  different_angle: "Different Angle",
};

const TONE_LABELS: Record<string, string> = {
  formal: "Formal",
  casual: "Casual",
  value_prop: "Value Prop",
};

const TONE_COLORS: Record<string, string> = {
  formal: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  casual: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  value_prop: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
};

function ResearchAccordion({ job }: { job: any }) {
  const [open, setOpen] = useState(false);
  if (!job) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1 text-xs text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Research Context
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 space-y-3 rounded-lg border bg-muted/30 p-3 text-xs">
          {job.orgResearch && (
            <div>
              <p className="font-semibold text-foreground mb-1">Org Research</p>
              <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">{job.orgResearch}</p>
            </div>
          )}
          {job.contactResearch && (
            <>
              <Separator />
              <div>
                <p className="font-semibold text-foreground mb-1">Contact Research</p>
                <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">{job.contactResearch}</p>
              </div>
            </>
          )}
          {job.fitAnalysis && (
            <>
              <Separator />
              <div>
                <p className="font-semibold text-foreground mb-1">Fit Analysis</p>
                <div className="space-y-1">
                  <p><span className="font-medium">Fit Score:</span> {(job.fitAnalysis as any).fit_score ?? "—"}/100</p>
                  {((job.fitAnalysis as any).pain_points ?? []).length > 0 && (
                    <div>
                      <p className="font-medium">Pain Points:</p>
                      <ul className="list-disc list-inside text-muted-foreground">
                        {((job.fitAnalysis as any).pain_points as string[]).map((p, i) => (
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {((job.fitAnalysis as any).personalization_hooks ?? []).length > 0 && (
                    <div>
                      <p className="font-medium">Personalization Hooks:</p>
                      <ul className="list-disc list-inside text-muted-foreground">
                        {((job.fitAnalysis as any).personalization_hooks as string[]).map((h, i) => (
                          <li key={i}>{h}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function DraftCard({ draft, onAction }: { draft: any; onAction: () => void }) {
  const [editMode, setEditMode] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [scoreData, setScoreData] = useState<any>(null);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [regenPreset, setRegenPreset] = useState<Preset>("more_formal");

  const utils = trpc.useUtils();
  const approve = trpc.aiPipeline.approveDraft.useMutation({
    onSuccess: () => { toast.success("Draft approved"); onAction(); },
    onError: (e) => toast.error(e.message),
  });
  const reject = trpc.aiPipeline.rejectDraft.useMutation({
    onSuccess: () => { toast.success("Draft rejected"); onAction(); },
    onError: (e) => toast.error(e.message),
  });
  const regen = trpc.aiPipeline.regenerateDraft.useMutation({
    onSuccess: (data) => {
      setSubject(data.subject);
      setBody(data.body);
      toast.success("Draft regenerated");
      onAction();
    },
    onError: (e) => toast.error(e.message),
  });
  const score = trpc.aiPipeline.scoreDraft.useMutation({
    onSuccess: (data) => { setScoreData(data); setScoreOpen(true); },
    onError: (e) => toast.error(e.message),
  });

  const tone = draft.tone as string;

  return (
    <Card className="border">
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {editMode ? (
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="text-sm font-medium"
                placeholder="Subject line"
              />
            ) : (
              <p className="text-sm font-semibold truncate">{subject}</p>
            )}
            <p className="text-xs text-muted-foreground mt-0.5">
              To: {draft.toEmail || `Contact #${draft.toContactId}`}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {tone && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${TONE_COLORS[tone] ?? "bg-muted text-muted-foreground"}`}>
                {TONE_LABELS[tone] ?? tone}
              </span>
            )}
          </div>
        </div>

        {/* Body */}
        {editMode ? (
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            className="text-sm resize-none"
          />
        ) : (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed line-clamp-4">
            {body}
          </p>
        )}

        {/* Research context accordion */}
        <ResearchAccordion job={draft.job} />

        {/* Score data */}
        {scoreOpen && scoreData && (
          <div className="rounded-lg border bg-muted/30 p-3 text-xs space-y-2">
            <div className="flex items-center gap-2">
              <Star className="h-3.5 w-3.5 text-yellow-500" />
              <span className="font-semibold">Effectiveness Score: {scoreData.score}/10</span>
            </div>
            {scoreData.strengths?.length > 0 && (
              <div>
                <p className="font-medium text-green-700 dark:text-green-400">Strengths:</p>
                <ul className="list-disc list-inside text-muted-foreground">
                  {scoreData.strengths.map((s: string, i: number) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            {scoreData.improvements?.length > 0 && (
              <div>
                <p className="font-medium text-orange-700 dark:text-orange-400">Improvements:</p>
                <ul className="list-disc list-inside text-muted-foreground">
                  {scoreData.improvements.map((s: string, i: number) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            {scoreData.alt_subjects?.length > 0 && (
              <div>
                <p className="font-medium">Alt Subject Lines:</p>
                <ul className="list-disc list-inside text-muted-foreground">
                  {scoreData.alt_subjects.map((s: string, i: number) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {editMode ? (
            <>
              <Button
                size="sm"
                onClick={() => approve.mutate({ draftId: draft.id, subject, body })}
                disabled={approve.isPending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {approve.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
                Save & Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditMode(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => approve.mutate({ draftId: draft.id })}
                disabled={approve.isPending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {approve.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => setEditMode(true)}>
                Edit & Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => reject.mutate({ draftId: draft.id })}
                disabled={reject.isPending}
                className="text-red-600 hover:text-red-700 border-red-200 hover:border-red-300"
              >
                {reject.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                Reject
              </Button>
              <div className="flex items-center gap-1 ml-auto">
                <Select value={regenPreset} onValueChange={(v) => setRegenPreset(v as Preset)}>
                  <SelectTrigger className="h-7 text-xs w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
                      <SelectItem key={p} value={p}>{PRESET_LABELS[p]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => regen.mutate({ draftId: draft.id, preset: regenPreset })}
                  disabled={regen.isPending}
                >
                  {regen.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Regen
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => score.mutate({ draftId: draft.id })}
                  disabled={score.isPending}
                  title="Score this draft"
                >
                  {score.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Star className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function AIPipelineQueue() {
  const [contactSearch, setContactSearch] = useState("");
  const [selectedContacts, setSelectedContacts] = useState<number[]>([]);
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [page, setPage] = useState(1);

  // CRM context selectors (shared EntityPicker)
  const [ctxSegments, setCtxSegments] = useState<number[]>([]);
  const [ctxSequences, setCtxSequences] = useState<number[]>([]);
  const [ctxCampaigns, setCtxCampaigns] = useState<number[]>([]);
  const [ctxOpen, setCtxOpen] = useState(false);

  const { data: contacts = [], isLoading: loadingContacts } = trpc.contacts.list.useQuery(
    contactSearch ? { search: contactSearch } : undefined,
    { enabled: true }
  );
  const { data: stats, isLoading: loadingStats, refetch: refetchStats } = trpc.aiPipeline.getQueueStats.useQuery(undefined, {
    refetchInterval: 10000,
  });
  const { data: drafts = [], isLoading: loadingDrafts, refetch: refetchDrafts } = trpc.aiPipeline.getDraftQueue.useQuery(
    { page, pageSize: 20 },
    { refetchInterval: 15000 }
  );
  const { data: jobs = [], isLoading: loadingJobs, refetch: refetchJobs } = trpc.aiPipeline.getJobs.useQuery(
    { limit: 10 },
    { refetchInterval: 10000 }
  );

  const runForContact = trpc.aiPipeline.runForContact.useMutation({
    onSuccess: () => {
      toast.success("Pipeline started! Drafts will appear in the queue when ready.");
      refetchStats();
      refetchJobs();
    },
    onError: (e) => toast.error(e.message),
  });
  const runBulk = trpc.aiPipeline.runBulk.useMutation({
    onSuccess: (data) => {
      toast.success(`Pipeline started for ${data.count} contacts`);
      setBulkDialogOpen(false);
      setSelectedContacts([]);
      refetchStats();
      refetchJobs();
    },
    onError: (e) => toast.error(e.message),
  });
  const bulkApprove = trpc.aiPipeline.bulkApproveDrafts.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.count} drafts approved`);
      refetchDrafts();
      refetchStats();
    },
    onError: (e) => toast.error(e.message),
  });
  const sendBulkApproved = trpc.smtpConfig.sendBulkApproved.useMutation({
    onSuccess: (data) => { toast.success(`Sent ${data.sent} emails, ${data.failed} failed`); refetchDrafts(); refetchStats(); },
    onError: (e) => toast.error(e.message.includes("No active SMTP") ? "SMTP not configured — set up in Settings → Email Delivery" : e.message),
  });

  const handleRefresh = () => {
    refetchDrafts();
    refetchStats();
    refetchJobs();
  };

  const toggleContact = (id: number) => {
    setSelectedContacts((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const pendingDraftIds = drafts.map((d) => d.id);

  return (
    <Shell title="AI Pipeline">
      <PageHeader title="AI Draft Queue" description="Review and approve AI-generated email drafts from the research pipeline queue." pageKey="ai-pipeline"
        icon={<Sparkles className="size-5" />}
      >
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Refresh
        </Button>
      </PageHeader>
      <div className="p-6 space-y-6">

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {loadingStats ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4 flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-6 w-12" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </CardContent>
            </Card>
          ))
        ) : (
          [
            { label: "Pending Review", value: stats?.pending_review ?? 0, color: "text-yellow-600", icon: Mail },
            { label: "Approved", value: stats?.approved ?? 0, color: "text-emerald-600", icon: CheckCircle },
            { label: "Rejected", value: stats?.rejected ?? 0, color: "text-red-500", icon: XCircle },
            { label: "Sent", value: stats?.sent ?? 0, color: "text-blue-600", icon: ThumbsUp },
          ].map(({ label, value, color, icon: Icon }) => (
            <Card key={label}>
              <CardContent className="p-4 flex items-center gap-3">
                <Icon className={`h-8 w-8 ${color} shrink-0`} />
                <div>
                  <p className="text-2xl font-bold tabular-nums">{value}</p>
                  <p className="text-xs text-muted-foreground">{label}</p>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Trigger Panel */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Play className="h-4 w-4 text-purple-500" />
                Trigger Pipeline
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-xs text-muted-foreground mb-2">Search and select contacts to run the pipeline for:</p>
                <Input
                  placeholder="Search contacts..."
                  value={contactSearch}
                  onChange={(e) => setContactSearch(e.target.value)}
                  className="text-sm"
                />
              </div>
              {loadingContacts ? (
                <div className="max-h-52 overflow-y-auto space-y-1 border rounded-md p-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2 p-2">
                      <Skeleton className="h-4 w-4 rounded" />
                      <div className="space-y-1.5 flex-1">
                        <Skeleton className="h-3.5 w-28" />
                        <Skeleton className="h-3 w-40" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="max-h-52 overflow-y-auto space-y-1 border rounded-md p-1">
                  {contacts.slice(0, 30).map((c: any) => (
                    <div
                      key={c.id}
                      className={`flex items-center gap-2 p-2 rounded cursor-pointer text-sm transition-colors ${
                        selectedContacts.includes(c.id)
                          ? "bg-purple-100 dark:bg-purple-900/30"
                          : "hover:bg-muted/50"
                      }`}
                      onClick={() => toggleContact(c.id)}
                    >
                      <input
                        type="checkbox"
                        checked={selectedContacts.includes(c.id)}
                        onChange={() => toggleContact(c.id)}
                        className="rounded"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="min-w-0">
                        <p className="font-medium truncate">{c.firstName} {c.lastName}</p>
                        <p className="text-xs text-muted-foreground truncate">{c.title} {c.email ? `· ${c.email}` : ""}</p>
                      </div>
                    </div>
                  ))}
                  {contacts.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-4">No contacts found</p>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  disabled={selectedContacts.length === 0 || runBulk.isPending || runForContact.isPending}
                  onClick={() => {
                    if (selectedContacts.length === 1) {
                      runForContact.mutate({ contactId: selectedContacts[0] });
                    } else {
                      runBulk.mutate({ contactIds: selectedContacts });
                    }
                    // Context is passed as metadata — future: extend runBulk/runForContact with crmContext
                  }}
                >
                  {(runBulk.isPending || runForContact.isPending) ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  ) : (
                    <Sparkles className="h-4 w-4 mr-1" />
                  )}
                  Run Pipeline
                  {selectedContacts.length > 0 && ` (${selectedContacts.length})`}
                </Button>
                {selectedContacts.length > 0 && (
                  <Button size="sm" variant="outline" onClick={() => setSelectedContacts([])}>
                    Clear
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* CRM Context Selectors */}
          <Card>
            <Collapsible open={ctxOpen} onOpenChange={setCtxOpen}>
            <CardHeader className="pb-2 pt-3">
              <CollapsibleTrigger asChild>
                <button className="flex w-full items-center justify-between text-sm font-semibold hover:text-foreground text-muted-foreground transition-colors">
                  <span className="flex items-center gap-2">
                    <Link2 className="h-4 w-4 text-indigo-400" />
                    CRM Context
                    {(ctxSegments.length + ctxSequences.length + ctxCampaigns.length) > 0 && (
                      <span className="ml-1 rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 text-xs px-1.5 py-0.5">
                        {ctxSegments.length + ctxSequences.length + ctxCampaigns.length}
                      </span>
                    )}
                  </span>
                  {ctxOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
              </CollapsibleTrigger>
            </CardHeader>
              <CollapsibleContent>
                <CardContent className="pt-0 pb-4 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Selected entities become AI context — the pipeline will reference these when generating subject lines, body copy, and personalization.
                  </p>
                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1.5">
                      <Layers className="h-3.5 w-3.5 text-purple-400" /> Segments
                    </Label>
                    <EntityPicker
                      type="segments"
                      mode="multi"
                      value={ctxSegments}
                      onChange={setCtxSegments}
                      placeholder="Add segment context…"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1.5">
                      <GitBranch className="h-3.5 w-3.5 text-teal-400" /> Sequences
                    </Label>
                    <EntityPicker
                      type="sequences"
                      mode="multi"
                      value={ctxSequences}
                      onChange={setCtxSequences}
                      placeholder="Add sequence context…"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs flex items-center gap-1.5">
                      <Megaphone className="h-3.5 w-3.5 text-orange-400" /> Campaigns
                    </Label>
                    <EntityPicker
                      type="campaigns"
                      mode="multi"
                      value={ctxCampaigns}
                      onChange={setCtxCampaigns}
                      placeholder="Add campaign context…"
                    />
                  </div>
                  {(ctxSegments.length + ctxSequences.length + ctxCampaigns.length) > 0 && (
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                      onClick={() => { setCtxSegments([]); setCtxSequences([]); setCtxCampaigns([]); }}
                    >
                      Clear all context
                    </button>
                  )}
                </CardContent>
              </CollapsibleContent>
            </Collapsible>
            </Card>

          {/* Recent Jobs */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart2 className="h-4 w-4" />
                Recent Jobs
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {loadingJobs ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 border-b last:border-0">
                    <div className="space-y-1.5">
                      <Skeleton className="h-3.5 w-24" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </div>
                ))
              ) : jobs.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-3">No jobs yet</p>
              ) : (
                jobs.map((job: any) => (
                  <div key={job.id} className="flex items-center justify-between text-xs py-1.5 border-b last:border-0">
                    <div>
                      <p className="font-medium">
                        {job.contactId ? `Contact #${job.contactId}` : `Lead #${job.leadId}`}
                      </p>
                      <p className="text-muted-foreground">
                        {new Date(job.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={
                        job.status === "done"
                          ? "border-emerald-500 text-emerald-600"
                          : job.status === "running"
                          ? "border-blue-500 text-blue-600"
                          : job.status === "failed"
                          ? "border-red-500 text-red-600"
                          : "border-yellow-500 text-yellow-600"
                      }
                    >
                      {job.status === "running" && <Loader2 className="h-2.5 w-2.5 animate-spin mr-1" />}
                      {job.status}
                    </Badge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: Draft Review Queue */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Mail className="h-5 w-5" />
              Draft Review Queue
              {stats?.pending_review ? (
                <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
                  {stats.pending_review} pending
                </Badge>
              ) : null}
            </h2>
            <div className="flex items-center gap-2">
            {pendingDraftIds.length > 0 && (
              <Button
                size="sm"
                onClick={() => bulkApprove.mutate({ draftIds: pendingDraftIds })}
                disabled={bulkApprove.isPending}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {bulkApprove.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <CheckCircle className="h-4 w-4 mr-1" />
                )}
                Approve All ({pendingDraftIds.length})
              </Button>
            )}
            {(stats?.approved ?? 0) > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => sendBulkApproved.mutate({})}
                disabled={sendBulkApproved.isPending}
              >
                {sendBulkApproved.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Mail className="h-4 w-4 mr-1" />
                )}
                Send Approved ({stats?.approved})
              </Button>
            )}
            </div>
          </div>

          {loadingDrafts ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-2 flex-1">
                        <div className="flex items-center gap-2">
                          <Skeleton className="h-5 w-20 rounded-full" />
                          <Skeleton className="h-5 w-16 rounded-full" />
                        </div>
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="h-3 w-32" />
                      </div>
                      <Skeleton className="h-8 w-8 rounded" />
                    </div>
                    <div className="space-y-1.5">
                      <Skeleton className="h-3.5 w-full" />
                      <Skeleton className="h-3.5 w-5/6" />
                      <Skeleton className="h-3.5 w-4/6" />
                    </div>
                    <div className="flex gap-2 pt-1">
                      <Skeleton className="h-8 w-20 rounded" />
                      <Skeleton className="h-8 w-20 rounded" />
                      <Skeleton className="h-8 w-24 rounded" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : drafts.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <Sparkles className="h-12 w-12 text-muted-foreground/30 mb-3" />
                <p className="font-medium text-muted-foreground">No drafts pending review</p>
                <p className="text-sm text-muted-foreground/70 mt-1">
                  Select contacts and run the pipeline to generate AI-personalized drafts
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {drafts.map((draft: any) => (
                <DraftCard key={draft.id} draft={draft} onAction={handleRefresh} />
              ))}
              <div className="flex items-center justify-between pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">Page {page}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={drafts.length < 20}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      </div>
    </Shell>
  );
}
