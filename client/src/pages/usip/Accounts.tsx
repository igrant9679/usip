import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, fmt$, FormDialog, SelectField, Section, StatusPill } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { trpc } from "@/lib/trpc";
import { Building2, ChevronRight, Plus, MoreHorizontal, Pencil, Trash2, Tag, Megaphone, Loader2, Send, Wand2, CheckCircle2, Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/* ─── Send Email Modal (with contact picker for accounts) ───────────────── */
function SendEmailModal({ open, onOpenChange, accountIds, onComplete }: { open: boolean; onOpenChange: (v: boolean) => void; accountIds: number[]; onComplete: () => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [useAi, setUseAi] = useState(false);
  const [sent, setSent] = useState(false);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(new Set());

  const { data: accountContacts } = trpc.contacts.list.useQuery(
    accountIds.length === 1 ? { accountId: accountIds[0] } : undefined,
    { enabled: open && accountIds.length > 0 }
  );

  const generate = trpc.emailDrafts.compose.useMutation({
    onSuccess: (data) => {
      setSubject(data.subject ?? "");
      setBody(data.body ?? "");
      setUseAi(false);
      toast.success("AI email generated — review and send");
    },
    onError: (e: any) => toast.error(e.message),
  });

  const send = trpc.contacts.sendAdHocEmail.useMutation({
    onSuccess: (d) => {
      setSent(true);
      toast.success(`Email sent to ${d.sent} contact${d.sent !== 1 ? "s" : ""}${d.skipped > 0 ? ` (${d.skipped} skipped — no email)` : ""}`);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const contactsToSend = selectedContactIds.size > 0 ? Array.from(selectedContactIds) : (accountContacts ?? []).map((c: any) => c.id);

  function toggleContact(id: number) {
    setSelectedContactIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }

  function reset() {
    setSubject(""); setBody(""); setAiPrompt(""); setUseAi(false); setSent(false); setSelectedContactIds(new Set());
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { reset(); } onOpenChange(v); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Send className="size-4 text-blue-500" />Send Email to Account Contacts</DialogTitle></DialogHeader>
        {sent ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <CheckCircle2 className="size-10 text-emerald-500" />
            <p className="text-sm font-medium">Email sent successfully</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={reset}>Send another</Button>
              <Button size="sm" onClick={() => { reset(); onComplete(); onOpenChange(false); }}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Contact picker */}
            {accountContacts && accountContacts.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Select recipients (all checked by default):</p>
                <div className="max-h-36 overflow-y-auto border rounded-md divide-y">
                  {accountContacts.map((c: any) => (
                    <label key={c.id} className="flex items-center gap-2 px-3 py-2 hover:bg-secondary/30 cursor-pointer">
                      <input type="checkbox" checked={selectedContactIds.size === 0 || selectedContactIds.has(c.id)} onChange={() => toggleContact(c.id)} className="rounded border-gray-300" />
                      <span className="text-sm flex-1">{c.firstName} {c.lastName}</span>
                      <span className="text-xs text-muted-foreground">{c.email ?? "no email"}</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">{contactsToSend.length} recipient{contactsToSend.length !== 1 ? "s" : ""} selected</p>
              </div>
            )}
            {accountContacts && accountContacts.length === 0 && (
              <p className="text-sm text-muted-foreground">No contacts found for this account.</p>
            )}
            {/* AI compose toggle */}
            <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/30">
              <Wand2 className="size-4 text-violet-500 shrink-0" />
              <div className="flex-1 text-sm">Generate with AI</div>
              <Button size="sm" variant={useAi ? "default" : "outline"} onClick={() => setUseAi(!useAi)}>
                {useAi ? "Cancel" : "Use AI"}
              </Button>
            </div>
            {useAi && (
              <div className="space-y-2">
                <Textarea
                  placeholder="Describe the email (e.g. 'Follow up on our demo last week, offer a free trial')"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  rows={3}
                />
                <Button size="sm" className="w-full" onClick={() => generate.mutate({ prompt: aiPrompt })} disabled={!aiPrompt.trim() || generate.isPending}>
                  {generate.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Wand2 className="size-4 mr-1" />}
                  Generate Email
                </Button>
              </div>
            )}
            {/* Subject + Body */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Subject</label>
              <Input placeholder="Email subject…" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Body</label>
              <Textarea placeholder="Email body…" value={body} onChange={(e) => setBody(e.target.value)} rows={8} />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => { reset(); onOpenChange(false); }}>Cancel</Button>
              <Button
                onClick={() => send.mutate({ contactIds: contactsToSend, subject, body, aiGenerated: generate.isSuccess })}
                disabled={!subject.trim() || !body.trim() || contactsToSend.length === 0 || send.isPending}
              >
                {send.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Send className="size-4 mr-1" />}
                Send to {contactsToSend.length}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─── Add to Campaign Modal (with contact picker for accounts) ──────────── */
function AddToCampaignModal({ open, onOpenChange, accountIds, onComplete }: { open: boolean; onOpenChange: (v: boolean) => void; accountIds: number[]; onComplete: () => void }) {
  const [campaignId, setCampaignId] = useState("");
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(new Set());
  const { data: campaigns } = trpc.campaigns.list.useQuery();
  // Load contacts for all selected accounts
  const { data: accountContacts } = trpc.contacts.list.useQuery(
    accountIds.length === 1 ? { accountId: accountIds[0] } : undefined,
    { enabled: open && accountIds.length > 0 }
  );
  const addMut = trpc.campaigns.addAudience.useMutation({
    onSuccess: (d) => { toast.success(`Added ${d.added} contact${d.added !== 1 ? "s" : ""} to campaign`); onComplete(); onOpenChange(false); setCampaignId(""); setSelectedContactIds(new Set()); },
    onError: (e: any) => toast.error(e.message),
  });
  const contactsToAdd = selectedContactIds.size > 0 ? Array.from(selectedContactIds) : (accountContacts ?? []).map((c: any) => c.id);
  function toggleContact(id: number) {
    setSelectedContactIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Megaphone className="size-4 text-orange-500" />Add to Campaign</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <Select value={campaignId} onValueChange={setCampaignId}>
            <SelectTrigger><SelectValue placeholder="Choose a campaign..." /></SelectTrigger>
            <SelectContent>{(campaigns ?? []).map((c: any) => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
          {accountContacts && accountContacts.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-2">Select individual contacts from this account (or leave all checked to add everyone):</p>
              <div className="max-h-48 overflow-y-auto border rounded-md divide-y">
                {accountContacts.map((c: any) => (
                  <label key={c.id} className="flex items-center gap-2 px-3 py-2 hover:bg-secondary/30 cursor-pointer">
                    <input type="checkbox" checked={selectedContactIds.size === 0 || selectedContactIds.has(c.id)} onChange={() => toggleContact(c.id)} className="rounded border-gray-300" />
                    <span className="text-sm flex-1">{c.firstName} {c.lastName}</span>
                    <span className="text-xs text-muted-foreground">{c.email}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">{contactsToAdd.length} contact{contactsToAdd.length !== 1 ? "s" : ""} will be added</p>
            </div>
          )}
          {accountContacts && accountContacts.length === 0 && (
            <p className="text-sm text-muted-foreground">No contacts found for this account.</p>
          )}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => addMut.mutate({ campaignId: Number(campaignId), contactIds: contactsToAdd })} disabled={!campaignId || contactsToAdd.length === 0 || addMut.isPending}>
              {addMut.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Megaphone className="size-4 mr-1" />}
              Add {contactsToAdd.length}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Add to Segment Modal (with contact picker for accounts) ───────────── */
function AddToSegmentModal({ open, onOpenChange, accountIds, onComplete }: { open: boolean; onOpenChange: (v: boolean) => void; accountIds: number[]; onComplete: () => void }) {
  const [segmentId, setSegmentId] = useState("");
  const [selectedContactIds, setSelectedContactIds] = useState<Set<number>>(new Set());
  const { data: segments } = trpc.segments.list.useQuery();
  const { data: accountContacts } = trpc.contacts.list.useQuery(
    accountIds.length === 1 ? { accountId: accountIds[0] } : undefined,
    { enabled: open && accountIds.length > 0 }
  );
  const addMut = trpc.segments.addContacts.useMutation({
    onSuccess: (d) => { toast.success(`Added ${d.added} contact${d.added !== 1 ? "s" : ""} to segment`); onComplete(); onOpenChange(false); setSegmentId(""); setSelectedContactIds(new Set()); },
    onError: (e: any) => toast.error(e.message),
  });
  const contactsToAdd = selectedContactIds.size > 0 ? Array.from(selectedContactIds) : (accountContacts ?? []).map((c: any) => c.id);
  function toggleContact(id: number) {
    setSelectedContactIds((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Tag className="size-4 text-violet-500" />Add to Segment</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <Select value={segmentId} onValueChange={setSegmentId}>
            <SelectTrigger><SelectValue placeholder="Choose a segment..." /></SelectTrigger>
            <SelectContent>{(segments ?? []).map((s: any) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          {accountContacts && accountContacts.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-2">Select individual contacts from this account (or leave all checked to add everyone):</p>
              <div className="max-h-48 overflow-y-auto border rounded-md divide-y">
                {accountContacts.map((c: any) => (
                  <label key={c.id} className="flex items-center gap-2 px-3 py-2 hover:bg-secondary/30 cursor-pointer">
                    <input type="checkbox" checked={selectedContactIds.size === 0 || selectedContactIds.has(c.id)} onChange={() => toggleContact(c.id)} className="rounded border-gray-300" />
                    <span className="text-sm flex-1">{c.firstName} {c.lastName}</span>
                    <span className="text-xs text-muted-foreground">{c.email}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">{contactsToAdd.length} contact{contactsToAdd.length !== 1 ? "s" : ""} will be added</p>
            </div>
          )}
          {accountContacts && accountContacts.length === 0 && (
            <p className="text-sm text-muted-foreground">No contacts found for this account.</p>
          )}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => addMut.mutate({ segmentId: Number(segmentId), contactIds: contactsToAdd })} disabled={!segmentId || contactsToAdd.length === 0 || addMut.isPending}>
              {addMut.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Tag className="size-4 mr-1" />}
              Add {contactsToAdd.length}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Edit Account Dialog ───────────────────────────────────────────────── */
function EditAccountDialog({ account, open, onOpenChange, onSaved, list }: { account: any; open: boolean; onOpenChange: (v: boolean) => void; onSaved: () => void; list: any[] }) {
  const updateMut = trpc.accounts.update.useMutation({
    onSuccess: () => { toast.success("Account updated"); onSaved(); onOpenChange(false); },
    onError: (e: any) => toast.error(e.message),
  });
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Edit Account" isPending={updateMut.isPending}
      onSubmit={(f) => updateMut.mutate({ id: account.id, patch: {
        name: String(f.get("name")),
        industry: String(f.get("industry") ?? "") || undefined,
        region: String(f.get("region") ?? "") || undefined,
        parentAccountId: Number(f.get("parentAccountId")) || undefined,
      }})}>
      <Field name="name" label="Name" required defaultValue={account?.name} />
      <Field name="industry" label="Industry" defaultValue={account?.industry} />
      <Field name="region" label="Region" defaultValue={account?.region} />
      <SelectField name="parentAccountId" label="Parent (optional)" defaultValue={String(account?.parentAccountId ?? "")}
        options={[{ value: "", label: "— None —" }, ...(list.filter((a) => a.id !== account?.id).map((a) => ({ value: String(a.id), label: a.name })))]} />
    </FormDialog>
  );
}

/* ─── Main Accounts page ────────────────────────────────────────────────── */
export default function Accounts() {
  const [open, setOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ id: number; name: string; subtitle: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sendEmailOpen, setSendEmailOpen] = useState(false);
  const [addToCampaignOpen, setAddToCampaignOpen] = useState(false);
  const [addToSegmentOpen, setAddToSegmentOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<any | null>(null);
  const utils = trpc.useUtils();
  const { data: list } = trpc.accounts.list.useQuery();
  const { data: tree } = trpc.accounts.hierarchy.useQuery();

  const create = trpc.accounts.create.useMutation({
    onSuccess: () => { utils.accounts.list.invalidate(); utils.accounts.hierarchy.invalidate(); setOpen(false); toast.success("Account created"); },
  });
  const deleteMut = trpc.accounts.delete.useMutation({
    onSuccess: () => { utils.accounts.list.invalidate(); utils.accounts.hierarchy.invalidate(); toast.success("Account deleted"); },
    onError: (e: any) => toast.error(e.message),
  });

  const allIds = (list ?? []).map((a) => a.id);
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
    <Shell title="Accounts">
      <PageHeader title="Accounts" description="Manage company accounts, ARR rollup, and associated contacts and deals." pageKey="accounts"
        icon={<Building2 className="size-5" />}
      >
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
          const rows = list ?? [];
          if (!rows.length) return;
          const cols = ["id", "name", "domain", "industry", "employees", "annualRevenue", "city", "state", "country", "website", "createdAt"];
          const lines = [cols.join(","), ...rows.map((r: any) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))];
          const blob = new Blob([lines.join("\n")], { type: "text/csv" });
          const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `accounts-${Date.now()}.csv`; a.click();
        }} disabled={!list?.length}>
          <Download className="size-4" /> Export CSV
        </Button>
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New account</Button>
      </PageHeader>
      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Section title="All accounts">
            {(list ?? []).length === 0 ? <EmptyState icon={Building2} title="No accounts" /> : (
              <table className="w-full text-sm">
                <thead className="bg-secondary/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 w-8">
                      <input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded border-gray-300 cursor-pointer" title="Select all" />
                    </th>
                    <th className="text-left px-3 py-2">Name</th>
                    <th className="text-left px-3 py-2">Industry</th>
                    <th className="text-left px-3 py-2">Region</th>
                    <th className="text-right px-3 py-2">ARR</th>
                    <th className="text-right px-3 py-2">Employees</th>
                    <th className="px-3 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {(list ?? []).map((a) => (
                    <tr key={a.id} className="hover:bg-secondary/20 cursor-pointer" onClick={() => setDrawer({ id: a.id, name: a.name, subtitle: `${a.industry ?? ""} · ${a.region ?? ""}` })}>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selectedIds.has(a.id)} onChange={() => toggleOne(a.id)} className="rounded border-gray-300 cursor-pointer" />
                      </td>
                      <td className="px-3 py-2 font-medium">{a.name}</td>
                      <td className="px-3 py-2 text-muted-foreground">{a.industry ?? "—"}</td>
                      <td className="px-3 py-2 text-muted-foreground">{a.region ?? "—"}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">{fmt$(Number(a.arr ?? 0))}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">{a.employeeBand ?? "—"}</td>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-7">
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditAccount(a)}>
                              <Pencil className="size-4 mr-2" />Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setDrawer({ id: a.id, name: a.name, subtitle: `${a.industry ?? ""} · ${a.region ?? ""}` })}>
                              <Building2 className="size-4 mr-2" />View details
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => { setSelectedIds(new Set([a.id])); setSendEmailOpen(true); }}>
                              <Send className="size-4 mr-2" />Send Email
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { setSelectedIds(new Set([a.id])); setAddToCampaignOpen(true); }}>
                              <Megaphone className="size-4 mr-2" />Add to Campaign
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => { setSelectedIds(new Set([a.id])); setAddToSegmentOpen(true); }}>
                              <Tag className="size-4 mr-2" />Add to Segment
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-destructive" onClick={() => { if (confirm(`Delete ${a.name}?`)) deleteMut.mutate({ id: a.id }); }}>
                              <Trash2 className="size-4 mr-2" />Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>
        <div>
          <Section title="Hierarchy" description="ARR rolled up to parent.">
            <div className="p-3 space-y-2">
              {((tree as any)?.roots ?? []).map((node: any) => <Node key={node.id} node={node} depth={0} />)}
            </div>
          </Section>
        </div>
      </div>
      <FormDialog open={open} onOpenChange={setOpen} title="New account" isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          name: String(f.get("name")),
          industry: String(f.get("industry") ?? "") || undefined,
          region: String(f.get("region") ?? "") || undefined,
          parentAccountId: Number(f.get("parentAccountId")) || undefined,
        })}>
        <Field name="name" label="Name" required />
        <Field name="industry" label="Industry" />
        <Field name="region" label="Region" />
        <SelectField name="parentAccountId" label="Parent (optional)" options={[{ value: "", label: "— None —" }, ...((list ?? []).map((a) => ({ value: String(a.id), label: a.name })))]} />
      </FormDialog>
      <RecordDrawer open={!!drawer} onOpenChange={(v) => !v && setDrawer(null)} relatedType="account" relatedId={drawer?.id ?? null} title={drawer?.name ?? ""} subtitle={drawer?.subtitle} />
      <SendEmailModal open={sendEmailOpen} onOpenChange={setSendEmailOpen} accountIds={Array.from(selectedIds)} onComplete={() => setSelectedIds(new Set())} />
      <AddToCampaignModal open={addToCampaignOpen} onOpenChange={setAddToCampaignOpen} accountIds={Array.from(selectedIds)} onComplete={() => setSelectedIds(new Set())} />
      <AddToSegmentModal open={addToSegmentOpen} onOpenChange={setAddToSegmentOpen} accountIds={Array.from(selectedIds)} onComplete={() => setSelectedIds(new Set())} />
      {editAccount && (
        <EditAccountDialog
          account={editAccount}
          open={!!editAccount}
          onOpenChange={(v) => !v && setEditAccount(null)}
          onSaved={() => { utils.accounts.list.invalidate(); utils.accounts.hierarchy.invalidate(); setEditAccount(null); }}
          list={list ?? []}
        />
      )}
    </Shell>
  );
}
function Node({ node, depth }: { node: any; depth: number }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm py-1 hover:bg-secondary/30 rounded px-1" style={{ paddingLeft: depth * 16 + 4 }}>
        {node.children?.length ? <ChevronRight className="size-3.5 text-muted-foreground" /> : <span className="size-3.5" />}
        <span className="flex-1 truncate">{node.name}</span>
        <span className="font-mono tabular-nums text-xs whitespace-nowrap shrink-0">{fmt$(Number(node.rolledArr ?? node.arr ?? 0))}</span>
      </div>
      {node.children?.map((c: any) => <Node key={c.id} node={c} depth={depth + 1} />)}
    </div>
  );
}
