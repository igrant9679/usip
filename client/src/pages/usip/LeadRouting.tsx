import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader, QueryError, Shell, SubNav, TableSkeleton } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { LEAD_ASSIGNMENT_NAV } from "@/lib/leadAssignmentNav";
import { readableErrorMessage } from "@/lib/trpcErrorMessage";
import {
  blankRoutingConditions, normalizeRoutingConditions, ROUTING_FIELDS, ROUTING_OPS, ROUTING_STRATEGY_LABEL,
  routingConditionsProblem, routingFieldType,
} from "@shared/leadRouting";
import {
  conditionsForSave, editableConditions, pickableMembers, ruleStatus,
  type EditableConditions, type RuleCond as Cond, type RuleMember as Member,
} from "@/lib/routingRuleView";
import { ArrowDown, ArrowUp, Pencil, Plus, Sparkles, Trash2, GitMerge } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { confirmAction } from "@/components/usip/Common";

type Group = "all" | "any";
type Rule = {
  id?: number;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: EditableConditions;
  strategy: "round_robin" | "geography" | "industry" | "direct";
  targetUserIds: number[];
};

export default function LeadRouting() {
  const utils = trpc.useUtils();
  const rulesQ = trpc.leadRouting.list.useQuery();
  const rules = rulesQ.data;
  const { data: members } = trpc.workspace.members.useQuery();
  const [editing, setEditing] = useState<Rule | null>(null);
  const memberList = (members as Member[] | undefined) ?? [];

  const remove = trpc.leadRouting.remove.useMutation({ onSuccess: () => { utils.leadRouting.list.invalidate(); toast.success("Rule deleted"); }, onError: (e) => toast.error(e.message) });
  const reorder = trpc.leadRouting.reorder.useMutation({ onSuccess: () => utils.leadRouting.list.invalidate(), onError: (e) => toast.error(e.message) });
  // One reorder at a time from this page (P124): a second click before the
  // first is saved, and the list read back, would send an order built from
  // the stale list.
  const reordering = reorder.isPending || rulesQ.isFetching;

  const move = (idx: number, dir: -1 | 1) => {
    if (!rules || reordering) return;
    const ids = rules.map((r) => r.id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= ids.length) return;
    const [m] = ids.splice(idx, 1);
    ids.splice(newIdx, 0, m!);
    reorder.mutate({ orderedIds: ids });
  };

  return (
    <Shell title="Lead Routing">
      <PageHeader title="Lead Routing Engine" description="Configure routing rules that automatically assign inbound leads to the right rep or team. Base assignments on territory, industry, lead score, or round-robin rotation. Rules run top to bottom; the first that matches assigns the lead." pageKey="lead-routing"
        icon={<GitMerge className="size-5" />}
      >
        <Button onClick={() => setEditing({ name: "", priority: ((rules?.length ?? 0) + 1) * 10, enabled: true, conditions: { all: [], any: [] }, strategy: "round_robin", targetUserIds: [] })}>
          <Plus className="size-4" /> New rule
        </Button>
      </PageHeader>
      <SubNav items={LEAD_ASSIGNMENT_NAV} />

      <div className="p-4 md:p-5">
        {rulesQ.error && !rules ? (
          <QueryError what="routing rules" message={rulesQ.error.message} onRetry={() => rulesQ.refetch()} />
        ) : !rules ? (
          <TableSkeleton rows={4} />
        ) : rules.length === 0 ? (
          <EmptyState icon={Sparkles} title="No routing rules yet" description="Add a rule to auto-assign new leads on creation." />
        ) : (
          <div className="rounded-lg border bg-card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2 w-24">Order</th>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Strategy</th>
                  <th className="text-left px-3 py-2">Targets</th>
                  <th className="text-left px-3 py-2">Matches</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rules.map((r, i) => {
                  const targets = (r.targetUserIds as number[] | null) ?? [];
                  // As the router sees it: a rule whose targets have all left is skipped (P115).
                  const status = members ? ruleStatus({ enabled: r.enabled, strategy: r.strategy, targetUserIds: targets }, memberList) : (r.enabled ? "active" : "disabled");
                  const blanks = blankRoutingConditions(normalizeRoutingConditions(r.conditions));
                  return (
                  <tr key={r.id}
                    className="hover:bg-secondary/30"
                    draggable={!reordering}
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(i)); e.dataTransfer.effectAllowed = "move"; }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (reordering) return;
                      const fromIdx = Number(e.dataTransfer.getData("text/plain"));
                      if (Number.isNaN(fromIdx) || fromIdx === i) return;
                      const ids = rules.map((x) => x.id);
                      const [m] = ids.splice(fromIdx, 1);
                      ids.splice(i, 0, m!);
                      reorder.mutate({ orderedIds: ids });
                    }}
                  >
                    <td className="px-3 py-2">
                      {/* The position is the order rules run in; the stored priority is how it is kept (P124). */}
                      <div className="flex gap-1 items-center">
                        <span className="cursor-grab text-muted-foreground select-none" title="Drag to reorder">⋮⋮</span>
                        <span className="tabular-nums text-xs text-muted-foreground w-5">{i + 1}</span>
                        <Button aria-label="Move rule up" size="icon" variant="ghost" className="h-6 w-6" onClick={() => move(i, -1)} disabled={i === 0 || reordering}><ArrowUp className="size-3" /></Button>
                        <Button aria-label="Move rule down" size="icon" variant="ghost" className="h-6 w-6" onClick={() => move(i, +1)} disabled={i === rules.length - 1 || reordering}><ArrowDown className="size-3" /></Button>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {r.name}
                      {blanks > 0 && <div className="text-xs font-normal text-amber-700">{blanks} empty condition{blanks === 1 ? "" : "s"}, ignored; edit the rule to fill {blanks === 1 ? "it" : "them"} in or remove {blanks === 1 ? "it" : "them"}</div>}
                    </td>
                    <td className="px-3 py-2">{ROUTING_STRATEGY_LABEL[r.strategy] ?? r.strategy}</td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">{targets.length ? targets.map((uid) => {
                      const m = memberList.find((x) => x.id === uid);
                      return `${m?.name ?? m?.email ?? `user#${uid}`}${m && !m.deactivatedAt ? "" : " (left)"}`;
                    }).join(", ") : "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground tabular-nums">{r.matchCount}</td>
                    <td className="px-3 py-2">{status === "disabled" ? (
                      <span className="px-1.5 rounded text-xs bg-muted text-muted-foreground">Disabled</span>
                    ) : status === "no_active_targets" ? (
                      <span className="px-1.5 rounded text-xs bg-amber-100 text-amber-800" title="Every target has left or none is set, so the router skips this rule">No active targets</span>
                    ) : status === "territory_only" ? (
                      <span className="px-1.5 rounded text-xs bg-amber-100 text-amber-800" title="No active target to fall back on: only leads whose territory has an owner are assigned">Territory owners only</span>
                    ) : (
                      <span className="px-1.5 rounded text-xs bg-emerald-100 text-emerald-700">Active</span>
                    )}</td>
                    <td className="px-3 py-2 text-right space-x-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing({
                        id: r.id, name: r.name, priority: r.priority, enabled: r.enabled,
                        conditions: editableConditions(r.conditions),
                        strategy: r.strategy as any,
                        targetUserIds: targets,
                      })}><Pencil className="size-3.5" /> Edit</Button>
                      <Button aria-label={`Delete rule ${r.name}`} size="sm" variant="ghost" className="text-rose-600" onClick={() => { confirmAction({ title: `Delete rule "${r.name}"?`, description: "This routing rule will be permanently deleted. This cannot be undone.", confirmLabel: "Delete" }, () => { remove.mutate({ id: r.id }); }); }}><Trash2 className="size-3.5" /></Button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <RuleEditor
        rule={editing}
        position={editing?.id ? (rules ?? []).findIndex((r) => r.id === editing.id) + 1 : (rules?.length ?? 0) + 1}
        members={memberList}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); utils.leadRouting.list.invalidate(); }}
      />
    </Shell>
  );
}

function RuleEditor({ rule, position, members, onClose, onSaved }: { rule: Rule | null; position: number; members: Member[]; onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<Rule | null>(rule);
  useEffect(() => setDraft(rule), [rule]);
  const save = trpc.leadRouting.save.useMutation({ onSuccess: () => { toast.success("Rule saved"); onSaved(); }, onError: (e) => toast.error(readableErrorMessage(e)) });
  if (!draft) return null;
  const problem = routingConditionsProblem(draft.conditions);
  // Leavers aren't offered; one still ticked on this rule is listed so it can be removed (P115).
  const pickable = pickableMembers(members, draft.targetUserIds);

  // Edits to one group keep the other (P126: saving rewrote the rule as
  // `{ all }`, so an "Any" group vanished on the first edit).
  const setGroup = (g: Group, next: Cond[]) => setDraft({ ...draft, conditions: { ...draft.conditions, [g]: next } });

  return (
    <Dialog open={!!rule} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl">
        <DialogHeader><DialogTitle>{rule?.id ? "Edit routing rule" : "New routing rule"}</DialogTitle></DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input aria-label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <div className="text-xs text-muted-foreground">Runs {position === 1 ? "first" : `#${position}`}; drag rules in the list to change the order.</div>
          </div>

          <div className="space-y-1"><Label>Strategy</Label>
            <select aria-label="Strategy" className="w-full h-9 border rounded bg-background px-2 text-sm" value={draft.strategy} onChange={(e) => setDraft({ ...draft, strategy: e.target.value as any })}>
              <option value="round_robin">Round robin (cycle through targets)</option>
              <option value="direct">Direct (always assign to the first target)</option>
              <option value="geography">Geography (the owner of the matching territory rule by country or state, else the first target)</option>
              <option value="industry">Industry (the owner of the matching territory rule by industry, else the first target)</option>
            </select>
          </div>

          <div className="space-y-1">
            <Label>Targets</Label>
            <div className="rounded border p-2 max-h-40 overflow-auto space-y-1">
              {pickable.map((m) => {
                const checked = draft.targetUserIds.includes(m.id);
                return (
                  <label key={m.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={checked} onChange={(e) => setDraft({
                      ...draft,
                      targetUserIds: e.target.checked ? [...draft.targetUserIds, m.id] : draft.targetUserIds.filter((x) => x !== m.id),
                    })} />
                    <span>{m.name ?? m.email ?? `user#${m.id}`}{m.deactivatedAt ? " (left the workspace; never routed to)" : ""}</span>
                  </label>
                );
              })}
              {pickable.length === 0 && <div className="text-xs text-muted-foreground">No workspace members loaded.</div>}
            </div>
          </div>

          <ConditionGroup label="Conditions (ALL must match)" conds={draft.conditions.all} onChange={(c) => setGroup("all", c)}
            empty="No conditions = matches every lead. Use the order to make a catch-all rule run last." />
          <ConditionGroup label="And at least ONE of these (optional)" conds={draft.conditions.any} onChange={(c) => setGroup("any", c)} />
          <div className="text-xs text-muted-foreground">
            Text compares ignore case. Score is the score a lead is created with: its profile points, before any engagement or AI fit.
          </div>
          {problem && <div role="alert" className="text-xs text-rose-600">{problem}</div>}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            Enabled
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending || !draft.name.trim() || !!problem} onClick={() => save.mutate({ ...draft, conditions: conditionsForSave(draft.conditions) })}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One group of conditions. Operators and the value box follow the field's type
 * (audit 2026-10-20, P42): Score takes a number and numeric comparisons, text
 * fields equals / not equals / contains.
 */
function ConditionGroup({ label, conds, onChange, empty }: { label: string; conds: Cond[]; onChange: (next: Cond[]) => void; empty?: string }) {
  const update = (i: number, next: Cond) => onChange(conds.map((c, j) => (j === i ? next : c)));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button size="sm" variant="outline" className="bg-card" onClick={() => onChange([...conds, { field: "title", op: "contains", value: "" }])}><Plus className="size-3.5" /> Add</Button>
      </div>
      {conds.length === 0 && empty && <div className="text-xs text-muted-foreground">{empty}</div>}
      {conds.map((c, i) => {
        const type = routingFieldType(c.field);
        const ops = ROUTING_OPS[type];
        return (
          <div key={i} className="grid grid-cols-12 gap-2 items-center">
            <select aria-label="Field" className="col-span-4 h-8 border rounded bg-background px-2 text-sm" value={c.field} onChange={(e) => {
              const field = e.target.value;
              const nextOps = ROUTING_OPS[routingFieldType(field)];
              // Keep the operator when the new field takes it, else its first one.
              update(i, { field, op: nextOps.some((o) => o.v === c.op) ? c.op : nextOps[0]!.v, value: c.value });
            }}>
              {ROUTING_FIELDS.map((f) => <option key={f.v} value={f.v}>{f.l}</option>)}
            </select>
            <select aria-label="Operator" className="col-span-3 h-8 border rounded bg-background px-2 text-sm" value={c.op} onChange={(e) => update(i, { ...c, op: e.target.value })}>
              {!ops.some((o) => o.v === c.op) && <option value={c.op}>{c.op}</option>}
              {ops.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
            <Input aria-label="Value" className="col-span-4 h-8" type={type === "number" ? "number" : "text"} value={String(c.value ?? "")}
              onChange={(e) => update(i, { ...c, value: type === "number" && e.target.value.trim() !== "" ? Number(e.target.value) : e.target.value })} />
            <Button aria-label="Remove condition" size="icon" variant="ghost" className="h-7 w-7 col-span-1 text-rose-600" onClick={() => onChange(conds.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
          </div>
        );
      })}
    </div>
  );
}
