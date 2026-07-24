/**
 * FormsV2 — the Grow → "Forms" surface (/v2/forms).
 *
 * Lead-capture forms with autonomous handling: each submission can auto-create a
 * lead, auto-route it to a rep, and auto-enroll it in a sequence (feeding the top
 * of the pipeline). Backed by the new `forms` router; the public fill page lives
 * at /f/:publicId.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { confirmAction } from "@/components/usip/Common";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  FileText, Plus, Copy, ExternalLink, Trash2, Inbox, Zap, Route as RouteIcon, UserPlus, Send,
} from "lucide-react";

type Form = {
  id: number; publicId: string; title: string; description?: string | null;
  fields?: any; status: string; autoCreateLead?: boolean; autoRoute?: boolean;
  autoEnrollSequenceId?: number | null; submitCount?: number | null; updatedAt?: string | Date | null;
};

const FIELD_PALETTE = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "company", label: "Company" },
  { key: "title", label: "Job title" },
  { key: "message", label: "Message" },
];

function publicUrl(publicId: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/f/${publicId}`;
}

export default function FormsV2() {
  const accent = useAccentColor();
  const utils = trpc.useUtils();
  const [createOpen, setCreateOpen] = useState(false);
  const [subsFor, setSubsFor] = useState<Form | null>(null);

  const list = trpc.forms.list.useQuery(undefined as any, { retry: false });
  const seqs = trpc.sequences.list.useQuery(undefined as any, { retry: false });

  const invalidate = () => utils.forms.list.invalidate();
  const toggle = trpc.forms.toggle.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const del = trpc.forms.delete.useMutation({ onSuccess: () => { invalidate(); toast.success("Form deleted"); }, onError: (e) => toast.error(e.message) });
  const create = trpc.forms.create.useMutation({
    onSuccess: () => { invalidate(); toast.success("Form created"); setCreateOpen(false); },
    onError: (e) => toast.error(e.message),
  });

  const forms = (list.data as Form[]) ?? [];
  const sequences = ((seqs.data as any[]) ?? []).map((s) => ({ id: s.id, name: s.name ?? `Sequence ${s.id}` }));

  const copyUrl = (publicId: string) => {
    const url = publicUrl(publicId);
    if (navigator?.clipboard) navigator.clipboard.writeText(url).then(() => toast.success("Public link copied")).catch(() => toast.message(url));
    else toast.message(url);
  };

  return (
    <Shell title="Forms">
      <div className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <FileText className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Forms</h1>
          <div className="flex-1" />
          <Button size="sm" className="h-7 gap-1.5" onClick={() => setCreateOpen(true)}><Plus className="size-3.5" /> New form</Button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-4">
          <div className="rounded-lg border bg-card px-4 py-2.5 flex items-center gap-3 shadow-sm">
            <span className="shrink-0 size-8 rounded-full flex items-center justify-center" style={{ backgroundColor: "#7c3aed1f", color: "#7c3aed" }}><Zap className="size-4" /></span>
            <div className="text-[12px] text-muted-foreground">Submissions run autonomously: a new lead is created, <b>auto-routed</b> to a rep, and (optionally) <b>auto-enrolled</b> into a sequence — no manual triage.</div>
          </div>

          {list.isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-24 rounded-xl bg-muted/50 animate-pulse" />)}</div>
          ) : list.error ? (
            <div className="rounded-xl border bg-card text-center py-12 px-4">
              <p className="text-sm text-muted-foreground">Couldn’t load forms. {list.error.message}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => list.refetch()}>Retry</Button>
            </div>
          ) : forms.length === 0 ? (
            <div className="rounded-xl border bg-card text-center py-14 px-4">
              <FileText className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
              <div className="text-sm font-medium">No forms yet</div>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">Create a lead-capture form, share its link or embed it, and captured leads flow straight into your autonomous pipeline.</p>
              <Button size="sm" className="mt-3 gap-1.5" onClick={() => setCreateOpen(true)}><Plus className="size-3.5" /> New form</Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {forms.map((f) => (
                <div key={f.id} className="rounded-xl border bg-card p-3.5 shadow-sm">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate flex items-center gap-2">
                        {f.title}
                        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px]", f.status === "active" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" : "bg-secondary text-muted-foreground")}>{f.status}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">{f.submitCount ?? 0} submissions</div>
                    </div>
                    <Switch checked={f.status === "active"} onCheckedChange={(v) => toggle.mutate({ id: f.id, status: v ? "active" : "inactive" })} />
                  </div>
                  <div className="flex items-center gap-1.5 mt-2 text-[10px] text-muted-foreground">
                    {f.autoCreateLead && <span className="inline-flex items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5"><UserPlus className="size-3" /> lead</span>}
                    {f.autoRoute && <span className="inline-flex items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5"><RouteIcon className="size-3" /> routed</span>}
                    {f.autoEnrollSequenceId && <span className="inline-flex items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5"><Send className="size-3" /> enrolled</span>}
                  </div>
                  <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t">
                    <Button size="sm" variant="outline" className="h-7 gap-1 text-[11px]" onClick={() => copyUrl(f.publicId)}><Copy className="size-3" /> Copy link</Button>
                    <a href={publicUrl(f.publicId)} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost" className="h-7 gap-1 text-[11px]"><ExternalLink className="size-3" /> Preview</Button></a>
                    <Button size="sm" variant="ghost" className="h-7 gap-1 text-[11px]" onClick={() => setSubsFor(f)}><Inbox className="size-3" /> Submissions</Button>
                    <div className="flex-1" />
                    <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-rose-600" title="Delete" onClick={() => { confirmAction({ title: `Delete "${f.title}"?`, description: "This form and its capture link will be permanently deleted. This cannot be undone.", confirmLabel: "Delete" }, () => { del.mutate({ id: f.id }); }); }}><Trash2 className="size-3.5" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <CreateFormDialog open={createOpen} onOpenChange={setCreateOpen} sequences={sequences} onCreate={(v) => create.mutate(v as any)} pending={create.isPending} />
      <SubmissionsDialog form={subsFor} onClose={() => setSubsFor(null)} />
    </Shell>
  );
}

function CreateFormDialog({ open, onOpenChange, sequences, onCreate, pending }: {
  open: boolean; onOpenChange: (v: boolean) => void; sequences: { id: number; name: string }[];
  onCreate: (v: any) => void; pending: boolean;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({ firstName: true, lastName: true, email: true, company: true });
  const [autoCreateLead, setAutoCreateLead] = useState(true);
  const [autoRoute, setAutoRoute] = useState(true);
  const [enrollSeq, setEnrollSeq] = useState<string>("none");

  const submit = () => {
    if (!title.trim()) return;
    const fields = FIELD_PALETTE.filter((f) => selected[f.key]).map((f) => ({ key: f.key, label: f.label, required: f.key === "email" }));
    if (fields.length === 0) { toast.error("Pick at least one field"); return; }
    onCreate({
      title: title.trim(), description: description.trim() || undefined, fields,
      autoCreateLead, autoRoute,
      autoEnrollSequenceId: enrollSeq !== "none" ? Number(enrollSeq) : null,
    });
    setTitle(""); setDescription(""); setSelected({ firstName: true, lastName: true, email: true, company: true }); setEnrollSeq("none");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New form</DialogTitle>
          <DialogDescription>Capture leads and hand them straight to the autonomous pipeline.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-auto">
          <div className="space-y-1.5">
            <Label htmlFor="f-title">Title</Label>
            <Input id="f-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Request a demo" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-desc">Description</Label>
            <Textarea id="f-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Optional intro shown above the form" />
          </div>
          <div className="space-y-1.5">
            <Label>Fields</Label>
            <div className="flex flex-wrap gap-1.5">
              {FIELD_PALETTE.map((f) => (
                <button key={f.key} type="button" onClick={() => setSelected((s) => ({ ...s, [f.key]: !s[f.key] }))}
                  className={cn("rounded-full border px-2.5 py-1 text-[11px] transition-colors", selected[f.key] ? "text-white border-transparent" : "hover:bg-muted")}
                  style={selected[f.key] ? { backgroundColor: "var(--primary, #14B89A)" } : undefined}>
                  {f.label}{f.key === "email" ? " *" : ""}
                </button>
              ))}
            </div>
          </div>
          <div className="rounded-lg border p-2.5 space-y-2.5">
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1"><Zap className="size-3" style={{ color: "#7c3aed" }} /> Autonomous handling</div>
            <label className="flex items-center justify-between text-sm cursor-pointer"><span>Auto-create a lead</span><Switch checked={autoCreateLead} onCheckedChange={setAutoCreateLead} /></label>
            <label className="flex items-center justify-between text-sm cursor-pointer"><span>Auto-route to a rep</span><Switch checked={autoRoute} onCheckedChange={setAutoRoute} disabled={!autoCreateLead} /></label>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm">Auto-enroll in sequence</span>
              <Select value={enrollSeq} onValueChange={setEnrollSeq} disabled={!autoCreateLead}>
                <SelectTrigger className="h-7 w-[160px] text-xs"><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {sequences.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={pending || !title.trim()} onClick={submit}>{pending ? "Creating…" : "Create form"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SubmissionsDialog({ form, onClose }: { form: Form | null; onClose: () => void }) {
  const subs = trpc.forms.submissions.useQuery({ formId: form?.id ?? 0 }, { enabled: !!form, retry: false });
  const rows = (subs.data as any[]) ?? [];
  return (
    <Dialog open={!!form} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate">{form?.title} — submissions</DialogTitle>
          <DialogDescription>{rows.length} total · leads auto-created &amp; routed</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-auto rounded-lg border">
          {subs.isLoading ? (
            <div className="p-3 space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-9 rounded bg-muted/50 animate-pulse" />)}</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-10 text-xs text-muted-foreground">No submissions yet. Share the form link to start capturing leads.</div>
          ) : rows.map((r: any) => (
            <div key={r.id} className="flex items-center gap-3 px-3 py-2 border-b border-border/60 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium truncate">{r.name || r.email || "Anonymous"}</div>
                <div className="text-[11px] text-muted-foreground truncate">{[r.email, r.company].filter(Boolean).join(" · ")}</div>
              </div>
              {r.leadId && <span className="shrink-0 text-[10px] rounded px-1.5 py-0.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">lead #{r.leadId}</span>}
              <div className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ""}</div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
