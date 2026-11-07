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
import { ArrowDown, ArrowUp, Pencil, Plus, Sparkles, Trash2, GitMerge, FlaskConical, Loader2 } from "lucide-react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { confirmAction } from "@/components/usip/Common";
import { useWorkspaceRole } from "@/hooks/useWorkspaceRole";

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
  const [testing, setTesting] = useState(false);
  const memberList = (members as Member[] | undefined) ?? [];
  // New, edit, delete and reorder are an admin's on the server (P120).
  const isAdmin = useWorkspaceRole().isAdmin;

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
        {isAdmin && (
          <Button onClick={() => setEditing({ name: "", priority: ((rules?.length ?? 0) + 1) * 10, enabled: true, conditions: { all: [], any: [] }, strategy: "round_robin", targetUserIds: [] })}>
            <Plus className="size-4" /> New rule
          </Button>
        )}
        {/* A dry run anyone can make: it changes nothing (audit F41). */}
        <Button variant="outline" className="bg-card" onClick={() => setTesting(true)}>
          <FlaskConical className="size-4" /> Test a lead
        </Button>
      </PageHeader>
      <SubNav items={LEAD_ASSIGNMENT_NAV} />

      <div className="p-4 md:p-5">
        {rulesQ.error && !rules ? (
          <QueryError what="routing rules" message={rulesQ.error.message} onRetry={() => rulesQ.refetch()} />
        ) : !rules ? (
          <TableSkeleton rows={4} />
        ) : rules.length === 0 ? (
          <EmptyState icon={Sparkles} title="No routing rules yet" description={isAdmin ? "Add a rule to auto-assign new leads on creation." : "An admin adds the rules that auto-assign new leads."} />
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
                    draggable={isAdmin && !reordering}
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(i)); e.dataTransfer.effectAllowed = "move"; }}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (!isAdmin || reordering) return;
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
                        {isAdmin && <span className="cursor-grab text-muted-foreground select-none" title="Drag to reorder">⋮⋮</span>}
                        <span className="tabular-nums text-xs text-muted-foreground w-5">{i + 1}</span>
                        {isAdmin && (
                          <>
                            <Button aria-label="Move rule up" size="icon" variant="ghost" className="h-6 w-6" onClick={() => move(i, -1)} disabled={i === 0 || reordering}><ArrowUp className="size-3" /></Button>
                            <Button aria-label="Move rule down" size="icon" variant="ghost" className="h-6 w-6" onClick={() => move(i, +1)} disabled={i === rules.length - 1 || reordering}><ArrowDown className="size-3" /></Button>
                          </>
                        )}
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
                      {isAdmin && (<>
                      <Button size="sm" variant="ghost" onClick={() => setEditing({
                        id: r.id, name: r.name, priority: r.priority, enabled: r.enabled,
                        conditions: editableConditions(r.conditions),
                        strategy: r.strategy as any,
                        targetUserIds: targets,
                      })}><Pencil className="size-3.5" /> Edit</Button>
                      <Button aria-label={`Delete rule ${r.name}`} size="sm" variant="ghost" className="text-rose-600" onClick={() => { confirmAction({ title: `Delete rule "${r.name}"?`, description: "This routing rule will be permanently deleted. This cannot be undone.", confirmLabel: "Delete" }, () => { remove.mutate({ id: r.id }); }); }}><Trash2 className="size-3.5" /></Button>
                      </>)}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <TestLeadDialog open={testing} onOpenChange={setTesting} members={memberList} />

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

/** What each rule's verdict in a dry run reads as (F41). */
export const TEST_VERDICT_LABEL: Record<string, string> = {
  disabled: "Disabled, skipped",
  no_match: "Conditions not met",
  no_owner: "Conditions met, but nobody to give it to: skipped",
  picked: "Takes the lead",
  not_reached: "Not reached",
};

/** The lead a test describes when it is typed in: the routing fields, Score a number. */
export function testLeadInput(values: Record<string, string>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const f of ROUTING_FIELDS) {
    const v = (values[f.v] ?? "").trim();
    if (!v) continue;
    if (f.type === "number") { const n = Number(v); if (Number.isFinite(n)) out[f.v] = Math.max(0, Math.min(100, Math.round(n))); }
    else out[f.v] = v;
  }
  return out;
}

/**
 * "Test a lead" (audit 2026-10-20, F41): which rule would take a lead and who
 * would get it, run against the saved rules with nothing changed: no owner is
 * set, no round-robin turn is used and no match is counted. Test a saved lead,
 * or type one in with the fields the rules can match on.
 */
function TestLeadDialog({ open, onOpenChange, members }: { open: boolean; onOpenChange: (v: boolean) => void; members: Member[] }) {
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<"saved" | "typed">("saved");
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim());
  const { data: leadList } = trpc.leads.list.useQuery({ search: query || undefined, limit: 20 }, { enabled: open && mode === "saved" });
  const [leadId, setLeadId] = useState<number | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof utils.leadRouting.testLead.fetch>> | null>(null);
  const nameOf = (uid: number | null) => {
    if (uid == null) return "nobody";
    const m = members.find((x) => x.id === uid);
    return m ? (m.name ?? m.email ?? `user #${uid}`) : `user #${uid}`;
  };
  const run = async () => {
    setRunning(true);
    try {
      setResult(await utils.leadRouting.testLead.fetch(mode === "saved" ? { leadId: leadId ?? undefined } : { lead: testLeadInput(values) as never }));
    } catch (e: any) {
      toast.error(readableErrorMessage(e));
    } finally {
      setRunning(false);
    }
  };
  const picked = result?.pick ? result.rules.find((r) => r.ruleId === result.pick!.ruleId) : null;
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setResult(null); }}>
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Test a lead</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">Runs the saved rules against one lead and shows who would get it. Nothing changes: no owner is set, no round-robin turn is used, no match is counted.</p>
        <div className="flex gap-2 text-sm" role="radiogroup" aria-label="Which lead">
          <label className="flex items-center gap-1.5"><input type="radio" name="test-mode" checked={mode === "saved"} onChange={() => { setMode("saved"); setResult(null); }} /> A saved lead</label>
          <label className="flex items-center gap-1.5"><input type="radio" name="test-mode" checked={mode === "typed"} onChange={() => { setMode("typed"); setResult(null); }} /> Type one in</label>
        </div>
        {mode === "saved" ? (
          <div className="flex gap-2 flex-wrap">
            <Input aria-label="Search leads" placeholder="Search leads…" className="h-9 w-48" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select aria-label="Lead" className="h-9 rounded border bg-background px-2 text-sm flex-1 min-w-[12rem]" value={leadId ?? ""} onChange={(e) => { setLeadId(Number(e.target.value) || null); setResult(null); }}>
              <option value="">{leadList && leadList.length === 0 ? "No leads match" : "Select a lead…"}</option>
              {(leadList ?? []).map((l) => <option key={l.id} value={l.id}>{l.firstName} {l.lastName}{l.company ? ` — ${l.company}` : ""}</option>)}
            </select>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {ROUTING_FIELDS.map((f) => (
              <div key={f.v} className="space-y-1">
                <Label htmlFor={`test-${f.v}`} className="text-xs">{f.l}</Label>
                <Input id={`test-${f.v}`} className="h-8" type={f.type === "number" ? "number" : "text"} min={f.type === "number" ? 0 : undefined} max={f.type === "number" ? 100 : undefined}
                  value={values[f.v] ?? ""} onChange={(e) => { setValues({ ...values, [f.v]: e.target.value }); setResult(null); }} />
              </div>
            ))}
          </div>
        )}
        {result && (
          <div className="space-y-2" role="status">
            <div className={`rounded border p-3 text-sm ${result.pick ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30" : "border-amber-300 bg-amber-50 dark:bg-amber-950/30"}`}>
              {result.pick && picked
                ? <>Rule <strong>{picked.name}</strong> would assign this lead to <strong>{nameOf(result.pick.ownerUserId)}</strong>.</>
                : <>No rule takes this lead: it would be left unassigned.</>}
            </div>
            <div className="text-xs text-muted-foreground">
              As the router sees it: {(["title", "company", "source", "industry", "country", "state", "score"] as const)
                .map((k) => [ROUTING_FIELDS.find((f) => f.v === k)?.l ?? k, (result.payload as Record<string, unknown>)[k]] as const)
                .filter(([, v]) => v != null && v !== "")
                .map(([l, v]) => `${l} ${v}`).join(" · ") || "no field filled in"}
            </div>
            <ol className="text-xs space-y-1">
              {result.rules.map((r, i) => (
                <li key={r.ruleId} className={r.verdict === "picked" ? "font-medium" : "text-muted-foreground"}>
                  {i + 1}. {r.name}: {TEST_VERDICT_LABEL[r.verdict] ?? r.verdict}{r.verdict === "picked" ? ` (to ${nameOf(r.ownerUserId)})` : ""}
                </li>
              ))}
              {result.rules.length === 0 && <li className="text-muted-foreground">There are no routing rules yet.</li>}
            </ol>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          <Button disabled={running || (mode === "saved" && !leadId)} onClick={run}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />} Run test
          </Button>
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
