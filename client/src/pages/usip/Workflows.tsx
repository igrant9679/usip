import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmButton, Field, fmtDate, FormDialog, Section, SelectField, StatusPill } from "@/components/usip/Common";
import { EmptyState, PageHeader, QueryError, Shell, TableSkeleton } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { actionSupportsEntity, CONDITION_OPS, isDeadTrigger, LIVE_TRIGGERS, RECORD_ENTITIES, recordFieldsFor } from "@shared/workflowTriggers";
import { Play, Plus, Save, Trash2, Workflow, GitBranch, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

/**
 * Trigger and operator vocabularies both come from @shared/workflowTriggers, so
 * this page, the engine and the AI rule generator cannot drift apart again —
 * they had, and the generator was advertising a trigger this page already knew
 * was dead. Only triggers with a real dispatch site are offered; see the header
 * of server/services/workflowEngine.ts for the site of each.
 *
 * Three were retired for exactly that reason, and are still recognised on old
 * saved rules (flagged "never fires" on the row rather than left looking
 * healthy): `nps_submitted` (nothing submits an NPS score — it is a column
 * edited like any other, so use "record is updated"), `field_equals` (that is a
 * CONDITION, not an event — add it in the Conditions section below), and
 * `schedule` (a cron rule with no record context; "deal is stuck" already
 * covers the case it was seeded for).
 */
const TRIGGERS = LIVE_TRIGGERS.map((t) => [t.id, t.label] as const);

/** Comparators the engine's evalConditions actually implements. */
const OPS = CONDITION_OPS.map((o) => [o.id, o.label] as const);

/**
 * Condition fields. `ownerId` and `leadGrade` were offered here and are not
 * columns on anything — the schema spells them `ownerUserId` and `grade` — so a
 * rule conditioned on either compared against `undefined` and evaluated false
 * forever, the same silent shape as the `in` operator bug above. Replaced with
 * their real names, plus the keys the dispatch payloads actually carry
 * (2026-09-20).
 *
 * Which of these are populated depends on the trigger: stage_changed carries
 * stage/fromStage/value/winProb; deal_stuck adds daysInStage; signal_received
 * carries `signal`; task_overdue carries priority/type.
 *
 * record_created / record_updated no longer use this list at all — they take
 * their fields from recordFieldsFor(), which is the SAME declaration the
 * dispatch payload is built from (@shared/workflowTriggers). The two used to
 * be independent hand-written lists with nothing in common, so every
 * conditioned record rule compared against `undefined` and never matched
 * (2026-09-20). A per-trigger map for the remaining four is its own item.
 */
const FIELDS = [
  "stage", "value", "winProb", "ownerUserId", "status", "score", "grade", "source",
  "company", "title", "industry", "region", "daysInStage", "changed", "signal",
  "priority", "healthScore", "renewalDate", "npsScore",
];

const ACTION_TYPES = [
  ["create_task", "Create task"],
  ["send_email_draft", "Send AI email draft"],
  ["notify_user", "Notify user"],
  ["update_field", "Update field"],
  ["enroll_sequence", "Enroll in sequence"],
  ["post_slack", "Post to Slack"],
  ["notify_teams", "Notify Teams"],
  ["webhook", "Call webhook"],
] as const;

type Cond = { field: string; op: string; value: string };
type Act = { type: string; params: Record<string, string> };

export default function Workflows() {
  const utils = trpc.useUtils();
  const { data, isLoading, error, refetch } = trpc.workflows.list.useQuery();
  const [selected, setSelected] = useState<number | null>(null);
  const [openNew, setOpenNew] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestionsQ = trpc.workflowsAi.listSuggestions.useQuery(undefined, { enabled: showSuggestions });
  const suggestMut = trpc.workflowsAi.generateSuggestions.useMutation({
    onSuccess: () => suggestionsQ.refetch(),
    onError: (e: any) => toast.error(e.message),
  });
  const runs = trpc.workflows.runs.useQuery({ ruleId: selected ?? undefined });
  const create = trpc.workflows.create.useMutation({ onSuccess: () => { utils.workflows.list.invalidate(); setOpenNew(false); toast.success("Rule created"); }, onError: (e) => toast.error(e.message) });
  const update = trpc.workflows.update.useMutation({ onSuccess: () => { utils.workflows.list.invalidate(); toast.success("Rule saved"); }, onError: (e) => toast.error(e.message) });
  const toggle = trpc.workflows.toggle.useMutation({ onSuccess: () => utils.workflows.list.invalidate(), onError: (e) => toast.error(e.message) });
  const test = trpc.workflows.testFire.useMutation({ onSuccess: () => { utils.workflows.runs.invalidate(); utils.workflows.list.invalidate(); toast.success("Rule fired (1 simulated run)"); }, onError: (e) => toast.error(e.message) });
  const removeRule = trpc.workflows.delete.useMutation({
    onSuccess: (_d, vars) => {
      utils.workflows.list.invalidate();
      if (selected === vars.id) setSelected(null);
      toast.success("Rule deleted");
    },
    onError: (e) => toast.error("Failed to delete rule", { description: e.message }),
  });

  const rule = useMemo(() => data?.find((x) => x.id === selected) ?? null, [data, selected]);

  return (
    <Shell title="Workflow Automation">
      <PageHeader title="Workflow Automation" description="Automate repetitive actions with trigger-based workflow rules across the entire CRM. Workflows fire on record changes, time delays, or score thresholds and can update fields, send emails, or create tasks." pageKey="workflows"
        icon={<GitBranch className="size-5" />}
      >
        <Button variant="outline" onClick={() => { suggestMut.mutate(); setShowSuggestions(true); }} disabled={suggestMut.isPending}>
          <Sparkles className="size-4" /> {suggestMut.isPending ? "Analysing…" : "AI suggestions"}
        </Button>
        <Button onClick={() => setOpenNew(true)}><Plus className="size-4" /> New rule</Button>
      </PageHeader>
      {/* AI Workflow Suggestions Panel */}
      {showSuggestions && (suggestionsQ.data ?? []).length > 0 && (
        <div className="mx-6 mt-4 rounded-lg border border-violet-200 bg-violet-50/60 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-sm font-medium text-violet-800">
              <Sparkles className="size-4" />
              AI-suggested workflows based on your activity patterns
            </div>
            <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowSuggestions(false)}>Dismiss</button>
          </div>
          <ul className="space-y-2">
            {(suggestionsQ.data ?? []).map((s: any, i: number) => (
              <li key={s.id ?? i} className="rounded border bg-white p-3 text-sm">
                <div className="font-medium">{s.title}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{s.description}</div>
                <div className="mt-1.5 flex gap-3 text-xs">
                  <span className="text-muted-foreground">Trigger: <span className="font-medium text-foreground">{s.triggerType}</span></span>
                  <span className="text-muted-foreground">Action: <span className="font-medium text-foreground">{(s.actions as any[])?.[0]?.type ?? "—"}</span></span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="p-4 md:p-5 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          <Section title={`Rules (${data?.length ?? 0})`}>
            {error ? <QueryError message={error.message} onRetry={() => refetch()} /> : isLoading ? <TableSkeleton rows={6} /> : (data ?? []).length === 0 ? <EmptyState icon={Workflow} title="None yet" /> : (
              <ul className="divide-y">
                {data!.map((r) => (
                  <li key={r.id} className={`p-3 cursor-pointer hover:bg-secondary/40 ${selected === r.id ? "bg-secondary/60" : ""}`} onClick={() => setSelected(r.id)}>
                    <div className="flex items-center gap-2">
                      <Switch checked={r.enabled} onCheckedChange={(v) => toggle.mutate({ id: r.id, enabled: v })} onClick={(e) => e.stopPropagation()} />
                      <div className="text-sm font-medium flex-1 truncate">{r.name}</div>
                      <span className="text-xs text-muted-foreground font-mono tabular-nums">{r.fireCount}x</span>
                      {/* span stops the click reaching the row behind it. */}
                      <span onClick={(e) => e.stopPropagation()} className="contents">
                        <ConfirmButton
                          className="text-muted-foreground hover:text-destructive p-1 h-auto rounded"
                          ariaLabel="Delete rule"
                          title="Delete this workflow rule?"
                          description={`"${r.name}" will be permanently deleted and will stop firing. This cannot be undone.`}
                          confirmLabel="Delete"
                          onConfirm={() => removeRule.mutate({ id: r.id })}
                        >
                          <Trash2 className="size-3.5" />
                        </ConfirmButton>
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                      <StatusPill tone={isDeadTrigger(r.triggerType) ? "muted" : "info"}>{r.triggerType}</StatusPill>
                      {isDeadTrigger(r.triggerType) && (
                        <span title="This trigger has no dispatcher — the rule will never fire. Edit it and pick another trigger.">
                          <StatusPill tone="warning">never fires</StatusPill>
                        </span>
                      )}
                    </div>
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
          const t = String(f.get("triggerType"));
          create.mutate({
            name: String(f.get("name")),
            description: String(f.get("description") ?? "") || undefined,
            triggerType: t as any,
            // Explicit rather than relying on the engine's "absent means lead"
            // default, so the editor shows the same scope the rule will use.
            triggerConfig: t === "record_created" || t === "record_updated" ? { entity: "lead" } : {},
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
  const [triggerConfig, setTriggerConfig] = useState<Record<string, string>>((rule.triggerConfig as Record<string, string>) ?? {});

  useEffect(() => {
    setTrigger(rule.triggerType);
    setConds((rule.conditions as Cond[]) ?? []);
    setActs((rule.actions as Act[]) ?? [{ type: "create_task", params: { title: "Follow up" } }]);
    setTriggerConfig((rule.triggerConfig as Record<string, string>) ?? {});
  }, [rule.id]);

  /**
   * The record triggers are scoped to one entity, and the condition fields
   * follow that scope: a contact payload has no `stage`, so offering one is
   * the dead wiring this page keeps being fixed for. Absent entity reads as
   * "lead", exactly as the engine's entityGateAllows() does.
   */
  const isRecordTrigger = trigger === "record_created" || trigger === "record_updated";
  const entity = isRecordTrigger ? (triggerConfig.entity ?? "lead") : null;
  const fieldOptions = isRecordTrigger ? recordFieldsFor(trigger, entity) : FIELDS;

  const dirty =
    trigger !== rule.triggerType ||
    JSON.stringify(conds) !== JSON.stringify(rule.conditions ?? []) ||
    JSON.stringify(acts) !== JSON.stringify(rule.actions ?? []) ||
    JSON.stringify(triggerConfig) !== JSON.stringify(rule.triggerConfig ?? {});

  return (
    <Section
      title={rule.name}
      description={rule.description ?? "Edit when this rule fires and what it does, then save."}
      right={
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onTest}><Play className="size-3.5" /> Test fire</Button>
          <Button size="sm" disabled={!dirty || isSaving} onClick={() => onSave({ triggerType: trigger, triggerConfig, conditions: conds, actions: acts })}>
            <Save className="size-3.5" /> {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      }
    >
      <div className="p-4 space-y-5 text-sm">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">When</div>
          {/* Conditions are cleared with the trigger: a field vocabulary from
              another trigger is meaningless here, and a leftover `daysInStage`
              on a record rule is a condition that can never match. The entity
              is seeded so the editor shows the scope the engine will use. */}
          <select
            value={trigger}
            onChange={(e) => {
              const t = e.target.value;
              setTrigger(t);
              setTriggerConfig(t === "record_created" || t === "record_updated" ? { entity: "lead" } : {});
              setConds([]);
            }}
            className="w-full border rounded-md px-3 py-2 h-10 text-sm bg-card"
          >
            {TRIGGERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {trigger === "deal_stuck" && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Stage (leave blank for any)</label>
                <input
                  value={triggerConfig.stage ?? ""}
                  onChange={(e) => setTriggerConfig({ ...triggerConfig, stage: e.target.value })}
                  placeholder="e.g. Proposal"
                  className="w-full border rounded px-2 py-1.5 text-xs bg-card"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Days stuck (minimum)</label>
                <input
                  type="number"
                  value={triggerConfig.days ?? "7"}
                  onChange={(e) => setTriggerConfig({ ...triggerConfig, days: e.target.value })}
                  placeholder="7"
                  className="w-full border rounded px-2 py-1.5 text-xs bg-card"
                />
              </div>
            </div>
          )}
          {isRecordTrigger && (
            <div className="mt-2 space-y-1">
              <label className="text-xs text-muted-foreground">Which records</label>
              <select
                value={entity ?? "lead"}
                onChange={(e) => { setTriggerConfig({ ...triggerConfig, entity: e.target.value }); setConds([]); }}
                className="w-full border rounded px-2 py-1.5 text-xs bg-card"
              >
                {RECORD_ENTITIES.map((en) => <option key={en.id} value={en.id}>{en.label}</option>)}
              </select>
              {/* A rule saved before these triggers covered anything but leads
                  carries no entity at all; the engine reads that as "lead", so
                  the default shown here matches what it will actually do. */}
              <div className="text-[11px] text-muted-foreground">
                Conditions below follow this choice — they are the fields the event actually carries. Accounts are not covered yet: update field, enroll and email draft have no account handler.
              </div>
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Conditions (all must match)</div>
            <Button size="sm" variant="ghost" onClick={() => setConds([...conds, { field: fieldOptions[0]!, op: "eq", value: "" }])}>+ Condition</Button>
          </div>
          {conds.length === 0 ? <div className="text-xs text-muted-foreground italic py-2">No conditions — fires on every trigger.</div> : (
            <div className="space-y-2">
              {conds.map((c, i) => (
                <div key={i} className="grid grid-cols-12 gap-2">
                  <select value={c.field} onChange={(e) => setConds(conds.map((x, j) => j === i ? { ...x, field: e.target.value } : x))} className="col-span-4 border rounded px-2 py-1.5 text-xs bg-card">
                    {/* A field saved before this vocabulary narrowed is kept as
                        its own option — dropping it would render the select
                        blank and silently rewrite the rule on the next save. */}
                    {fieldOptions.indexOf(c.field) < 0 && c.field ? <option value={c.field}>{c.field} (not carried by this event)</option> : null}
                    {fieldOptions.map((f) => <option key={f} value={f}>{f}</option>)}
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
                  {/* An action the scoped entity cannot run is labelled, not
                      hidden: the engine returns "cannot enroll a opportunity"
                      on every fire and logs the run as failed, which is a rule
                      that looks built and never works. Saved rules keep their
                      action so the label explains the failures they already
                      have (2026-09-20). */}
                  <select value={a.type} onChange={(e) => setActs(acts.map((x, j) => j === i ? { ...x, type: e.target.value, params: defaultParams(e.target.value) } : x))} className="flex-1 border rounded px-2 py-1.5 text-xs bg-card">
                    {ACTION_TYPES.map(([v, l]) => (
                      <option key={v} value={v}>{actionSupportsEntity(v, entity) ? l : `${l} — not supported on a ${entity}`}</option>
                    ))}
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
    case "notify_teams": return { message: "" };
    case "webhook": return { url: "", body: "{}" };
    default: return {};
  }
}
