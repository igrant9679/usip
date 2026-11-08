import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmButton, Field, fmtDate, FormDialog, Section, SelectField, StatusPill } from "@/components/usip/Common";
import { EmptyState, PageHeader, QueryError, Shell, TableSkeleton } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import {
  actionSupportsEntity, CONDITION_OPS, conditionFieldsFor, dryRunRecordTypesFor, isDeadTrigger, LEAD_STATUSES, LIVE_TRIGGERS,
  payloadField, RECORD_ENTITIES, SIGNAL_NAMES, TASK_PRIORITIES, UPDATE_FIELD_ALLOWED, type DryRunRecordType,
} from "@shared/workflowTriggers";
import { Check, FlaskConical, Play, Plus, Save, Trash2, Workflow, GitBranch, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { pressable } from "@/lib/pressable";

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
const triggerLabel = (id: string) => LIVE_TRIGGERS.find((t) => t.id === id)?.label ?? id;

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
 * record_created / record_updated take their fields from recordFieldsFor(),
 * which is the SAME declaration the dispatch payload is built from
 * (@shared/workflowTriggers). The other four triggers take theirs from
 * TRIGGER_FIELDS in the same file, so every trigger offers only what its event
 * carries (G61). Each key is shown by its declared label, and its value is
 * picked by name where it names something (F46, G71).
 */

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
const actionLabel = (t: string) => ACTION_TYPES.find(([v]) => v === t)?.[1] ?? t;

/** The task types create_task accepts (workflowEngine's TASK_TYPES). */
const CREATE_TASK_TYPES = ["follow_up", "call", "manual_email", "social_touch", "meeting_prep", "crm_update", "generic_action", "todo"] as const;
const humanize = (s: string) => s.replace(/_/g, " ");

type Cond = { field: string; op: string; value: string };
type Act = { type: string; params: Record<string, string> };
type Options = {
  users: Array<{ id: number; name: string }>;
  sequences: Array<{ id: number; name: string; status: string }>;
  stages: Array<{ key: string; label: string }>;
  campaigns: Array<{ id: number; name: string }>;
};
const NO_OPTIONS: Options = { users: [], sequences: [], stages: [], campaigns: [] };

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
  // The suggestion panel's actions (G71: it listed ideas with nothing to do
  // with them). Added rules start switched off, as everywhere else (G61).
  const applySuggestion = trpc.workflowsAi.applySuggestion.useMutation({
    onSuccess: () => { void suggestionsQ.refetch(); utils.workflows.list.invalidate(); toast.success("Rule added, switched off — open it to check, then turn it on"); },
    onError: (e) => toast.error(e.message),
  });
  const dismissSuggestion = trpc.workflowsAi.dismissSuggestion.useMutation({
    onSuccess: () => { void suggestionsQ.refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const applyAllSuggestions = trpc.workflowsAi.applyAllSuggestions.useMutation({
    onSuccess: (r) => {
      void suggestionsQ.refetch();
      utils.workflows.list.invalidate();
      toast[r.failed.length ? "warning" : "success"](`${r.applied} rule${r.applied === 1 ? "" : "s"} added, switched off${r.failed.length ? `, ${r.failed.length} failed` : ""}`);
    },
    onError: (e) => toast.error(e.message),
  });
  const runs = trpc.workflows.runs.useQuery({ ruleId: selected ?? undefined });
  const options = trpc.workflows.editorOptions.useQuery(undefined, { staleTime: 60_000 });
  const create = trpc.workflows.create.useMutation({ onSuccess: () => { utils.workflows.list.invalidate(); setOpenNew(false); toast.success("Rule created, switched off — set its conditions and actions, then turn it on"); }, onError: (e) => toast.error(e.message) });
  const update = trpc.workflows.update.useMutation({ onSuccess: () => { utils.workflows.list.invalidate(); toast.success("Rule saved"); }, onError: (e) => toast.error(e.message) });
  const toggle = trpc.workflows.toggle.useMutation({ onSuccess: () => utils.workflows.list.invalidate(), onError: (e) => toast.error(e.message) });
  // A test runs nothing (audit G19): it says what the rule would do.
  const test = trpc.workflows.testFire.useMutation({
    onSuccess: (r) => {
      utils.workflows.runs.invalidate();
      const lines = [...r.plan, ...r.errors];
      if (r.errors.length) toast.error("Test: this rule can't run as set up. Nothing was sent or changed.", { description: lines.join(" · ") });
      else toast.success("Test only: nothing was sent or changed.", { description: lines.join(" · ") });
    },
    onError: (e) => toast.error(e.message),
  });
  const removeRule = trpc.workflows.delete.useMutation({
    onSuccess: (_d, vars) => {
      utils.workflows.list.invalidate();
      if (selected === vars.id) setSelected(null);
      toast.success("Rule deleted");
    },
    onError: (e) => toast.error("Failed to delete rule", { description: e.message }),
  });

  const rule = useMemo(() => data?.find((x) => x.id === selected) ?? null, [data, selected]);
  const sugList = (suggestionsQ.data ?? []) as any[];

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
      {showSuggestions && sugList.length > 0 && (
        <div className="mx-6 mt-4 rounded-lg border border-violet-200 bg-violet-50/60 p-4">
          <div className="flex items-center justify-between mb-3 gap-2">
            <div className="flex items-center gap-2 text-sm font-medium text-violet-800">
              <Sparkles className="size-4" />
              AI-suggested workflows based on your activity patterns
            </div>
            <div className="flex items-center gap-2">
              <ConfirmButton size="sm" variant="outline" destructive={false} className="h-7 gap-1.5" disabled={applyAllSuggestions.isPending || applySuggestion.isPending}
                title={`Add all ${sugList.length} suggested rule${sugList.length === 1 ? "" : "s"}?`}
                description="Each suggestion becomes a workflow rule, switched off. Nothing fires until you open a rule, check it and turn it on."
                confirmLabel="Add all" onConfirm={() => applyAllSuggestions.mutate()}>
                <Check className="size-3.5" /> Add all
              </ConfirmButton>
              <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowSuggestions(false)}>Hide</button>
            </div>
          </div>
          <ul className="space-y-2">
            {sugList.map((s: any, i: number) => (
              <li key={s.id ?? i} className="rounded border bg-white p-3 text-sm flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{s.title}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{s.description}</div>
                  <div className="mt-1.5 flex flex-wrap gap-3 text-xs">
                    <span className="text-muted-foreground">Trigger: <span className="font-medium text-foreground">{triggerLabel(String(s.triggerType ?? ""))}</span></span>
                    <span className="text-muted-foreground">Then: <span className="font-medium text-foreground">{((s.actions as any[]) ?? []).map((a) => actionLabel(String(a?.type ?? ""))).join(", ") || "—"}</span></span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="sm" variant="outline" className="h-7 gap-1" disabled={applySuggestion.isPending} onClick={() => applySuggestion.mutate({ id: s.id })}><Check className="size-3.5" /> Add</Button>
                  <Button aria-label={`Dismiss suggestion ${s.title}`} size="icon" variant="ghost" className="size-7 text-muted-foreground" disabled={dismissSuggestion.isPending} onClick={() => dismissSuggestion.mutate({ id: s.id })}><X className="size-4" /></Button>
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
                  <li key={r.id} className={`p-3 cursor-pointer hover:bg-secondary/40 ${selected === r.id ? "bg-secondary/60" : ""}`} {...pressable(() => setSelected(r.id))}>
                    <div className="flex items-center gap-2">
                      <Switch aria-label={`${r.name} enabled`} checked={r.enabled} onCheckedChange={(v) => toggle.mutate({ id: r.id, enabled: v })} onClick={(e) => e.stopPropagation()} />
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
                      <StatusPill tone={isDeadTrigger(r.triggerType) ? "muted" : "info"}>{isDeadTrigger(r.triggerType) ? r.triggerType : triggerLabel(r.triggerType)}</StatusPill>
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
              options={options.data ?? NO_OPTIONS}
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
            // Off until someone turns it on: with the placeholder action above
            // and no conditions, a live rule made a "Follow up" task on every
            // stage change the moment it was created (G61).
            enabled: false,
          });
        }}>
        <Field name="name" label="Name" required />
        <Field name="description" label="Description" />
        <SelectField name="triggerType" label="Trigger" options={TRIGGERS.map(([v, l]) => ({ value: v, label: l }))} defaultValue="stage_changed" />
        <div className="text-xs text-muted-foreground">The rule is created switched off. Add its conditions and actions in the visual editor, then turn it on.</div>
      </FormDialog>
    </Shell>
  );
}

const inputCls = "border rounded px-2 py-1.5 text-xs bg-card";

/** A select that keeps a saved value it does not know, rather than silently rewriting it on the next save. */
function NamedSelect({ ariaLabel, value, onChange, choices, placeholder, className }: {
  ariaLabel: string; value: string; onChange: (v: string) => void;
  choices: Array<{ value: string; label: string }>; placeholder?: string; className?: string;
}) {
  const known = value === "" || choices.some((c) => c.value === value);
  return (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} ${className ?? ""}`}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {!known && <option value={value}>{value} (not found)</option>}
      {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
    </select>
  );
}

/** Pick a record by name (accounts in conditions; any record in the dry run). Stores the id. */
function RecordSearch({ type, value, onPick, ariaLabel }: {
  type: "lead" | "contact" | "opportunity" | "task" | "account"; value: number | null;
  onPick: (r: { id: number; label: string } | null) => void; ariaLabel: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const results = trpc.workflows.searchRecords.useQuery({ type, q: q || undefined }, { enabled: open, staleTime: 15_000 });
  const chosen = trpc.workflows.searchRecords.useQuery({ type, ids: value ? [value] : [] }, { enabled: !!value && !open, staleTime: 60_000 });
  const chosenLabel = value ? (chosen.data?.[0]?.label ?? "…") : "";
  return (
    <div className="relative">
      <input aria-label={ariaLabel} value={open ? q : chosenLabel} placeholder={`Search ${type === "opportunity" ? "deals" : `${type}s`} by name`}
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)} className={`${inputCls} w-full`} />
      {open && (
        <ul className="absolute z-20 mt-1 w-full max-h-56 overflow-auto rounded-md border bg-popover shadow-sm text-xs">
          {(results.data ?? []).length === 0 ? <li className="px-2 py-1.5 text-muted-foreground">{results.isLoading ? "Searching…" : "No matches"}</li> : results.data!.map((r) => (
            <li key={r.id}>
              <button type="button" className="w-full text-left px-2 py-1.5 hover:bg-muted" onMouseDown={(e) => e.preventDefault()} onClick={() => { onPick({ id: r.id, label: r.label }); setOpen(false); setQ(""); }}>
                <span className="font-medium">{r.label}</span>{r.sub ? <span className="text-muted-foreground"> · {r.sub}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A condition's value, picked by name when the declared field names something (G71). */
function ConditionValue({ field, op, value, onChange, options, ariaLabel }: {
  field: string; op: string; value: string; onChange: (v: string) => void; options: Options; ariaLabel: string;
}) {
  const f = payloadField(field);
  if (op === "in") return <input aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} placeholder="values, comma-separated" className={`${inputCls} w-full`} />;
  if (f.ref === "user") return <NamedSelect ariaLabel={ariaLabel} value={value} onChange={onChange} placeholder="Pick a person…" choices={options.users.map((u) => ({ value: String(u.id), label: u.name }))} className="w-full" />;
  if (f.ref === "stage") return <NamedSelect ariaLabel={ariaLabel} value={value} onChange={onChange} placeholder="Pick a stage…" choices={options.stages.map((s) => ({ value: s.key, label: s.label }))} className="w-full" />;
  if (f.ref === "campaign") return <NamedSelect ariaLabel={ariaLabel} value={value} onChange={onChange} placeholder="Pick a campaign…" choices={options.campaigns.map((c) => ({ value: String(c.id), label: c.name }))} className="w-full" />;
  if (f.ref === "account") return <RecordSearch type="account" ariaLabel={ariaLabel} value={Number(value) || null} onPick={(r) => onChange(r ? String(r.id) : "")} />;
  if (f.values) return <NamedSelect ariaLabel={ariaLabel} value={value} onChange={onChange} placeholder="Pick…" choices={f.values.map((v) => ({ value: v, label: humanize(v) }))} className="w-full" />;
  if (f.type === "boolean") return <NamedSelect ariaLabel={ariaLabel} value={value} onChange={onChange} placeholder="Pick…" choices={[{ value: "true", label: "yes" }, { value: "false", label: "no" }]} className="w-full" />;
  return <input aria-label={ariaLabel} type={f.type === "number" ? "number" : "text"} value={value} onChange={(e) => onChange(e.target.value)} placeholder={f.hint ?? "value"} className={`${inputCls} w-full`} />;
}

/** The fields update_field can set for this rule's records (the engine's allowlist). */
function updatableFields(entity: string | null): string[] {
  if (entity && entity !== "any" && UPDATE_FIELD_ALLOWED[entity]) return Object.keys(UPDATE_FIELD_ALLOWED[entity]!);
  const all: string[] = [];
  for (const e of Object.keys(UPDATE_FIELD_ALLOWED)) for (const k of Object.keys(UPDATE_FIELD_ALLOWED[e]!)) if (all.indexOf(k) < 0) all.push(k);
  return all;
}

/**
 * One action's settings, with names where the engine wants an id (G71: it
 * showed a raw text box per param — "userId", "sequenceId"). Params a saved
 * rule carries that this editor does not know are kept as plain fields.
 */
function ActionParams({ act, index, entity, options, onChange }: {
  act: Act; index: number; entity: string | null; options: Options; onChange: (params: Record<string, string>) => void;
}) {
  const p = act.params;
  const set = (k: string, v: string) => onChange({ ...p, [k]: v });
  const n = index + 1;
  const users = options.users.map((u) => ({ value: String(u.id), label: u.name }));
  const known: string[] = [];
  const text = (k: string, label: string, placeholder?: string, type = "text") => {
    known.push(k);
    return <input key={k} aria-label={`Action ${n} ${label}`} type={type} value={p[k] ?? ""} onChange={(e) => set(k, e.target.value)} placeholder={placeholder ?? label} className={inputCls} />;
  };
  const pick = (k: string, label: string, choices: Array<{ value: string; label: string }>, placeholder: string) => {
    known.push(k);
    return <NamedSelect key={k} ariaLabel={`Action ${n} ${label}`} value={p[k] ?? ""} onChange={(v) => set(k, v)} choices={choices} placeholder={placeholder} />;
  };
  let fields: ReactNode[] = [];
  switch (act.type) {
    case "create_task":
      fields = [
        text("title", "task title", "Task title"),
        text("dueInDays", "due in days", "Due in (days)", "number"),
        pick("priority", "priority", TASK_PRIORITIES.map((v) => ({ value: v, label: v })), "Normal priority"),
        pick("type", "task type", CREATE_TASK_TYPES.map((v) => ({ value: v, label: humanize(v) })), "Follow-up"),
        pick("ownerUserId", "assign to", users, "The record's owner"),
      ];
      break;
    case "notify_user":
      fields = [pick("userId", "person to notify", users, "The record's owner"), text("message", "message", "Message")];
      break;
    case "update_field": {
      const fieldKey = p.field ?? "";
      fields = [pick("field", "field to set", updatableFields(entity).map((k) => ({ value: k, label: payloadField(k).label })), "Pick a field…")];
      known.push("value");
      const vLabel = `Action ${n} new value`;
      if (fieldKey === "ownerUserId") fields.push(<NamedSelect key="value" ariaLabel={vLabel} value={p.value ?? ""} onChange={(v) => set("value", v)} choices={users} placeholder="Pick a person…" />);
      else if (fieldKey === "stage") fields.push(<NamedSelect key="value" ariaLabel={vLabel} value={p.value ?? ""} onChange={(v) => set("value", v)} choices={options.stages.map((s) => ({ value: s.key, label: s.label }))} placeholder="Pick a stage…" />);
      else if (fieldKey === "status") fields.push(<NamedSelect key="value" ariaLabel={vLabel} value={p.value ?? ""} onChange={(v) => set("value", v)} choices={LEAD_STATUSES.map((v) => ({ value: v, label: v }))} placeholder="Pick a status…" />);
      else fields.push(<input key="value" aria-label={vLabel} type={["value", "winProb", "score"].indexOf(fieldKey) >= 0 ? "number" : "text"} value={p.value ?? ""} onChange={(e) => set("value", e.target.value)} placeholder="New value" className={inputCls} />);
      break;
    }
    case "enroll_sequence":
      fields = [pick("sequenceId", "sequence", options.sequences.map((s) => ({ value: String(s.id), label: s.status === "active" ? s.name : `${s.name} (${s.status})` })), "Pick a sequence…")];
      break;
    case "send_email_draft":
      fields = [text("tone", "tone", "Tone, e.g. professional"), text("goal", "goal", "Goal, e.g. follow up")];
      break;
    case "post_slack":
      fields = [text("channel", "Slack channel", "#sales"), text("message", "message", "Message")];
      break;
    case "notify_teams":
      fields = [text("message", "message", "Message")];
      break;
    case "webhook":
      fields = [text("url", "webhook URL", "https://…"), text("body", "body", "JSON body (optional)")];
      break;
  }
  // Anything else a saved rule carries stays editable, so a save never drops it.
  const extra = Object.keys(p).filter((k) => known.indexOf(k) < 0);
  return (
    <div className="grid grid-cols-2 gap-2">
      {fields}
      {extra.map((k) => (
        <input aria-label={`Action ${n} ${k}`} key={k} value={p[k] ?? ""} onChange={(e) => set(k, e.target.value)} placeholder={k} className={inputCls} />
      ))}
    </div>
  );
}

function RuleEditor({ rule, options, onSave, onTest, isSaving }: { rule: any; options: Options; onSave: (patch: any) => void; onTest: () => void; isSaving: boolean }) {
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
   * "lead", exactly as the engine's entityGateAllows() does. The list comes
   * from recordFieldsFor() for those triggers, through conditionFieldsFor().
   */
  const isRecordTrigger = trigger === "record_created" || trigger === "record_updated";
  const entity = isRecordTrigger ? (triggerConfig.entity ?? "lead") : null;
  const fieldOptions = conditionFieldsFor(trigger, entity);

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
          <Button size="sm" variant="ghost" onClick={onTest}><Play className="size-3.5" /> Test (sends nothing)</Button>
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
          <select aria-label="Trigger"
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
                <label className="text-xs text-muted-foreground">Stage</label>
                {/* A stage picked by name (G71): this was a free-text box that
                    wanted the stage KEY, so "Proposal" never matched "proposal". */}
                <NamedSelect ariaLabel="Stage (any if blank)" value={triggerConfig.stage ?? ""} onChange={(v) => setTriggerConfig({ ...triggerConfig, stage: v })}
                  placeholder="Any stage" choices={options.stages.map((s) => ({ value: s.key, label: s.label }))} className="w-full" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Days stuck (minimum)</label>
                <input aria-label="Days stuck (minimum)"
                  type="number"
                  value={triggerConfig.days ?? "7"}
                  onChange={(e) => setTriggerConfig({ ...triggerConfig, days: e.target.value })}
                  placeholder="7"
                  className="w-full border rounded px-2 py-1.5 text-xs bg-card"
                />
              </div>
            </div>
          )}
          {trigger === "signal_received" && (
            <div className="mt-2 space-y-1">
              <label className="text-xs text-muted-foreground">Which signal</label>
              <NamedSelect ariaLabel="Which signal" value={triggerConfig.signal ?? ""} onChange={(v) => setTriggerConfig({ ...triggerConfig, signal: v })}
                placeholder="Any signal" choices={SIGNAL_NAMES.map((s) => ({ value: s, label: humanize(s) }))} className="w-full" />
            </div>
          )}
          {isRecordTrigger && (
            <div className="mt-2 space-y-1">
              <label className="text-xs text-muted-foreground">Which records</label>
              <select aria-label="Which records"
                value={entity ?? "lead"}
                onChange={(e) => { setTriggerConfig({ ...triggerConfig, entity: e.target.value }); setConds([]); }}
                className="w-full border rounded px-2 py-1.5 text-xs bg-card"
              >
                {RECORD_ENTITIES.map((en) => <option key={en.id} value={en.id}>{en.label}</option>)}
              </select>
              {/* A rule saved before these triggers covered anything but leads
                  carries no entity at all (triggerConfig.entity unset); the
                  engine reads that as "lead", so the default shown here
                  matches what it will actually do. */}
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
                  <select aria-label={`Condition ${i + 1} field`} value={c.field} onChange={(e) => setConds(conds.map((x, j) => j === i ? { ...x, field: e.target.value, value: "" } : x))} className={`col-span-4 ${inputCls}`}>
                    {/* A field saved before this vocabulary narrowed is kept as
                        its own option — dropping it would render the select
                        blank and silently rewrite the rule on the next save. */}
                    {fieldOptions.indexOf(c.field) < 0 && c.field ? <option value={c.field}>{c.field} (not carried by this event)</option> : null}
                    {fieldOptions.map((f) => <option key={f} value={f}>{payloadField(f).label}</option>)}
                  </select>
                  <select aria-label={`Condition ${i + 1} operator`} value={c.op} onChange={(e) => setConds(conds.map((x, j) => j === i ? { ...x, op: e.target.value } : x))} className={`col-span-3 ${inputCls}`}>
                    {OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <div className="col-span-4">
                    <ConditionValue field={c.field} op={c.op} value={String(c.value ?? "")} options={options} ariaLabel={`Condition ${i + 1} value`}
                      onChange={(v) => setConds(conds.map((x, j) => j === i ? { ...x, value: v } : x))} />
                  </div>
                  <button aria-label="Remove condition" onClick={() => setConds(conds.filter((_, j) => j !== i))} className="col-span-1 text-muted-foreground hover:text-rose-600 flex items-center justify-center"><Trash2 className="size-3.5" /></button>
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
                  <select aria-label={`Action ${i + 1}`} value={a.type} onChange={(e) => setActs(acts.map((x, j) => j === i ? { ...x, type: e.target.value, params: defaultParams(e.target.value) } : x))} className={`flex-1 ${inputCls}`}>
                    {ACTION_TYPES.map(([v, l]) => (
                      <option key={v} value={v}>{actionSupportsEntity(v, entity) ? l : `${l} — not supported on a ${entity}`}</option>
                    ))}
                  </select>
                  <button aria-label="Remove action" onClick={() => setActs(acts.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-rose-600"><Trash2 className="size-3.5" /></button>
                </div>
                <ActionParams act={a} index={i} entity={entity} options={options}
                  onChange={(params) => setActs(acts.map((x, j) => j === i ? { ...x, params } : x))} />
              </div>
            ))}
          </div>
        </div>

        <DryRunPanel trigger={trigger} triggerConfig={triggerConfig} conds={conds} acts={acts} options={options} />
      </div>
    </Section>
  );
}

/**
 * Try the rule, as it stands on screen, against one real record (F46): the
 * payload its trigger would carry, which gates and conditions pass, and what
 * each action would do to that record. The server only reads.
 */
function DryRunPanel({ trigger, triggerConfig, conds, acts, options }: {
  trigger: string; triggerConfig: Record<string, string>; conds: Cond[]; acts: Act[]; options: Options;
}) {
  const types = dryRunRecordTypesFor(trigger, triggerConfig.entity);
  const [type, setType] = useState<DryRunRecordType | "">(types[0] ?? "");
  const [record, setRecord] = useState<{ id: number; label: string } | null>(null);
  const [signal, setSignal] = useState<string>(SIGNAL_NAMES[0]);
  const [fromStage, setFromStage] = useState("");
  const run = trpc.workflows.dryRun.useMutation({ onError: (e) => toast.error(e.message) });
  const typesKey = types.join(",");
  useEffect(() => {
    if (!type || types.indexOf(type as DryRunRecordType) < 0) { setType(types[0] ?? ""); setRecord(null); run.reset(); }
  }, [typesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (types.length === 0) return null;
  const r = run.data;
  const typeName = (t: string) => (t === "opportunity" ? "deal" : t);
  return (
    <div className="rounded-md border p-3 space-y-3 bg-muted/20">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground"><FlaskConical className="size-3.5" /> Dry run on a record</div>
      <div className="grid grid-cols-12 gap-2 items-center">
        {types.length > 1 && (
          <select aria-label="Record type for the dry run" value={type} onChange={(e) => { setType(e.target.value as DryRunRecordType); setRecord(null); run.reset(); }} className={`col-span-3 ${inputCls}`}>
            {types.map((t) => <option key={t} value={t}>{typeName(t)}</option>)}
          </select>
        )}
        <div className={types.length > 1 ? "col-span-6" : "col-span-9"}>
          {type && <RecordSearch key={type} type={type} value={record?.id ?? null} ariaLabel={`Pick a ${typeName(type)} for the dry run`} onPick={(x) => { setRecord(x); run.reset(); }} />}
        </div>
        <Button size="sm" variant="outline" className="col-span-3" disabled={!record || !type || run.isPending}
          onClick={() => record && type && run.mutate({
            draft: { triggerType: trigger as any, triggerConfig, conditions: conds, actions: acts },
            recordType: type as DryRunRecordType,
            recordId: record.id,
            signal: trigger === "signal_received" && !triggerConfig.signal ? signal : undefined,
            fromStage: trigger === "stage_changed" && fromStage ? fromStage : undefined,
          })}>
          {run.isPending ? "Trying…" : "Try it"}
        </Button>
      </div>
      {trigger === "signal_received" && !triggerConfig.signal && (
        <NamedSelect ariaLabel="Signal to try" value={signal} onChange={setSignal} choices={SIGNAL_NAMES.map((s) => ({ value: s, label: humanize(s) }))} />
      )}
      {trigger === "stage_changed" && (
        <NamedSelect ariaLabel="Previous stage to try" value={fromStage} onChange={setFromStage} placeholder="Moved from: any stage" choices={options.stages.map((s) => ({ value: s.key, label: s.label }))} />
      )}
      {r && (
        <div className="space-y-2 text-xs" aria-live="polite">
          <div className="flex items-center gap-2">
            <StatusPill tone={r.wouldFire ? "success" : "muted"}>{r.wouldFire ? "Would fire" : "Would not fire"}</StatusPill>
            <span className="text-muted-foreground">for {r.record.label}. Nothing was changed or sent.</span>
          </div>
          {r.gates.length > 0 && (
            <ul className="space-y-0.5">{r.gates.map((g, i) => <li key={i} className={g.pass ? "text-emerald-700" : "text-rose-600"}>{g.pass ? "✓" : "✗"} {g.label}: {g.detail}</li>)}</ul>
          )}
          {r.conditions.length > 0 && (
            <ul className="space-y-0.5">{r.conditions.map((c, i) => (
              <li key={i} className={c.pass ? "text-emerald-700" : "text-rose-600"}>
                {c.pass ? "✓" : "✗"} {c.label} {OPS.find(([v]) => v === c.op)?.[1] ?? c.op} "{String(c.value ?? "")}" — the record has "{c.actual == null ? "nothing" : String(c.actual)}"
              </li>
            ))}</ul>
          )}
          <ul className="space-y-0.5">{r.steps.map((s, i) => <li key={i} className={s.ok ? "" : "text-amber-700"}>{actionLabel(s.action)}: {s.text}</li>)}</ul>
          {r.notes.map((n, i) => <p key={i} className="text-muted-foreground">{n}</p>)}
        </div>
      )}
    </div>
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
