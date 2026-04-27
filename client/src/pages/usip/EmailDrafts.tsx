import { Button } from "@/components/ui/button";
import { Field, FormDialog, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { BarChart2, Check, ChevronDown, ChevronRight, Eye, FileText, MousePointer, Pencil, Send, Sparkles, Trash2, X, Zap, AlertTriangle, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";

function SubjectABPanel({ draftId }: { draftId: number }) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const { data: variants = [], refetch } = trpc.subjectAB.list.useQuery({ emailDraftId: draftId }, { enabled: open });
  const generate = trpc.subjectAB.generate.useMutation({
    onSuccess: () => { refetch(); toast.success("Variants generated"); },
    onError: (e) => toast.error(e.message),
  });
  const select = trpc.subjectAB.select.useMutation({
    onSuccess: () => { utils.emailDrafts.list.invalidate(); refetch(); toast.success("Subject applied"); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="mt-3 border-t pt-3">
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
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => generate.mutate({ emailDraftId: draftId })}
            disabled={generate.isPending}
          >
            {generate.isPending ? "Generating…" : "Generate 3 variants"}
          </Button>
          {variants.map((v: any) => (
            <div
              key={v.id}
              className={`rounded-md border px-3 py-2 text-xs space-y-1 ${
                v.isSelected ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30" : "bg-muted/30"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium flex-1">{v.subject}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge
                    variant="outline"
                    className={`text-xs ${
                      Number(v.spamScore) <= 10
                        ? "border-emerald-400 text-emerald-700"
                        : Number(v.spamScore) <= 25
                        ? "border-amber-400 text-amber-700"
                        : "border-red-400 text-red-700"
                    }`}
                  >
                    Spam {v.spamScore}
                  </Badge>
                  {!v.isSelected && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs px-2"
                      onClick={() => select.mutate({ variantId: v.id, emailDraftId: draftId })}
                      disabled={select.isPending}
                    >
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

function TrackingStatsPanel({ draftId, status }: { draftId: number; status: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = trpc.smtpConfig.getTrackingStats.useQuery(
    { draftId },
    { enabled: open && status === "sent" }
  );
  if (status !== "sent") return null;
  return (
    <div className="mt-2 border-t pt-2">
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

function PreviewResolvedModal({ draftId, open, onClose }: { draftId: number | null; open: boolean; onClose: () => void }) {
  const { data, isLoading } = trpc.smtpConfig.previewResolved.useQuery(
    { draftId: draftId! },
    { enabled: open && draftId != null }
  );
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl">
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
                  dangerouslySetInnerHTML={{ __html: data.htmlBody }}
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

// ─── EditDraftDialog ─────────────────────────────────────────────────────────
function EditDraftDialog({ draft, open, onClose }: { draft: any | null; open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (!draft || !open) return;
    setSubject(draft.subject ?? "");
    setBody(draft.body ?? "");
  }, [draft, open]);

  const update = trpc.emailDrafts.update.useMutation({
    onSuccess: () => {
      utils.emailDrafts.list.invalidate();
      toast.success("Draft updated");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl">
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
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              className="resize-y font-mono text-sm"
              placeholder="Email body — use {{firstName}}, {{lastName}}, {{company}}, {{senderName}} as merge variables"
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

export default function EmailDrafts() {
  const [composeOpen, setComposeOpen] = useState(false);
  const [previewDraftId, setPreviewDraftId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<any | null>(null);
  const [filter, setFilter] = useState<"pending_review" | "approved" | "sent" | "rejected" | "all" | "bounced">("pending_review");
  const [location, setLocation] = useLocation();
  const utils = trpc.useUtils();

  // Feature 58: read ?filter=bounced from URL on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const f = params.get("filter");
    if (f === "bounced") setFilter("bounced");
  }, [location]);

  // For bounced filter, fetch all sent emails then filter client-side (bouncedAt IS NOT NULL)
  const { data: allData } = trpc.emailDrafts.list.useQuery(
    { status: filter === "bounced" ? "sent" : filter === "all" ? undefined : filter as any },
  );
  const data = filter === "bounced"
    ? (allData ?? []).filter((d) => d.bouncedAt != null)
    : allData;
  const { data: contacts } = trpc.contacts.list.useQuery();
  const compose = trpc.emailDrafts.compose.useMutation({
    onSuccess: () => { utils.emailDrafts.list.invalidate(); setComposeOpen(false); toast.success("Draft created — review it below"); },
  });
  const approve = trpc.emailDrafts.approve.useMutation({ onSuccess: () => utils.emailDrafts.list.invalidate() });
  const reject = trpc.emailDrafts.reject.useMutation({ onSuccess: () => utils.emailDrafts.list.invalidate() });
  const sendViaDb = trpc.emailDrafts.send.useMutation({ onSuccess: () => { utils.emailDrafts.list.invalidate(); toast.success("Draft marked sent"); } });
  const sendViaSmtp = trpc.smtpConfig.sendDraft.useMutation({
    onSuccess: () => { utils.emailDrafts.list.invalidate(); toast.success("Email sent via SMTP"); },
    onError: (e) => {
      // If SMTP not configured, show a warning
      if (e.message.includes("SMTP") || e.message.includes("not configured") || e.message.includes("No active SMTP")) {
        toast.warning("SMTP not configured — configure SMTP in Settings → Email Delivery first.");
      } else {
        toast.error(e.message);
      }
    },
  });
  const sendBulkApproved = trpc.smtpConfig.sendBulkApproved.useMutation({
    onSuccess: (data) => { utils.emailDrafts.list.invalidate(); toast.success(`Sent ${data.sent} emails, ${data.failed} failed`); },
    onError: (e) => toast.error(e.message),
  });

  // Feature 60: remove from suppression by email
  const removeSuppressionByEmail = trpc.emailSuppressions.removeByEmail.useMutation({
    onSuccess: (_, vars) => {
      utils.emailDrafts.list.invalidate();
      utils.emailSuppressions.list.invalidate();
      utils.emailSuppressions.summary.invalidate();
      toast.success(`${vars.email} removed from suppression list. You can now send emails to this address.`);
    },
    onError: (e) => toast.error(`Failed to remove suppression: ${e.message}`),
  });

  return (
    <Shell title="Email Drafts">
      <PageHeader title="Email Drafts" description="AI-generated outbound that requires human review before send." pageKey="email-drafts">
        <div className="flex items-center gap-1 bg-secondary rounded-md p-0.5">
          {(["pending_review", "approved", "sent", "rejected", "all", "bounced"] as const).map((f) => (
            <button
              key={f}
              onClick={() => {
                setFilter(f);
                if (f !== "bounced") setLocation("/email-drafts");
              }}
              className={`px-2 py-1 text-xs rounded flex items-center gap-1 ${
                filter === f ? "bg-card shadow-sm" : "text-muted-foreground"
              } ${f === "bounced" ? "text-red-500" : ""}`}
            >
              {f === "bounced" && <XCircle className="size-3" />}
              {f.replace("_", " ")}
            </button>
          ))}
        </div>
        {filter === "approved" && (
          <Button size="sm" variant="outline" onClick={() => sendBulkApproved.mutate({})} disabled={sendBulkApproved.isPending}>
            <Send className="size-4" /> Send All Approved
          </Button>
        )}
        <Button onClick={() => setComposeOpen(true)}><Sparkles className="size-4" /> AI compose</Button>
      </PageHeader>
      <div className="p-6 space-y-3">
        {(data ?? []).length === 0 ? <EmptyState icon={FileText} title="No drafts" /> : data!.map((d) => (
          <div key={d.id} className={`rounded-lg border bg-card p-4 ${d.bouncedAt ? "border-red-500/30" : ""}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <StatusPill tone={d.status === "pending_review" ? "warning" : d.status === "approved" ? "info" : d.status === "sent" ? "success" : "muted"}>{d.status}</StatusPill>
              {/* Feature 57 + 60: Bounced badge + Remove from suppression */}
              {d.bouncedAt && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge
                    variant="destructive"
                    className="text-xs bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30"
                    title={d.bounceMessage ?? "Bounced"}
                  >
                    <XCircle className="size-3 mr-1" />
                    {d.bounceType === "hard"
                      ? "Hard Bounce"
                      : d.bounceType === "soft"
                      ? "Soft Bounce"
                      : d.bounceType === "spam"
                      ? "Spam Complaint"
                      : "Bounced"}
                  </Badge>
                  {/* Feature 60: Remove from suppression inline button */}
                  {(d.toEmail) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-red-600"
                      title={`Remove ${d.toEmail} from suppression list`}
                      disabled={removeSuppressionByEmail.isPending}
                      onClick={() => removeSuppressionByEmail.mutate({ email: d.toEmail! })}
                    >
                      <Trash2 className="size-3 mr-1" />
                      Remove suppression
                    </Button>
                  )}
                </div>
              )}
              <div className="text-sm font-medium flex-1 truncate">{d.subject}</div>
              <div className="flex gap-1">
                {(d.status === "pending_review" || d.status === "rejected") && (
                  <Button size="sm" variant="ghost" onClick={() => setEditDraft(d)}><Pencil className="size-3.5" /> Edit</Button>
                )}
                {d.status === "pending_review" && <>
                  <Button size="sm" variant="ghost" onClick={() => approve.mutate({ id: d.id })}><Check className="size-3.5" /> Approve</Button>
                  <Button size="sm" variant="ghost" onClick={() => reject.mutate({ id: d.id })}><X className="size-3.5" /> Reject</Button>
                </>}
                {d.status === "approved" && (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEditDraft(d)}><Pencil className="size-3.5" /> Edit</Button>
                    <Button size="sm" variant="ghost" onClick={() => setPreviewDraftId(d.id)}><Eye className="size-3.5" /> Preview</Button>
                    <Button size="sm" onClick={() => sendViaSmtp.mutate({ draftId: d.id })} disabled={sendViaSmtp.isPending}><Send className="size-3.5" /> Send</Button>
                  </>
                )}
              </div>
            </div>
            <div className="text-sm whitespace-pre-wrap mt-3 text-muted-foreground">{d.body}</div>
            <SubjectABPanel draftId={d.id} />
            <TrackingStatsPanel draftId={d.id} status={d.status} />
          </div>
        ))}
      </div>

      <PreviewResolvedModal draftId={previewDraftId} open={previewDraftId != null} onClose={() => setPreviewDraftId(null)} />
      <EditDraftDialog draft={editDraft} open={!!editDraft} onClose={() => setEditDraft(null)} />

      <FormDialog open={composeOpen} onOpenChange={setComposeOpen} title="AI compose email" isPending={compose.isPending}
        onSubmit={(f) => compose.mutate({
          prompt: String(f.get("prompt")),
          tone: f.get("tone") as any,
          toContactId: Number(f.get("toContactId")) || undefined,
        })}>
        <SelectField name="toContactId" label="To contact" options={[{ value: "", label: "—" }, ...((contacts ?? []).map((c) => ({ value: String(c.id), label: `${c.firstName} ${c.lastName}` })))]} />
        <SelectField name="tone" label="Tone" options={["concise", "warm", "formal", "punchy"].map((t) => ({ value: t, label: t }))} defaultValue="concise" />
        <TextareaField name="prompt" label="What's the angle?" required placeholder="Follow up on our demo last week, propose a 30-min call to scope phase 2" rows={5} />
      </FormDialog>
    </Shell>
  );
}
