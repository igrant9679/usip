import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Field, fmtDate, FormDialog, Section, SelectField, StatusPill } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Play, Plus, Save, Trash2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const TRIGGERS = [
  ["record_created", "When a record is created"],
  ["record_updated", "When a record is updated"],
  ["stage_changed", "When opportunity stage changes"],
  ["task_overdue", "When a task becomes overdue"],
  ["nps_submitted", "When NPS is submitted"],
  ["signal_received", "When a buying signal fires"],
  ["field_equals", "When a field equals a value"],
  ["schedule", "On a schedule (cron)"],
] as const;

const OPS = [
  ["eq", "equals"], ["neq", "not equal"], ["gt", "greater than"], ["lt", "less than"],
  ["gte", "≥"], ["lte", "≤"], ["contains", "contains"], ["in", "in list"],
] as const;

const FIELDS = [
  "stage", "value", "winProb", "ownerId", "industry", "region", "leadGrade", "healthScore", "renewalDate", "npsScore",
];

const ACTION_TYPES = [
  ["create_task", "Create task"],
  ["send_email_draft", "Send AI email draft"],
  ["notify_user", "Notify user"],
  ["update_field", "Update field"],
  ["enroll_sequence", "Enroll in sequence"],
  ["post_slack", "Post to Slack"],
  ["webhook", "Call webhook"],
] as const;

type Cond = { field: string; op: string; value: string };
type Act = { type: string; params: Record<string, string> };

export default function Workflows() {
  const utils = trpc.useUtils();
  const { data } = trpc.workflows.list.useQuery();
  const [selected, setSelected] = useState<number | null>(null);
  const [openNew, setOpenNew] = useState(false);
  const runs = trpc.workflows.runs.useQuery({ ruleId: selected ?? undefined });
  const create = trpc.workflows.create.useMutation({ onSuccess: () => { utils.workflows.list.invalidate(); setOpenNew(false); toast.success("Rule created"); } });
  const update = trpc.workflows.update.useMutation({ onSuccess: () => { utils.workflows.list.invalidate(); toast.success("Rule saved"); } });
  const toggle = trpc.workflows.toggle.useMutation({ onSuccess: () => utils.workflows.list.invalidate() });
  const test = trpc.workflows.testFire.useMutation({ onSuccess: () => { utils.workflows.runs.invalidate(); utils.workflows.list.invalidate(); toast.success("Rule fired (1 simulated run)"); } });

  const rule = useMemo(() => data?.find((x) => x.id === selected) ?? null, [data, selected]);

  return (
    <Shell title="Workflow Automation">
      <PageHeader title="Workflow Automation" description="When something happens, do something. Conditions narrow it down.">
        <Button onClick={() => setOpenNew(true)}><Plus className="size-4" /> New rule</Button>
      </PageHeader>
      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          <Section title={`Rules (${data?.length ?? 0})`}>
            {(data ?? []).length === 0 ? <EmptyState icon={Workflow} title="None yet" /> : (
              <ul className="divide-y">
                {data!.map((r) => (
                  <li key={r.id} className={`p-3 cursor-pointer hover:bg-secondary/40 ${selected === r.id ? "bg-secondary/60" : ""}`} onClick={() => setSelected(r.id)}>
                    <div className="flex items-center gap-2">
                      <Switch checked={r.enabled} onCheckedChange={(v) => toggle.mutate({ id: r.id, enabled: v })} onClick={(e) => e.stopPropagation()} />
                      <div className="text-sm font-medium flex-1 truncate">{r.name}</div>
                      <span className="text-xs text-muted-foreground font-mono tabular-nums">{r.fireCount}x</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5"><StatusPill tone="info">{r.triggerType}</StatusPill></div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div className="lg:col-span-2 space-y-4">
          {!rule ? <EmptyState icon={Workflow} title="Select a rule" description="Click a rule on the left to edit triggers, conditions, and actions." /> : (
            <RuleEditor
              key={rule.id}
              rule={rule}
              onSave={(patch) => update.mutate({ id: rule.id, patch })}
              onTest={() => test.mutate({ id: rule.id })}
              isSaving={update.isPending}
            />
          )}
          {rule && (
            <Section title="Run history">
              {(runs.data ?? []).length === 0 ? <div className="p-3 text-sm text-muted-foreground">No runs yet.</div> : (
                <ul className="divide-y">
                  {runs.data!.map((run) => (
                    <li key={run.id} className="p-3 flex items-center text-xs gap-3">
                      <StatusPill tone={run.status === "success" ? "success" : run.status === "failed" ? "danger" : "muted"}>{run.status}</StatusPill>
                      <div className="flex-1 truncate text-muted-foreground">via {run.triggeredBy}</div>
                      <div className="text-muted-foreground">{fmtDate(run.runAt)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
        </div>
      </div>

      <FormDialog open={openNew} onOpenChange={setOpenNew} title="New workflow rule" isPending={create.isPending}
        onSubmit={(f) => {
          create.mutate({
            name: String(f.get("name")),
            description: String(f.get("description") ?? "") || undefined,
            triggerType: f.get("triggerType") as any,
            triggerConfig: {},
            conditions: [],
            actions: [{ type: "create_task", params: { title: "Follow up" } }],
            enabled: true,
          });
        }}>
        <Field name="name" label="Name" required />
        <Field name="description" label="Description" />
        <SelectField name="triggerType" label="Trigger" options={TRIGGERS.map(([v, l]) => ({ value: v, label: l }))} defaultValue="stage_changed" />
        <div className="text-xs text-muted-foreground">After creating, you'll be able to add conditions and actions in the visual editor.</div>
      </FormDialog>
    </Shell>
  );
}

function RuleEditor({ rule, onSave, onTest, isSaving }: { rule: any; onSave: (patch: any) => void; onTest: () => void; isSaving: boolean }) {
  const [trigger, setTrigger] = useState<string>(rule.triggerType);
  const [conds, setConds] = useState<Cond[]>(((rule.conditions as Cond[]) ?? []).length ? (rule.conditions as Cond[]) : []);
  const [acts, setActs] = useState<Act[]>(((rule.actions as Act[]) ?? []).length ? (rule.actions as Act[]) : [{ type: "create_task", params: { title: "Follow up" } }]);

  useEffect(() => {
    setTrigger(rule.triggerType);
    setConds((rule.conditions as Cond[]) ?? []);
    setActs((rule.actions as Act[]) ?? [{ type: "create_task", params: { title: "Follow up" } }]);
  }, [rule.id]);

  const dirty =
    trigger !== rule.triggerType ||
    JSON.stringify(conds) !== JSON.stringify(rule.conditions ?? []) ||
    JSON.stringify(acts) !== JSON.stringify(rule.actions ?? []);

  return (
    <Section
      title={rule.name}
      description={rule.description ?? "Edit when this rule fires and what it does, then save."}
      right={
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onTest}><Play className="size-3.5" /> Test fire</Button>
          <Button size="sm" disabled={!dirty || isSaving} onClick={() => onSave({ triggerType: trigger, conditions: conds, actions: acts })}>
            <Save className="size-3.5" /> {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      }
    >
      <div className="p-4 space-y-5 text-sm">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">When</div>
          <select value={trigger} onChange={(e) => setTrigger(e.target.value)} className="w-full border rounded-md px-3 py-2 h-10 text-sm bg-card">
            {TRIGGERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Conditions (all must match)</div>
            <Button size="sm" variant="ghost" onClick={() => setConds([...conds, { field: FIELDS[0]!, op: "eq", value: "" }])}>+ Condition</Button>
          </div>
          {conds.length === 0 ? <div className="text-xs text-muted-foreground italic py-2">No conditions — fires on every trigger.</div> : (
            <div className="space-y-2">
              {conds.map((c, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <select value={c.field} onChange={(e) => setConds(conds.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} className="col-span-4 border rounded px-2 py-1.5 text-xs bg-card">
                    {FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <select value={c.op} onChange={(e) => setConds(conds.map((x, j) => j === i ? { ...x, op: e.target.value } : x))} className="col-span-3 border rounded px-2 py-1.5 text-xs bg-card">
                    {OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <input value={c.value} onChange={(e) => setConds(conds.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} placeholder="value" className="col-span-4 border rounded px-2 py-1.5 text-xs bg-card" />
                  <button onClick={() => setConds(conds.filter((_, j) => j !== i))} className="col-span-1 text-muted-foreground hover:text-rose-600 flex items-center justify-center"><Trash2 className="size-3.5" /></button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Then do</div>
            <Button size="sm" variant="ghost" onClick={() => setActs([...acts, { type: "create_task", params: { title: "" } }])}>+ Action</Button>
          </div>
          <div className="space-y-2">
            {acts.map((a, i) => (
              <div key={i} className="border rounded-md p-2 bg-secondary/20 space-y-2">
                <div className="flex items-center gap-2">
                  <select value={a.type} onChange={(e) => setActs(acts.map((x, j) => j === i ? { ...x, type: e.target.value, params: defaultParams(e.target.value) } : x))} className="flex-1 border rounded px-2 py-1.5 text-xs bg-card">
                    {ACTION_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <button onClick={() => setActs(acts.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-rose-600"><Trash2 className="size-3.5" /></button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(a.params).map(([k, v]) => (
                    <input key={k} value={v} onChange={(e) => setActs(acts.map((x, j) => j === i ? { ...x, params: { ...x.params, [k]: e.target.value } } : x))} placeholder={k} className="border rounded px-2 py-1.5 text-xs bg-card" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

function defaultParams(actionType: string): Record<string, string> {
  switch (actionType) {
    case "create_task": return { title: "Follow up", dueInDays: "2" };
    case "send_email_draft": return { tone: "professional", goal: "follow up" };
    case "notify_user": return { userId: "", message: "" };
    case "update_field": return { field: "", value: "" };
    case "enroll_sequence": return { sequenceId: "" };
    case "post_slack": return { channel: "#sales", message: "" };
    case "webhook": return { url: "", body: "{}" };
    default: return {};
  }
}
