import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { ConfirmButton, Field, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell, SubNav } from "@/components/usip/Shell";
import { RichTextEditor } from "@/components/usip/RichTextEditor";
import { EmailClientPreview } from "@/components/usip/EmailClientPreview";
import { sanitizeEmailHtml } from "@/lib/sanitizeHtml";
import { trpc } from "@/lib/trpc";
import { invalidateEnrollmentReads } from "@/lib/enrollmentCache";
import { SequenceDraftsNote } from "@/components/usip/SequenceDraftsNote";
import { SequenceEnrollDialog } from "@/components/usip/SequenceEnrollDialog";
import { usePermissions } from "@/hooks/usePermissions";
import {
  Activity, GitBranch, Pause, Play, Plus, Power, CheckCircle2, XCircle,
  BarChart3, RefreshCw, Pencil, Trash2, ArrowUp, ArrowDown, Mail, Clock, ClipboardList, TrendingUp,
  FlaskConical, Trophy, Loader2, ListOrdered, UserPlus, Eye, ChevronDown, ChevronRight
} from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { pressable } from "@/lib/pressable";
import { tablistProps, tabProps } from "@/lib/tabs";

// ─── Types ───────────────────────────────────────────────────────────────────
type StepType = "email" | "wait" | "task";
interface EmailStep { type: "email"; subject: string; body?: string; templateId?: number }

/**
 * Strip HTML tags and decode common entities into a plaintext preview.
 * Used by the right-panel step summary so RichTextEditor-encoded bodies
 * (which store HTML) render as readable text in the line-clamped
 * preview rather than as visible markup.
 */
function htmlToPlainText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
interface WaitStep { type: "wait"; days: number }
interface TaskStep { type: "task"; body: string }
type Step = EmailStep | WaitStep | TaskStep;

/** What a template-linked step is: a copy (O26) — the same words the v2 editor uses. */
const TEMPLATE_COPY_NOTE = "This is the copy that sends. Later changes to the template don't reach it; pick the template again to refresh it.";

// ─── EnrollmentStatsPanel ────────────────────────────────────────────────────
function EnrollmentStatsPanel({ sequenceId, steps }: { sequenceId: number; steps: any[] }) {
  const utils = trpc.useUtils();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const { data: stats, isLoading: statsLoading, refetch } = trpc.sequences.getEnrollmentStats.useQuery({ sequenceId });
  const { data: stepStats = [] } = trpc.sequences.getEnrollmentStepStats.useQuery({ sequenceId });
  const { data: enrollmentList = [], isLoading: listLoading } = trpc.sequences.listEnrollments.useQuery({ sequenceId });

  // `refetch` alone re-read this panel's own stats query and left every
  // other reader — the v2 Contacts tab included — on the old numbers.
  const refreshed = () => invalidateEnrollmentReads(utils, sequenceId);
  const resume = trpc.sequences.resumeEnrollment.useMutation({
    onSuccess: () => { refreshed(); toast.success("Enrollment resumed"); },
    onError: (e) => toast.error(e.message),
  });
  const exit = trpc.sequences.exitEnrollment.useMutation({
    onSuccess: () => { refreshed(); toast.success("Enrollment exited"); },
    onError: (e) => toast.error(e.message),
  });
  const pauseOnReply = trpc.sequences.pauseOnReply.useMutation({
    onSuccess: () => { refreshed(); toast.success("Enrollment paused (reply detected)"); },
    onError: (e) => toast.error(e.message),
  });
  // A plain pause (audit 2026-10-20, O37): "Reply" was the only way to pause
  // someone here, and it files a "Reply detected" task for a reply that may
  // never have happened.
  const pause = trpc.sequences.pauseEnrollment.useMutation({
    onSuccess: () => { refreshed(); toast.success("Enrollment paused"); },
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
        <div className="flex items-center gap-1">
          <Button size="sm" onClick={() => setEnrollOpen(true)}>
            <UserPlus className="h-3 w-3 mr-1" /> Enroll
          </Button>
          <Button size="sm" variant="ghost" onClick={() => refreshed()}>
            <RefreshCw className="h-3 w-3 mr-1" /> Refresh
          </Button>
        </div>
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
                  {/* WHO, not a row id — with a link to the person record
                      (owner ask 2026-09-20). */}
                  {e.personId ? (
                    <Link href={`/prospects/${e.personId}`} className="font-medium hover:underline">
                      {e.personName || `Enrollment #${e.id}`}
                    </Link>
                  ) : e.leadHref ? (
                    <Link href={e.leadHref} className="font-medium hover:underline">
                      {e.personName || `Enrollment #${e.id}`}
                    </Link>
                  ) : (
                    <span className="font-medium">{e.personName || `Enrollment #${e.id}`}</span>
                  )}
                  <span className="text-muted-foreground ml-2">· Step {e.currentStep + 1}</span>
                  {e.nextActionAt && (
                    <span className="text-xs text-muted-foreground ml-2">
                      · Next: {new Date(e.nextActionAt).toLocaleDateString()}
                    </span>
                  )}
                  {/* A paused row with a resumeAt is an out-of-office snooze,
                      not a dead end — say so, or the rep resumes it by hand
                      on top of the sweep. */}
                  {e.status === "paused" && e.resumeAt && (
                    <span className="text-xs text-muted-foreground ml-2">
                      · Resumes {new Date(e.resumeAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <StatusPill tone={e.status === "active" ? "success" : e.status === "paused" ? "warning" : e.status === "finished" ? "info" : "muted"}>{e.status}</StatusPill>
                <div className="flex gap-1 shrink-0">
                  {e.status === "paused" && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => resume.mutate({ id: e.id })} disabled={resume.isPending}>Resume</Button>
                  )}
                  {e.status === "active" && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => pause.mutate({ id: e.id })} disabled={pause.isPending}>Pause</Button>
                  )}
                  {e.status === "active" && (
                    <Button size="sm" variant="ghost" className="h-6 text-xs px-2 text-amber-600" title="They replied: pause them and file a task to follow up" onClick={() => pauseOnReply.mutate({ enrollmentId: e.id })} disabled={pauseOnReply.isPending}>Mark replied</Button>
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

      <SequenceEnrollDialog
        sequenceId={sequenceId}
        open={enrollOpen}
        onClose={() => setEnrollOpen(false)}
        onEnrolled={() => {
          // Every enrolment-derived read, not the three this panel happens to
          // show: the same enrol can be visible in a v2 tab next door.
          invalidateEnrollmentReads(utils, sequenceId);
          refetch();
        }}
      />
    </div>
  );
}

// ─── StepEditor ──────────────────────────────────────────────────────────────
function StepEditor({ steps, onChange, disabled }: { steps: Step[]; onChange: (s: Step[]) => void; disabled?: boolean }) {
  // Pull every non-archived workspace template so each email step gets
  // a template picker. The list endpoint already returns the full row
  // (htmlOutput included) so apply-template is a single client-side
  // copy — no extra fetch per pick.
  const templatesQ = trpc.emailTemplates?.list?.useQuery({ status: "all" });
  const templates = (templatesQ?.data ?? []).filter((t: any) => t.status !== "archived");
  const templateById = new Map<number, any>(templates.map((t: any) => [t.id, t]));

  // Per-step minimize. Keyed by index (steps have no stable ids), so
  // move/remove below remap the set to follow the step. Email steps
  // that already carry content start minimized — the editor opens as a
  // compact subject-line outline instead of a wall of rendered emails;
  // wait/task steps are small and start expanded. Init once per mount
  // (steps can hydrate async after the dialog's live query resolves).
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const collapseInitRef = useRef(false);
  useEffect(() => {
    if (collapseInitRef.current || steps.length === 0) return;
    collapseInitRef.current = true;
    setCollapsed(new Set(steps.flatMap((s, i) =>
      s.type === "email" && (s.templateId || (s.body ?? "").trim() !== "") ? [i] : []
    )));
  }, [steps]);

  function toggleCollapsed(i: number) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  /** One-line summary shown in a minimized step's header. */
  function stepSummary(step: Step): string {
    if (step.type === "email") return step.subject || "(no subject)";
    if (step.type === "wait") return `${step.days} day${step.days === 1 ? "" : "s"}`;
    return htmlToPlainText(step.body ?? "");
  }

  function applyTemplateToStep(i: number, templateId: number) {
    const t = templateById.get(templateId);
    if (!t) return;
    // RichTextEditor stores HTML, so we drop the template's htmlOutput
    // in verbatim. Subject is plain text. templateId tracked so the
    // breadcrumb survives reopening the dialog.
    updateStep(i, {
      subject: t.subject ?? "",
      body: t.htmlOutput ?? "",
      templateId,
    } as Partial<EmailStep>);
  }

  function addStep(type: StepType) {
    const newStep: Step =
      type === "email" ? { type: "email", subject: "New email", body: "" } :
      type === "wait"  ? { type: "wait", days: 1 } :
                         { type: "task", body: "Follow up task" };
    onChange([...steps, newStep]);
  }

  function removeStep(i: number) {
    onChange(steps.filter((_, idx) => idx !== i));
    setCollapsed((prev) => {
      const next = new Set<number>();
      for (const idx of prev) {
        if (idx < i) next.add(idx);
        else if (idx > i) next.add(idx - 1);
      }
      return next;
    });
  }

  function moveStep(i: number, dir: -1 | 1) {
    const arr = [...steps];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange(arr);
    setCollapsed((prev) => {
      const next = new Set(prev);
      const hadI = next.has(i);
      const hadJ = next.has(j);
      next.delete(i); next.delete(j);
      if (hadI) next.add(j);
      if (hadJ) next.add(i);
      return next;
    });
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
      {steps.map((step, i) => {
        const isCollapsed = collapsed.has(i);
        return (
        <div key={i} className="border rounded-md p-3 bg-card space-y-2">
          <div className="flex items-center gap-2">
            {/* Whole header (minus the action buttons) toggles minimize.
                When minimized, a one-line summary (email subject / wait
                days / task snippet) stands in for the content below. */}
            <button
              type="button"
              onClick={() => toggleCollapsed(i)}
              className="flex items-center gap-2 flex-1 min-w-0 text-left"
              title={isCollapsed ? "Expand step" : "Minimize step"}
            >
              {isCollapsed
                ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              {step.type === "email" && <Mail className="h-3.5 w-3.5 text-blue-500 shrink-0" />}
              {step.type === "wait"  && <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
              {step.type === "task"  && <ClipboardList className="h-3.5 w-3.5 text-purple-500 shrink-0" />}
              <span className="text-xs font-mono text-muted-foreground shrink-0">Step {i + 1}</span>
              <span className="text-xs capitalize text-muted-foreground shrink-0">· {step.type}</span>
              {isCollapsed && (
                <span className="text-xs truncate min-w-0" title={stepSummary(step)}>
                  — {stepSummary(step)}
                </span>
              )}
            </button>
            <div className="ml-auto flex gap-1 shrink-0">
              <Button aria-label="Move step up" size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={disabled || i === 0} onClick={() => moveStep(i, -1)}><ArrowUp className="h-3 w-3" /></Button>
              <Button aria-label="Move step down" size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={disabled || i === steps.length - 1} onClick={() => moveStep(i, 1)}><ArrowDown className="h-3 w-3" /></Button>
              <Button aria-label="Delete step" size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" disabled={disabled} onClick={() => removeStep(i)}><Trash2 className="h-3 w-3" /></Button>
            </div>
          </div>

          {!isCollapsed && step.type === "email" && (() => {
            const appliedTemplate = step.templateId ? templateById.get(step.templateId) : null;
            return (
              <div className="space-y-1.5">
                {/* Apply-template picker + breadcrumb. Selecting a
                    template copies its subject + body straight into
                    this step so the user sees the content immediately
                    and can edit it inline. The source template stays
                    untouched. */}
                <div className="flex items-center gap-2">
                  <Select
                    value={step.templateId?.toString() ?? ""}
                    disabled={disabled}
                    onValueChange={(v) => applyTemplateToStep(i, Number(v))}
                  >
                    <SelectTrigger className="h-7 text-xs flex-1">
                      <SelectValue placeholder={
                        templates.length === 0 ? "No templates saved yet" : "Apply a template…"
                      } />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t: any) => (
                        <SelectItem key={t.id} value={t.id.toString()} className="text-xs">
                          <span className="flex items-center gap-2">
                            <span>{t.name}</span>
                            {t.status === "draft" && (
                              <span className="text-[10px] px-1 py-0 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                                draft
                              </span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                      {templates.length === 0 && (
                        <div className="px-3 py-2 text-xs text-muted-foreground">
                          No templates found — create one in Email Builder.
                        </div>
                      )}
                    </SelectContent>
                  </Select>
                </div>
                {appliedTemplate && (
                  <div className="flex items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-2.5 py-1 text-[11px] text-blue-700 dark:text-blue-300">
                    <Mail className="size-3 shrink-0" />
                    <Link
                      href={`/email-builder/${appliedTemplate.id}`}
                      className="flex-1 truncate hover:underline underline-offset-2"
                      title="Open this template in Email Builder"
                    >
                      From template: <span className="font-medium">{appliedTemplate.name}</span> →
                    </Link>
                    {!disabled && (
                      <button
                        type="button"
                        className="text-[11px] underline-offset-2 hover:underline shrink-0"
                        // The copy shown is the one that sends, so detaching keeps it.
                        onClick={() => updateStep(i, { templateId: undefined } as Partial<EmailStep>)}
                        title="Detach from the source template (keeps this copy for inline editing)"
                      >
                        Detach
                      </button>
                    )}
                  </div>
                )}
                {step.templateId ? (
                  /* A step from a template holds a COPY, and the copy is what
                     sends (audit 2026-10-20, O26; the v2 editor's rule since
                     PR #29). This used to show the template's current
                     version, which is not what went out once the template had
                     changed. Read-only, because the rich-text editor can't
                     hold Email Builder HTML faithfully; Detach to edit it. */
                  <>
                    <div className="text-sm font-medium px-1">{step.subject || "(no subject)"}</div>
                    <div
                      className="border rounded-md bg-white text-[#202124] p-3 text-sm max-h-[300px] overflow-y-auto [&_a]:text-blue-600 [&_a]:underline [&_p]:my-2 break-words [&_table]:max-w-full [&_td]:break-words [&_img]:max-w-full [&_img]:h-auto"
                      dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(step.body ?? "") }}
                    />
                    <p className="text-[11px] text-muted-foreground px-1">{TEMPLATE_COPY_NOTE}</p>
                  </>
                ) : (
                  <>
                    <Input aria-label="Subject"
                      placeholder="Subject"
                      value={step.subject}
                      disabled={disabled}
                      onChange={(e) => updateStep(i, { subject: e.target.value })}
                      className="h-7 text-sm"
                    />
                    <RichTextEditor
                      value={step.body ?? ""}
                      onChange={(html) => updateStep(i, { body: html })}
                      placeholder="Body (optional — leave blank to compose with AI at send time)"
                      minHeight="80px"
                      maxHeight="300px"
                      compact
                      disabled={disabled}
                    />
                  </>
                )}
              </div>
            );
          })()}

          {!isCollapsed && step.type === "wait" && (
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground shrink-0">Wait days</Label>
              <Input aria-label="Wait days"
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

          {!isCollapsed && step.type === "task" && (
            <RichTextEditor
              value={step.body ?? ""}
              onChange={(html) => updateStep(i, { body: html })}
              placeholder="Task description"
              minHeight="60px"
              maxHeight="200px"
              compact
              disabled={disabled}
            />
          )}
        </div>
        );
      })}

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
  // On unless switched off — the engine's default and the canvas panel's (O9).
  const [skipWeekends, setSkipWeekends] = useState(true);
  const [replyDetection, setReplyDetection] = useState(true);
  const [sendWindowStart, setSendWindowStart] = useState("08:00");
  const [sendWindowEnd, setSendWindowEnd] = useState("18:00");

  // Steps state
  const [steps, setSteps] = useState<Step[]>([]);
  // Local flag: bumped each time the user saves steps so we don't
  // reset their in-progress edits with the just-refetched server data.
  // (The seq prop is a parent snapshot — if we hydrated unconditionally
  // on every refresh, save → server refetch → snapshot replacement would
  // race the user's typing.)
  const [stepsDirtyAfterLoad, setStepsDirtyAfterLoad] = useState(false);
  // Prospect-POV preview (Gmail/Outlook chrome). Uses the LOCAL steps
  // state so unsaved edits preview live.
  const [previewOpen, setPreviewOpen] = useState(false);

  // Live query so the dialog stays in sync with parallel edits made
  // from the canvas / right panel. seq prop seeds the initial load;
  // liveSeq drives every subsequent refresh so a save (which
  // invalidates sequences.get) flows back here cleanly.
  const liveSeqQ = trpc.sequences.get.useQuery({ id: seq?.id }, { enabled: open && !!seq?.id });
  const liveSeq = liveSeqQ.data ?? seq;

  // Same lock rule as the canvas — paused sequences should be editable
  // (that's why users pause). Only lock active (running) and archived.
  const isLocked = liveSeq?.status === "active" || liveSeq?.status === "archived";

  // Pre-fill when dialog opens, or when the live data updates (and the
  // user hasn't started editing steps yet — otherwise we'd nuke their
  // unsaved changes).
  useEffect(() => {
    if (!liveSeq || !open) return;
    setName(liveSeq.name ?? "");
    setDescription(liveSeq.description ?? "");
    setDailyCap(liveSeq.dailyCap != null ? String(liveSeq.dailyCap) : "");
    const s = liveSeq.settings ?? {};
    setSkipWeekends(s.skipWeekends ?? true);
    setReplyDetection(s.replyDetection ?? true);
    setSendWindowStart(s.sendWindowStart ?? "08:00");
    setSendWindowEnd(s.sendWindowEnd ?? "18:00");
    if (!stepsDirtyAfterLoad) {
      setSteps((liveSeq.steps as Step[]) ?? []);
    }
  }, [liveSeq, open, stepsDirtyAfterLoad]);

  // Reset tab + dirty flag whenever the dialog opens fresh.
  useEffect(() => {
    if (open) {
      setTab("settings");
      setStepsDirtyAfterLoad(false);
    }
  }, [open, seq?.id]);

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
      // Clear the local dirty flag so the next live-query refresh
      // (carrying the just-saved data) hydrates the dialog. Without
      // this, the user's edits would stay frozen as "in-progress" and
      // any parallel canvas edit would never propagate in.
      setStepsDirtyAfterLoad(false);
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

  // Saved as shown (O26). Saving used to re-copy every template-linked step
  // from the template's current version without saying so; a step now keeps
  // its copy until someone picks the template again, as in the v2 editor.
  function handleSaveSteps() {
    updateSteps.mutate({ id: seq.id, steps });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      {/* sm:max-w-3xl: bare max-w-2xl lost to the default sm:max-w-lg, which
          squeezed the editor to 512px on desktop. */}
      <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-3xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Edit sequence — {liveSeq?.name}</DialogTitle>
        </DialogHeader>

        {isLocked && (
          <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            This sequence is <strong>{liveSeq?.status}</strong>. Settings can be edited, but steps are read-only. Pause the sequence to edit steps.
          </div>
        )}

        {/* Tab bar */}
        <div {...tablistProps("Sequence sections")} className="flex border-b shrink-0">
          {(["settings", "steps"] as const).map((t) => (
            <button {...tabProps(tab === t)} key={t} onClick={() => setTab(t)}
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
                <Input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sequence name" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Description</Label>
                <Textarea aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" rows={2} className="resize-none" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Daily send cap</Label>
                <Input aria-label="Daily send cap" type="number" min={1} max={10000} value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} placeholder="Unlimited" className="w-36" />
                <p className="text-xs text-muted-foreground">Maximum emails sent per day across all enrollments. Leave blank for unlimited.</p>
              </div>
              <div className="border rounded-md p-3 space-y-3">
                <p className="text-sm font-medium">Send window</p>
                <div className="flex items-center gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Start</Label>
                    <Input aria-label="Start" type="time" value={sendWindowStart} onChange={(e) => setSendWindowStart(e.target.value)} className="w-32 h-8 text-sm" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">End</Label>
                    <Input aria-label="End" type="time" value={sendWindowEnd} onChange={(e) => setSendWindowEnd(e.target.value)} className="w-32 h-8 text-sm" />
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
            <StepEditor
              steps={steps}
              onChange={(next) => { setSteps(next); setStepsDirtyAfterLoad(true); }}
              disabled={isLocked}
            />
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
            <>
              <Button variant="outline" onClick={() => setPreviewOpen(true)} disabled={steps.length === 0}>
                <Eye className="size-3.5" /> Preview
              </Button>
              <Button onClick={handleSaveSteps} disabled={updateSteps.isPending || isLocked}>
                {updateSteps.isPending ? "Saving…" : "Save steps"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>

      <EmailClientPreview
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        steps={steps}
        sequenceName={liveSeq?.name}
      />
    </Dialog>
  );
}

// ─── SequenceAbPanel ────────────────────────────────────────────────────────
function SequenceAbPanel({ sequenceId, steps }: { sequenceId: number; steps: any[] }) {
  const [selectedStep, setSelectedStep] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [editVariant, setEditVariant] = useState<any | null>(null);
  const [minSendsEditing, setMinSendsEditing] = useState<number | null>(null);
  const [minSendsValue, setMinSendsValue] = useState<number>(100);
  const utils = trpc.useUtils();

  const emailSteps = steps
    .map((s, i) => ({ ...s, index: i }))
    .filter((s) => s.type === "email");

  const { data: variants, isLoading } = trpc.sequenceAb.list.useQuery(
    { sequenceId, stepIndex: selectedStep },
    { enabled: emailSteps.length > 0 },
  );
  const { data: stats } = trpc.sequenceAb.getStats.useQuery(
    { sequenceId, stepIndex: selectedStep },
    { enabled: emailSteps.length > 0 },
  );

  const createVariant = trpc.sequenceAb.create.useMutation({
    onSuccess: () => { utils.sequenceAb.list.invalidate(); utils.sequenceAb.getStats.invalidate(); setAddOpen(false); toast.success("Variant added"); },
    onError: (e) => toast.error(e.message),
  });
  const updateVariant = trpc.sequenceAb.update.useMutation({
    onSuccess: () => { utils.sequenceAb.list.invalidate(); utils.sequenceAb.getStats.invalidate(); setEditVariant(null); toast.success("Variant updated"); },
    onError: (e) => toast.error(e.message),
  });
  const deleteVariant = trpc.sequenceAb.delete.useMutation({
    onSuccess: () => { utils.sequenceAb.list.invalidate(); utils.sequenceAb.getStats.invalidate(); toast.success("Variant deleted"); },
    onError: (e) => toast.error(e.message),
  });
  const promoteWinner = trpc.sequenceAb.promoteWinner.useMutation({
    onSuccess: () => { utils.sequenceAb.list.invalidate(); utils.sequenceAb.getStats.invalidate(); toast.success("Winner promoted!"); },
    onError: (e) => toast.error(e.message),
  });
  const setMinSends = trpc.sequenceAb.setMinSends.useMutation({
    onSuccess: () => { utils.sequenceAb.list.invalidate(); utils.sequenceAb.getStats.invalidate(); setMinSendsEditing(null); toast.success("Min-sends threshold saved"); },
    onError: (e) => toast.error(e.message),
  });

  if (emailSteps.length === 0) {
    return <div className="text-sm text-muted-foreground py-6 text-center">No email steps in this sequence. Add an email step first.</div>;
  }

  const topVariant = stats && stats.length > 0 ? stats.reduce((a, b) => a.score > b.score ? a : b) : null;
  const promotedVariant = stats?.find((v) => v.isWinner);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Email step:</Label>
          <select aria-label="Email step"
            className="text-sm border rounded px-2 py-1 bg-background"
            value={selectedStep}
            onChange={(e) => setSelectedStep(Number(e.target.value))}
          >
            {emailSteps.map((s) => (
              <option key={s.index} value={s.index}>Step {s.index + 1}: {s.subject || "(no subject)"}</option>
            ))}
          </select>
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="size-3.5 mr-1" /> Add variant</Button>
      </div>

      {/* Winner / auto-promotion status banner */}
      {promotedVariant && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 text-sm">
          <Trophy className="size-4 text-amber-500 shrink-0" />
          <span className="font-medium text-amber-800 dark:text-amber-300">Variant {promotedVariant.variantLabel} is the winner</span>
          {promotedVariant.promotedAt && (
            <span className="text-xs text-muted-foreground ml-1">
              — promoted {new Date(promotedVariant.promotedAt).toLocaleDateString()}
            </span>
          )}
        </div>
      )}
      {!promotedVariant && stats && stats.length >= 2 && (
        <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-800 px-3 py-2 text-sm text-blue-700 dark:text-blue-300">
          <Activity className="size-4 shrink-0" />
          <span>Testing in progress — winner will be auto-promoted once all variants reach their min-sends threshold.</span>
        </div>
      )}

      {isLoading && <div className="flex justify-center py-6"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}

      {!isLoading && (variants ?? []).length === 0 && (
        <div className="text-sm text-muted-foreground py-6 text-center border rounded-md">
          No A/B variants for this step yet. Add a variant to start testing.
        </div>
      )}

      {(variants ?? []).length > 0 && (
        <div className="space-y-2">
          {/* Stats comparison table */}
          {stats && stats.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-1.5 px-2">Variant</th>
                    <th className="text-left py-1.5 px-2">Subject</th>
                    <th className="text-right py-1.5 px-2">Split</th>
                    <th className="text-right py-1.5 px-2">Sent</th>
                    <th className="text-right py-1.5 px-2">Open %</th>
                    <th className="text-right py-1.5 px-2">Reply %</th>
                    <th className="text-right py-1.5 px-2">Min Sends</th>
                    <th className="py-1.5 px-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((v) => (
                    <tr key={v.id} className={`border-b hover:bg-muted/30 ${v.isWinner ? "bg-amber-50/50 dark:bg-amber-950/20" : ""}`}>
                      <td className="py-1.5 px-2">
                        <span className="font-mono font-semibold">{v.variantLabel}</span>
                        {v.isWinner && (
                          <span className="inline-flex items-center gap-0.5 ml-1.5 text-amber-600 dark:text-amber-400">
                            <Trophy className="size-3" />
                            <span className="text-[10px] font-medium">Winner</span>
                          </span>
                        )}
                        {!v.isWinner && topVariant?.id === v.id && v.sentCount > 0 && !promotedVariant && (
                          <span className="inline-flex items-center gap-0.5 ml-1.5 text-blue-500">
                            <TrendingUp className="size-3" />
                            <span className="text-[10px]">Leading</span>
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 px-2 max-w-[160px] truncate">{v.subject}</td>
                      <td className="py-1.5 px-2 text-right">{v.splitPct}%</td>
                      <td className="py-1.5 px-2 text-right">{v.sentCount}</td>
                      <td className={`py-1.5 px-2 text-right font-medium ${v.openRate >= 30 ? "text-emerald-600" : v.openRate >= 15 ? "text-amber-600" : "text-muted-foreground"}`}>{v.openRate}%</td>
                      <td className={`py-1.5 px-2 text-right font-medium ${v.replyRate >= 10 ? "text-emerald-600" : v.replyRate >= 5 ? "text-amber-600" : "text-muted-foreground"}`}>{v.replyRate}%</td>
                      <td className="py-1.5 px-2 text-right">
                        {minSendsEditing === v.id ? (
                          <div className="flex items-center gap-1 justify-end">
                            <Input aria-label="Minimum sends"
                              type="number"
                              className="h-5 w-16 text-xs px-1"
                              value={minSendsValue}
                              min={1}
                              onChange={(e) => setMinSendsValue(Number(e.target.value))}
                            />
                            <Button size="sm" className="h-5 px-1.5 text-[10px]" onClick={() => setMinSends.mutate({ id: v.id, minSendsForPromotion: minSendsValue })} disabled={setMinSends.isPending}>Save</Button>
                            <Button aria-label="Cancel" size="sm" variant="ghost" className="h-5 px-1" onClick={() => setMinSendsEditing(null)}>✕</Button>
                          </div>
                        ) : (
                          <button
                            className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                            onClick={() => { setMinSendsEditing(v.id); setMinSendsValue(v.minSendsForPromotion ?? 100); }}
                          >
                            {v.minSendsForPromotion ?? 100}
                          </button>
                        )}
                      </td>
                      <td className="py-1.5 px-2">
                        <div className="flex gap-1 justify-end">
                          {!v.isWinner && (
                            <Button
                              size="sm" variant="outline"
                              className="h-6 px-1.5 text-[10px] text-amber-700 border-amber-300 hover:bg-amber-50"
                              onClick={() => promoteWinner.mutate({ sequenceId, stepIndex: selectedStep, winnerId: v.id })}
                              disabled={promoteWinner.isPending}
                              title="Promote as winner"
                            >
                              <Trophy className="size-3 mr-0.5" />Promote
                            </Button>
                          )}
                          <Button aria-label="Edit variant" size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => setEditVariant(variants!.find((vv) => vv.id === v.id))}><Pencil className="size-3" /></Button>
                          <Button aria-label="Delete variant" size="sm" variant="ghost" className="h-6 px-1.5 text-destructive" onClick={() => deleteVariant.mutate({ id: v.id })}><Trash2 className="size-3" /></Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Add variant dialog */}
      <FormDialog open={addOpen} onOpenChange={setAddOpen} title="Add A/B Variant" isPending={createVariant.isPending}
        onSubmit={(f) => createVariant.mutate({
          sequenceId,
          stepIndex: selectedStep,
          variantLabel: String(f.get("variantLabel") ?? ""),
          subject: String(f.get("subject") ?? ""),
          body: String(f.get("body") ?? ""),
          splitPct: Number(f.get("splitPct") ?? 50),
        })}>
        <Field label="Variant label (e.g. A, B, C)" name="variantLabel" placeholder="B" required />
        <Field label="Subject line" name="subject" placeholder="Alternative subject..." required />
        <TextareaField label="Body" name="body" placeholder="Email body for this variant..." />
        <Field label="Split %" name="splitPct" type="number" placeholder="50" />
      </FormDialog>

      {/* Edit variant dialog */}
      {editVariant && (
        <Dialog open={!!editVariant} onOpenChange={(v) => !v && setEditVariant(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>Edit Variant {editVariant.variantLabel}</DialogTitle></DialogHeader>
            <div className="space-y-3 py-2">
              <div className="space-y-1"><Label>Subject</Label><Input aria-label="Subject" defaultValue={editVariant.subject} id="ev-subject" /></div>
              <div className="space-y-1"><Label>Body</Label><Textarea aria-label="Body" defaultValue={editVariant.body} id="ev-body" rows={5} /></div>
              <div className="space-y-1"><Label>Split %</Label><Input aria-label="Split %" type="number" defaultValue={editVariant.splitPct} id="ev-split" /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditVariant(null)}>Cancel</Button>
              <Button
                onClick={() => updateVariant.mutate({
                  id: editVariant.id,
                  subject: (document.getElementById("ev-subject") as HTMLInputElement)?.value,
                  body: (document.getElementById("ev-body") as HTMLTextAreaElement)?.value,
                  splitPct: Number((document.getElementById("ev-split") as HTMLInputElement)?.value),
                })}
                disabled={updateVariant.isPending}
              >
                {updateVariant.isPending && <Loader2 className="size-4 animate-spin mr-1" />}Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
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
          <input aria-label="From"
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-[#14B89A]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground font-medium">To</label>
          <input aria-label="To"
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

      <SequenceStepBreakdown sequenceId={sequenceId} />
    </div>
  );
}

/**
 * Per-step performance table — one row per email step in the sequence,
 * showing sent / unique opens / unique clicks / replies / bounces and
 * their rates as % bars. Surfaces where a sequence's funnel is leaking.
 */
function SequenceStepBreakdown({ sequenceId }: { sequenceId: number }) {
  const { data, isLoading } = trpc.sequences.getStepAnalytics.useQuery({ sequenceId });
  if (isLoading) {
    return (
      <Section title="Per-step performance">
        <div className="p-3 text-sm text-muted-foreground">Loading step breakdown…</div>
      </Section>
    );
  }
  const steps = (data?.steps ?? []).filter((s: any) => s.stepType === "email" || s.stepIndex === -1 || s.sent > 0);
  if (steps.length === 0) {
    return (
      <Section title="Per-step performance">
        <div className="p-3 text-sm text-muted-foreground">
          No email steps have sent yet — once drafts go out, this will break down by step.
        </div>
      </Section>
    );
  }
  // Color thresholds: green if good, amber if mid, muted otherwise.
  const tone = (rate: number, good: number, mid: number) =>
    rate >= good ? "text-emerald-600" : rate >= mid ? "text-amber-600" : "text-muted-foreground";
  const bounceTone = (rate: number) =>
    rate > 5 ? "text-rose-600" : rate > 2 ? "text-amber-600" : rate > 0 ? "text-emerald-600" : "text-muted-foreground";

  return (
    <Section title="Per-step performance">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-muted-foreground uppercase tracking-wide border-b">
              <th className="text-left py-2 pl-3 pr-2 font-medium">Step</th>
              <th className="text-right px-2 font-medium">Sent</th>
              <th className="text-right px-2 font-medium">Opens</th>
              <th className="text-right px-2 font-medium">Clicks</th>
              <th className="text-right px-2 font-medium">Replies</th>
              <th className="text-right pr-3 pl-2 font-medium">Bounced</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s: any) => (
              <tr key={s.stepIndex} className="border-b last:border-b-0 hover:bg-muted/40">
                <td className="py-2 pl-3 pr-2">
                  <div className="text-xs font-medium">
                    {s.stepIndex === -1 ? "—" : `Step ${s.stepIndex + 1}`}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate max-w-[260px]" title={s.stepLabel}>
                    {s.stepLabel}
                  </div>
                </td>
                <td className="text-right px-2 tabular-nums font-mono">{s.sent}</td>
                <td className="text-right px-2 tabular-nums">
                  <span className={tone(s.openRate, 30, 15)}>{s.uniqueOpens}</span>
                  <span className="text-[11px] text-muted-foreground ml-1">({s.openRate}%)</span>
                </td>
                <td className="text-right px-2 tabular-nums">
                  <span className={tone(s.clickRate, 5, 2)}>{s.uniqueClicks}</span>
                  <span className="text-[11px] text-muted-foreground ml-1">({s.clickRate}%)</span>
                </td>
                <td className="text-right px-2 tabular-nums">
                  <span className={tone(s.replyRate, 5, 2)}>{s.replied}</span>
                  <span className="text-[11px] text-muted-foreground ml-1">({s.replyRate}%)</span>
                </td>
                <td className="text-right pr-3 pl-2 tabular-nums">
                  <span className={bounceTone(s.bounceRate)}>{s.bounced}</span>
                  <span className="text-[11px] text-muted-foreground ml-1">({s.bounceRate}%)</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

export default function Sequences() {
  // sequences.create refuses a member whose manage_sequences is denied; hiding
  // the button is what keeps that from arriving as an unexplained toast.
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  const [editSeq, setEditSeq] = useState<any | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"steps" | "stats" | "analytics" | "ab">("steps");
  const utils = trpc.useUtils();
  const { data, isLoading, isError, error } = trpc.sequences.list.useQuery();
  const create = trpc.sequences.create.useMutation({
    onSuccess: () => { utils.sequences.list.invalidate(); setOpen(false); toast.success("Sequence created"); },
    onError: (e) => toast.error("Failed to create sequence", { description: e.message }),
  });
  // The detail pane reads sequences.get, so a status change invalidates it
  // too; it used to refresh only the list and the pane kept the old status (O37).
  const setStatus = trpc.sequences.setStatus.useMutation({
    onSuccess: (_d, vars) => { utils.sequences.list.invalidate(); utils.sequences.get.invalidate({ id: vars.id }); },
    onError: (e) => toast.error("Failed to change status", { description: e.message }),
  });
  const remove = trpc.sequences.delete.useMutation({
    onSuccess: (_d, vars) => {
      utils.sequences.list.invalidate();
      // Clear the right-pane selection if we just deleted what was open.
      if (selected === vars.id) setSelected(null);
      toast.success("Sequence deleted");
    },
    onError: (e) => toast.error("Failed to delete sequence", { description: e.message }),
  });
  const detail = trpc.sequences.get.useQuery({ id: selected! }, { enabled: !!selected });
  // Workspace templates available for the right-panel "From template: <name>"
  // chip. Cheap query; result is reused across every step row that has a
  // templateId, so each step doesn't trigger its own fetch.
  const allTemplatesQ = trpc.emailTemplates?.list?.useQuery({ status: "all" });
  const templateNameById = new Map<number, string>(
    ((allTemplatesQ?.data ?? []) as any[]).map((t) => [t.id as number, t.name as string]),
  );

  return (
    <Shell title="Sequences">
      <PageHeader title="Sequences" description="Build multi-step email and task cadences to engage prospects at scale with personalised touchpoints. Set the steps, the delays between them and a daily cap; a reply pauses the person." pageKey="sequences"
        icon={<ListOrdered className="size-5" />}
      >
        {can("manage_sequences") && <Button onClick={() => setOpen(true)} data-tour-id="sequences-new-button"><Plus className="size-4" /> New sequence</Button>}
      </PageHeader>
      <SubNav items={[
        { href: "/v2/emails?status=awaiting&source=sequence", label: "Email Drafts", title: "Review and edit drafts created by sequence steps" },
        { href: "/email-analytics", label: "Email Analytics", title: "Open / click / reply rates per sequence and per step" },
      ]} />
      <div className="px-4 md:px-5 pt-4"><SequenceDraftsNote /></div>
      <div className="p-4 md:p-5 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          <Section title="All sequences">
            {/* Not read yet is not empty (audit 2026-10-20, O56). */}
            {isLoading ? (
              <div className="p-3 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading sequences…</div>
            ) : isError ? (
              <div className="p-3 text-sm text-destructive">Sequences could not be loaded{error?.message ? `: ${error.message}` : "."}</div>
            ) : (data ?? []).length === 0 ? <EmptyState icon={Activity} title="None yet" /> : (
              <ul className="divide-y">
                {data!.map((s) => (
                  <li key={s.id}
                    className={`p-3 cursor-pointer hover:bg-secondary/40 ${selected === s.id ? "bg-secondary/60" : ""}`}
                    {...pressable(() => { setSelected(s.id); setActiveTab("steps"); })}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 text-sm font-medium truncate">{s.name}</div>
                      <StatusPill tone={s.status === "active" ? "success" : s.status === "paused" ? "warning" : "muted"}>{s.status}</StatusPill>
                      {/* span stops the click reaching the row behind it. */}
                      <span onClick={(e) => e.stopPropagation()} className="contents">
                        <ConfirmButton
                          className="text-muted-foreground hover:text-destructive p-1 h-auto rounded"
                          ariaLabel="Delete sequence"
                          title="Delete this sequence?"
                          description={`"${s.name}" is deleted with its steps, its enrolments and any drafts not yet sent. Emails it already sent stay in the Emails log, and their unsubscribe links keep working. This cannot be undone.`}
                          confirmLabel="Delete"
                          onConfirm={() => remove.mutate({ id: s.id })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </ConfirmButton>
                      </span>
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
                    <Button size="sm" variant="outline" onClick={() => setPreviewOpen(true)}
                      title="Preview emails as the prospect will see them (Gmail / Outlook)">
                      <Eye className="size-3.5" /> Preview
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
                <div {...tablistProps("Sequence sections")} className="flex border-b mb-3 px-3">
                  {[
                    { k: "steps", label: "Steps", icon: Activity },
                    { k: "stats", label: "Stats & Enrollments", icon: BarChart3 },
                    { k: "analytics", label: "Performance", icon: TrendingUp },
                    { k: "ab", label: "A/B Testing", icon: FlaskConical },
                  ].map(({ k, label, icon: Icon }) => (
                    <button {...tabProps(activeTab === k)} key={k}
                      onClick={() => setActiveTab(k as any)}
                      className={`flex items-center gap-1.5 px-3 py-2 text-sm ${activeTab === k ? "border-b-2 border-[#14B89A] font-semibold" : "text-muted-foreground"}`}>
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </button>
                  ))}
                </div>

                {activeTab === "steps" && (
                  <ol className="p-3 space-y-2">
                    {((detail.data.steps as any[]) ?? []).map((step, i) => {
                      // Resolve template provenance for the right-pane chip.
                      // templateId is plumbed end-to-end (Edit dialog +
                      // canvas → server stepSchema → here) so the chip
                      // shows in lock-step with whichever editor the user
                      // last touched.
                      const tmplName = step.type === "email" && typeof step.templateId === "number"
                        ? templateNameById.get(step.templateId)
                        : null;
                      const bodyPreview = step.body ? htmlToPlainText(String(step.body)) : "";
                      return (
                        <li key={i} className="border rounded p-2.5">
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="font-mono">Step {i + 1}</span> · {step.type}
                            {step.type === "wait" ? ` · ${step.days}d` : ""}
                          </div>
                          {/* What sends is the step's own copy, template or not
                              (O26), so the copy is what is shown; a template
                              step says where its copy came from. */}
                          {step.subject && <div className="text-sm font-medium mt-1">{step.subject}</div>}
                          {bodyPreview && <div className="text-xs text-muted-foreground line-clamp-3 mt-1 whitespace-pre-wrap">{bodyPreview}</div>}
                          {step.type === "email" && typeof step.templateId === "number" && (
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              <Mail className="size-3 inline mr-1" />
                              A copy of{" "}
                              {tmplName
                                ? <Link href={`/email-builder/${step.templateId}`} className="font-medium text-blue-700 dark:text-blue-300 hover:underline underline-offset-2">{tmplName}</Link>
                                : "a template you can't open, or that has been deleted"}
                              . {TEMPLATE_COPY_NOTE}
                            </div>
                          )}
                        </li>
                      );
                    })}
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

                {activeTab === "ab" && (
                  <div className="p-3">
                    <SequenceAbPanel
                      sequenceId={detail.data.id}
                      steps={(detail.data.steps as any[]) ?? []}
                    />
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

      {/* Prospect-POV preview (right-panel button) — saved steps */}
      {detail.data && (
        <EmailClientPreview
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          steps={(detail.data.steps as any[]) ?? []}
          sequenceName={detail.data.name}
        />
      )}
    </Shell>
  );
}
