import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Field, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import {
  Activity, GitBranch, Pause, Play, Plus, Power, CheckCircle2, XCircle,
  BarChart3, RefreshCw, Pencil, Trash2, ArrowUp, ArrowDown, Mail, Clock, ClipboardList, TrendingUp,
} from "lucide-react";
import { useState, useEffect } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";

// ─── Types ───────────────────────────────────────────────────────────────────
type StepType = "email" | "wait" | "task";
interface EmailStep { type: "email"; subject: string; body?: string }
interface WaitStep { type: "wait"; days: number }
interface TaskStep { type: "task"; body: string }
type Step = EmailStep | WaitStep | TaskStep;

// ─── EnrollmentStatsPanel ────────────────────────────────────────────────────
function EnrollmentStatsPanel({ sequenceId, steps }: { sequenceId: number; steps: any[] }) {
  const { data: stats, isLoading: statsLoading, refetch } = trpc.sequences.getEnrollmentStats.useQuery({ sequenceId });
  const { data: stepStats = [] } = trpc.sequences.getEnrollmentStepStats.useQuery({ sequenceId });
  const { data: enrollmentList = [], isLoading: listLoading } = trpc.sequences.listEnrollments.useQuery({ sequenceId });

  const resume = trpc.sequences.resumeEnrollment.useMutation({
    onSuccess: () => { refetch(); toast.success("Enrollment resumed"); },
    onError: (e) => toast.error(e.message),
  });
  const exit = trpc.sequences.exitEnrollment.useMutation({
    onSuccess: () => { refetch(); toast.success("Enrollment exited"); },
    onError: (e) => toast.error(e.message),
  });
  const pauseOnReply = trpc.sequences.pauseOnReply.useMutation({
    onSuccess: () => { refetch(); toast.success("Enrollment paused (reply detected)"); },
    onError: (e) => toast.error(e.message),
  });

  const total = (stats?.active ?? 0) + (stats?.paused ?? 0) + (stats?.finished ?? 0) + (stats?.exited ?? 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: "Active", value: stats?.active ?? 0, icon: Play, color: "text-emerald-600" },
          { label: "Paused", value: stats?.paused ?? 0, icon: Pause, color: "text-amber-600" },
          { label: "Finished", value: stats?.finished ?? 0, icon: CheckCircle2, color: "text-blue-600" },
          { label: "Exited", value: stats?.exited ?? 0, icon: XCircle, color: "text-muted-foreground" },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="border">
            <CardContent className="p-3 flex items-center gap-2">
              <Icon className={`h-5 w-5 ${color} shrink-0`} />
              <div>
                <p className="text-xl font-bold tabular-nums">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {steps.length > 0 && stepStats.length > 0 && (
        <Section title="Step Performance">
          <div className="p-3 space-y-2">
            {steps.map((step, i) => {
              const count = stepStats.find((s: any) => s.step === i)?.count ?? 0;
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <div key={i} className="flex items-center gap-3 text-sm">
                  <span className="w-16 text-xs text-muted-foreground font-mono shrink-0">Step {i + 1}</span>
                  <span className="w-14 text-xs capitalize text-muted-foreground shrink-0">{step.type}</span>
                  <div className="flex-1 bg-muted rounded-full h-2">
                    <div className="h-2 rounded-full bg-[#14B89A] transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs tabular-nums w-8 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title={`Enrollments (${total})`} right={
        <Button size="sm" variant="ghost" onClick={() => refetch()}><RefreshCw className="h-3 w-3 mr-1" /> Refresh</Button>
      }>
        {listLoading ? (
          <div className="p-3 text-sm text-muted-foreground">Loading…</div>
        ) : enrollmentList.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">No enrollments yet.</div>
        ) : (
          <ul className="divide-y">
            {enrollmentList.map((e: any) => (
              <li key={e.id} className="p-3 flex items-center gap-2 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-medium">Enrollment #{e.id}</span>
                  <span className="text-muted-foreground ml-2">· Step {e.currentStep + 1}</span>
                  {e.nextActionAt && (
                    <span className="text-xs text-muted-foreground ml-2">
                      · Next: {new Date(e.nextActionAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <StatusPill tone={e.status === "active" ? "success" : e.status === "paused" ? "warning" : e.status === "finished" ? "info" : "muted"}>{e.status}</StatusPill>
                <div className="flex gap-1 shrink-0">
                  {e.status === "paused" && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => resume.mutate({ id: e.id })} disabled={resume.isPending}>Resume</Button>
                  )}
                  {e.status === "active" && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2 text-amber-600" onClick={() => pauseOnReply.mutate({ enrollmentId: e.id })} disabled={pauseOnReply.isPending}>Reply</Button>
                  )}
                  {(e.status === "active" || e.status === "paused") && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2 text-muted-foreground" onClick={() => exit.mutate({ id: e.id })} disabled={exit.isPending}>Exit</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ─── StepEditor ──────────────────────────────────────────────────────────────
function StepEditor({ steps, onChange, disabled }: { steps: Step[]; onChange: (s: Step[]) => void; disabled?: boolean }) {
  function addStep(type: StepType) {
    const newStep: Step =
      type === "email" ? { type: "email", subject: "New email", body: "" } :
      type === "wait"  ? { type: "wait", days: 1 } :
                         { type: "task", body: "Follow up task" };
    onChange([...steps, newStep]);
  }

  function removeStep(i: number) {
    onChange(steps.filter((_, idx) => idx !== i));
  }

  function moveStep(i: number, dir: -1 | 1) {
    const arr = [...steps];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange(arr);
  }

  function updateStep(i: number, patch: Partial<Step>) {
    const arr = [...steps];
    arr[i] = { ...arr[i], ...patch } as Step;
    onChange(arr);
  }

  return (
    <div className="space-y-2">
      {steps.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">No steps yet. Add one below.</p>
      )}
      {steps.map((step, i) => (
        <div key={i} className="border rounded-md p-3 bg-card space-y-2">
          <div className="flex items-center gap-2">
            {step.type === "email" && <Mail className="h-3.5 w-3.5 text-blue-500 shrink-0" />}
            {step.type === "wait"  && <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
            {step.type === "task"  && <ClipboardList className="h-3.5 w-3.5 text-purple-500 shrink-0" />}
            <span className="text-xs font-mono text-muted-foreground">Step {i + 1}</span>
            <span className="text-xs capitalize text-muted-foreground">· {step.type}</span>
            <div className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={disabled || i === 0} onClick={() => moveStep(i, -1)}><ArrowUp className="h-3 w-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={disabled || i === steps.length - 1} onClick={() => moveStep(i, 1)}><ArrowDown className="h-3 w-3" /></Button>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" disabled={disabled} onClick={() => removeStep(i)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </div>

          {step.type === "email" && (
            <div className="space-y-1.5">
              <Input
                placeholder="Subject"
                value={step.subject}
                disabled={disabled}
                onChange={(e) => updateStep(i, { subject: e.target.value })}
                className="h-7 text-sm"
              />
              <Textarea
                placeholder="Body (optional — leave blank to compose with AI at send time)"
                value={step.body ?? ""}
                disabled={disabled}
                onChange={(e) => updateStep(i, { body: e.target.value })}
                rows={3}
                className="text-sm resize-none"
              />
            </div>
          )}

          {step.type === "wait" && (
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground shrink-0">Wait days</Label>
              <Input
                type="number"
                min={0}
                max={60}
                value={step.days}
                disabled={disabled}
                onChange={(e) => updateStep(i, { days: Math.max(0, Math.min(60, Number(e.target.value))) })}
                className="h-7 w-20 text-sm"
              />
            </div>
          )}

          {step.type === "task" && (
            <Textarea
              placeholder="Task description"
              value={step.body}
              disabled={disabled}
              onChange={(e) => updateStep(i, { body: e.target.value })}
              rows={2}
              className="text-sm resize-none"
            />
          )}
        </div>
      ))}

      {!disabled && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => addStep("email")}><Mail className="h-3 w-3 mr-1" /> Email</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => addStep("wait")}><Clock className="h-3 w-3 mr-1" /> Wait</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => addStep("task")}><ClipboardList className="h-3 w-3 mr-1" /> Task</Button>
        </div>
      )}
    </div>
  );
}

// ─── SequenceEditDialog ───────────────────────────────────────────────────────
function SequenceEditDialog({ seq, open, onClose }: { seq: any; open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<"settings" | "steps">("settings");

  // Settings state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [dailyCap, setDailyCap] = useState<string>("");
  const [skipWeekends, setSkipWeekends] = useState(false);
  const [replyDetection, setReplyDetection] = useState(true);
  const [sendWindowStart, setSendWindowStart] = useState("08:00");
  const [sendWindowEnd, setSendWindowEnd] = useState("18:00");

  // Steps state
  const [steps, setSteps] = useState<Step[]>([]);

  const isLocked = seq?.status === "active" || seq?.status === "paused";

  // Pre-fill when dialog opens
  useEffect(() => {
    if (!seq || !open) return;
    setName(seq.name ?? "");
    setDescription(seq.description ?? "");
    setDailyCap(seq.dailyCap != null ? String(seq.dailyCap) : "");
    const s = seq.settings ?? {};
    setSkipWeekends(s.skipWeekends ?? false);
    setReplyDetection(s.replyDetection ?? true);
    setSendWindowStart(s.sendWindowStart ?? "08:00");
    setSendWindowEnd(s.sendWindowEnd ?? "18:00");
    setSteps((seq.steps as Step[]) ?? []);
    setTab("settings");
  }, [seq, open]);

  const updateMeta = trpc.sequences.updateMeta.useMutation({
    onSuccess: () => {
      utils.sequences.list.invalidate();
      utils.sequences.get.invalidate({ id: seq.id });
      toast.success("Sequence settings saved");
    },
    onError: (e) => toast.error(e.message),
  });

  const updateSteps = trpc.sequences.updateSteps.useMutation({
    onSuccess: () => {
      utils.sequences.list.invalidate();
      utils.sequences.get.invalidate({ id: seq.id });
      toast.success("Steps saved");
    },
    onError: (e) => toast.error(e.message),
  });

  function handleSaveSettings() {
    updateMeta.mutate({
      id: seq.id,
      name: name.trim() || undefined,
      description: description.trim() || undefined,
      dailyCap: dailyCap !== "" ? Number(dailyCap) : null,
      settings: { skipWeekends, replyDetection, sendWindowStart, sendWindowEnd },
    });
  }

  function handleSaveSteps() {
    updateSteps.mutate({ id: seq.id, steps });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Edit sequence — {seq?.name}</DialogTitle>
        </DialogHeader>

        {isLocked && (
          <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            This sequence is <strong>{seq?.status}</strong>. Settings can be edited, but steps are read-only. Pause the sequence to edit steps.
          </div>
        )}

        {/* Tab bar */}
        <div className="flex border-b shrink-0">
          {(["settings", "steps"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm capitalize ${tab === t ? "border-b-2 border-[#14B89A] font-semibold" : "text-muted-foreground"}`}>
              {t}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto flex-1 py-3 space-y-4">
          {tab === "settings" && (
            <>
              <div className="space-y-1.5">
                <Label className="text-sm">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sequence name" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Description</Label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" rows={2} className="resize-none" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Daily send cap</Label>
                <Input type="number" min={1} max={10000} value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} placeholder="Unlimited" className="w-36" />
                <p className="text-xs text-muted-foreground">Maximum emails sent per day across all enrollments. Leave blank for unlimited.</p>
              </div>
              <div className="border rounded-md p-3 space-y-3">
                <p className="text-sm font-medium">Send window</p>
                <div className="flex items-center gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Start</Label>
                    <Input type="time" value={sendWindowStart} onChange={(e) => setSendWindowStart(e.target.value)} className="w-32 h-8 text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">End</Label>
                    <Input type="time" value={sendWindowEnd} onChange={(e) => setSendWindowEnd(e.target.value)} className="w-32 h-8 text-sm" />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="skipWeekends" checked={skipWeekends} onCheckedChange={setSkipWeekends} />
                  <Label htmlFor="skipWeekends" className="text-sm cursor-pointer">Skip weekends</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id="replyDetection" checked={replyDetection} onCheckedChange={setReplyDetection} />
                  <Label htmlFor="replyDetection" className="text-sm cursor-pointer">Pause enrollment on reply</Label>
                </div>
              </div>
            </>
          )}

          {tab === "steps" && (
            <StepEditor steps={steps} onChange={setSteps} disabled={isLocked} />
          )}
        </div>

        <DialogFooter className="shrink-0 pt-2 border-t">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {tab === "settings" && (
            <Button onClick={handleSaveSettings} disabled={updateMeta.isPending}>
              {updateMeta.isPending ? "Saving…" : "Save settings"}
            </Button>
          )}
          {tab === "steps" && (
            <Button onClick={handleSaveSteps} disabled={updateSteps.isPending || isLocked}>
              {updateSteps.isPending ? "Saving…" : "Save steps"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
// ─── SequencePerformancePanel ───────────────────────────────────────────────
function SequencePerformancePanel({ sequenceId }: { sequenceId: number }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const queryInput: { sequenceId: number; dateFrom?: string; dateTo?: string } = { sequenceId };
  if (dateFrom) queryInput.dateFrom = dateFrom;
  if (dateTo) queryInput.dateTo = dateTo;
  const { data, isLoading } = trpc.sequences.getPerformanceAnalytics.useQuery(queryInput);
  const row = data?.[0];
  const hasDateFilter = !!dateFrom || !!dateTo;

  if (isLoading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground py-6"><RefreshCw className="size-3 animate-spin" /> Loading analytics…</div>;
  }

  if (!row) {
    return <div className="text-sm text-muted-foreground py-8 text-center">No analytics data yet. Send emails through this sequence to see performance metrics.</div>;
  }

  const metrics = [
    { label: "Emails Sent", value: row.sent, sub: "total sent", color: "text-foreground" },
    { label: "Open Rate", value: `${row.openRate}%`, sub: `${row.uniqueOpens} unique opens`, color: row.openRate >= 30 ? "text-emerald-600" : row.openRate >= 15 ? "text-amber-600" : "text-muted-foreground" },
    { label: "Click Rate", value: `${row.clickRate}%`, sub: `${row.uniqueClicks} unique clicks`, color: row.clickRate >= 5 ? "text-emerald-600" : row.clickRate >= 2 ? "text-amber-600" : "text-muted-foreground" },
    { label: "Bounce Rate", value: `${row.bounceRate}%`, sub: `${row.bounced} bounced`, color: row.bounceRate > 5 ? "text-rose-600" : row.bounceRate > 2 ? "text-amber-600" : "text-emerald-600" },
    { label: "Exit Rate", value: `${row.exitRate}%`, sub: `${row.exited} exited`, color: row.exitRate > 20 ? "text-rose-600" : "text-muted-foreground" },
  ];

  const enrollment = [
    { label: "Total Enrolled", value: row.totalEnrolled },
    { label: "Active", value: row.active },
    { label: "Finished", value: row.finished },
    { label: "Paused", value: row.paused },
    { label: "Exited", value: row.exited },
  ];

  return (
    <div className="space-y-4">
      {/* Date range filter */}
      <div className="flex flex-wrap items-end gap-3 p-3 bg-muted/40 rounded-lg border">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-[#14B89A]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-[#14B89A]"
          />
        </div>
        {hasDateFilter && (
          <button
            onClick={() => { setDateFrom(""); setDateTo(""); }}
            className="h-8 px-3 rounded-md text-xs border border-border text-muted-foreground hover:text-foreground hover:border-[#14B89A] transition-colors"
          >
            Clear filter
          </button>
        )}
        {hasDateFilter && (
          <span className="text-xs text-[#14B89A] font-medium self-end pb-1">
            Filtered: {dateFrom || "…"} → {dateTo || "…"}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {metrics.map(({ label, value, sub, color }) => (
          <Card key={label} className="border">
            <CardContent className="p-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className={`text-2xl font-bold tabular-nums ${color}`}>{value}</p>
              <p className="text-[11px] text-muted-foreground">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Section title="Enrollment Funnel">
        <div className="p-3 space-y-2">
          {enrollment.map(({ label, value }) => {
            const pct = row.totalEnrolled > 0 ? Math.round((value / row.totalEnrolled) * 100) : 0;
            return (
              <div key={label} className="flex items-center gap-3 text-sm">
                <span className="w-28 text-xs text-muted-foreground shrink-0">{label}</span>
                <div className="flex-1 bg-muted rounded-full h-2">
                  <div className="h-2 rounded-full bg-[#14B89A] transition-all" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs tabular-nums w-10 text-right font-mono">{value}</span>
                <span className="text-[11px] text-muted-foreground w-8 text-right">{pct}%</span>
              </div>
            );
          })}
        </div>
      </Section>

      {row.sent > 0 && (
        <Section title="Email Engagement Funnel">
          <div className="p-3 space-y-2">
            {[
              { label: "Sent", value: row.sent, pct: 100 },
              { label: "Opened (unique)", value: row.uniqueOpens, pct: row.openRate },
              { label: "Clicked (unique)", value: row.uniqueClicks, pct: row.clickRate },
              { label: "Bounced", value: row.bounced, pct: row.bounceRate },
            ].map(({ label, value, pct }) => (
              <div key={label} className="flex items-center gap-3 text-sm">
                <span className="w-32 text-xs text-muted-foreground shrink-0">{label}</span>
                <div className="flex-1 bg-muted rounded-full h-2">
                  <div className="h-2 rounded-full bg-[#14B89A] transition-all" style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs tabular-nums w-10 text-right font-mono">{value}</span>
                <span className="text-[11px] text-muted-foreground w-8 text-right">{pct}%</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

export default function Sequences() {
  const [open, setOpen] = useState(false);
  const [editSeq, setEditSeq] = useState<any | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"steps" | "stats" | "analytics">("steps");
  const utils = trpc.useUtils();
  const { data } = trpc.sequences.list.useQuery();
  const create = trpc.sequences.create.useMutation({
    onSuccess: () => { utils.sequences.list.invalidate(); setOpen(false); toast.success("Sequence created"); },
  });
  const setStatus = trpc.sequences.setStatus.useMutation({ onSuccess: () => utils.sequences.list.invalidate() });
  const detail = trpc.sequences.get.useQuery({ id: selected! }, { enabled: !!selected });

  return (
    <Shell title="Sequences">
      <PageHeader title="Sequences" description="Multi-step outbound cadences with AI compose.">
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New sequence</Button>
      </PageHeader>
      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          <Section title="All sequences">
            {(data ?? []).length === 0 ? <EmptyState icon={Activity} title="None yet" /> : (
              <ul className="divide-y">
                {data!.map((s) => (
                  <li key={s.id}
                    className={`p-3 cursor-pointer hover:bg-secondary/40 ${selected === s.id ? "bg-secondary/60" : ""}`}
                    onClick={() => { setSelected(s.id); setActiveTab("steps"); }}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 text-sm font-medium truncate">{s.name}</div>
                      <StatusPill tone={s.status === "active" ? "success" : s.status === "paused" ? "warning" : "muted"}>{s.status}</StatusPill>
                    </div>
                    <div className="text-xs text-muted-foreground line-clamp-1">{s.description}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {s.enrolledCount} enrolled
                      {s.dailyCap ? ` · ${s.dailyCap}/day cap` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div className="lg:col-span-2 space-y-4">
          {!selected ? <EmptyState icon={Activity} title="Select a sequence" /> : detail.data ? (
            <>
              <Section title={detail.data.name} description={detail.data.description ?? ""}
                right={
                  <div className="flex gap-1 flex-wrap">
                    <Button size="sm" variant="outline" onClick={() => setEditSeq(detail.data)}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                    <Link href={`/sequences/${detail.data.id}/canvas`}>
                      <Button size="sm" variant="outline"><GitBranch className="size-3.5" /> Canvas</Button>
                    </Link>
                    <Button size="sm" variant="ghost"
                      onClick={() => setStatus.mutate({ id: detail.data!.id, status: detail.data!.status === "active" ? "paused" : "active" })}>
                      {detail.data.status === "active" ? <><Pause className="size-3.5" /> Pause</> : <><Play className="size-3.5" /> Activate</>}
                    </Button>
                    <Button size="sm" variant="ghost"
                      onClick={() => setStatus.mutate({ id: detail.data!.id, status: "archived" })}>
                      <Power className="size-3.5" /> Archive
                    </Button>
                  </div>
                }>
                {/* Tab bar */}
                <div className="flex border-b mb-3 px-3">
                  {[
                    { k: "steps", label: "Steps", icon: Activity },
                    { k: "stats", label: "Stats & Enrollments", icon: BarChart3 },
                    { k: "analytics", label: "Performance", icon: TrendingUp },
                  ].map(({ k, label, icon: Icon }) => (
                    <button key={k}
                      onClick={() => setActiveTab(k as any)}
                      className={`flex items-center gap-1.5 px-3 py-2 text-sm ${activeTab === k ? "border-b-2 border-[#14B89A] font-semibold" : "text-muted-foreground"}`}>
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  ))}
                </div>

                {activeTab === "steps" && (
                  <ol className="p-3 space-y-2">
                    {((detail.data.steps as any[]) ?? []).map((step, i) => (
                      <li key={i} className="border rounded p-2.5">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="font-mono">Step {i + 1}</span> · {step.type}
                          {step.type === "wait" ? ` · ${step.days}d` : ""}
                        </div>
                        {step.subject && <div className="text-sm font-medium mt-1">{step.subject}</div>}
                        {step.body && <div className="text-xs text-muted-foreground line-clamp-3 mt-1">{step.body}</div>}
                      </li>
                    ))}
                    {((detail.data.steps as any[]) ?? []).length === 0 && (
                      <div className="text-sm text-muted-foreground py-4 text-center">
                        No steps yet. Click <strong>Edit</strong> to add steps, or open the Canvas.
                      </div>
                    )}
                  </ol>
                )}

                {activeTab === "stats" && (
                  <div className="p-3">
                    <EnrollmentStatsPanel
                      sequenceId={detail.data.id}
                      steps={(detail.data.steps as any[]) ?? []}
                    />
                  </div>
                )}

                {activeTab === "analytics" && (
                  <div className="p-3">
                    <SequencePerformancePanel sequenceId={detail.data.id} />
                  </div>
                )}
              </Section>
            </>
          ) : null}
        </div>
      </div>

      {/* New sequence dialog */}
      <FormDialog open={open} onOpenChange={setOpen} title="New sequence" isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          name: String(f.get("name")), description: String(f.get("description") ?? "") || undefined,
          steps: [
            { type: "email", subject: String(f.get("step1Subject") ?? "Quick intro"), body: String(f.get("step1Body") ?? "") },
            { type: "wait", days: 3 },
            { type: "email", subject: "Following up", body: "Did this come at a bad time?" },
          ],
        })}>
        <Field name="name" label="Name" required />
        <TextareaField name="description" label="Description" />
        <Field name="step1Subject" label="Step 1 subject" />
        <TextareaField name="step1Body" label="Step 1 body" />
      </FormDialog>

      {/* Edit sequence dialog */}
      {editSeq && (
        <SequenceEditDialog
          seq={editSeq}
          open={!!editSeq}
          onClose={() => setEditSeq(null)}
        />
      )}
    </Shell>
  );
}
