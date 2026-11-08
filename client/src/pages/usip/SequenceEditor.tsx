/**
 * SequenceEditor — the sequence builder (/v2/sequences/:id).
 *
 * Apollo's sequence editor: header (name + Share / Add contacts / Activate
 * or Pause), tabs (Editor / Contacts / Activity / Report / Settings). The
 * Editor tab is the step builder — an ordered list of steps with an "Add a
 * step" picker (Email / Phone call / Action item / LinkedIn / Wait) and inline
 * editors per step. Steps persist via sequences.updateSteps; name and
 * description via sequences.update; status via sequences.setStatus.
 *
 * THE sequence editor (audit 2026-10-20, U14, 2026-11-07). Legacy /sequences
 * and its canvas now redirect here, after everything only they had was folded
 * in: the A/B tests tab, the bulk enrol picker behind "Add contacts", the
 * daily cap and reply detection, Archive and Delete, "Mark replied", the
 * prospect preview, the per-step report, AI-written email steps and waits in
 * hours. What a sequence saved from either old screen loads and saves here
 * unchanged (server/conaSequenceEditor.test.ts).
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { SendingStatusBar } from "@/components/usip/SendingStatusBar";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTextEditor } from "@/components/usip/RichTextEditor";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Send, Star, Share2, Zap, UserPlus, ChevronDown, Plus, Mail, Phone,
  CheckSquare, MessageSquare, Clock, Trash2, GripVertical, ArrowUp, ArrowDown,
  PauseCircle, PlayCircle, Archive, Eye, FlaskConical, Sparkles, AlertTriangle,
  Loader2, Users, Activity as ActivityIcon, Settings2, X,
} from "lucide-react";
import { pressable } from "@/lib/pressable";
import { tablistProps, tabProps } from "@/lib/tabs";
import { sanitizeEmailHtml } from "@/lib/sanitizeHtml";
import { applyTemplate, describeSendWindow, detachTemplate, stepDistribution, stepWithDisplacedVariants, waitDaysFrom, waitParts, MAX_WAIT_DAYS, type EmailStep, type TemplateChoice } from "@/lib/sequenceSteps";
import { SequenceEnrollmentActions } from "@/components/usip/SequenceEnrollmentActions";
import { SequenceDraftsNote } from "@/components/usip/SequenceDraftsNote";
import { ConfirmButton } from "@/components/usip/Common";
import { useAuth } from "@/_core/hooks/useAuth";
import { SequenceReport } from "@/components/usip/SequenceReport";
import { StepTemplatePicker } from "@/components/usip/StepTemplatePicker";
import { SequenceSendingSettings } from "@/components/usip/SequenceSendingSettings";
import { SequenceReviewBanner } from "@/components/usip/SequenceReviewBanner";
import { SequenceScheduleSettings } from "@/components/usip/SequenceScheduleSettings";
import { SequenceTimelinePreview } from "@/components/usip/SequenceTimelinePreview";
import { SequenceEnrollDialog } from "@/components/usip/SequenceEnrollDialog";
import { SequenceAbTests, variantCountsByStep } from "@/components/usip/SequenceAbTests";
import { SequenceStepBreakdown } from "@/components/usip/SequenceStepBreakdown";
import { SequenceMarkReply } from "@/components/usip/SequenceMarkReply";
import { EmailClientPreview } from "@/components/usip/EmailClientPreview";
import { Switch } from "@/components/ui/switch";
import { canvasLeftovers } from "@/lib/canvasSupport";
import { isHtmlBody } from "@shared/emailBody";
import { invalidateSequenceReads } from "@/lib/entityCache";

/**
 * `enabled: false` marks a RETIRED step: the send engine skips it entirely.
 * Set either by hand here or by the optimisation layer when a step has real
 * volume and has never earned a reply (/are/performance → Recommendations).
 * Absent/true means active, so existing sequences are unaffected.
 */
type Step =
  | EmailStep
  | { type: "wait"; days: number; enabled?: boolean }
  | { type: "task"; body: string; enabled?: boolean }
  | { type: "linkedin_dm"; body?: string; enabled?: boolean }
  | { type: "linkedin_invite"; note?: string; enabled?: boolean };

/**
 * One email step, not two (audit 2026-10-20, O39): "Automatic email" and
 * "Manual email" made the same step, and every email step works the same way
 * (a draft that waits for review or auto-send), so the choice meant nothing.
 */
const STEP_OPTIONS: { key: string; label: string; icon: any; make: () => Step }[] = [
  { key: "email_step", label: "Email", icon: Mail, make: () => ({ type: "email", subject: "", body: "" }) },
  { key: "call", label: "Phone call", icon: Phone, make: () => ({ type: "task", body: "Call: " }) },
  { key: "task", label: "Action item", icon: CheckSquare, make: () => ({ type: "task", body: "" }) },
  { key: "li_invite", label: "LinkedIn — connection request", icon: UserPlus, make: () => ({ type: "linkedin_invite", note: "" }) },
  { key: "li_dm", label: "LinkedIn — message", icon: MessageSquare, make: () => ({ type: "linkedin_dm", body: "" }) },
  { key: "wait", label: "Wait / delay", icon: Clock, make: () => ({ type: "wait", days: 2 }) },
];

function stepMeta(s: Step): { icon: any; label: string; summary: string } {
  switch (s.type) {
    case "email": return { icon: Mail, label: "Email", summary: s.subject || "Untitled email" };
    case "wait": return { icon: Clock, label: "Wait", summary: `Wait ${s.days} day${s.days === 1 ? "" : "s"}` };
    case "task": return { icon: CheckSquare, label: "Task", summary: s.body || "Action item" };
    case "linkedin_invite": return { icon: UserPlus, label: "LinkedIn invite", summary: s.note || "Connection request" };
    case "linkedin_dm": return { icon: MessageSquare, label: "LinkedIn message", summary: s.body || "LinkedIn message" };
  }
}

const TABS = ["Editor", "Contacts", "A/B tests", "Activity", "Report", "Settings"] as const;
type Tab = (typeof TABS)[number];

/**
 * The enrollment states the schema actually has — `drizzle/schema.ts` →
 * `enrollments.status`, the mysqlEnum — in the order a rep reads them.
 *
 * Pinned by `server/sequenceContactsTab.test.ts` against that enum: a fifth
 * state added there without a tile here would quietly vanish from this grid
 * and the counts would stop summing to the rows below them.
 */
const ENROLLMENT_STATES = [
  { key: "active", label: "Active", pill: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300" },
  { key: "paused", label: "Paused", pill: "bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-300" },
  { key: "finished", label: "Finished", pill: "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300" },
  { key: "exited", label: "Exited", pill: "bg-muted text-muted-foreground" },
] as const;

/**
 * WHAT WAS DELETED HERE, and why there are four tiles and not six
 * (2026-11-01). The Contacts tab used to render six: "Total" and "In
 * progress" were the same enrolled count printed twice, and Cold /
 * Approaching / Replied / Interested were the literal number `0` — in the
 * accent colour, in the same weight and size as the real count — so four of
 * six tiles were decoration that read as measurement, with an empty-state
 * card below them that never listed anybody however many were enrolled.
 *
 * Nothing in the schema backs those four. An `enrollments` row carries
 * status, currentStep, startedAt, nextActionAt and resumeAt; there is no
 * engagement temperature in it anywhere. They are deleted rather than mapped
 * onto the nearest column, because a tile that is absent asks a question and
 * a tile that is wrong answers one.
 *
 * "Replied" is the one of the four that could be built, but not from enrollment
 * state: it belongs in `sequences.getPerformanceAnalytics`
 * (server/services/sequenceAnalytics.ts), which the Report tab renders and which
 * does not count replies yet.
 */

export default function SequenceEditor() {
  const { id: idStr } = useParams<{ id: string }>();
  const id = Number(idStr);
  const [, setLocation] = useLocation();
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  const seqQ = trpc.sequences.get.useQuery({ id }, { enabled: Number.isFinite(id) });
  const seq = seqQ.data as any;

  /**
   * A refused step edit puts the screen back to what is saved (audit
   * 2026-10-20, O38). It only toasted, and the edit stayed on screen looking
   * saved, so a sequence could appear to say something it does not send.
   */
  const updateSteps = trpc.sequences.updateSteps.useMutation({
    onSuccess: () => { invalidateSequenceReads(utils); },
    onError: (e) => {
      toast.error(e.message);
      void seqQ.refetch().then((r) => { if (r.data) setSteps(Array.isArray((r.data as any).steps) ? (r.data as any).steps : []); });
    },
  });
  // Activate and Pause on this page (O38): Activate used to take you to the
  // legacy list to find the real button.
  const setStatus = trpc.sequences.setStatus.useMutation({
    onSuccess: (_d, v) => {
      invalidateSequenceReads(utils);
      toast.success(v.status === "active" ? "Sequence activated" : v.status === "archived" ? "Sequence archived" : v.status === "draft" ? "Sequence restored as a draft" : "Sequence paused");
    },
    onError: (e) => toast.error(e.message),
  });
  const { user } = useAuth();
  const updateMeta = trpc.sequences.update.useMutation({ onSuccess: () => { invalidateSequenceReads(utils); }, onError: (e) => toast.error(e.message) });
  // Reply detection, from the legacy edit dialog and the canvas panel (U14).
  const saveReplyDetection = trpc.sequences.updateMeta.useMutation({
    onSuccess: (_d, v) => { invalidateSequenceReads(utils); toast.success(v.settings?.replyDetection === false ? "Replies no longer pause anyone" : "A reply pauses the person again"); },
    onError: (e) => toast.error(e.message),
  });
  // Delete, from the legacy list (U14), with its words about what stays (O22).
  const removeSeq = trpc.sequences.delete.useMutation({
    onSuccess: () => { invalidateSequenceReads(utils); toast.success("Sequence deleted"); setLocation("/v2/sequences"); },
    onError: (e) => toast.error(e.message),
  });
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  /** Every variant of every step, to badge the steps and keep them in place (U14). */
  const variantsQ = trpc.sequenceAb.list.useQuery({ sequenceId: id }, { enabled: Number.isFinite(id) });
  const variantsByStep = useMemo(() => variantCountsByStep(variantsQ.data as { stepIndex: number }[] | undefined), [variantsQ.data]);
  /** What a drawing on the retired canvas held beyond these steps (U14). */
  const canvasQ = trpc.sequences.getCanvas.useQuery({ id }, { enabled: Number.isFinite(id) });
  const leftovers = useMemo(() => canvasLeftovers((canvasQ.data?.nodes ?? []) as any[], (canvasQ.data?.edges ?? []) as any[]), [canvasQ.data]);

  const [tabForQuery, setTabForQuery] = useState(false);
  /**
   * WHO is enrolled, from the one resolver that already answers it
   * (`sequences.listEnrollments` — it batch-resolves the name and the
   * /prospects/:id link per row, added for the owner 2026-09-20). Both the
   * tiles and the list read these same rows, so the counts can never disagree
   * with what is listed under them.
   */
  const enrollmentsQ = trpc.sequences.listEnrollments.useQuery(
    { sequenceId: id },
    { enabled: Number.isFinite(id) && tabForQuery },
  );

  const [tab, setTab] = useState<Tab>("Editor");
  useEffect(() => { if (tab === "Contacts") setTabForQuery(true); }, [tab]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // settings draft
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [dailyCap, setDailyCap] = useState("");

  useEffect(() => {
    if (seq) {
      setSteps(Array.isArray(seq.steps) ? seq.steps : []);
      setName(seq.name ?? "");
      setDescription(seq.description ?? "");
      setDailyCap(seq.dailyCap != null ? String(seq.dailyCap) : "");
    }
  }, [seq?.id]);

  const commit = (next: Step[]) => { setSteps(next); updateSteps.mutate({ id, steps: next as any }); };
  const addStep = (make: () => Step) => { const next = [...steps, make()]; setSteps(next); updateSteps.mutate({ id, steps: next as any }); setExpanded(next.length - 1); setAddOpen(false); };
  /**
   * A/B variants are kept by step position, so a move or removal that shifts a
   * step with variants would send them at another step. Refused, with why (U14).
   */
  const displacesVariants = (change: Parameters<typeof stepWithDisplacedVariants>[0]) => {
    const at = stepWithDisplacedVariants(change, steps.length, variantsByStep);
    if (at === null) return false;
    toast.error(`Step ${at + 1} has A/B variants, and they belong to its place in the sequence. Remove them on the A/B tests tab first, or they would send at a different step.`);
    return true;
  };
  const removeStep = (i: number) => { if (displacesVariants({ kind: "remove", at: i })) return; const next = steps.filter((_, idx) => idx !== i); commit(next); if (expanded === i) setExpanded(null); };
  /**
   * Retire / restore a step. Retiring keeps it in the sequence (so its history
   * and copy survive) but the engine skips it — the reversible alternative to
   * deleting a step that isn't working.
   */
  const toggleStepEnabled = (i: number) => {
    const next = steps.map((s, idx) =>
      idx === i ? ({ ...s, enabled: (s as any).enabled === false ? true : false } as Step) : s,
    );
    commit(next);
  };
  const moveStep = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= steps.length) return; if (displacesVariants({ kind: "move", from: i, to: j })) return; const next = [...steps]; [next[i], next[j]] = [next[j], next[i]]; commit(next); };
  const patchStep = (i: number, patch: Partial<Step>) => { setSteps((prev) => prev.map((s, idx) => (idx === i ? ({ ...s, ...patch } as Step) : s))); };
  const commitEdits = () => updateSteps.mutate({ id, steps: steps as any });
  // A change saved at once, for controls that leave no field behind to blur.
  const commitPatch = (i: number, patch: Partial<Step>) => commit(steps.map((s, idx) => (idx === i ? ({ ...s, ...patch } as Step) : s)));
  // Saved at once: the picker and the button leave no field behind to blur.
  const withEmailStep = (i: number, change: (s: EmailStep) => EmailStep) =>
    commit(steps.map((s, idx) => (idx === i && s.type === "email" ? change(s) : s)));
  // The server refuses step edits on these two, and a change that looked saved would not be.
  const stepsBlocked = seq?.status === "active"
    ? "Pause the sequence to change its steps."
    : seq?.status === "archived" ? "An archived sequence can't be changed." : null;

  const statusBadge = useMemo(() => {
    const s = seq?.status ?? "draft";
    const map: Record<string, string> = { active: "bg-emerald-100 text-emerald-800", paused: "bg-amber-100 text-amber-800", draft: "bg-secondary text-muted-foreground", archived: "bg-muted text-muted-foreground" };
    return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", map[s])}>{s}</span>;
  }, [seq?.status]);

  if (seqQ.isLoading) {
    return <Shell title="Sequence"><div className="p-6"><div className="h-8 w-48 bg-muted/50 rounded animate-pulse mb-4" /><div className="h-40 bg-muted/40 rounded animate-pulse" /></div></Shell>;
  }
  if (!seq) {
    return <Shell title="Sequence"><div className="p-10 text-center text-sm text-muted-foreground">Sequence not found. <Link href="/v2/sequences" className="underline" style={{ color: accent }}>Back to Sequences</Link></div></Shell>;
  }

  return (
    <Shell title={seq.name}>
      <div className="flex flex-col h-full min-h-0">
        {/* What is holding sends right now, if anything (audit 2026-10-20, U1). */}
        <SendingStatusBar surface="sequences" className="shrink-0" />
        {/* header */}
        <div className="relative shrink-0 px-4 pt-2.5 pb-0 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mb-0.5">
            <Link href="/v2/sequences" className="hover:text-foreground hover:underline">Sequences</Link><span>›</span>
            <span className="text-foreground truncate max-w-[240px]">{seq.name}</span>
          </div>
          <div className="flex items-center gap-2 mb-1.5">
            <Send className="size-4" style={{ color: accent }} />
            <h1 className="text-[16px] font-semibold tracking-tight truncate max-w-[300px]">{seq.name}</h1>
            <Star className="size-4 text-muted-foreground" />
            {statusBadge}
            <div className="flex-1" />
            <Button variant="ghost" size="sm" className="h-7 gap-1.5"><Share2 className="size-3.5" /> Share</Button>
            {/* The bulk enrol picker from legacy /sequences (U14). */}
            <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={seq.status === "archived"} onClick={() => setEnrollOpen(true)}><Users className="size-3.5" /> Add contacts</Button>
            {seq.status === "active" ? (
              <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id, status: "paused" })}>
                <PauseCircle className="size-3.5" /> Pause
              </Button>
            ) : seq.status !== "archived" ? (
              <ConfirmButton
                variant="default"
                destructive={false}
                className="h-7 gap-1.5"
                disabled={setStatus.isPending || steps.length === 0}
                title="Activate this sequence?"
                description="Everyone enrolled starts moving through its steps. Email steps write drafts that wait for review unless auto-send sends them; LinkedIn steps go out within your account's limits. Nothing goes out while outbound sending is paused."
                confirmLabel="Activate"
                onConfirm={() => setStatus.mutate({ id, status: "active" })}
              >
                <Zap className="size-3.5" /> {steps.length === 0 ? "Add a step to activate" : "Activate"}
              </ConfirmButton>
            ) : (
              <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id, status: "draft" })}>
                Restore as draft
              </Button>
            )}
            {/* Archive, from legacy /sequences and the canvas (U14). It ends every enrolment, so it asks. */}
            {seq.status !== "archived" && (
              <ConfirmButton
                className="h-7 gap-1.5"
                disabled={setStatus.isPending}
                title="Archive this sequence?"
                description="Everyone still active or paused in it is taken out, and nothing more is drafted from it. Its emails, report and history stay. You can restore it as a draft later, but people would have to be enrolled again."
                confirmLabel="Archive"
                onConfirm={() => setStatus.mutate({ id, status: "archived" })}
              >
                <Archive className="size-3.5" /> Archive
              </ConfirmButton>
            )}
          </div>
          {/* tabs */}
          <div {...tablistProps("Sequence sections")} className="flex items-center gap-1">
            {TABS.map((t) => (
              <button {...tabProps(tab === t)} key={t} onClick={() => setTab(t)} className={cn("relative px-3 py-2 text-[13px] transition-colors", tab === t ? "font-semibold" : "text-muted-foreground hover:text-foreground")} style={tab === t ? { color: accent } : undefined}>
                {t}{tab === t && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full" style={{ backgroundColor: accent }} />}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {/* This sequence's drafts that wait, linked to exactly those (U15). */}
          <SequenceReviewBanner sequenceId={id} className="mx-4 mt-3 md:mx-6" />
          {/* EDITOR */}
          {tab === "Editor" && (
            <div className="max-w-2xl mx-auto p-4 md:p-6">
              <SequenceDraftsNote className="mb-3" sequenceSettings={seq.settings} />
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[12px] font-medium px-2 py-1 rounded-md border bg-card inline-flex items-center gap-1.5"><Send className="size-3.5" style={{ color: accent }} /> {steps.length} step{steps.length === 1 ? "" : "s"}</span>
                {updateSteps.isPending && <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Loader2 className="size-3 animate-spin" /> Saving…</span>}
                <div className="flex-1" />
                {/* The prospect's-eye preview from legacy /sequences (U14): the copy that sends. */}
                <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={steps.length === 0} onClick={() => setPreviewOpen(true)}><Eye className="size-3.5" /> Preview</Button>
              </div>
              {(leftovers.notes.length > 0 || leftovers.unreached > 0) && (
                <div role="note" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                  <div className="font-semibold flex items-center gap-1.5"><AlertTriangle className="size-3.5" /> This sequence was drawn on the old canvas, and part of the drawing never ran</div>
                  <ul className="mt-1 list-disc pl-4 space-y-0.5">
                    {leftovers.notes.map((n) => <li key={n}>{n}</li>)}
                    {leftovers.unreached > 0 && <li>{leftovers.unreached} {leftovers.unreached === 1 ? "node isn't" : "nodes aren't"} joined to the start, so {leftovers.unreached === 1 ? "it" : "they"} never ran.</li>}
                  </ul>
                  <p className="mt-1">The steps below are what runs. Saving them here redraws the canvas as a straight line, and these drop off then.</p>
                </div>
              )}

              {steps.length === 0 ? (
                <div className="text-center py-14 border border-dashed rounded-xl">
                  <Send className="size-9 text-muted-foreground opacity-40 mx-auto mb-3" />
                  <div className="text-sm font-medium">Your sequence is empty</div>
                  <p className="text-sm text-muted-foreground mt-1">Add steps to build your sequence.</p>
                  <div className="mt-4"><AddStepButton accent={accent} open={addOpen} setOpen={setAddOpen} onAdd={addStep} /></div>
                </div>
              ) : (
                <div className="space-y-3">
                  {steps.map((s, i) => {
                    const meta = stepMeta(s);
                    const Icon = meta.icon;
                    const open = expanded === i;
                    // A retired step still sends nothing. It must LOOK inactive —
                    // otherwise the engine silently skipping it is invisible here.
                    const retired = (s as any).enabled === false;
                    return (
                      <div key={i} className={cn("rounded-xl border bg-card shadow-sm", retired && "border-dashed opacity-70")}>
                        <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer" {...pressable(() => setExpanded(open ? null : i))}>
                          <GripVertical className="size-4 text-muted-foreground/50 shrink-0" />
                          <span
                            className="shrink-0 size-7 rounded-lg flex items-center justify-center text-[11px] font-bold"
                            style={retired
                              ? { backgroundColor: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" }
                              : { backgroundColor: `${accent}1f`, color: accent }}
                          >{i + 1}</span>
                          <Icon className="size-4 shrink-0" style={{ color: retired ? "hsl(var(--muted-foreground))" : accent }} />
                          <div className="min-w-0 flex-1">
                            <div className="text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                              {meta.label}
                              {(variantsByStep.get(i) ?? 0) > 0 && (
                                <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-violet-800 dark:bg-violet-950/50 dark:text-violet-300" title="This step sends its A/B variants instead of its own copy">
                                  A/B · {variantsByStep.get(i)}
                                </span>
                              )}
                              {s.type === "email" && s.emailMode === "dynamic" && (
                                <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-blue-800 dark:bg-blue-950/50 dark:text-blue-300">AI writes it</span>
                              )}
                              {retired && (
                                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
                                  Skipped — not sending
                                </span>
                              )}
                            </div>
                            <div className={cn("text-[13px] truncate", retired && "line-through text-muted-foreground")}>{meta.summary}</div>
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="ghost" size="icon-sm"
                              className={retired ? "text-amber-600" : "text-muted-foreground"}
                              title={retired ? "Restore this step — the engine will send it again" : "Retire this step — keeps its copy but stops sending it"}
                              onClick={() => toggleStepEnabled(i)}
                            >
                              {retired ? <PlayCircle className="size-3.5" /> : <PauseCircle className="size-3.5" />}
                            </Button>
                            <Button aria-label="Move step up" variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => moveStep(i, -1)}><ArrowUp className="size-3.5" /></Button>
                            <Button aria-label="Move step down" variant="ghost" size="icon-sm" disabled={i === steps.length - 1} onClick={() => moveStep(i, 1)}><ArrowDown className="size-3.5" /></Button>
                            <Button aria-label="Delete step" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => removeStep(i)}><Trash2 className="size-3.5" /></Button>
                            <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-180")} />
                          </div>
                        </div>
                        {retired && (
                          <div className="border-t border-dashed border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
                            Enrollments skip straight past this step. It may have been retired automatically because it
                            had sends but no replies — see <span className="font-medium">What's Working</span> → Applied changes.
                          </div>
                        )}
                        {open && (
                          <div className="border-t border-border/60 p-3 space-y-2" onBlur={commitEdits}>
                            <StepEditor
                              step={s}
                              onChange={(patch) => patchStep(i, patch)}
                              accent={accent}
                              blocked={stepsBlocked}
                              onPickTemplate={(t: TemplateChoice) => withEmailStep(i, (e) => applyTemplate(e, t))}
                              onDetachTemplate={() => withEmailStep(i, detachTemplate)}
                              onCommit={(patch) => commitPatch(i, patch)}
                              enrolledCount={Number(seq.enrolledCount ?? 0)}
                              hasVariants={(variantsByStep.get(i) ?? 0) > 0}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="pt-1"><AddStepButton accent={accent} open={addOpen} setOpen={setAddOpen} onAdd={addStep} /></div>
                </div>
              )}
              {/* When the steps really happen, with the engine's own rules (audit 2026-10-20, U4). */}
              {steps.length > 0 && <SequenceTimelinePreview sequenceId={id} accent={accent} className="mt-5" />}
            </div>
          )}

          {/* CONTACTS */}
          {tab === "Contacts" && (
            <ContactsTab
              accent={accent}
              query={enrollmentsQ}
              sequenceId={id}
              steps={steps}
              onAddContacts={() => setEnrollOpen(true)}
            />
          )}

          {/* A/B TESTS, from legacy /sequences (U14) */}
          {tab === "A/B tests" && (
            <SequenceAbTests
              sequenceId={id}
              steps={steps}
              accent={accent}
              locked={seq.status === "active" ? "Pause the sequence to change its variants." : seq.status === "archived" ? "An archived sequence can't be changed." : null}
            />
          )}

          {/* ACTIVITY */}
          {tab === "Activity" && (
            <div className="max-w-2xl mx-auto p-4 md:p-6">
              <div className="rounded-xl border bg-card shadow-sm divide-y divide-border/60">
                <div className="flex items-center gap-3 px-3 py-3">
                  <span className="size-7 rounded-full flex items-center justify-center" style={{ backgroundColor: `${accent}1f`, color: accent }}><Send className="size-3.5" /></span>
                  {/* "You" only for the person who did (O39). */}
                  <div className="text-[13px]">{seq.ownerUserId != null && seq.ownerUserId === user?.id ? "You created the sequence." : "This sequence was created."}</div>
                  <div className="flex-1" />
                  <div className="text-[11px] text-muted-foreground">{seq.createdAt ? new Date(seq.createdAt).toLocaleString() : ""}</div>
                </div>
              </div>
            </div>
          )}

          {/* REPORT */}
          {tab === "Report" && <SequenceReport sequenceId={id} accent={accent} />}
          {tab === "Report" && <SequenceStepBreakdown sequenceId={id} accent={accent} />}

          {/* SETTINGS */}
          {tab === "Settings" && (
            <div className="max-w-xl mx-auto p-4 md:p-6 space-y-4">
              <div className="rounded-xl border bg-card shadow-sm p-4 space-y-3">
                <h2 className="text-sm font-semibold flex items-center gap-2"><Settings2 className="size-4" style={{ color: accent }} /> Sequence settings</h2>
                <div>
                  <div className="text-[12px] font-medium mb-1">Sequence name</div>
                  <Input aria-label="Sequence name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div>
                  <div className="text-[12px] font-medium mb-1">Description</div>
                  <textarea aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2" style={{ ["--tw-ring-color" as any]: `${accent}55` }} />
                </div>
                {/* The daily cap, from the legacy edit dialog (U14). The engine stops drafting from this sequence for the day once it is reached. */}
                <div>
                  <div className="text-[12px] font-medium mb-1">Daily send cap</div>
                  <Input aria-label="Daily send cap" type="number" min={1} max={10000} className="w-36" placeholder="No cap" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} />
                  <p className="text-[11px] text-muted-foreground mt-1">The most emails this sequence drafts in a day, across everyone in it. Leave it empty for no cap of its own; the workspace's daily limit still applies.</p>
                </div>
                <div className="flex items-center gap-2"><span className="text-[12px] text-muted-foreground">Status:</span> {statusBadge}</div>
                <div className="flex justify-end">
                  <Button size="sm" style={{ backgroundColor: accent }} disabled={updateMeta.isPending || !name.trim() || (dailyCap.trim() !== "" && !(Number(dailyCap) >= 1 && Number(dailyCap) <= 10000))} onClick={() => updateMeta.mutate({ id, patch: { name: name.trim(), description: description.trim() || null, dailyCap: dailyCap.trim() === "" ? null : Math.round(Number(dailyCap)) } })}>
                    {updateMeta.isPending ? "Saving…" : "Update settings"}
                  </Button>
                </div>
              </div>
              <div className="rounded-xl border bg-card shadow-sm p-4">
                <h2 className="text-sm font-semibold mb-2">Scheduling</h2>
                {/* The window the engine really uses (O39): this printed a fixed weekday 8-to-5 window whatever was set, and the default is 08:00–18:00. */}
                <p className="text-[12px] text-muted-foreground">{describeSendWindow(seq.settings)}</p>
                <p className="text-[12px] text-muted-foreground mt-1 mb-3">Sending also waits for the workspace send window in Settings.</p>
                {/* Its own zone and window, here as on the canvas (audit 2026-10-20, U15). */}
                <SequenceScheduleSettings sequenceId={id} settings={seq.settings} accent={accent} disabled={seq.status === "archived"} />
              </div>
              {/* Review or auto-send, and recipient time, for this sequence (F22, F18). */}
              <SequenceSendingSettings sequenceId={id} settings={seq.settings} accent={accent} />
              {/* Reply detection, from the legacy edit dialog and the canvas panel (U14). On unless switched off, as the engine reads it. */}
              <div className="rounded-xl border bg-card shadow-sm p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-sm font-semibold">Pause a person when they reply</h2>
                    <p className="text-[12px] text-muted-foreground mt-0.5">A reply stops their remaining steps until someone resumes them. Switched off, they keep getting steps after replying.</p>
                  </div>
                  <Switch
                    aria-label="Pause a person when they reply"
                    checked={(seq.settings as { replyDetection?: boolean } | null)?.replyDetection !== false}
                    disabled={saveReplyDetection.isPending || seq.status === "archived"}
                    onCheckedChange={(on) => saveReplyDetection.mutate({ id, settings: { replyDetection: on } })}
                  />
                </div>
              </div>
              {/* Delete, from legacy /sequences (U14), saying what stays (O22). */}
              <div className="rounded-xl border border-destructive/30 bg-card shadow-sm p-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">Delete this sequence</h2>
                  <p className="text-[12px] text-muted-foreground mt-0.5">Its steps, enrolments and unsent drafts go. Emails it already sent stay.</p>
                </div>
                <ConfirmButton
                  variant="outline"
                  className="h-8 text-destructive"
                  disabled={removeSeq.isPending}
                  title="Delete this sequence?"
                  description={`"${seq.name}" is deleted with its steps, its enrolments and any drafts not yet sent. Emails it already sent stay in the Emails log, and their unsubscribe links keep working. This cannot be undone.`}
                  confirmLabel="Delete"
                  onConfirm={() => removeSeq.mutate({ id })}
                >
                  <Trash2 className="size-3.5" /> Delete
                </ConfirmButton>
              </div>
            </div>
          )}
        </div>
      </div>
      <SequenceEnrollDialog sequenceId={id} open={enrollOpen} onClose={() => setEnrollOpen(false)} />
      <EmailClientPreview open={previewOpen} onClose={() => setPreviewOpen(false)} steps={steps} sequenceName={seq.name} />
    </Shell>
  );
}

/**
 * The Contacts tab: four counted states, then the people themselves.
 *
 * Every number here is counted off the rows listed below it, and an unknown
 * is never drawn as a zero — while the query is in flight or has failed, the
 * tiles read "—" and the error says so in words. That is the whole point of
 * the rewrite: the tab's previous zeros were not measurements.
 */
function ContactsTab({
  accent, query, sequenceId, steps, onAddContacts,
}: {
  accent: string;
  query: { data?: unknown; isError: boolean; error?: { message: string } | null };
  sequenceId: number;
  steps: Step[];
  onAddContacts: () => void;
}) {
  /**
    * `known === null` means NOT READ YET, and every number below asks it
    * first. It is keyed off the rows existing rather than off a loading flag:
    * the query is enabled only once this tab is opened, so on the first paint
    * `isLoading` is still false with no data in hand — which rendered four
    * zeros and "No contacts enrolled yet" for a frame before the fetch even
    * started. A zero that is true a moment later is still a zero that was
    * never measured.
    */
  const rows = Array.isArray(query.data) ? (query.data as any[]) : null;
  const known = query.isError ? null : rows;

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of known ?? []) c[String(r?.status)] = (c[String(r?.status)] ?? 0) + 1;
    return c;
  }, [known]);

  // Rows whose status is not one of the four. The mysqlEnum makes this
  // impossible today and the guard test pins the enum, but counting the
  // remainder means the tiles always sum to the list even if it stops being.
  const unrecognised = known
    ? known.length - ENROLLMENT_STATES.reduce((n, s) => n + (counts[s.key] ?? 0), 0)
    : 0;

  /**
   * "Enrolled" means active + paused + finished — the same definition
   * `liveEnrolledCounts` uses for the count on the Sequences list and in the
   * people picker, so this header cannot contradict them. An exited row was
   * taken out of the sequence and is reported in its own tile instead.
   */
  const enrolled = known
    ? (counts.active ?? 0) + (counts.paused ?? 0) + (counts.finished ?? 0)
    : null;

  const ordered = useMemo(() => {
    const rank = new Map(ENROLLMENT_STATES.map((s, i) => [s.key as string, i]));
    return [...(known ?? [])].sort((a, b) =>
      (rank.get(String(a?.status)) ?? 9) - (rank.get(String(b?.status)) ?? 9) || (a?.id ?? 0) - (b?.id ?? 0),
    );
  }, [known]);

  const atStep = useMemo(() => stepDistribution(known ?? [], steps.length), [known, steps.length]);

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[12px] font-medium px-2 py-1 rounded-md border bg-card inline-flex items-center gap-1.5">
          <Users className="size-3.5" style={{ color: accent }} />
          {enrolled === null ? "Enrollments" : `${enrolled} enrolled`}
        </span>
        {known === null && !query.isError && (
          <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
            <Loader2 className="size-3 animate-spin" /> Reading enrollments…
          </span>
        )}
      </div>

      {query.isError && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          These counts could not be read, so they are shown as unknown rather than zero.
          {query.error?.message ? ` ${query.error.message}` : ""}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {ENROLLMENT_STATES.map((s) => (
          <div key={s.key} className="rounded-lg border bg-card p-2.5 text-center shadow-sm">
            <div className="text-lg font-semibold tabular-nums" style={known ? { color: accent } : undefined}>
              {known ? (counts[s.key] ?? 0) : <span className="text-muted-foreground" title="Not read yet — not zero">—</span>}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>

      {unrecognised > 0 && (
        <div className="mb-3 text-[11px] text-muted-foreground">
          {unrecognised} enrollment{unrecognised === 1 ? "" : "s"} in a state this tab does not have a tile for — listed below.
        </div>
      )}

      {known && atStep.total > 0 && (
        <div className="mb-4 rounded-xl border bg-card p-3 shadow-sm space-y-1.5">
          <div className="text-[12px] font-medium">Where active and paused people are</div>
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-3 text-[12px]">
              <span className="w-32 shrink-0 truncate text-muted-foreground">{i + 1}. {stepMeta(s).label}</span>
              <div className="h-2 min-w-0 flex-1 rounded-full bg-muted">
                <div className="h-2 rounded-full" style={{ width: `${(atStep.perStep[i] / atStep.total) * 100}%`, backgroundColor: accent }} />
              </div>
              <span className="w-8 shrink-0 text-right tabular-nums">{atStep.perStep[i]}</span>
            </div>
          ))}
          {atStep.beyond > 0 && (
            <div className="text-[11px] text-muted-foreground">
              {atStep.beyond} {atStep.beyond === 1 ? "person is" : "people are"} on a step that has since been removed.
            </div>
          )}
        </div>
      )}

      {query.isError ? null : known === null ? (
        <div className="rounded-xl border bg-card shadow-sm divide-y divide-border/60">
          {[0, 1, 2].map((i) => (
            <div key={i} className="px-3 py-3"><div className="h-4 w-48 bg-muted/50 rounded animate-pulse" /></div>
          ))}
        </div>
      ) : ordered.length === 0 ? (
        <div className="rounded-xl border bg-card shadow-sm py-14 text-center">
          <Users className="size-8 text-muted-foreground opacity-40 mx-auto mb-2" />
          <div className="text-sm font-medium">No contacts enrolled yet</div>
          <p className="text-xs text-muted-foreground mt-1">Pick contacts, leads or prospects to enrol, or select people on the People page.</p>
          <Button size="sm" className="mt-3" style={{ backgroundColor: accent }} onClick={onAddContacts}>Add contacts</Button>
        </div>
      ) : (
        <ul className="rounded-xl border bg-card shadow-sm divide-y divide-border/60">
          {ordered.map((e) => {
            const state = ENROLLMENT_STATES.find((s) => s.key === e?.status);
            const name = e?.personName || `Enrollment #${e?.id}`;
            const href = e?.personId ? `/prospects/${e.personId}` : e?.leadHref ?? null;
            return (
              <li key={e?.id} className="flex items-center gap-2 px-3 py-2.5 text-[13px]">
                <span className="size-7 shrink-0 rounded-full flex items-center justify-center text-[10px] font-semibold" style={{ backgroundColor: `${accent}1f`, color: accent }}>
                  {(e?.personName ?? "?").trim().charAt(0).toUpperCase() || "?"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {href ? <Link href={href} className="hover:underline">{name}</Link> : <span>{name}</span>}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    Step {(e?.currentStep ?? 0) + 1}
                    {/* When the next step goes, in the zone it runs in (F18): the
                        person's own when the sequence sends in each person's time zone. */}
                    {e?.nextSendAt
                      ? ` · Next send ${formatInZone(e.nextSendAt, e.sendZone)}${e.sendZone ? ` (${e.sendZone}${e.zoneSource === "stored" ? ", their zone" : e.zoneSource === "location" ? ", from their location" : ""})` : ""}`
                      : e?.nextActionAt && ` · Next ${new Date(e.nextActionAt).toLocaleDateString()}`}
                    {/* A paused row with a resumeAt is an out-of-office snooze that
                        resumes itself, not a dead end — the rep needs to see that
                        before resuming it by hand on top of the sweep. */}
                    {e?.status === "paused" && e?.resumeAt && ` · Resumes ${new Date(e.resumeAt).toLocaleDateString()}`}
                  </div>
                </div>
                <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide", state?.pill ?? "bg-muted text-muted-foreground")}>
                  {state?.label ?? String(e?.status ?? "unknown")}
                </span>
                <SequenceMarkReply enrollment={e} sequenceId={sequenceId} />
                <SequenceEnrollmentActions enrollment={e} sequenceId={sequenceId} />
              </li>
            );
          })}
        </ul>
      )}

    </div>
  );
}

/** "Tue, Nov 10, 9:00 AM" in a zone, or in the viewer's own when none is given. */
function formatInZone(ms: number, zone?: string | null): string {
  try {
    return new Date(ms).toLocaleString(undefined, { timeZone: zone || undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function AddStepButton({ accent, open, setOpen, onAdd }: { accent: string; open: boolean; setOpen: (b: boolean) => void; onAdd: (make: () => Step) => void }) {
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" className="gap-1.5" style={{ backgroundColor: accent }}><Plus className="size-4" /> Add a step</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {STEP_OPTIONS.map((o) => {
          const Icon = o.icon;
          return <DropdownMenuItem key={o.key} onClick={() => onAdd(o.make)}><Icon className="size-4 mr-2" style={{ color: accent }} /> {o.label}</DropdownMenuItem>;
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The canvas's AI-writing choices (NodeEditPanel), carried into the editor with U14. */
const AI_TONES = ["professional", "friendly", "direct", "consultative", "casual"] as const;
const AI_LENGTHS = [
  { value: "short", label: "Short (1–2 sentences)" },
  { value: "medium", label: "Medium (3–5 sentences)" },
  { value: "long", label: "Long (a full paragraph)" },
] as const;

function StepEditor({ step, onChange, accent, blocked, onPickTemplate, onDetachTemplate, onCommit, enrolledCount, hasVariants }: {
  step: Step;
  onChange: (patch: Partial<Step>) => void;
  accent: string;
  blocked: string | null;
  onPickTemplate: (template: TemplateChoice) => void;
  onDetachTemplate: () => void;
  /** Saved at once, for controls that leave no field behind to blur. */
  onCommit: (patch: Partial<Step>) => void;
  enrolledCount: number;
  hasVariants: boolean;
}) {
  const ta = "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2";
  const ring = { ["--tw-ring-color" as any]: `${accent}55` } as React.CSSProperties;
  if (step.type === "email") {
    /**
     * Who writes the email (U14): the canvas's "AI-dynamic" mode, which the
     * engine honours (generateDynamicEmail) and which this editor could not
     * show, so a step saved that way looked like an empty email here. AI writes
     * per person at send time, so switching to it spends; it says how much and
     * asks first.
     */
    const ai = step.emailMode === "dynamic";
    const modeBtn = (on: boolean) => cn("h-7 rounded-md px-2.5 text-[12px] font-medium border", on ? "text-white" : "bg-card text-muted-foreground hover:text-foreground");
    return (
      <>
        <div role="radiogroup" aria-label="Who writes this email" className="flex flex-wrap items-center gap-1.5">
          <button type="button" role="radio" aria-checked={!ai} disabled={!!blocked} className={modeBtn(!ai)} style={!ai ? { backgroundColor: accent, borderColor: accent } : undefined}
            onClick={() => { if (ai) onCommit({ emailMode: "typed" } as Partial<Step>); }}>
            Written here
          </button>
          {ai ? (
            <button type="button" role="radio" aria-checked className={modeBtn(true)} style={{ backgroundColor: accent, borderColor: accent }}>
              <Sparkles className="size-3 inline mr-1" />AI writes it
            </button>
          ) : (
            <ConfirmButton
              variant="outline"
              destructive={false}
              disabled={!!blocked}
              className={modeBtn(false)}
              title="Have AI write this email for each person?"
              description={`When this step runs, AI writes a subject and body for each person who reaches it: one AI call each, up to about 700 tokens, charged to the workspace's AI provider and counted in Settings → Billing. ${enrolledCount} ${enrolledCount === 1 ? "person is" : "people are"} enrolled now. The drafts still wait for review unless auto-send sends them, and nothing goes out while outbound sending is paused.${hasVariants ? " This step has A/B variants, which are sent instead, so AI would write nothing until they are removed." : ""}`}
              confirmLabel="Use AI"
              onConfirm={() => onCommit({ emailMode: "dynamic", aiTone: step.aiTone ?? "professional", aiLength: step.aiLength ?? "medium" } as Partial<Step>)}
            >
              <Sparkles className="size-3 mr-1" />AI writes it
            </ConfirmButton>
          )}
          {blocked && <span className="text-[11px] text-muted-foreground">{blocked}</span>}
        </div>
        {ai ? (
          <div className="space-y-2 rounded-md border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900/50 dark:bg-blue-950/30">
            <p className="text-[12px] text-blue-900 dark:text-blue-200">
              AI writes the subject and body for each person when this step runs, using what Velocity knows about them. One AI call per person.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[12px] font-medium space-y-1 block">
                <span>Tone</span>
                <select aria-label="AI tone" className="h-8 w-full rounded-md border bg-background px-2 text-[13px] capitalize" disabled={!!blocked}
                  value={step.aiTone ?? "professional"} onChange={(e) => onCommit({ aiTone: e.target.value } as Partial<Step>)}>
                  {AI_TONES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="text-[12px] font-medium space-y-1 block">
                <span>Length</span>
                <select aria-label="AI length" className="h-8 w-full rounded-md border bg-background px-2 text-[13px]" disabled={!!blocked}
                  value={step.aiLength ?? "medium"} onChange={(e) => onCommit({ aiLength: e.target.value } as Partial<Step>)}>
                  {AI_LENGTHS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            </div>
            <label className="text-[12px] font-medium space-y-1 block">
              <span>What the email is for</span>
              <Input aria-label="What the AI email is for" maxLength={500} value={step.aiFocus ?? ""} placeholder="e.g. book a 15-minute call about their RevOps stack"
                onChange={(e) => onChange({ aiFocus: e.target.value } as Partial<Step>)} />
            </label>
            {/* The engine skips a dynamic step with no goal rather than mail emptiness. */}
            {!(step.aiFocus ?? "").trim() && <p className="text-[11px] text-rose-600">Without this the step is skipped: AI has nothing to write from.</p>}
          </div>
        ) : (
          <>
            <StepTemplatePicker step={step} blocked={blocked} onPick={onPickTemplate} />
            <Input aria-label="Subject" value={step.subject} placeholder="Subject line" onChange={(e) => onChange({ subject: e.target.value } as any)} />
            {step.templateId ? (
              /* The rich-text editor can't hold Email Builder HTML faithfully, and
                 its first keystroke would save its own version over the copy. So a
                 step from a template shows the copy that will send, and editing it
                 here is a choice. */
              <>
                <div
                  className="border rounded-md bg-white text-[#202124] p-3 text-sm max-h-[300px] overflow-y-auto [&_a]:text-blue-600 [&_a]:underline [&_p]:my-2 break-words [&_table]:max-w-full [&_td]:break-words [&_img]:max-w-full [&_img]:h-auto"
                  dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(step.body ?? "") }}
                />
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="min-w-0 flex-1">This is the copy that sends. Later changes to the template don't reach it; pick the template again to refresh it.</span>
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!!blocked} onClick={onDetachTemplate}>Edit the text here</Button>
                </div>
              </>
            ) : (
              <RichTextEditor
                value={step.body ?? ""}
                placeholder="Write your email… Use {{first_name}} for personalization."
                minHeight="140px"
                compact
                aiContext={{ subject: step.subject }}
                onChange={(html) => onChange({ body: html } as any)}
              />
            )}
          </>
        )}
      </>
    );
  }
  if (step.type === "wait") {
    // Days and hours (U14): the canvas could save a wait in hours, which is a
    // fractional `days`, and one whole-number box could neither show nor keep it.
    const parts = waitParts(step.days);
    return (
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span>Wait</span>
        <Input aria-label="Wait days" type="number" min={0} max={MAX_WAIT_DAYS} value={parts.days} className="w-20 h-8"
          onChange={(e) => onChange({ days: waitDaysFrom(Number(e.target.value), parts.hours) } as any)} />
        <span>day(s) and</span>
        <Input aria-label="Wait hours" type="number" min={0} max={23} value={parts.hours} className="w-20 h-8"
          onChange={(e) => onChange({ days: waitDaysFrom(parts.days, Number(e.target.value)) } as any)} />
        <span>hour(s) before the next step, up to {MAX_WAIT_DAYS} days.</span>
      </div>
    );
  }
  if (step.type === "task") {
    // The legacy editor wrote task text as rich text; that keeps its editor here
    // rather than showing its markup in a plain box (U14).
    return isHtmlBody(step.body ?? "")
      ? <RichTextEditor value={step.body ?? ""} placeholder="What should the rep do?" minHeight="80px" compact onChange={(html) => onChange({ body: html } as any)} />
      : <textarea aria-label="Task instructions" value={step.body} placeholder="What should the rep do? (e.g. Call and reference their recent funding)" rows={3} className={ta} style={ring} onChange={(e) => onChange({ body: e.target.value } as any)} />;
  }
  if (step.type === "linkedin_invite") {
    return <textarea aria-label="Connection request note" value={step.note ?? ""} placeholder="Connection request note (optional, 300 char max)" rows={3} maxLength={300} className={ta} style={ring} onChange={(e) => onChange({ note: e.target.value } as any)} />;
  }
  return <textarea aria-label="LinkedIn message" value={step.body ?? ""} placeholder="LinkedIn message…" rows={4} className={ta} style={ring} onChange={(e) => onChange({ body: e.target.value } as any)} />;
}
