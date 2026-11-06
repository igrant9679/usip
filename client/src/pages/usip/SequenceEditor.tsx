/**
 * SequenceEditor — the sequence builder (/v2/sequences/:id).
 *
 * Apollo's sequence editor: header (name + Share / Add contacts / Activate
 * or Pause), tabs (Editor / Contacts / Activity / Report / Settings). The
 * Editor tab is the step builder — an ordered list of steps with an "Add a
 * step" picker (Email / Phone call / Action item / LinkedIn / Wait) and inline
 * editors per step. Steps persist via sequences.updateSteps; name and
 * description via sequences.update; status via sequences.setStatus.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
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
  PauseCircle, PlayCircle,
  Loader2, Users, Activity as ActivityIcon, Settings2, X,
} from "lucide-react";
import { pressable } from "@/lib/pressable";
import { tablistProps, tabProps } from "@/lib/tabs";
import { sanitizeEmailHtml } from "@/lib/sanitizeHtml";
import { applyTemplate, describeSendWindow, detachTemplate, stepDistribution, type EmailStep, type TemplateChoice } from "@/lib/sequenceSteps";
import { SequenceEnrollmentActions } from "@/components/usip/SequenceEnrollmentActions";
import { SequenceDraftsNote } from "@/components/usip/SequenceDraftsNote";
import { ConfirmButton } from "@/components/usip/Common";
import { useAuth } from "@/_core/hooks/useAuth";
import { SequenceReport } from "@/components/usip/SequenceReport";
import { StepTemplatePicker } from "@/components/usip/StepTemplatePicker";

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

const TABS = ["Editor", "Contacts", "Activity", "Report", "Settings"] as const;
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
    onSuccess: () => { utils.sequences.get.invalidate({ id }); utils.sequences.list.invalidate(); },
    onError: (e) => {
      toast.error(e.message);
      void seqQ.refetch().then((r) => { if (r.data) setSteps(Array.isArray((r.data as any).steps) ? (r.data as any).steps : []); });
    },
  });
  // Activate and Pause on this page (O38): Activate used to take you to the
  // legacy list to find the real button.
  const setStatus = trpc.sequences.setStatus.useMutation({
    onSuccess: (_d, v) => {
      utils.sequences.get.invalidate({ id });
      utils.sequences.list.invalidate();
      toast.success(v.status === "active" ? "Sequence activated" : "Sequence paused");
    },
    onError: (e) => toast.error(e.message),
  });
  const { user } = useAuth();
  const updateMeta = trpc.sequences.update.useMutation({ onSuccess: () => { utils.sequences.get.invalidate({ id }); utils.sequences.list.invalidate(); }, onError: (e) => toast.error(e.message) });

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

  useEffect(() => {
    if (seq) {
      setSteps(Array.isArray(seq.steps) ? seq.steps : []);
      setName(seq.name ?? "");
      setDescription(seq.description ?? "");
    }
  }, [seq?.id]);

  const commit = (next: Step[]) => { setSteps(next); updateSteps.mutate({ id, steps: next as any }); };
  const addStep = (make: () => Step) => { const next = [...steps, make()]; setSteps(next); updateSteps.mutate({ id, steps: next as any }); setExpanded(next.length - 1); setAddOpen(false); };
  const removeStep = (i: number) => { const next = steps.filter((_, idx) => idx !== i); commit(next); if (expanded === i) setExpanded(null); };
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
  const moveStep = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= steps.length) return; const next = [...steps]; [next[i], next[j]] = [next[j], next[i]]; commit(next); };
  const patchStep = (i: number, patch: Partial<Step>) => { setSteps((prev) => prev.map((s, idx) => (idx === i ? ({ ...s, ...patch } as Step) : s))); };
  const commitEdits = () => updateSteps.mutate({ id, steps: steps as any });
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
            <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => setLocation("/v2/people")}><Users className="size-3.5" /> Add contacts</Button>
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
            ) : null}
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
          {/* EDITOR */}
          {tab === "Editor" && (
            <div className="max-w-2xl mx-auto p-4 md:p-6">
              <SequenceDraftsNote className="mb-3" />
              <div className="flex items-center gap-2 mb-4">
                <span className="text-[12px] font-medium px-2 py-1 rounded-md border bg-card inline-flex items-center gap-1.5"><Send className="size-3.5" style={{ color: accent }} /> {steps.length} step{steps.length === 1 ? "" : "s"}</span>
                {updateSteps.isPending && <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Loader2 className="size-3 animate-spin" /> Saving…</span>}
              </div>

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
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="pt-1"><AddStepButton accent={accent} open={addOpen} setOpen={setAddOpen} onAdd={addStep} /></div>
                </div>
              )}
            </div>
          )}

          {/* CONTACTS */}
          {tab === "Contacts" && (
            <ContactsTab
              accent={accent}
              query={enrollmentsQ}
              sequenceId={id}
              steps={steps}
              onAddContacts={() => setLocation("/v2/people")}
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
                <div className="flex items-center gap-2"><span className="text-[12px] text-muted-foreground">Status:</span> {statusBadge}</div>
                <div className="flex justify-end">
                  <Button size="sm" style={{ backgroundColor: accent }} disabled={updateMeta.isPending || !name.trim()} onClick={() => updateMeta.mutate({ id, patch: { name: name.trim(), description: description.trim() || null } })}>
                    {updateMeta.isPending ? "Saving…" : "Update settings"}
                  </Button>
                </div>
              </div>
              <div className="rounded-xl border bg-card shadow-sm p-4">
                <h2 className="text-sm font-semibold mb-2">Scheduling</h2>
                {/* The window the engine really uses (O39): this printed a fixed weekday 8-to-5 window whatever was set, and the default is 08:00–18:00. */}
                <p className="text-[12px] text-muted-foreground">{describeSendWindow(seq.settings)}</p>
                <p className="text-[12px] text-muted-foreground mt-1">Sending also waits for the workspace send window in Settings. Change this sequence's window from its canvas, under Sequence settings.</p>
              </div>
            </div>
          )}
        </div>
      </div>
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
          <p className="text-xs text-muted-foreground mt-1">Add people from the People page or a list to start this sequence.</p>
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
                    {e?.nextActionAt && ` · Next ${new Date(e.nextActionAt).toLocaleDateString()}`}
                    {/* A paused row with a resumeAt is an out-of-office snooze that
                        resumes itself, not a dead end — the rep needs to see that
                        before resuming it by hand on top of the sweep. */}
                    {e?.status === "paused" && e?.resumeAt && ` · Resumes ${new Date(e.resumeAt).toLocaleDateString()}`}
                  </div>
                </div>
                <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide", state?.pill ?? "bg-muted text-muted-foreground")}>
                  {state?.label ?? String(e?.status ?? "unknown")}
                </span>
                <SequenceEnrollmentActions enrollment={e} sequenceId={sequenceId} />
              </li>
            );
          })}
        </ul>
      )}

      {/* The bulk enrol picker lives on legacy /sequences and is not here yet; the gap is recorded in HANDOFF.md. */}
    </div>
  );
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

function StepEditor({ step, onChange, accent, blocked, onPickTemplate, onDetachTemplate }: {
  step: Step;
  onChange: (patch: Partial<Step>) => void;
  accent: string;
  blocked: string | null;
  onPickTemplate: (template: TemplateChoice) => void;
  onDetachTemplate: () => void;
}) {
  const ta = "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2";
  const ring = { ["--tw-ring-color" as any]: `${accent}55` } as React.CSSProperties;
  if (step.type === "email") {
    return (
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
    );
  }
  if (step.type === "wait") {
    return (
      <label className="flex items-center gap-2 text-[13px]">Wait
        <Input type="number" min={0} max={60} value={step.days} className="w-20 h-8" onChange={(e) => onChange({ days: Math.max(0, Math.min(60, Number(e.target.value) || 0)) } as any)} /> day(s) before the next step.
      </label>
    );
  }
  if (step.type === "task") {
    return <textarea aria-label="Task instructions" value={step.body} placeholder="What should the rep do? (e.g. Call and reference their recent funding)" rows={3} className={ta} style={ring} onChange={(e) => onChange({ body: e.target.value } as any)} />;
  }
  if (step.type === "linkedin_invite") {
    return <textarea aria-label="Connection request note" value={step.note ?? ""} placeholder="Connection request note (optional, 300 char max)" rows={3} maxLength={300} className={ta} style={ring} onChange={(e) => onChange({ note: e.target.value } as any)} />;
  }
  return <textarea aria-label="LinkedIn message" value={step.body ?? ""} placeholder="LinkedIn message…" rows={4} className={ta} style={ring} onChange={(e) => onChange({ body: e.target.value } as any)} />;
}
