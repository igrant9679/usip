import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Field, FormDialog, SelectField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { EmailVerificationBadge } from "@/components/usip/EmailVerificationBadge";
import { trpc } from "@/lib/trpc";
import {
  Plus,
  Users,
  ShieldCheck,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Loader2,
  X,
  Filter,
  ListPlus,
  Send,
  Wand2,
  MoreHorizontal,
  Pencil,
  Trash2,
  Tag,
  Megaphone,
  Download,
  Sparkles,
} from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type VerifFilter = "all" | "valid" | "accept_all" | "risky" | "invalid" | "unknown";

const VERIF_FILTER_OPTIONS: { value: VerifFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "valid", label: "Valid" },
  { value: "accept_all", label: "Accept-All" },
  { value: "risky", label: "Risky" },
  { value: "invalid", label: "Invalid" },
  { value: "unknown", label: "Not verified" },
];

/* ─── Bulk Verify Modal ─────────────────────────────────────────────────── */
function BulkVerifyModal({
  open,
  onOpenChange,
  contactIds,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contactIds: number[];
  onComplete: () => void;
}) {
  const [jobId, setJobId] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<"idle" | "starting" | "running" | "done" | "error">("idle");
  const [summary, setSummary] = useState<{ valid: number; invalid: number; risky: number; acceptAll: number; unknown: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const utils = trpc.useUtils();

  const startBulk = trpc.emailVerification.verifyBulk.useMutation({
    onSuccess: (data) => {
      setJobId(data.jobId);
      setStatus("running");
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to start verification job.");
      setStatus("error");
    },
  });

  // Start polling when jobId is set
  useEffect(() => {
    if (!jobId || status !== "running") return;
    pollRef.current = setInterval(async () => {
      try {
        const result = await utils.emailVerification.getBulkJobStatus.fetch({ jobId });
        setProgress(result.progressPct ?? 0);
        if (result.status === "completed") {
          clearInterval(pollRef.current!);
          setStatus("done");
          utils.contacts.list.invalidate();
          onComplete();
        } else if (result.status === "failed") {
          clearInterval(pollRef.current!);
          setStatus("error");
        }
      } catch {
        // ignore transient poll errors
      }
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [jobId, status]);

  // Reset when modal closes
  useEffect(() => {
    if (!open) {
      setJobId(null);
      setProgress(0);
      setStatus("idle");
      setSummary(null);
      if (pollRef.current) clearInterval(pollRef.current);
    }
  }, [open]);

  function handleStart() {
    setStatus("starting");
    startBulk.mutate({ contactIds });
  }

  const emailCount = contactIds.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-[#14B89A]" />
            Bulk Email Verification
          </DialogTitle>
          <DialogDescription>
            Verify {emailCount} email address{emailCount !== 1 ? "es" : ""} using Reoon Power Mode.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {status === "idle" && (
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Contacts selected</span>
                  <span className="font-medium">{emailCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Verification mode</span>
                  <span className="font-medium">Reoon Power Mode</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Estimated time</span>
                  <span className="font-medium">~{Math.max(1, Math.ceil(emailCount / 100))} min</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Results will be applied to each contact record automatically. You can close this dialog and check back later.
              </p>
              <Button onClick={handleStart} className="w-full gap-2">
                <ShieldCheck className="h-4 w-4" />
                Start Verification
              </Button>
            </div>
          )}

          {status === "starting" && (
            <div className="flex items-center justify-center gap-3 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              Starting verification job…
            </div>
          )}

          {status === "running" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  Verifying emails…
                </span>
                <span className="font-medium">{progress}%</span>
              </div>
              <Progress value={progress} className="h-2" />
              <p className="text-xs text-muted-foreground text-center">
                This may take a few minutes. You can close this dialog — results will be saved automatically.
              </p>
              <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full">
                Close and continue working
              </Button>
            </div>
          )}

          {status === "done" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-700">
                <CheckCircle2 className="h-5 w-5" />
                <span className="font-semibold">Verification complete</span>
              </div>
              {summary && (
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-lg border bg-green-50 p-2">
                    <p className="text-lg font-bold text-green-700">{summary.valid}</p>
                    <p className="text-green-600">Valid</p>
                  </div>
                  <div className="rounded-lg border bg-yellow-50 p-2">
                    <p className="text-lg font-bold text-yellow-700">{summary.acceptAll + summary.risky}</p>
                    <p className="text-yellow-600">Risky</p>
                  </div>
                  <div className="rounded-lg border bg-red-50 p-2">
                    <p className="text-lg font-bold text-red-700">{summary.invalid}</p>
                    <p className="text-red-600">Invalid</p>
                  </div>
                </div>
              )}
              <Button onClick={() => onOpenChange(false)} className="w-full">
                Done
              </Button>
            </div>
          )}

          {status === "error" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5" />
                <span className="font-semibold">Verification failed</span>
              </div>
              <p className="text-sm text-muted-foreground">
                The verification job encountered an error. Please check your Reoon API key in Settings → Integrations and try again.
              </p>
              <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full">
                Close
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}


/* ─── Add to Sequence Modal ─────────────────────────────────────────────── */
function AddToSequenceModal({
  open,
  onOpenChange,
  contactIds,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contactIds: number[];
  onComplete: () => void;
}) {
  const { data: sequences } = trpc.sequences.list.useQuery(undefined, { enabled: open });
  const [sequenceId, setSequenceId] = useState<string>("");
  const [result, setResult] = useState<{ enrolled: number; skipped: number; sequenceName: string } | null>(null);
  const addMut = trpc.contacts.bulkAddToSequence.useMutation({
    onSuccess: (data) => {
      setResult({ enrolled: data.enrolled, skipped: data.skipped, sequenceName: data.sequenceName });
    },
    onError: (e) => toast.error(e.message),
  });

  const handleClose = () => {
    setSequenceId("");
    setResult(null);
    onOpenChange(false);
    if (result) onComplete();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListPlus className="size-5 text-[#14B89A]" />
            Add to Sequence
          </DialogTitle>
          <DialogDescription>
            Enroll {contactIds.length} selected contact{contactIds.length !== 1 ? "s" : ""} into a sequence.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 border border-green-200">
              <CheckCircle2 className="size-5 text-green-600 shrink-0" />
              <div>
                <div className="text-sm font-medium text-green-800">Enrollment complete</div>
                <div className="text-xs text-green-700">Sequence: {result.sequenceName}</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg border text-center">
                <div className="text-2xl font-bold text-green-600">{result.enrolled}</div>
                <div className="text-xs text-muted-foreground">Enrolled</div>
              </div>
              <div className="p-3 rounded-lg border text-center">
                <div className="text-2xl font-bold text-orange-500">{result.skipped}</div>
                <div className="text-xs text-muted-foreground">Skipped</div>
              </div>
            </div>
            {result.skipped > 0 && (
              <p className="text-xs text-muted-foreground">
                Skipped contacts were either already enrolled or have invalid email addresses blocked by your guard setting.
              </p>
            )}
            <Button className="w-full" onClick={handleClose}>Done</Button>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Select sequence</label>
              <Select value={sequenceId} onValueChange={setSequenceId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a sequence..." />
                </SelectTrigger>
                <SelectContent>
                  {(sequences ?? []).map((s: any) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button
                onClick={() => addMut.mutate({ contactIds, sequenceId: Number(sequenceId) })}
                disabled={!sequenceId || addMut.isPending}
              >
                {addMut.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <ListPlus className="size-4 mr-1" />}
                Enroll {contactIds.length} contact{contactIds.length !== 1 ? "s" : ""}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─── Send Email Modal ──────────────────────────────────────────────────── */
function SendEmailModal({
  open,
  onOpenChange,
  contactIds,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  contactIds: number[];
  onComplete: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [aiMode, setAiMode] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [result, setResult] = useState<{ sent: number; skipped: number } | null>(null);

  const generateMut = trpc.emailDrafts.compose.useMutation({
    onSuccess: (data) => {
      setSubject(data.subject ?? "");
      setBody(data.body ?? "");
      setAiMode(false);
      toast.success("AI email generated — review and send");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const sendMut = trpc.contacts.sendAdHocEmail.useMutation({
    onSuccess: (data) => setResult({ sent: data.sent, skipped: data.skipped }),
    onError: (e: any) => toast.error(e.message),
  });

  const handleClose = () => {
    setSubject("");
    setBody("");
    setAiPrompt("");
    setAiMode(false);
    setResult(null);
    onOpenChange(false);
    if (result) onComplete();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="size-5 text-[#14B89A]" />
            Send Email
          </DialogTitle>
          <DialogDescription>
            Send an email to {contactIds.length} selected contact{contactIds.length !== 1 ? "s" : ""}.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 border border-green-200">
              <CheckCircle2 className="size-5 text-green-600 shrink-0" />
              <div>
                <div className="text-sm font-medium text-green-800">Emails sent</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3 rounded-lg border text-center">
                <div className="text-2xl font-bold text-green-600">{result.sent}</div>
                <div className="text-xs text-muted-foreground">Sent</div>
              </div>
              <div className="p-3 rounded-lg border text-center">
                <div className="text-2xl font-bold text-orange-500">{result.skipped}</div>
                <div className="text-xs text-muted-foreground">Skipped (no email)</div>
              </div>
            </div>
            <Button className="w-full" onClick={handleClose}>Done</Button>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            {/* AI generate toggle */}
            <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/30">
              <Wand2 className="size-4 text-violet-500 shrink-0" />
              <div className="flex-1 text-sm">Generate with AI</div>
              <Button
                size="sm"
                variant={aiMode ? "default" : "outline"}
                onClick={() => setAiMode(!aiMode)}
              >
                {aiMode ? "Cancel" : "Use AI"}
              </Button>
            </div>
            {aiMode && (
              <div className="space-y-2">
                <Textarea
                  placeholder="Describe the email you want to send (e.g. 'Follow up on our product demo last week, offer a free trial')"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  rows={3}
                />
                <Button
                  size="sm"
                  className="w-full"
                  onClick={() => generateMut.mutate({ prompt: aiPrompt })}
                  disabled={!aiPrompt.trim() || generateMut.isPending}
                >
                  {generateMut.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Wand2 className="size-4 mr-1" />}
                  Generate Email
                </Button>
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Subject</label>
              <Input
                placeholder="Email subject..."
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Body</label>
              <Textarea
                placeholder="Email body..."
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={8}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button
                onClick={() => sendMut.mutate({ contactIds, subject, body, aiGenerated: false })}
                disabled={!subject.trim() || !body.trim() || sendMut.isPending}
              >
                {sendMut.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Send className="size-4 mr-1" />}
                Send to {contactIds.length}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─── Add to Campaign Modal ────────────────────────────────────────────── */
function AddToCampaignModal({ open, onOpenChange, contactIds, onComplete }: { open: boolean; onOpenChange: (v: boolean) => void; contactIds: number[]; onComplete: () => void }) {
  const [campaignId, setCampaignId] = useState("");
  const { data: campaigns } = trpc.campaigns.list.useQuery();
  const addMut = trpc.campaigns.addAudience.useMutation({
    onSuccess: (d) => { toast.success(`Added ${d.added} contact${d.added !== 1 ? "s" : ""} to campaign`); onComplete(); onOpenChange(false); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Megaphone className="size-4 text-orange-500" />Add to Campaign</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <Select value={campaignId} onValueChange={setCampaignId}>
            <SelectTrigger><SelectValue placeholder="Choose a campaign..." /></SelectTrigger>
            <SelectContent>{(campaigns ?? []).map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => addMut.mutate({ campaignId: Number(campaignId), contactIds })} disabled={!campaignId || addMut.isPending}>
              {addMut.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Megaphone className="size-4 mr-1" />}
              Add {contactIds.length}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Add to Segment Modal ─────────────────────────────────────────────── */
function AddToSegmentModal({ open, onOpenChange, contactIds, onComplete }: { open: boolean; onOpenChange: (v: boolean) => void; contactIds: number[]; onComplete: () => void }) {
  const [segmentId, setSegmentId] = useState("");
  const { data: segments } = trpc.segments.list.useQuery();
  const addMut = trpc.segments.addContacts.useMutation({
    onSuccess: (d) => { toast.success(`Added ${d.added} contact${d.added !== 1 ? "s" : ""} to segment`); onComplete(); onOpenChange(false); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Tag className="size-4 text-violet-500" />Add to Segment</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <Select value={segmentId} onValueChange={setSegmentId}>
            <SelectTrigger><SelectValue placeholder="Choose a segment..." /></SelectTrigger>
            <SelectContent>{(segments ?? []).map((s: any) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => addMut.mutate({ segmentId: Number(segmentId), contactIds })} disabled={!segmentId || addMut.isPending}>
              {addMut.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Tag className="size-4 mr-1" />}
              Add {contactIds.length}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Edit Contact Dialog ───────────────────────────────────────────────── */
function EditContactDialog({ contact, open, onOpenChange, onSaved }: { contact: any; open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const { data: accounts } = trpc.accounts.list.useQuery();
  const updateMut = trpc.contacts.update.useMutation({
    onSuccess: () => { toast.success("Contact updated"); onSaved(); onOpenChange(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const handleSubmit = (f: FormData) => updateMut.mutate({ id: contact.id, patch: {
    firstName: String(f.get("firstName")), lastName: String(f.get("lastName")),
    email: String(f.get("email") ?? "") || undefined, title: String(f.get("title") ?? "") || undefined,
    phone: String(f.get("phone") ?? "") || undefined, accountId: Number(f.get("accountId")) || undefined,
  }});
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Edit Contact" isPending={updateMut.isPending} onSubmit={handleSubmit}>
      <div className="grid grid-cols-2 gap-3">
        <Field name="firstName" label="First name" required defaultValue={contact?.firstName} />
        <Field name="lastName" label="Last name" required defaultValue={contact?.lastName} />
      </div>
      <Field name="email" label="Email" type="email" defaultValue={contact?.email} />
      <Field name="title" label="Title" defaultValue={contact?.title} />
      <Field name="phone" label="Phone" defaultValue={contact?.phone} />
      <SelectField name="accountId" label="Account" defaultValue={String(contact?.accountId ?? "")} options={[{ value: "", label: "—" }, ...((accounts ?? []).map((a: any) => ({ value: String(a.id), label: a.name })))]} />
    </FormDialog>
  );
}

/* ─── Enrich Diff-and-Approve Modal ────────────────────────────────────── */
type DiffRow = {
  fieldName: string;
  label: string;
  currentValue: string | null;
  proposedValue: string | null;
  isManuallyEdited: boolean;
};

function EnrichDiffModal({
  contactId,
  open,
  onOpenChange,
  onApplied,
}: {
  contactId: number | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onApplied: () => void;
}) {
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());

  const preview = trpc.clodura.enrichPreview.useMutation({
    onSuccess: (data) => {
      if (data.eligible && data.diff) {
        // Pre-select all non-manually-edited fields that have a proposed value
        setSelectedFields(
          new Set(
            data.diff
              .filter((r: DiffRow) => !r.isManuallyEdited)
              .map((r: DiffRow) => r.fieldName),
          ),
        );
      }
    },
    onError: (e) => toast.error(e.message),
  });

  const apply = trpc.clodura.enrichApply.useMutation({
    onSuccess: (res) => {
      toast.success(`Applied ${res.applied} field update${res.applied !== 1 ? "s" : ""}${res.skippedManuallyEdited ? ` (${res.skippedManuallyEdited} manually-edited fields skipped)` : ""}`);
      onApplied();
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });

  // Trigger preview when modal opens
  useEffect(() => {
    if (open && contactId) {
      preview.reset();
      setSelectedFields(new Set());
      preview.mutate({ contactId });
    }
  }, [open, contactId]);

  const diff: DiffRow[] = (preview.data as any)?.diff ?? [];
  const noMatch = (preview.data as any)?.noMatch;
  const notEligible = (preview.data as any)?.eligible === false;

  const toggleField = (fieldName: string) => {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(fieldName)) next.delete(fieldName);
      else next.add(fieldName);
      return next;
    });
  };

  const handleApply = () => {
    if (!contactId) return;
    const fields = diff
      .filter((r: DiffRow) => selectedFields.has(r.fieldName))
      .map((r: DiffRow) => ({ fieldName: r.fieldName, newValue: r.proposedValue }));
    apply.mutate({
      contactId,
      fields,
      rawResponse: (preview.data as any)?.rawResponse,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Enrich Contact with Clodura</DialogTitle>
          <DialogDescription>
            Review proposed field updates from Clodura.ai. Deselect any fields you don't want to apply.
          </DialogDescription>
        </DialogHeader>

        {preview.isPending && (
          <div className="flex items-center justify-center py-12 gap-3 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Fetching enrichment data…</span>
          </div>
        )}

        {preview.isError && (
          <div className="flex items-center gap-2 text-destructive text-sm py-4">
            <AlertCircle className="h-4 w-4" />
            {preview.error.message}
          </div>
        )}

        {notEligible && (
          <div className="text-sm text-muted-foreground py-4">
            This contact doesn't have enough identifiers (LinkedIn URL, email, or name + company) for enrichment.
          </div>
        )}

        {noMatch && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
            <AlertCircle className="h-4 w-4" />
            No Clodura match found for this contact.
          </div>
        )}

        {diff.length > 0 && (
          <div className="space-y-2 max-h-[400px] overflow-y-auto">
            <div className="grid grid-cols-[auto_1fr_1fr_1fr] gap-2 text-xs font-medium text-muted-foreground uppercase tracking-wide px-2">
              <div className="w-5" />
              <div>Field</div>
              <div>Current</div>
              <div>Proposed</div>
            </div>
            {diff.map((row: DiffRow) => (
              <div
                key={row.fieldName}
                className={`grid grid-cols-[auto_1fr_1fr_1fr] gap-2 items-start rounded-md border px-2 py-2 text-sm cursor-pointer hover:bg-muted/50 ${
                  row.isManuallyEdited ? "opacity-50" : ""
                }`}
                onClick={() => !row.isManuallyEdited && toggleField(row.fieldName)}
              >
                <input
                  type="checkbox"
                  checked={selectedFields.has(row.fieldName)}
                  disabled={row.isManuallyEdited}
                  onChange={() => toggleField(row.fieldName)}
                  className="mt-0.5 rounded"
                />
                <div className="font-medium">
                  {row.label}
                  {row.isManuallyEdited && (
                    <Badge variant="outline" className="ml-1 text-xs">manually edited</Badge>
                  )}
                </div>
                <div className="text-muted-foreground truncate">{row.currentValue || <span className="italic">empty</span>}</div>
                <div className="text-green-700 dark:text-green-400 truncate">{row.proposedValue}</div>
              </div>
            ))}
          </div>
        )}

        {diff.length === 0 && !preview.isPending && !preview.isError && !notEligible && !noMatch && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            All fields are already up to date — no changes proposed.
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={handleApply}
            disabled={selectedFields.size === 0 || apply.isPending || preview.isPending}
          >
            {apply.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
            Apply {selectedFields.size > 0 ? `${selectedFields.size} update${selectedFields.size !== 1 ? "s" : ""}` : ""}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Bulk Enrich Confirm ──────────────────────────────────────────────── */
function BulkEnrichConfirm({
  contactIds,
  onComplete,
  onCancel,
}: {
  contactIds: number[];
  onComplete: () => void;
  onCancel: () => void;
}) {
  const bulk = trpc.clodura.enrichBulk.useMutation({
    onSuccess: (res) => {
      toast.success(`Queued ${res.queued} contact${res.queued !== 1 ? "s" : ""} for enrichment. Daily budget remaining: ${res.dailyBudgetRemaining}`);
      onComplete();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button variant="outline" onClick={onCancel}>Cancel</Button>
      <Button
        onClick={() => bulk.mutate({ contactIds, mode: "fill_empty" })}
        disabled={bulk.isPending}
      >
        {bulk.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Sparkles className="h-4 w-4 mr-2" />}
        Queue {contactIds.length} for enrichment
      </Button>
    </div>
  );
}

/* ─── Main Contacts page ────────────────────────────────────────────────── */
export default function Contacts() {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ id: number; name: string; subtitle: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkVerifyOpen, setBulkVerifyOpen] = useState(false);
  const [addToSeqOpen, setAddToSeqOpen] = useState(false);
  const [sendEmailOpen, setSendEmailOpen] = useState(false);
  const [addToCampaignOpen, setAddToCampaignOpen] = useState(false);
  const [addToSegmentOpen, setAddToSegmentOpen] = useState(false);
  const [editContact, setEditContact] = useState<any | null>(null);
  const [verifFilter, setVerifFilter] = useState<VerifFilter>("all");
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [enrichContactId, setEnrichContactId] = useState<number | null>(null);
  const [bulkEnrichOpen, setBulkEnrichOpen] = useState(false);
  const [enrichmentFilter, setEnrichmentFilter] = useState<"all" | "enriched" | "not_enriched">("all");

  const utils = trpc.useUtils();
  const { data: rawContacts } = trpc.contacts.list.useQuery({ search });
  // Apply verification status filter client-side
  const data = verifFilter === "all"
    ? rawContacts
    : verifFilter === "unknown"
      ? (rawContacts ?? []).filter((c) => !c.emailVerificationStatus)
      : (rawContacts ?? []).filter((c) => c.emailVerificationStatus === verifFilter);
  const { data: accounts } = trpc.accounts.list.useQuery();

  const create = trpc.contacts.create.useMutation({
    onSuccess: () => {
      utils.contacts.list.invalidate();
      setOpen(false);
      toast.success("Contact added");
    },
  });

  const deleteMut = trpc.contacts.delete.useMutation({
    onSuccess: () => { utils.contacts.list.invalidate(); toast.success("Contact deleted"); },
    onError: (e: any) => toast.error(e.message),
  });

  const allIds = (data ?? []).map((c) => c.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));
  const someSelected = selectedIds.size > 0;

  function toggleAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allIds));
    }
  }

  function toggleOne(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Only select contacts that have an email address for bulk verify
  const verifiableIds = Array.from(selectedIds).filter((id) =>
    (data ?? []).find((c) => c.id === id && c.email),
  );

  // Enrichment status filter (client-side)
  const filteredData = enrichmentFilter === "all"
    ? data
    : enrichmentFilter === "enriched"
      ? (data ?? []).filter((c) => (c as any).enrichedAt)
      : (data ?? []).filter((c) => !(c as any).enrichedAt);

  return (
    <Shell title="Contacts">
      <PageHeader title="Contacts" pageKey="contacts" description={`${(data ?? []).length} contact${(data ?? []).length !== 1 ? "s" : ""}${verifFilter !== "all" ? " · filtered" : " · all"}`}
        icon={<Users className="size-5" />}
      >
        <Input
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-56"
        />
        {/* Verification status filter */}
        <div className="flex items-center gap-1.5">
          <Select
            value={verifFilter}
            onValueChange={(v) => {
              setVerifFilter(v as VerifFilter);
              setSelectedIds(new Set());
            }}
          >
            <SelectTrigger className="w-40 h-9 text-xs gap-1">
              <Filter className="h-3 w-3 text-muted-foreground shrink-0" />
              <SelectValue placeholder="Filter status" />
            </SelectTrigger>
            <SelectContent>
              {VERIF_FILTER_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {verifFilter !== "all" && (
            <button
              onClick={() => { setVerifFilter("all"); setSelectedIds(new Set()); }}
              className="flex items-center gap-1 rounded-full border bg-primary/10 text-primary px-2 py-0.5 text-xs font-medium hover:bg-primary/20 transition-colors"
            >
              {VERIF_FILTER_OPTIONS.find((o) => o.value === verifFilter)?.label}
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {someSelected && (
          <>
            <Button
              variant="outline"
              onClick={() => setBulkVerifyOpen(true)}
              disabled={verifiableIds.length === 0}
              className="gap-2"
            >
              <ShieldCheck className="h-4 w-4 text-[#14B89A]" />
              Verify Emails ({verifiableIds.length})
            </Button>
            <Button
              variant="outline"
              onClick={() => setAddToSeqOpen(true)}
              className="gap-2"
            >
              <ListPlus className="h-4 w-4 text-violet-500" />
              Add to Sequence ({selectedIds.size})
            </Button>
            <Button
              variant="outline"
              onClick={() => setSendEmailOpen(true)}
              className="gap-2"
            >
              <Send className="h-4 w-4 text-blue-500" />
              Send Email ({selectedIds.size})
            </Button>
            <Button
              variant="outline"
              onClick={() => setAddToCampaignOpen(true)}
              className="gap-2"
            >
              <Megaphone className="h-4 w-4 text-orange-500" />
              Add to Campaign ({selectedIds.size})
            </Button>
            <Button
              variant="outline"
              onClick={() => setAddToSegmentOpen(true)}
              className="gap-2"
            >
              <Tag className="h-4 w-4 text-violet-500" />
              Add to Segment ({selectedIds.size})
            </Button>
            <Button
              variant="outline"
              onClick={() => setBulkEnrichOpen(true)}
              className="gap-2"
            >
              <Sparkles className="h-4 w-4 text-amber-500" />
              Enrich ({selectedIds.size})
            </Button>
          </>
        )}
        <Button variant="outline" onClick={() => {
          const rows = data ?? [];
          if (!rows.length) return;
          const cols = ["id", "firstName", "lastName", "email", "phone", "title", "company", "city", "state", "country", "linkedinUrl", "createdAt"];
          const lines = [cols.join(","), ...rows.map((r: any) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))];
          const blob = new Blob([lines.join("\n")], { type: "text/csv" });
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `contacts-${Date.now()}.csv`; a.click();
        }} disabled={!data?.length}>
          <Download className="size-4" /> Export CSV
        </Button>
        <Button onClick={() => setOpen(true)}>
          <Plus className="size-4" /> New contact
        </Button>
      </PageHeader>

      <div className="p-6">
        {(data ?? []).length === 0 ? (
          <EmptyState icon={Users} title="No contacts" description="Add one or convert a lead." />
        ) : (
          <div className="rounded-lg border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="rounded border-gray-300 cursor-pointer"
                      title="Select all"
                    />
                  </th>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Title</th>
                  <th className="text-left px-3 py-2">Account</th>
                  <th className="text-left px-3 py-2">Email</th>
                  <th className="text-left px-3 py-2 w-28">Verified</th>
                  <th className="text-left px-3 py-2">Phone</th>
                  <th className="text-left px-3 py-2 w-24">Enriched</th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(data ?? []).map((c) => (
                  <tr
                    key={c.id}
                    className={`hover:bg-secondary/30 cursor-pointer ${selectedIds.has(c.id) ? "bg-primary/5" : ""}`}
                    onClick={() =>
                      setDrawer({
                        id: c.id,
                        name: `${c.firstName} ${c.lastName}`,
                        subtitle: `${c.title ?? ""} · ${(c as any).accountName ?? ""}`,
                      })
                    }
                  >
                    <td
                      className="px-3 py-2"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleOne(c.id);
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        readOnly
                        className="rounded border-gray-300 cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium">
                      <span className="underline-offset-2 hover:underline">
                        {c.firstName} {c.lastName}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{c.title}</td>
                    <td className="px-3 py-2 text-muted-foreground">{(c as any).accountName}</td>
                    <td className="px-3 py-2 text-muted-foreground">{c.email}</td>
                    <td className="px-3 py-2">
                      {c.email ? (
                        <EmailVerificationBadge
                          status={c.emailVerificationStatus}
                          verifiedAt={c.emailVerifiedAt}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{c.phone}</td>
                    <td className="px-3 py-2">
                      {(c as any).enrichedAt ? (
                        <Badge variant="secondary" className="text-xs gap-1">
                          <Sparkles className="h-2.5 w-2.5 text-amber-500" />
                          Enriched
                        </Badge>
                      ) : (
                        <button
                          className="text-xs text-amber-600 hover:text-amber-700 hover:underline flex items-center gap-0.5"
                          onClick={(e) => { e.stopPropagation(); setEnrichContactId(c.id); setEnrichOpen(true); }}
                        >
                          <Sparkles className="h-3 w-3" /> Enrich
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-7">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditContact(c)}>
                            <Pencil className="size-4 mr-2" />Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDrawer({ id: c.id, name: `${c.firstName} ${c.lastName}`, subtitle: `${c.title ?? ""} · ${(c as any).accountName ?? ""}` })}>
                            <Users className="size-4 mr-2" />View details
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => { setSelectedIds(new Set([c.id])); setAddToCampaignOpen(true); }}>
                            <Megaphone className="size-4 mr-2" />Add to Campaign
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => { setSelectedIds(new Set([c.id])); setAddToSegmentOpen(true); }}>
                            <Tag className="size-4 mr-2" />Add to Segment
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => { setEnrichContactId(c.id); setEnrichOpen(true); }}>
                            <Sparkles className="size-4 mr-2 text-amber-500" />Enrich with Clodura
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onClick={() => { if (confirm(`Delete ${c.firstName} ${c.lastName}?`)) deleteMut.mutate({ id: c.id }); }}>
                            <Trash2 className="size-4 mr-2" />Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* New contact dialog */}
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title="New contact"
        isPending={create.isPending}
        onSubmit={(f) =>
          create.mutate({
            firstName: String(f.get("firstName")),
            lastName: String(f.get("lastName")),
            email: String(f.get("email") ?? "") || undefined,
            title: String(f.get("title") ?? "") || undefined,
            phone: String(f.get("phone") ?? "") || undefined,
            accountId: Number(f.get("accountId")) || undefined,
          })
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field name="firstName" label="First name" required />
          <Field name="lastName" label="Last name" required />
        </div>
        <Field name="email" label="Email" type="email" />
        <Field name="title" label="Title" />
        <Field name="phone" label="Phone" />
        <SelectField
          name="accountId"
          label="Account"
          options={[
            { value: "", label: "—" },
            ...((accounts ?? []).map((a) => ({ value: String(a.id), label: a.name }))),
          ]}
        />
      </FormDialog>

      {/* Record drawer */}
      <RecordDrawer
        open={!!drawer}
        onOpenChange={(v) => !v && setDrawer(null)}
        relatedType="contact"
        relatedId={drawer?.id ?? null}
        title={drawer?.name ?? ""}
        subtitle={drawer?.subtitle}
      />

      {/* Bulk verify modal */}
      <BulkVerifyModal
        open={bulkVerifyOpen}
        onOpenChange={setBulkVerifyOpen}
        contactIds={verifiableIds}
        onComplete={() => {
          setSelectedIds(new Set());
          utils.contacts.list.invalidate();
        }}
      />
      {/* Add to sequence modal */}
      <AddToSequenceModal
        open={addToSeqOpen}
        onOpenChange={setAddToSeqOpen}
        contactIds={Array.from(selectedIds)}
        onComplete={() => setSelectedIds(new Set())}
      />
      {/* Send email modal */}
      <SendEmailModal
        open={sendEmailOpen}
        onOpenChange={setSendEmailOpen}
        contactIds={Array.from(selectedIds)}
        onComplete={() => setSelectedIds(new Set())}
      />
      {/* Add to Campaign modal */}
      <AddToCampaignModal
        open={addToCampaignOpen}
        onOpenChange={setAddToCampaignOpen}
        contactIds={Array.from(selectedIds)}
        onComplete={() => setSelectedIds(new Set())}
      />
      {/* Add to Segment modal */}
      <AddToSegmentModal
        open={addToSegmentOpen}
        onOpenChange={setAddToSegmentOpen}
        contactIds={Array.from(selectedIds)}
        onComplete={() => setSelectedIds(new Set())}
      />
      {/* Edit contact dialog */}
      {editContact && (
        <EditContactDialog
          contact={editContact}
          open={!!editContact}
          onOpenChange={(v) => !v && setEditContact(null)}
          onSaved={() => { utils.contacts.list.invalidate(); setEditContact(null); }}
        />
      )}

      {/* Enrich diff-and-approve modal */}
      <EnrichDiffModal
        contactId={enrichContactId}
        open={enrichOpen}
        onOpenChange={(v) => { setEnrichOpen(v); if (!v) setEnrichContactId(null); }}
        onApplied={() => utils.contacts.list.invalidate()}
      />

      {/* Bulk enrich confirmation dialog */}
      {bulkEnrichOpen && (
        <Dialog open={bulkEnrichOpen} onOpenChange={setBulkEnrichOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Bulk Enrich Contacts</DialogTitle>
              <DialogDescription>
                Queue {selectedIds.size} contact{selectedIds.size !== 1 ? "s" : ""} for Clodura enrichment. Each contact consumes 1 credit. The worker processes jobs every 2 minutes.
              </DialogDescription>
            </DialogHeader>
            <BulkEnrichConfirm
              contactIds={Array.from(selectedIds)}
              onComplete={() => { setBulkEnrichOpen(false); setSelectedIds(new Set()); utils.contacts.list.invalidate(); }}
              onCancel={() => setBulkEnrichOpen(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </Shell>
  );
}
