import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { trpc } from "@/lib/trpc";
import {
  Loader2, Plus, Sparkles, Target, UserCheck,
  MoreHorizontal, Pencil, Trash2, Send, Tag, Megaphone, Wand2, Download,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const GRADE_TONE: Record<string, string> = { A: "bg-emerald-100 text-emerald-800", B: "bg-blue-100 text-blue-800", C: "bg-amber-100 text-amber-800", D: "bg-rose-100 text-rose-800" };
const TIER_TONE: Record<string, { label: string; cls: string }> = {
  cold: { label: "Cold", cls: "bg-slate-200 text-slate-700" },
  warm: { label: "Warm", cls: "bg-yellow-100 text-yellow-800" },
  hot: { label: "Hot", cls: "bg-orange-100 text-orange-800" },
  sales_ready: { label: "Sales Ready", cls: "bg-emerald-100 text-emerald-800" },
};
function tierFromScore(s: number | null | undefined): keyof typeof TIER_TONE {
  const n = s ?? 0;
  if (n >= 81) return "sales_ready";
  if (n >= 61) return "hot";
  if (n >= 31) return "warm";
  return "cold";
}

/* ─── Send Email Modal ──────────────────────────────────────────────────── */
function SendEmailModal({ open, onOpenChange, leadIds, onComplete }: { open: boolean; onOpenChange: (v: boolean) => void; leadIds: number[]; onComplete: () => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [useAi, setUseAi] = useState(false);
  const [sent, setSent] = useState(false);
  const compose = trpc.emailDrafts.compose.useMutation({
    onSuccess: (d) => { setSubject(d.subject ?? ""); setBody(d.body ?? ""); setUseAi(false); },
    onError: (e: any) => toast.error(e.message),
  });
  const send = trpc.leads.sendAdHocEmail.useMutation({
    onSuccess: () => { setSent(true); onComplete(); },
    onError: (e: any) => toast.error(e.message),
  });
  function reset() { setSubject(""); setBody(""); setAiPrompt(""); setUseAi(false); setSent(false); }
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { reset(); } onOpenChange(v); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Send className="size-4 text-blue-500" />Send Email to {leadIds.length} lead{leadIds.length !== 1 ? "s" : ""}</DialogTitle></DialogHeader>
        {sent ? (
          <div className="py-8 text-center space-y-3">
            <div className="text-4xl">✅</div>
            <p className="text-sm text-muted-foreground">Email sent successfully.</p>
            <Button variant="outline" onClick={reset}>Send another</Button>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2">
              <Button variant={useAi ? "default" : "outline"} size="sm" onClick={() => setUseAi(!useAi)} className="gap-1.5">
                <Wand2 className="size-3.5" />Use AI
              </Button>
              {useAi && (
                <>
                  <Input placeholder="Describe the email…" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} className="flex-1 h-8 text-sm" />
                  <Button size="sm" onClick={() => compose.mutate({ prompt: aiPrompt, contactIds: [] })} disabled={!aiPrompt || compose.isPending}>
                    {compose.isPending ? <Loader2 className="size-3.5 animate-spin" /> : "Generate"}
                  </Button>
                </>
              )}
            </div>
            <Input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <Textarea placeholder="Body…" value={body} onChange={(e) => setBody(e.target.value)} rows={6} />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => send.mutate({ leadIds, subject, body })} disabled={!subject || !body || send.isPending}>
                {send.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Send className="size-4 mr-1" />}
                Send
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─── Add to Campaign Modal ─────────────────────────────────────────────── */
function AddToCampaignModal({ open, onOpenChange, leadIds, onComplete }: { open: boolean; onOpenChange: (v: boolean) => void; leadIds: number[]; onComplete: () => void }) {
  const [campaignId, setCampaignId] = useState("");
  const { data: campaigns } = trpc.campaigns.list.useQuery();
  const addMut = trpc.campaigns.addAudience.useMutation({
    onSuccess: (d) => { toast.success(`Added ${d.added} lead${d.added !== 1 ? "s" : ""} to campaign`); onComplete(); onOpenChange(false); },
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
            <Button onClick={() => addMut.mutate({ campaignId: Number(campaignId), contactIds: leadIds })} disabled={!campaignId || addMut.isPending}>
              {addMut.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Megaphone className="size-4 mr-1" />}
              Add {leadIds.length}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Add to Segment Modal ──────────────────────────────────────────────── */
function AddToSegmentModal({ open, onOpenChange, leadIds, onComplete }: { open: boolean; onOpenChange: (v: boolean) => void; leadIds: number[]; onComplete: () => void }) {
  const [segmentId, setSegmentId] = useState("");
  const { data: segments } = trpc.segments.list.useQuery();
  const addMut = trpc.segments.addContacts.useMutation({
    onSuccess: (d) => { toast.success(`Added ${d.added} lead${d.added !== 1 ? "s" : ""} to segment`); onComplete(); onOpenChange(false); },
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
            <Button onClick={() => addMut.mutate({ segmentId: Number(segmentId), contactIds: leadIds })} disabled={!segmentId || addMut.isPending}>
              {addMut.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Tag className="size-4 mr-1" />}
              Add {leadIds.length}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Edit Lead Dialog ──────────────────────────────────────────────────── */
function EditLeadDialog({ lead, open, onOpenChange, onSaved }: { lead: any; open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void }) {
  const utils = trpc.useUtils();
  const updateMut = trpc.leads.update.useMutation({
    onSuccess: () => { toast.success("Lead updated"); utils.leads.list.invalidate(); onSaved(); onOpenChange(false); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit Lead</DialogTitle></DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            updateMut.mutate({ id: lead.id, patch: {
              firstName: String(f.get("firstName")),
              lastName: String(f.get("lastName")),
              email: String(f.get("email") ?? "") || undefined,
              company: String(f.get("company") ?? "") || undefined,
              title: String(f.get("title") ?? "") || undefined,
              source: String(f.get("source") ?? "") || undefined,
            }});
          }}
          className="space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <Field name="firstName" label="First name" required defaultValue={lead?.firstName} />
            <Field name="lastName" label="Last name" required defaultValue={lead?.lastName} />
          </div>
          <Field name="email" label="Email" type="email" defaultValue={lead?.email} />
          <div className="grid grid-cols-2 gap-3">
            <Field name="title" label="Title" defaultValue={lead?.title} />
            <Field name="company" label="Company" defaultValue={lead?.company} />
          </div>
          <Field name="source" label="Source" defaultValue={lead?.source} />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={updateMut.isPending}>Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Main Leads page ───────────────────────────────────────────────────── */
export default function Leads() {
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ id: number; name: string; subtitle: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sendEmailOpen, setSendEmailOpen] = useState(false);
  const [addToCampaignOpen, setAddToCampaignOpen] = useState(false);
  const [addToSegmentOpen, setAddToSegmentOpen] = useState(false);
  const [editLead, setEditLead] = useState<any | null>(null);
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.leads.list.useQuery({ search });

  const rescore = trpc.leadScoring.recompute.useMutation({
    onSuccess: () => { utils.leads.list.invalidate(); toast.success("Re-scored"); },
  });
  const convert = trpc.leads.convert.useMutation({
    onSuccess: () => { utils.leads.list.invalidate(); utils.workspace.summary.invalidate(); toast.success("Converted to account + contact + opportunity"); },
  });
  const deleteMut = trpc.leads.delete.useMutation({
    onSuccess: () => { utils.leads.list.invalidate(); toast.success("Lead deleted"); },
    onError: (e: any) => toast.error(e.message),
  });

  const allIds = (data ?? []).map((l) => l.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));
  const someSelected = selectedIds.size > 0;

  function toggleAll() {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(allIds));
  }
  function toggleOne(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <Shell title="Leads">
      <PageHeader title="Leads" description="Inbound + outbound lead inbox with AI grading." pageKey="leads">
        <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-56" />
        {someSelected && (
          <>
            <Button variant="outline" onClick={() => setSendEmailOpen(true)} className="gap-2">
              <Send className="h-4 w-4 text-blue-500" />Send Email ({selectedIds.size})
            </Button>
            <Button variant="outline" onClick={() => setAddToCampaignOpen(true)} className="gap-2">
              <Megaphone className="h-4 w-4 text-orange-500" />Add to Campaign ({selectedIds.size})
            </Button>
            <Button variant="outline" onClick={() => setAddToSegmentOpen(true)} className="gap-2">
              <Tag className="h-4 w-4 text-violet-500" />Add to Segment ({selectedIds.size})
            </Button>
          </>
        )}
        <Button variant="outline" onClick={() => {
          const rows = data ?? [];
          if (!rows.length) return;
          const cols = ["id", "firstName", "lastName", "email", "phone", "company", "title", "source", "score", "status", "createdAt"];
          const lines = [cols.join(","), ...rows.map((r: any) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))];
          const blob = new Blob([lines.join("\n")], { type: "text/csv" });
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `leads-${Date.now()}.csv`; a.click();
        }} disabled={!data?.length}>
          <Download className="size-4" /> Export CSV
        </Button>
        <Button onClick={() => setCreateOpen(true)}><Plus className="size-4" /> New lead</Button>
      </PageHeader>
      <div className="p-6">
        {isLoading ? <Loader2 className="animate-spin size-4" /> : (data ?? []).length === 0 ? (
          <EmptyState icon={Target} title="No leads yet" description="Create one or wait for inbound." />
        ) : (
          <div className="rounded-lg border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 w-8">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded border-gray-300 cursor-pointer" title="Select all" />
                  </th>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Title / Company</th>
                  <th className="text-left px-3 py-2">Email</th>
                  <th className="text-left px-3 py-2">Source</th>
                  <th className="text-left px-3 py-2">Score</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data!.map((l) => (
                  <tr key={l.id} className={`hover:bg-secondary/30 cursor-pointer ${selectedIds.has(l.id) ? "bg-primary/5" : ""}`}
                    onClick={() => setDrawer({ id: l.id, name: `${l.firstName} ${l.lastName}`, subtitle: `${l.title ?? ""} · ${l.company ?? ""}` })}>
                    <td className="px-3 py-2" onClick={(e) => { e.stopPropagation(); toggleOne(l.id); }}>
                      <input type="checkbox" checked={selectedIds.has(l.id)} readOnly className="rounded border-gray-300 cursor-pointer" />
                    </td>
                    <td className="px-3 py-2 font-medium"><span className="underline-offset-2 hover:underline">{l.firstName} {l.lastName}</span></td>
                    <td className="px-3 py-2 text-muted-foreground">{l.title} · {l.company}</td>
                    <td className="px-3 py-2 text-muted-foreground">{l.email}</td>
                    <td className="px-3 py-2 text-muted-foreground">{l.source}</td>
                    <td className="px-3 py-2">
                      <span className="font-mono tabular-nums">{l.score}</span>
                      <span className={`ml-2 inline-block px-1.5 rounded text-xs ${GRADE_TONE[l.grade ?? "C"] ?? ""}`}>{l.grade ?? "—"}</span>
                      {(() => { const t = tierFromScore(l.score); return <span className={`ml-1 inline-block px-1.5 rounded text-xs ${TIER_TONE[t].cls}`}>{TIER_TONE[t].label}</span>; })()}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{l.status}</td>
                    <td className="px-3 py-2 text-right space-x-1" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="ghost" onClick={() => rescore.mutate({ leadId: l.id })} disabled={rescore.isPending}><Sparkles className="size-3.5" /> AI score</Button>
                      {l.status !== "converted" && (
                        <Button size="sm" variant="outline" className="bg-card" onClick={() => convert.mutate({ id: l.id, createOpportunity: true })} disabled={convert.isPending}><UserCheck className="size-3.5" /> Convert</Button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-7">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditLead(l)}>
                            <Pencil className="size-4 mr-2" />Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDrawer({ id: l.id, name: `${l.firstName} ${l.lastName}`, subtitle: `${l.title ?? ""} · ${l.company ?? ""}` })}>
                            <Target className="size-4 mr-2" />View details
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => { setSelectedIds(new Set([l.id])); setSendEmailOpen(true); }}>
                            <Send className="size-4 mr-2" />Send Email
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => { setSelectedIds(new Set([l.id])); setAddToCampaignOpen(true); }}>
                            <Megaphone className="size-4 mr-2" />Add to Campaign
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => { setSelectedIds(new Set([l.id])); setAddToSegmentOpen(true); }}>
                            <Tag className="size-4 mr-2" />Add to Segment
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive" onClick={() => { if (confirm(`Delete ${l.firstName} ${l.lastName}?`)) deleteMut.mutate({ id: l.id }); }}>
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

      <CreateLeadDialog open={createOpen} onOpenChange={setCreateOpen} />
      <RecordDrawer open={!!drawer} onOpenChange={(v) => !v && setDrawer(null)} relatedType="lead" relatedId={drawer?.id ?? null} title={drawer?.name ?? ""} subtitle={drawer?.subtitle} />
      <SendEmailModal open={sendEmailOpen} onOpenChange={setSendEmailOpen} leadIds={Array.from(selectedIds)} onComplete={() => setSelectedIds(new Set())} />
      <AddToCampaignModal open={addToCampaignOpen} onOpenChange={setAddToCampaignOpen} leadIds={Array.from(selectedIds)} onComplete={() => setSelectedIds(new Set())} />
      <AddToSegmentModal open={addToSegmentOpen} onOpenChange={setAddToSegmentOpen} leadIds={Array.from(selectedIds)} onComplete={() => setSelectedIds(new Set())} />
      {editLead && (
        <EditLeadDialog lead={editLead} open={!!editLead} onOpenChange={(v) => !v && setEditLead(null)} onSaved={() => setEditLead(null)} />
      )}
    </Shell>
  );
}

function CreateLeadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const utils = trpc.useUtils();
  const create = trpc.leads.create.useMutation({
    onSuccess: () => { utils.leads.list.invalidate(); onOpenChange(false); toast.success("Lead created"); },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>New lead</DialogTitle></DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            create.mutate({
              firstName: String(f.get("firstName")),
              lastName: String(f.get("lastName")),
              email: String(f.get("email") ?? "") || undefined,
              company: String(f.get("company") ?? "") || undefined,
              title: String(f.get("title") ?? "") || undefined,
              source: String(f.get("source") ?? "manual") || "manual",
            });
          }}
          className="space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <Field name="firstName" label="First name" required />
            <Field name="lastName" label="Last name" required />
          </div>
          <Field name="email" label="Email" type="email" />
          <div className="grid grid-cols-2 gap-3">
            <Field name="title" label="Title" />
            <Field name="company" label="Company" />
          </div>
          <Field name="source" label="Source" placeholder="manual / webform / event…" />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>Create</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field(props: { name: string; label: string; type?: string; required?: boolean; placeholder?: string; defaultValue?: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={props.name}>{props.label}</Label>
      <Input id={props.name} name={props.name} type={props.type ?? "text"} required={props.required} placeholder={props.placeholder} defaultValue={props.defaultValue} />
    </div>
  );
}
