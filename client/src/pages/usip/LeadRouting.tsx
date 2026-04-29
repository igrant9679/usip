import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { ArrowDown, ArrowUp, Pencil, Plus, Sparkles, Trash2, GitMerge } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type Cond = { field: string; op: string; value: any };
type Rule = {
  id?: number;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: { all?: Cond[]; any?: Cond[] };
  strategy: "round_robin" | "geography" | "industry" | "direct";
  targetUserIds: number[];
};

const FIELDS = [
  { v: "title", l: "Title" },
  { v: "company", l: "Company" },
  { v: "source", l: "Source" },
  { v: "industry", l: "Industry" },
  { v: "country", l: "Country" },
  { v: "state", l: "State" },
  { v: "score", l: "Score" },
];
const OPS = [
  { v: "eq", l: "equals" },
  { v: "neq", l: "not equals" },
  { v: "contains", l: "contains" },
  { v: "gt", l: ">" },
  { v: "gte", l: ">=" },
  { v: "lt", l: "<" },
  { v: "lte", l: "<=" },
];

export default function LeadRouting() {
  const utils = trpc.useUtils();
  const { data: rules } = trpc.leadRouting.list.useQuery();
  const { data: members } = trpc.workspace.members.useQuery();
  const [editing, setEditing] = useState<Rule | null>(null);

  const remove = trpc.leadRouting.remove.useMutation({ onSuccess: () => { utils.leadRouting.list.invalidate(); toast.success("Rule deleted"); } });
  const reorder = trpc.leadRouting.reorder.useMutation({ onSuccess: () => utils.leadRouting.list.invalidate() });

  const move = (idx: number, dir: -1 | 1) => {
    if (!rules) return;
    const ids = rules.map((r) => r.id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= ids.length) return;
    const [m] = ids.splice(idx, 1);
    ids.splice(newIdx, 0, m!);
    reorder.mutate({ orderedIds: ids });
  };

  return (
    <Shell title="Lead Routing">
      <PageHeader title="Lead Routing Engine" description="Configure rules to auto-assign inbound leads to the right rep or team." pageKey="lead-routing"
        icon={<GitMerge className="size-5" />}
      >
        <Button onClick={() => setEditing({ name: "", priority: ((rules?.length ?? 0) + 1) * 10, enabled: true, conditions: { all: [] }, strategy: "round_robin", targetUserIds: [] })}>
          <Plus className="size-4" /> New rule
        </Button>
      </PageHeader>

      <div className="p-6">
        {!rules || rules.length === 0 ? (
          <EmptyState icon={Sparkles} title="No routing rules yet" description="Add a rule to auto-assign new leads on creation." />
        ) : (
          <div className="rounded-lg border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2 w-16">Order</th>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Strategy</th>
                  <th className="text-left px-3 py-2">Targets</th>
                  <th className="text-left px-3 py-2">Matches</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rules.map((r, i) => (
                  <tr key={r.id}
                    className="hover:bg-secondary/30"
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(i)); e.dataTransfer.effectAllowed = "move"; }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const fromIdx = Number(e.dataTransfer.getData("text/plain"));
                      if (Number.isNaN(fromIdx) || fromIdx === i) return;
                      const ids = rules.map((x) => x.id);
                      const [m] = ids.splice(fromIdx, 1);
                      ids.splice(i, 0, m!);
                      reorder.mutate({ orderedIds: ids });
                    }}
                  >
                    <td className="px-3 py-2">
                      <div className="flex gap-1 items-center">
                        <span className="cursor-grab text-muted-foreground select-none" title="Drag to reorder">⋮⋮</span>
                        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp className="size-3" /></Button>
                        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => move(i, +1)} disabled={i === rules.length - 1}><ArrowDown className="size-3" /></Button>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-medium">{r.name}<div className="text-xs text-muted-foreground">priority {r.priority}</div></td>
                    <td className="px-3 py-2">{r.strategy}</td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">{(r.targetUserIds as number[] | null)?.map((uid) => members?.find((m: any) => m.id === uid)?.name ?? `user#${uid}`).join(", ") ?? "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground tabular-nums">{r.matchCount}</td>
                    <td className="px-3 py-2"><span className={`px-1.5 rounded text-xs ${r.enabled ? "bg-emerald-100 text-emerald-700" : "bg-muted text-muted-foreground"}`}>{r.enabled ? "Active" : "Disabled"}</span></td>
                    <td className="px-3 py-2 text-right space-x-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing({
                        id: r.id, name: r.name, priority: r.priority, enabled: r.enabled,
                        conditions: (r.conditions as any) ?? { all: [] },
                        strategy: r.strategy as any,
                        targetUserIds: (r.targetUserIds as number[] | null) ?? [],
                      })}><Pencil className="size-3.5" /> Edit</Button>
                      <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => { if (confirm(`Delete rule "${r.name}"?`)) remove.mutate({ id: r.id }); }}><Trash2 className="size-3.5" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <RuleEditor rule={editing} members={(members as any) ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); utils.leadRouting.list.invalidate(); }} />
    </Shell>
  );
}

function RuleEditor({ rule, members, onClose, onSaved }: { rule: Rule | null; members: Array<{ id: number; name: string | null; email: string | null }>; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<Rule | null>(rule);
  useEffect(() => setDraft(rule), [rule]);
  const save = trpc.leadRouting.save.useMutation({ onSuccess: () => { toast.success("Rule saved"); onSaved(); } });
  const conds = useMemo(() => draft?.conditions?.all ?? [], [draft]);
  if (!draft) return null;

  return (
    <Dialog open={!!rule} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{rule?.id ? "Edit routing rule" : "New routing rule"}</DialogTitle></DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1"><Label>Name</Label><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
            <div className="space-y-1"><Label>Priority</Label><Input type="number" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} /></div>
          </div>

          <div className="space-y-1"><Label>Strategy</Label>
            <select className="w-full h-9 border rounded bg-background px-2 text-sm" value={draft.strategy} onChange={(e) => setDraft({ ...draft, strategy: e.target.value as any })}>
              <option value="round_robin">Round Robin (cycle through targets)</option>
              <option value="direct">Direct (always assign to first target)</option>
              <option value="geography">Geography (first match by geo conditions, fallback to first target)</option>
              <option value="industry">Industry (first match by industry conditions, fallback to first target)</option>
            </select>
          </div>

          <div className="space-y-1">
            <Label>Targets</Label>
            <div className="rounded border p-2 max-h-40 overflow-auto space-y-1">
              {members.map((m) => {
                const checked = draft.targetUserIds.includes(m.id);
                return (
                  <label key={m.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={checked} onChange={(e) => setDraft({
                      ...draft,
                      targetUserIds: e.target.checked ? [...draft.targetUserIds, m.id] : draft.targetUserIds.filter((x) => x !== m.id),
                    })} />
                    <span>{m.name ?? m.email ?? `user#${m.id}`}</span>
                  </label>
                );
              })}
              {members.length === 0 && <div className="text-xs text-muted-foreground">No workspace members loaded.</div>}
            </div>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label>Conditions (ALL must match)</Label>
              <Button size="sm" variant="outline" className="bg-card" onClick={() => setDraft({ ...draft, conditions: { all: [...conds, { field: "title", op: "contains", value: "" }] } })}><Plus className="size-3.5" /> Add</Button>
            </div>
            {conds.length === 0 && <div className="text-xs text-muted-foreground">No conditions = matches every lead. Use priority to pick a fallback rule.</div>}
            {conds.map((c, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <select className="col-span-4 h-8 border rounded bg-background px-2 text-sm" value={c.field} onChange={(e) => updateCond(i, { ...c, field: e.target.value })}>
                  {FIELDS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}
                </select>
                <select className="col-span-3 h-8 border rounded bg-background px-2 text-sm" value={c.op} onChange={(e) => updateCond(i, { ...c, op: e.target.value })}>
                  {OPS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                </select>
                <Input className="col-span-4 h-8" value={String(c.value ?? "")} onChange={(e) => updateCond(i, { ...c, value: c.op === "gt" || c.op === "gte" || c.op === "lt" || c.op === "lte" ? Number(e.target.value) : e.target.value })} />
                <Button size="icon" variant="ghost" className="h-7 w-7 col-span-1 text-rose-600" onClick={() => setDraft({ ...draft, conditions: { all: conds.filter((_, j) => j !== i) } })}><Trash2 className="size-3.5" /></Button>
              </div>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            Enabled
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending || !draft.name.trim()} onClick={() => save.mutate({ ...draft })}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  function updateCond(i: number, next: Cond) {
    setDraft({ ...draft!, conditions: { all: conds.map((c, j) => j === i ? next : c) } });
  }
}
