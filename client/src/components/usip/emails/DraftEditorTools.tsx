/**
 * DraftEditorTools — the per-draft editor tools, hosted in the Emails
 * drawer (phase 4 port, 2026-09-15). These lived on the retired
 * /email-drafts and /ai-pipeline pages; the components moved here verbatim
 * where possible so their tRPC wiring stayed identical.
 *
 * Two disjoint tool sets, keyed the same way the old escape-hatch link was:
 *   - AI drafts (status === "ai_pending_review") — research context,
 *     regenerate presets, effectiveness score, edit & approve
 *     (aiPipeline.*, whose procs hard-filter that status).
 *   - Sequence/CRM drafts (any other draft status) — subject A/B + spam
 *     analyzer, edit, resolved-merge preview (subjectAB.* / emailDrafts.update
 *     / smtpConfig.previewResolved).
 *   - Sent drafts — delivery analytics (smtpConfig.getTrackingStats).
 */
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { sanitizeEmailHtml } from "@/lib/sanitizeHtml";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RichTextEditor } from "@/components/usip/RichTextEditor";
import {
  AlertTriangle, BarChart2, CheckCircle, ChevronDown, ChevronRight, Eye, ExternalLink,
  Loader2, MousePointer, Pencil, RefreshCw, Star, XCircle, Zap,
} from "lucide-react";

/* ─── Subject A/B + Spam Analyzer (sequence/CRM drafts) ───────────────────── */

export function SubjectABPanel({ draftId, onChanged }: { draftId: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const { data: variants = [], refetch } = trpc.subjectAB.list.useQuery({ emailDraftId: draftId }, { enabled: open });
  const generate = trpc.subjectAB.generate.useMutation({
    onSuccess: () => { refetch(); toast.success("Variants generated"); },
    onError: (e) => toast.error(e.message),
  });
  const select = trpc.subjectAB.select.useMutation({
    onSuccess: () => { onChanged(); refetch(); toast.success("Subject applied"); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="border-t pt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Zap className="h-3.5 w-3.5 text-amber-500" />
        Subject A/B + Spam Analyzer
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <Button size="sm" variant="outline" className="h-7 text-xs"
            onClick={() => generate.mutate({ emailDraftId: draftId })} disabled={generate.isPending}>
            {generate.isPending ? "Generating…" : "Generate 3 variants"}
          </Button>
          {variants.map((v: any) => (
            <div key={v.id}
              className={`rounded-md border px-3 py-2 text-xs space-y-1 ${
                v.isSelected ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30" : "bg-muted/30"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium flex-1">{v.subject}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge variant="outline"
                    className={`text-xs ${
                      Number(v.spamScore) <= 10 ? "border-emerald-400 text-emerald-700"
                        : Number(v.spamScore) <= 25 ? "border-amber-400 text-amber-700"
                        : "border-red-400 text-red-700"
                    }`}
                  >
                    Spam {v.spamScore}
                  </Badge>
                  {!v.isSelected && (
                    <Button size="sm" variant="outline" className="h-6 text-xs px-2"
                      onClick={() => select.mutate({ variantId: v.id, emailDraftId: draftId })} disabled={select.isPending}>
                      Use
                    </Button>
                  )}
                  {v.isSelected && <span className="text-emerald-600 font-semibold">✓ Active</span>}
                </div>
              </div>
              {v.spamFlags && v.spamFlags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {v.spamFlags.map((f: any, i: number) => (
                    <span key={i} className="text-xs bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300 px-1.5 py-0.5 rounded">
                      {f.rule}
                    </span>
                  ))}
                </div>
              )}
              {v.aiRationale && <p className="text-muted-foreground italic">{v.aiRationale}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Delivery analytics (sent drafts) ────────────────────────────────────── */

export function TrackingStatsPanel({ draftId, status }: { draftId: number; status: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = trpc.smtpConfig.getTrackingStats.useQuery(
    { draftId },
    { enabled: open && status === "sent" },
  );
  if (status !== "sent") return null;
  return (
    <div className="border-t pt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <BarChart2 className="h-3.5 w-3.5 text-blue-500" />
        Delivery analytics
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {isLoading ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : data ? (
            <>
              <div className="flex gap-4">
                <div className="flex items-center gap-1.5 text-xs">
                  <Eye className="h-3.5 w-3.5 text-emerald-500" />
                  <span className="font-medium">{data.draft.openCount}</span>
                  <span className="text-muted-foreground">open{data.draft.openCount !== 1 ? "s" : ""}</span>
                  {data.draft.lastOpenedAt && (
                    <span className="text-muted-foreground">· last {new Date(data.draft.lastOpenedAt).toLocaleString()}</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  <MousePointer className="h-3.5 w-3.5 text-violet-500" />
                  <span className="font-medium">{data.draft.clickCount}</span>
                  <span className="text-muted-foreground">click{data.draft.clickCount !== 1 ? "s" : ""}</span>
                  {data.draft.lastClickedAt && (
                    <span className="text-muted-foreground">· last {new Date(data.draft.lastClickedAt).toLocaleString()}</span>
                  )}
                </div>
              </div>
              {data.events.length > 0 && (
                <div className="rounded-md border bg-muted/20 divide-y max-h-48 overflow-y-auto">
                  {data.events.map((ev: any) => (
                    <div key={ev.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      {ev.type === "open" ? (
                        <Eye className="h-3 w-3 text-emerald-500 shrink-0" />
                      ) : (
                        <MousePointer className="h-3 w-3 text-violet-500 shrink-0" />
                      )}
                      <span className="capitalize text-muted-foreground">{ev.type}</span>
                      {ev.url && (
                        <span className="truncate text-muted-foreground max-w-[200px]" title={ev.url}>{ev.url}</span>
                      )}
                      <span className="ml-auto text-muted-foreground shrink-0">
                        {new Date(ev.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

/* ─── Resolved-merge preview (sequence/CRM drafts) ────────────────────────── */

function PreviewResolvedModal({ draftId, open, onClose }: { draftId: number | null; open: boolean; onClose: () => void }) {
  const { data, isLoading } = trpc.smtpConfig.previewResolved.useQuery(
    { draftId: draftId! },
    { enabled: open && draftId != null },
  );
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Preview Resolved Email</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="py-8 text-center text-muted-foreground text-sm">Resolving merge variables…</div>
        ) : data ? (
          <div className="space-y-4">
            {data.unresolvedTokens.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
                <AlertTriangle className="size-4 mt-0.5 shrink-0" />
                <div>
                  <span className="font-medium">Unresolved tokens: </span>
                  {data.unresolvedTokens.join(", ")}
                </div>
              </div>
            )}
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Subject</div>
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm font-medium">{data.resolvedSubject || <span className="text-muted-foreground italic">No subject</span>}</div>
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Body</div>
              <ScrollArea className="h-80 rounded-md border bg-muted/40">
                <div
                  className="p-4 text-sm prose prose-sm dark:prose-invert max-w-none"
                  dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(data.htmlBody) }}
                />
              </ScrollArea>
            </div>
            {data.toEmail && (
              <div className="text-xs text-muted-foreground">To: <span className="font-mono">{data.toEmail}</span></div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* ─── Edit draft dialog (sequence/CRM drafts) ─────────────────────────────── */

function EditDraftDialog({ draft, open, onClose, onChanged }: { draft: any | null; open: boolean; onClose: () => void; onChanged: () => void }) {
  const [subject, setSubject] = useState<string>(draft?.subject ?? "");
  const [body, setBody] = useState<string>(draft?.body ?? "");

  const update = trpc.emailDrafts.update.useMutation({
    onSuccess: () => { onChanged(); toast.success("Draft updated"); onClose(); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit draft</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label className="text-sm">Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Email subject" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Body</Label>
            <RichTextEditor
              value={body}
              onChange={(html) => setBody(html)}
              placeholder="Email body — use {{firstName}}, {{lastName}}, {{company}}, {{senderName}} as merge variables"
              minHeight="280px"
              maxHeight="500px"
              compact
            />
            <p className="text-xs text-muted-foreground">Merge variables: <code>{"{{firstName}}"}</code> <code>{"{{lastName}}"}</code> <code>{"{{company}}"}</code> <code>{"{{senderName}}"}</code></p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => update.mutate({ id: draft.id, subject, body })} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Research context (AI drafts) ────────────────────────────────────────── */

function ResearchAccordion({ job }: { job: any }) {
  const [open, setOpen] = useState(false);
  if (!job) return null;
  const fit = (job.fitAnalysis ?? null) as any;

  return (
    <div className="border-t pt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Research Context
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-lg border bg-muted/30 p-3 text-xs">
          {job.orgResearch && (
            <div>
              <p className="font-semibold text-foreground mb-1">Org Research</p>
              <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">{job.orgResearch}</p>
            </div>
          )}
          {job.contactResearch && (
            <div className="border-t pt-2">
              <p className="font-semibold text-foreground mb-1">Contact Research</p>
              <p className="text-muted-foreground leading-relaxed whitespace-pre-wrap">{job.contactResearch}</p>
            </div>
          )}
          {fit && (
            <div className="border-t pt-2">
              <p className="font-semibold text-foreground mb-1">Fit Analysis</p>
              <div className="space-y-1">
                <p><span className="font-medium">Fit Score:</span> {fit.fit_score ?? "—"}/100</p>
                {(fit.pain_points ?? []).length > 0 && (
                  <div>
                    <p className="font-medium">Pain Points:</p>
                    <ul className="list-disc list-inside text-muted-foreground">
                      {(fit.pain_points as string[]).map((p, i) => <li key={i}>{p}</li>)}
                    </ul>
                  </div>
                )}
                {(fit.personalization_hooks ?? []).length > 0 && (
                  <div>
                    <p className="font-medium">Personalization Hooks:</p>
                    <ul className="list-disc list-inside text-muted-foreground">
                      {(fit.personalization_hooks as string[]).map((h, i) => <li key={i}>{h}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="border-t pt-2">
            <Link href="/research-pipeline" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
              Open the Research Pipeline <ExternalLink className="size-3" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── AI draft tools (regenerate / score / edit & approve) ────────────────── */

type Preset = "more_formal" | "shorter" | "stronger_cta" | "different_angle";

const PRESET_LABELS: Record<Preset, string> = {
  more_formal: "More Formal",
  shorter: "Shorter",
  stronger_cta: "Stronger CTA",
  different_angle: "Different Angle",
};

function AiDraftTools({ draft, onChanged }: { draft: any; onChanged: () => void }) {
  const [editMode, setEditMode] = useState(false);
  const [subject, setSubject] = useState<string>(draft.subject ?? "");
  const [body, setBody] = useState<string>(draft.body ?? "");
  const [scoreData, setScoreData] = useState<any>(null);
  const [regenPreset, setRegenPreset] = useState<Preset>("more_formal");

  const approve = trpc.aiPipeline.approveDraft.useMutation({
    onSuccess: () => { toast.success("Draft approved"); setEditMode(false); onChanged(); },
    onError: (e) => toast.error(e.message),
  });
  const regen = trpc.aiPipeline.regenerateDraft.useMutation({
    onSuccess: (data) => { setSubject(data.subject); setBody(data.body); toast.success("Draft regenerated"); onChanged(); },
    onError: (e) => toast.error(e.message),
  });
  const score = trpc.aiPipeline.scoreDraft.useMutation({
    onSuccess: (data) => setScoreData(data),
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-3">
      {editMode ? (
        <div className="space-y-2">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="text-sm font-medium" placeholder="Subject line" />
          <RichTextEditor value={body} onChange={setBody} minHeight="140px" compact aiContext={{ subject }} />
          <div className="flex items-center gap-2">
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1"
              onClick={() => approve.mutate({ draftId: draft.id, subject, body })} disabled={approve.isPending}>
              {approve.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
              Save & Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditMode(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" className="gap-1" onClick={() => setEditMode(true)}>
            <Pencil className="h-3.5 w-3.5" /> Edit & Approve
          </Button>
          <div className="flex items-center gap-1 ml-auto">
            <Select value={regenPreset} onValueChange={(v) => setRegenPreset(v as Preset)}>
              <SelectTrigger className="h-7 text-xs w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
                  <SelectItem key={p} value={p}>{PRESET_LABELS[p]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="gap-1"
              onClick={() => regen.mutate({ draftId: draft.id, preset: regenPreset })} disabled={regen.isPending}>
              {regen.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Regen
            </Button>
            <Button size="sm" variant="ghost" title="Score this draft"
              onClick={() => score.mutate({ draftId: draft.id })} disabled={score.isPending}>
              {score.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Star className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      )}

      {scoreData && !editMode && (
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
    </div>
  );
}

/* ─── AI compose (the retired AI Pipeline page's trigger panel) ───────────── */

/**
 * Compose AI drafts for chosen contacts — the runForContact/runBulk trigger
 * that lived on /ai-pipeline. Drafts land in this page's "Needs review"
 * filter when the pipeline finishes.
 */
export function AiComposeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [contactSearch, setContactSearch] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const { data: contacts = [], isLoading } = trpc.contacts.list.useQuery(
    contactSearch ? { search: contactSearch } : undefined,
    { enabled: open },
  );
  const runBulk = trpc.aiPipeline.runBulk.useMutation({
    onSuccess: (data) => {
      toast.success(`Pipeline started for ${data.count} contact${data.count === 1 ? "" : "s"} — drafts appear under Needs review when ready`);
      setSelected([]);
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  const toggle = (id: number) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>AI compose</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <p className="text-xs text-muted-foreground">
            The AI pipeline researches each contact's organization and fit, then writes a personalized draft for your review — nothing sends without approval.
          </p>
          <Input value={contactSearch} onChange={(e) => setContactSearch(e.target.value)} placeholder="Search contacts…" className="h-8 text-xs" />
          <div className="rounded-md border max-h-64 overflow-y-auto divide-y">
            {isLoading ? (
              <div className="p-3 text-xs text-muted-foreground">Loading contacts…</div>
            ) : (contacts as any[]).length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground">No contacts match.</div>
            ) : (
              (contacts as any[]).slice(0, 50).map((c) => (
                <label key={c.id} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/40">
                  <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
                  <span className="font-medium">{c.firstName} {c.lastName}</span>
                  <span className="text-muted-foreground truncate">{c.email ?? c.companyName ?? ""}</span>
                </label>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={selected.length === 0 || runBulk.isPending} className="gap-1.5"
            onClick={() => runBulk.mutate({ contactIds: selected })}>
            {runBulk.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Generate {selected.length > 0 ? `for ${selected.length}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─── The drawer entry point ──────────────────────────────────────────────── */

/**
 * `row` is the feed row (identity + status), `detail` the emailActivity.get
 * payload for a draft (full body, tone, pipeline job). Renders nothing for
 * rows that are not drafts.
 */
export function DraftEditorTools({ row, detail, onChanged }: {
  row: { draftId: number | null; status: string; kind: string };
  detail: Record<string, any> | null;
  onChanged: () => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  if (!row.draftId) return null;
  const isAiDraft = row.status === "ai_pending_review";
  const isPendingSequence = row.status === "pending_review" || row.status === "approved";

  return (
    <div className="rounded-lg border bg-card p-3 space-y-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Draft tools</div>
      {isAiDraft && (
        <>
          <AiDraftTools draft={{ id: row.draftId, subject: detail?.subject ?? "", body: detail?.body ?? "" }} onChanged={onChanged} />
          <ResearchAccordion job={detail?.job ?? null} />
        </>
      )}
      {!isAiDraft && isPendingSequence && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setEditOpen(true)}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setPreviewOpen(true)}>
              <Eye className="h-3.5 w-3.5" /> Preview resolved
            </Button>
          </div>
          <SubjectABPanel draftId={row.draftId} onChanged={onChanged} />
        </>
      )}
      <TrackingStatsPanel draftId={row.draftId} status={row.status} />
      {editOpen && (
        <EditDraftDialog
          draft={{ id: row.draftId, subject: detail?.subject ?? "", body: detail?.body ?? "" }}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onChanged={onChanged}
        />
      )}
      <PreviewResolvedModal draftId={row.draftId} open={previewOpen} onClose={() => setPreviewOpen(false)} />
    </div>
  );
}
