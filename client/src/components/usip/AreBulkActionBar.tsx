/**
 * AreBulkActionBar — mass actions on a campaign's prospects, one bar for every
 * tab that lists them (Prospects, Sequences, Rejections, Signals).
 *
 * The bar is dumb on purpose: it owns selection UI, confirmation and the few
 * parameter prompts, and calls ONE procedure (`are.prospects.bulk`) which runs
 * the existing single-row procedures per id and logs the run on the campaign
 * and in the audit log. Which actions a tab offers is the tab's call
 * (`actions` prop); what an action does is the server's.
 *
 * Owner ask 2026-08-19: "select many or all prospects and different buttons
 * for all useful actions … track and save automatically within the campaign
 * and for all relevant info site-wide."
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, X } from "lucide-react";

export type BulkActionKey =
  | "approve" | "reject" | "skip" | "restore" | "reEvaluate" | "enrich" | "generateSequence"
  | "pauseSequence" | "resumeSequence" | "cancelSequence" | "editTimeline" | "activateSequence"
  | "addToList" | "createTasks" | "suppress" | "linkToPeople";

/** What a tab offers. `params` opens a small dialog; `confirm` an alert. */
export interface BulkActionDef {
  key: BulkActionKey;
  label: string;
  icon?: ReactNode;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  confirm?: { title: string; body: string; cta?: string };
  params?: "reason" | "list" | "task" | "suppress" | "regenerate" | "timeline";
  /** Quick-pick chips for the reason prompt. */
  presets?: string[];
  title?: string;
}

/** What the timeline editor needs to know about the current selection —
 *  supplied by the tab (it has the rows and the campaign; the bar stays dumb). */
export interface TimelineInfo {
  /** Longest generated sequence among the selected rows (≥ 1). */
  stepCount: number;
  /** The campaign's stepGapDays — the grid a cleared override falls back to. */
  campaignGapDays: number;
  /** Selected rows that have no generated sequence yet (the timeline still
   *  saves for them and applies once a sequence is generated + enrolled). */
  withoutSequence: number;
  /** When every selected row stores the SAME override, it prefills the editor. */
  commonOffsets: number[] | null;
}

/** What the bar needs from a selection — useRowSelection returns a superset,
 *  and a tab with its own selection state can pass the same three fields. */
export interface BulkSelection { selected: Set<number>; count: number; clear: () => void }

/** Selection over the rows a tab currently shows. Select-all means all of
 *  them (the tab's own filter/search is the scope the user is looking at). */
export function useRowSelection(ids: number[]) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const idSet = useMemo(() => new Set(ids), [ids]);
  // Rows that fell out of the list (filter changed, row moved) leave the selection.
  const live = useMemo(() => new Set(Array.from(selected).filter((id) => idSet.has(id))), [selected, idSet]);
  const allSelected = ids.length > 0 && live.size === ids.length;
  return {
    selected: live,
    count: live.size,
    allSelected,
    isSelected: (id: number) => live.has(id),
    toggle: (id: number) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    toggleAll: () => setSelected(allSelected ? new Set() : new Set(ids)),
    clear: () => setSelected(new Set()),
  };
}

/**
 * Live preview of the timeline being edited: one chip per step with its day
 * offset and the calendar date it would land on for a prospect enrolled today
 * (existing prospects anchor to their own first send, so their dates shift by
 * the same rhythm from a different day — the RELATIVE spacing is what this
 * shows truthfully for everyone).
 */
function TimelinePreview({ offsets }: { offsets: number[] }) {
  if (offsets.length === 0) return null;
  const today = Date.now();
  const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const last = offsets[offsets.length - 1];
  return (
    <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2">
      <div className="mb-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-medium text-foreground/80">Preview</span>
        <span>spans {last} day{last === 1 ? "" : "s"}{last >= 7 ? ` (~${Math.round(last / 7)} week${Math.round(last / 7) === 1 ? "" : "s"})` : ""}</span>
        <span className="ml-auto">dates shown for an enrolment today</span>
      </div>
      <ol className="flex flex-wrap items-stretch gap-1">
        {offsets.map((day, i) => (
          <li key={i} className="flex min-w-0 flex-1 basis-[92px] flex-col gap-0.5 rounded border border-border bg-card px-1.5 py-1">
            <span className="text-[10px] font-medium">Step {i + 1}</span>
            <span className="text-[10px] text-muted-foreground tabular-nums">day {day} · {fmt(today + day * 86_400_000)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function AreBulkActionBar({ campaignId, selection, actions, onDone, timeline }: {
  campaignId: number;
  selection: BulkSelection;
  actions: BulkActionDef[];
  /** Called after any successful run (the bar already invalidates the ARE queries). */
  onDone?: () => void;
  /** Required by tabs that offer the `editTimeline` action. */
  timeline?: TimelineInfo;
}) {
  const utils = trpc.useUtils();
  const [pending, setPending] = useState<BulkActionDef | null>(null);
  // param state
  const [reason, setReason] = useState("");
  const [listId, setListId] = useState<number | null>(null);
  const [newListName, setNewListName] = useState("");
  const [taskTitle, setTaskTitle] = useState("Follow up");
  const [taskType, setTaskType] = useState<"follow_up" | "call" | "manual_email" | "social_touch" | "meeting_prep" | "todo">("follow_up");
  const [taskPriority, setTaskPriority] = useState<"low" | "normal" | "high" | "urgent">("normal");
  const [dueInDays, setDueInDays] = useState(2);
  const [suppressionReason, setSuppressionReason] = useState<"do_not_contact" | "unsubscribe" | "competitor" | "existing_customer" | "manual">("do_not_contact");
  const [force, setForce] = useState(false);
  // timeline editor state — waits[0] is the delay before step 1, waits[k] the
  // gap after the previous step; cumulative sums are the stored day offsets.
  const [tlMode, setTlMode] = useState<"campaign" | "uniform" | "custom">("uniform");
  const [tlGap, setTlGap] = useState(7);
  const [tlStart, setTlStart] = useState(0);
  const [tlWaits, setTlWaits] = useState<number[]>([]);

  const lists = trpc.recordLists.list.useQuery(undefined, { enabled: pending?.params === "list" });

  const refreshAll = () => {
    utils.are.prospects.list.invalidate();
    utils.are.prospects.listSequences.invalidate();
    utils.are.prospects.getRejectionStats.invalidate();
    utils.are.execution.getQueue.invalidate();
    utils.are.execution.getStepStates.invalidate();
    utils.are.execution.getSignalLog.invalidate();
    utils.are.engine.getLogs.invalidate();
    utils.are.campaigns.get.invalidate({ id: campaignId });
    utils.recordLists.list.invalidate();
  };
  // A background run (LLM-backed actions above a small batch) finishes rows
  // one by one after the call returns; keep the tab fresh for a few minutes.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollUntil = useRef(0);
  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current); }, []);
  const startBackgroundPolling = () => {
    pollUntil.current = Date.now() + 5 * 60_000;
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(() => {
      refreshAll();
      if (Date.now() > pollUntil.current && pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    }, 10_000);
  };

  const bulk = trpc.are.prospects.bulk.useMutation({
    onSuccess: (r) => {
      const background = /in the background/.test(r.summary);
      if (r.failed.length === 0) toast.success(r.summary, background ? { duration: 8000 } : undefined);
      else toast.warning(`${r.summary} — ${r.failed.slice(0, 3).map((f) => `#${f.id}: ${f.error}`).join("; ")}${r.failed.length > 3 ? "…" : ""}`, { duration: 9000 });
      refreshAll();
      if (background) startBackgroundPolling();
      selection.clear();
      setPending(null);
      onDone?.();
    },
    onError: (e) => toast.error(e.message),
  });

  // The timeline the editor currently describes, as cumulative day offsets.
  const tlStepCount = Math.min(20, Math.max(1, timeline?.stepCount ?? 7));
  const tlCampaignGap = timeline?.campaignGapDays ?? 7;
  const tlOffsets = useMemo(() => {
    if (tlMode === "uniform") return Array.from({ length: tlStepCount }, (_, i) => tlStart + i * tlGap);
    if (tlMode === "custom") {
      let acc = 0;
      return Array.from({ length: tlStepCount }, (_, i) => (acc += tlWaits[i] ?? tlCampaignGap));
    }
    // campaign mode — preview only; the mutation sends clearTimeline instead.
    return Array.from({ length: tlStepCount }, (_, i) => i * tlCampaignGap);
  }, [tlMode, tlStepCount, tlStart, tlGap, tlWaits, tlCampaignGap]);
  const tlLastDay = tlOffsets[tlOffsets.length - 1] ?? 0;
  const tlTooLong = tlLastDay > 365;

  const run = (a: BulkActionDef) => {
    const prospectIds = Array.from(selection.selected);
    const base = { campaignId, prospectIds, action: a.key } as const;
    switch (a.params) {
      case "reason": return bulk.mutate({ ...base, reason: reason.trim() || undefined });
      case "list": return bulk.mutate({ ...base, ...(listId ? { listId } : { newListName: newListName.trim() }) });
      case "task": return bulk.mutate({ ...base, taskTitle: taskTitle.trim(), taskType, taskPriority, dueInDays });
      case "suppress": return bulk.mutate({ ...base, suppressionReason, reason: reason.trim() || undefined });
      case "regenerate": return bulk.mutate({ ...base, force });
      case "timeline": return bulk.mutate({ ...base, ...(tlMode === "campaign" ? { clearTimeline: true } : { dayOffsets: tlOffsets }) });
      default: return bulk.mutate(base);
    }
  };

  const open = (a: BulkActionDef) => {
    setReason(""); setForce(false);
    if (a.params === "timeline") {
      // Prefill from what the selection already stores: a shared override
      // opens in custom mode showing THAT timeline, otherwise the campaign
      // gap seeds a uniform edit.
      const common = timeline?.commonOffsets ?? null;
      if (common && common.length > 0) {
        setTlMode("custom");
        setTlWaits(Array.from({ length: tlStepCount }, (_, i) => {
          if (i === 0) return Math.max(0, common[0] ?? 0);
          if (i < common.length) return Math.max(0, (common[i] ?? 0) - (common[i - 1] ?? 0));
          return tlCampaignGap;
        }));
      } else {
        setTlMode("uniform");
        setTlWaits(Array.from({ length: tlStepCount }, (_, i) => (i === 0 ? 0 : tlCampaignGap)));
      }
      setTlGap(tlCampaignGap);
      setTlStart(0);
    }
    if (a.params || a.confirm) setPending(a);
    else run(a);
  };

  if (selection.count === 0) return null;
  const n = selection.count;

  return (
    <>
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
        <span className="text-xs font-medium text-primary tabular-nums">{n} selected</span>
        <span className="mx-1 h-4 w-px bg-border" />
        {actions.map((a) => (
          <Button key={a.key} size="sm" variant={a.variant ?? "outline"} className="h-7 text-[11px] gap-1"
            title={a.title} disabled={bulk.isPending}
            onClick={() => open(a)}>
            {bulk.isPending && pending?.key === a.key ? <Loader2 className="size-3 animate-spin" /> : a.icon}
            {a.label}
          </Button>
        ))}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" className="h-7 text-[11px]" onClick={selection.clear}><X className="size-3" /> Clear</Button>
      </div>

      {/* Confirm-only actions */}
      <AlertDialog open={!!pending && !!pending.confirm && !pending.params} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.confirm?.body.replace("{n}", String(n))}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction onClick={() => pending && run(pending)} className={pending?.variant === "destructive" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}>
              {pending?.confirm?.cta ?? pending?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Parameter actions */}
      <Dialog open={!!pending && !!pending.params} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent className={pending?.params === "timeline" ? "sm:max-w-xl" : "sm:max-w-md"}>
          <DialogHeader>
            <DialogTitle>{pending?.label} — {n} prospect{n === 1 ? "" : "s"}</DialogTitle>
          </DialogHeader>
          {pending?.confirm && <p className="text-xs text-muted-foreground -mt-1">{pending.confirm.body.replace("{n}", String(n))}</p>}
          <div className="space-y-3 py-1">
            {pending?.params === "reason" && (
              <div className="space-y-1.5">
                <Label className="text-xs">Reason (optional — recorded on each prospect)</Label>
                {pending.presets && pending.presets.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {pending.presets.map((t) => (
                      <button key={t} type="button" onClick={() => setReason(t)}
                        className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${reason === t ? "border-primary/50 bg-primary/10 text-primary font-medium" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                        {t}
                      </button>
                    ))}
                  </div>
                )}
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="text-sm" placeholder="Or type a custom reason…" />
              </div>
            )}
            {pending?.params === "list" && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Existing list</Label>
                  <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
                    value={listId ?? ""} onChange={(e) => { setListId(e.target.value ? Number(e.target.value) : null); if (e.target.value) setNewListName(""); }}>
                    <option value="">— create a new list —</option>
                    {((lists.data ?? []) as Array<{ id: number; name: string; entityType?: string }>).filter((l) => !l.entityType || l.entityType === "people").map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                </div>
                {!listId && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">New list name</Label>
                    <Input value={newListName} onChange={(e) => setNewListName(e.target.value)} placeholder="e.g. CF — higher-ed CFOs, warm" className="h-8 text-sm" />
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">Prospects not yet on People are linked there first, so the list is visible site-wide.</p>
              </>
            )}
            {pending?.params === "task" && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Title</Label>
                  <Input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} className="h-8 text-sm" />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Type</Label>
                    <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={taskType} onChange={(e) => setTaskType(e.target.value as typeof taskType)}>
                      {(["follow_up", "call", "manual_email", "social_touch", "meeting_prep", "todo"] as const).map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Priority</Label>
                    <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={taskPriority} onChange={(e) => setTaskPriority(e.target.value as typeof taskPriority)}>
                      {(["low", "normal", "high", "urgent"] as const).map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Due in (days)</Label>
                    <Input type="number" min={0} max={60} value={dueInDays} onChange={(e) => setDueInDays(Math.max(0, Math.min(60, Number(e.target.value) || 0)))} className="h-8 text-sm" />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">One task per person, on their People record — shows in Tasks and on the person.</p>
              </>
            )}
            {pending?.params === "suppress" && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Why</Label>
                  <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={suppressionReason} onChange={(e) => setSuppressionReason(e.target.value as typeof suppressionReason)}>
                    <option value="do_not_contact">Do not contact</option>
                    <option value="unsubscribe">Unsubscribed</option>
                    <option value="competitor">Competitor</option>
                    <option value="existing_customer">Existing customer</option>
                    <option value="manual">Other</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Note (optional)</Label>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} className="h-8 text-sm" />
                </div>
                <p className="text-[11px] text-amber-600">Adds each email to the ARE suppression list AND the site-wide email suppressions, and cancels anything scheduled for them in this campaign. No sender in Velocity will email them again.</p>
              </>
            )}
            {pending?.params === "regenerate" && (
              <label className="flex items-center gap-2 text-xs">
                <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
                Regenerate even where a sequence already exists (replaces it; sent steps are kept)
              </label>
            )}
            {pending?.params === "timeline" && (
              <>
                {/* Mode picker */}
                <div className="flex flex-wrap gap-1.5">
                  {([
                    { k: "campaign", label: `Campaign cadence (every ${tlCampaignGap}d)` },
                    { k: "uniform", label: "Same gap between steps" },
                    { k: "custom", label: "Custom per step" },
                  ] as const).map((m) => (
                    <button key={m.k} type="button" onClick={() => setTlMode(m.k)}
                      className={`text-[11px] px-2 py-1 rounded-full border transition-all ${tlMode === m.k ? "border-primary/50 bg-primary/10 text-primary font-medium" : "border-border text-muted-foreground hover:border-primary/30"}`}>
                      {m.label}
                    </button>
                  ))}
                </div>

                {tlMode === "campaign" && (
                  <p className="text-[11px] text-muted-foreground">
                    Removes any custom timing from the selected prospects — their steps follow the
                    campaign's step cadence again (changeable on the Settings tab).
                  </p>
                )}
                {tlMode === "uniform" && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Start delay (days before step 1)</Label>
                      <Input type="number" min={0} max={60} value={tlStart}
                        onChange={(e) => setTlStart(Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))))}
                        className="h-8 text-sm" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">Days between steps</Label>
                      <Input type="number" min={1} max={30} value={tlGap}
                        onChange={(e) => setTlGap(Math.max(1, Math.min(30, Math.round(Number(e.target.value) || 1))))}
                        className="h-8 text-sm" />
                    </div>
                  </div>
                )}
                {tlMode === "custom" && (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3">
                    {Array.from({ length: tlStepCount }, (_, i) => (
                      <label key={i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="w-11 shrink-0 font-medium text-foreground/80">Step {i + 1}</span>
                        <span className="shrink-0">{i === 0 ? "after" : "+"}</span>
                        <Input type="number" min={0} max={60} value={tlWaits[i] ?? tlCampaignGap}
                          onChange={(e) => {
                            const v = Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0)));
                            setTlWaits((prev) => Array.from({ length: tlStepCount }, (_, k) => (k === i ? v : prev[k] ?? tlCampaignGap)));
                          }}
                          className="h-7 w-14 text-xs" />
                        <span className="shrink-0">d</span>
                      </label>
                    ))}
                  </div>
                )}

                <TimelinePreview offsets={tlOffsets} />
                {tlTooLong && (
                  <p className="text-[11px] text-destructive">The last step lands more than a year out — shorten the gaps.</p>
                )}
                {(timeline?.withoutSequence ?? 0) > 0 && (
                  <p className="text-[11px] text-amber-600">
                    {timeline!.withoutSequence} of the selected prospect{timeline!.withoutSequence === 1 ? " has" : "s have"} no
                    generated sequence yet — the timing still saves and applies once their sequence is generated.
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Saved on each selected prospect: steps that are scheduled but unsent move immediately, sent steps never
                  move, and enrolment schedules new steps on this timing. Days count from each prospect's first send (or
                  their enrolment, if nothing has gone yet).
                </p>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>Cancel</Button>
            <Button size="sm" variant={pending?.variant === "destructive" ? "destructive" : "default"} disabled={bulk.isPending || (pending?.params === "list" && !listId && !newListName.trim()) || (pending?.params === "task" && !taskTitle.trim()) || (pending?.params === "timeline" && tlMode !== "campaign" && tlTooLong)}
              onClick={() => pending && run(pending)}>
              {bulk.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} {pending?.confirm?.cta ?? pending?.label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
