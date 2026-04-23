import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Field, fmt$, FormDialog, SelectField, Section, StatusPill } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { trpc } from "@/lib/trpc";
import { Building2, ChevronRight, Plus, MoreHorizontal, Pencil, Trash2, Tag, Megaphone, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/* ─── Add to Campaign Modal ─────────────────────────────────────────────── */
function AddToCampaignModal({ open, onOpenChange, accountIds, onComplete }: { open: boolean; onOpenChange: (v: boolean) => void; accountIds: number[]; onComplete: () => void }) {
  const [campaignId, setCampaignId] = useState("");
  const { data: campaigns } = trpc.campaigns.list.useQuery();
  const addMut = trpc.campaigns.addAudience.useMutation({
    onSuccess: (d) => { toast.success(`Added ${d.added} account${d.added !== 1 ? "s" : ""} to campaign`); onComplete(); onOpenChange(false); },
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
            <Button onClick={() => addMut.mutate({ campaignId: Number(campaignId), contactIds: accountIds })} disabled={!campaignId || addMut.isPending}>
              {addMut.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Megaphone className="size-4 mr-1" />}
              Add {accountIds.length}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Add to Segment Modal ──────────────────────────────────────────────── */
function AddToSegmentModal({ open, onOpenChange, accountIds, onComplete }: { open: boolean; onOpenChange: (v: boolean) => void; accountIds: number[]; onComplete: () => void }) {
  const [segmentId, setSegmentId] = useState("");
  const { data: segments } = trpc.segments.list.useQuery();
  const addMut = trpc.segments.addContacts.useMutation({
    onSuccess: (d) => { toast.success(`Added ${d.added} account${d.added !== 1 ? "s" : ""} to segment`); onComplete(); onOpenChange(false); },
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
            <Button onClick={() => addMut.mutate({ segmentId: Number(segmentId), contactIds: accountIds })} disabled={!segmentId || addMut.isPending}>
              {addMut.isPending ? <Loader2 className="size-4 animate-spin mr-1" /> : <Tag className="size-4 mr-1" />}
              Add {accountIds.length}
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
      <PageHeader title="Accounts" description="Companies you sell to. Parent → child rollup of ARR is computed automatically.">
        {someSelected && (
          <>
            <Button variant="outline" onClick={() => setAddToCampaignOpen(true)} className="gap-2">
              <Megaphone className="h-4 w-4 text-orange-500" />Add to Campaign ({selectedIds.size})
            </Button>
            <Button variant="outline" onClick={() => setAddToSegmentOpen(true)} className="gap-2">
              <Tag className="h-4 w-4 text-violet-500" />Add to Segment ({selectedIds.size})
            </Button>
          </>
        )}
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
                  {list!.map((a) => (
                    <tr key={a.id} className={`hover:bg-secondary/30 cursor-pointer ${selectedIds.has(a.id) ? "bg-primary/5" : ""}`}
                      onClick={() => setDrawer({ id: a.id, name: a.name, subtitle: `${a.industry ?? ""} · ${a.region ?? ""}` })}>
                      <td className="px-3 py-2" onClick={(e) => { e.stopPropagation(); toggleOne(a.id); }}>
                        <input type="checkbox" checked={selectedIds.has(a.id)} readOnly className="rounded border-gray-300 cursor-pointer" />
                      </td>
                      <td className="px-3 py-2 font-medium">
                        <span className="underline-offset-2 hover:underline">{a.name}</span>
                        {a.parentAccountId && <StatusPill tone="muted">child</StatusPill>}
                      </td>
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
