/**
 * Tour Builder — admin page for creating and editing guided tours
 *
 * Two authoring modes:
 *  1. Record Mode — click through the app while the recorder captures element selectors
 *  2. Manual Mode — add steps manually with selector/data-tour-id, title, body, treatment
 *
 * Also shows the tour list with publish/unpublish/delete controls.
 */

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Edit,
  GraduationCap,
  Loader2,
  Plus,
  Radio,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { confirmAction } from "@/components/usip/Common";
import {
  clearSteps as clearRecorderSteps,
  getSteps as getRecorderSteps,
  isRecording as recorderIsRecording,
  onRecorderUpdate,
  startRecording,
  stopRecording,
  type RecordedStep,
} from "@/lib/tourRecorder";

/* ─── Record Mode ────────────────────────────────────────────────────────── */

function RecorderPanel() {
  const [recording, setRecording] = useState(recorderIsRecording());
  const [steps, setSteps] = useState<RecordedStep[]>(getRecorderSteps());

  useEffect(() => {
    return onRecorderUpdate(() => {
      setRecording(recorderIsRecording());
      setSteps(getRecorderSteps());
    });
  }, []);

  const json = JSON.stringify(steps, null, 2);

  return (
    <div
      data-tour-recorder-ui
      className="mt-8 rounded-xl border border-violet-100 dark:border-violet-900 bg-violet-50 dark:bg-violet-950/30 p-4"
    >
      <div className="flex items-start gap-3">
        <Radio className={`h-5 w-5 flex-shrink-0 mt-0.5 ${recording ? "text-red-500 animate-pulse" : "text-violet-600 dark:text-violet-300"}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-sm font-semibold text-violet-800 dark:text-violet-200">
              Record Mode {recording && <span className="text-red-500">· recording ({steps.length})</span>}
            </p>
            <div className="flex items-center gap-2">
              {!recording ? (
                <Button size="sm" onClick={() => startRecording()} className="gap-1.5">
                  <Radio className="h-3.5 w-3.5" /> Start recording
                </Button>
              ) : (
                <Button size="sm" variant="destructive" onClick={() => stopRecording()} className="gap-1.5">
                  <Square className="h-3.5 w-3.5" /> Stop
                </Button>
              )}
              {steps.length > 0 && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => {
                      navigator.clipboard?.writeText(json);
                      toast.success("Step JSON copied");
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy JSON
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => clearRecorderSteps()}>
                    Clear
                  </Button>
                </>
              )}
            </div>
          </div>
          <p className="text-xs text-violet-600 dark:text-violet-300 mt-1 leading-relaxed">
            Click <strong>Start recording</strong>, then click through the app — each click captures the
            element&rsquo;s <code className="bg-violet-100 dark:bg-violet-900 px-1 rounded font-mono">data-tour-id</code>{" "}
            (or a CSS selector) and the route. Recording continues across pages; come back here and{" "}
            <strong>Stop</strong>, then <strong>Copy JSON</strong> to paste the steps into a new tour.
            Avoid clicking destructive buttons while recording — clicks fire normally.
          </p>
          {steps.length > 0 && (
            <Textarea
              readOnly
              value={json}
              className="mt-3 font-mono text-[11px] h-40 bg-card"
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Step Editor ────────────────────────────────────────────────────────── */

type StepDraft = {
  sortOrder: number;
  targetDataTourId: string;
  targetSelector: string;
  title: string;
  bodyMarkdown: string;
  visualTreatment: string;
  advanceCondition: string;
  skipAllowed: boolean;
  backAllowed: boolean;
};

function defaultStep(sortOrder: number): StepDraft {
  return {
    sortOrder,
    targetDataTourId: "",
    targetSelector: "",
    title: "",
    bodyMarkdown: "",
    visualTreatment: "spotlight",
    advanceCondition: "next_button",
    skipAllowed: true,
    backAllowed: true,
  };
}

function StepCard({
  step,
  index,
  total,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
}: {
  step: StepDraft;
  index: number;
  total: number;
  onChange: (s: StepDraft) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const [expanded, setExpanded] = useState(index === 0);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Step header */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="w-6 h-6 rounded-full bg-violet-100 text-violet-700 text-xs font-bold flex items-center justify-center flex-shrink-0">
          {index + 1}
        </div>
        <p className="flex-1 text-sm font-medium text-foreground line-clamp-1">
          {step.title || <span className="text-muted-foreground italic">Untitled step</span>}
        </p>
        <div className="flex gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
            disabled={index === 0}
            className="p-1 text-muted-foreground hover:text-muted-foreground disabled:opacity-30"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
            disabled={index === total - 1}
            className="p-1 text-muted-foreground hover:text-muted-foreground disabled:opacity-30"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1 text-muted-foreground hover:text-red-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Step fields */}
      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-border pt-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">data-tour-id (preferred)</Label>
              <Input
                value={step.targetDataTourId}
                onChange={(e) => onChange({ ...step, targetDataTourId: e.target.value })}
                placeholder="e.g. new-contact-button"
                className="text-xs h-8"
              />
            </div>
            <div>
              <Label className="text-xs">CSS Selector (fallback)</Label>
              <Input
                value={step.targetSelector}
                onChange={(e) => onChange({ ...step, targetSelector: e.target.value })}
                placeholder="e.g. #new-contact-btn"
                className="text-xs h-8"
              />
            </div>
          </div>
          <div>
            <Label className="text-xs">Step Title</Label>
            <Input
              value={step.title}
              onChange={(e) => onChange({ ...step, title: e.target.value })}
              placeholder="What to tell the user at this step"
              className="text-xs h-8"
            />
          </div>
          <div>
            <Label className="text-xs">Body (Markdown)</Label>
            <Textarea
              value={step.bodyMarkdown}
              onChange={(e) => onChange({ ...step, bodyMarkdown: e.target.value })}
              rows={3}
              placeholder="Detailed explanation (supports Markdown)"
              className="text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Visual Treatment</Label>
              <Select
                value={step.visualTreatment}
                onValueChange={(v) => onChange({ ...step, visualTreatment: v })}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="spotlight">Spotlight</SelectItem>
                  <SelectItem value="pulse">Pulse ring</SelectItem>
                  <SelectItem value="arrow">Arrow pointer</SelectItem>
                  <SelectItem value="coach">Coach mark</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Advance Condition</Label>
              <Select
                value={step.advanceCondition}
                onValueChange={(v) => onChange({ ...step, advanceCondition: v })}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="next_button">Next button click</SelectItem>
                  <SelectItem value="element_clicked">Target element clicked</SelectItem>
                  <SelectItem value="form_field_filled">Form field filled</SelectItem>
                  <SelectItem value="route_changed">Route changed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={step.skipAllowed}
                onChange={(e) => onChange({ ...step, skipAllowed: e.target.checked })}
                className="rounded"
              />
              Allow skip
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={step.backAllowed}
                onChange={(e) => onChange({ ...step, backAllowed: e.target.checked })}
                className="rounded"
              />
              Allow back
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Tour Form ──────────────────────────────────────────────────────────── */

function TourForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: any;
  onSave: (data: any) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    type: initial?.type ?? "feature",
    triggerPageKey: initial?.triggerPageKey ?? "",
    estimatedMinutes: initial?.estimatedMinutes?.toString() ?? "",
    status: initial?.status ?? "draft",
    achievementBadge: initial?.achievementBadge ?? "",
    showProactiveNudge: initial?.showProactiveNudge ?? true,
  });

  const [steps, setSteps] = useState<StepDraft[]>(
    initial?.steps?.length
      ? initial.steps.map((s: any) => ({
          sortOrder: s.sortOrder,
          targetDataTourId: s.targetDataTourId ?? "",
          targetSelector: s.targetSelector ?? "",
          title: s.title ?? "",
          bodyMarkdown: s.bodyMarkdown ?? "",
          visualTreatment: s.visualTreatment ?? "spotlight",
          advanceCondition: s.advanceCondition ?? "next_button",
          skipAllowed: s.skipAllowed ?? true,
          backAllowed: s.backAllowed ?? true,
        }))
      : [defaultStep(0)],
  );

  function addStep() {
    setSteps((prev) => [...prev, defaultStep(prev.length)]);
  }

  function updateStep(i: number, s: StepDraft) {
    setSteps((prev) => prev.map((x, idx) => (idx === i ? s : x)));
  }

  function deleteStep(i: number) {
    setSteps((prev) => prev.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, sortOrder: idx })));
  }

  function moveUp(i: number) {
    if (i === 0) return;
    setSteps((prev) => {
      const arr = [...prev];
      [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      return arr.map((s, idx) => ({ ...s, sortOrder: idx }));
    });
  }

  function moveDown(i: number) {
    if (i === steps.length - 1) return;
    setSteps((prev) => {
      const arr = [...prev];
      [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
      return arr.map((s, idx) => ({ ...s, sortOrder: idx }));
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Tour metadata */}
      <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-4">
        <h3 className="text-sm font-semibold text-foreground">Tour Details</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Tour Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Getting Started with Sequences" />
          </div>
          <div>
            <Label>Type</Label>
            <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="onboarding">Onboarding</SelectItem>
                <SelectItem value="feature">Feature</SelectItem>
                <SelectItem value="whats_new">What's New</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label>Description</Label>
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Brief description shown in the tour list" />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <Label>Trigger Page Key</Label>
            <Input value={form.triggerPageKey} onChange={(e) => setForm({ ...form, triggerPageKey: e.target.value })} placeholder="e.g. sequences" />
          </div>
          <div>
            <Label>Est. Minutes</Label>
            <Input type="number" value={form.estimatedMinutes} onChange={(e) => setForm({ ...form, estimatedMinutes: e.target.value })} placeholder="5" />
          </div>
          <div>
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Draft</SelectItem>
                <SelectItem value="published">Published</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Achievement Badge (emoji + text)</Label>
            <Input value={form.achievementBadge} onChange={(e) => setForm({ ...form, achievementBadge: e.target.value })} placeholder="🎓 Sequences Master" />
          </div>
          <div className="flex items-end pb-1">
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={form.showProactiveNudge}
                onChange={(e) => setForm({ ...form, showProactiveNudge: e.target.checked })}
                className="rounded"
              />
              Show proactive nudge on trigger page
            </label>
          </div>
        </div>
      </div>

      {/* Steps */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Steps ({steps.length})</h3>
          <Button size="sm" variant="outline" onClick={addStep} className="h-7 text-xs">
            <Plus className="h-3 w-3 mr-1" /> Add Step
          </Button>
        </div>
        {steps.map((step, i) => (
          <StepCard
            key={i}
            step={step}
            index={i}
            total={steps.length}
            onChange={(s) => updateStep(i, s)}
            onDelete={() => deleteStep(i)}
            onMoveUp={() => moveUp(i)}
            onMoveDown={() => moveDown(i)}
          />
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button
          className="bg-violet-600 hover:bg-violet-700 text-white"
          onClick={() =>
            onSave({
              ...form,
              estimatedMinutes: form.estimatedMinutes ? parseInt(form.estimatedMinutes) : undefined,
              steps,
            })
          }
        >
          <Save className="h-4 w-4 mr-1" />
          Save Tour
        </Button>
      </div>
    </div>
  );
}

/* ─── Tour Builder Page ──────────────────────────────────────────────────── */

export default function TourBuilderPage() {
  const [editing, setEditing] = useState<any | null>(null);
  const [isNew, setIsNew] = useState(false);

  const { data: tours, refetch } = trpc.tours.list.useQuery({ type: "all", status: "all" });

  const createMut = trpc.tours.create.useMutation({
    onSuccess: () => { toast.success("Tour created"); refetch(); setIsNew(false); },
    onError: (e) => toast.error(e.message),
  });
  const updateMut = trpc.tours.update.useMutation({
    onSuccess: () => { toast.success("Tour updated"); refetch(); setEditing(null); },
    onError: (e) => toast.error(e.message),
  });
  const deleteMut = trpc.tours.delete.useMutation({
    onSuccess: () => { toast.success("Tour deleted"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  if (isNew || editing) {
    return (
      <Shell title="Tour Builder">
        <PageHeader
          title="Tour Builder"
          description="Create and manage guided tours for your team."
          pageKey="tour-builder"
        />
        <div className="px-6 pb-8">
          <button
            onClick={() => { setEditing(null); setIsNew(false); }}
            className="text-xs text-violet-500 hover:text-violet-700 mb-4 flex items-center gap-1"
          >
            ← Back to tours
          </button>
          <h2 className="text-base font-semibold text-foreground mb-4">
            {isNew ? "New Tour" : `Edit: ${editing.name}`}
          </h2>
          <TourForm
            initial={editing}
            onSave={(data) => {
              if (isNew) {
                createMut.mutate(data);
              } else {
                updateMut.mutate({ id: editing.id, ...data });
              }
            }}
            onCancel={() => { setEditing(null); setIsNew(false); }}
          />
        </div>
      </Shell>
    );
  }

  const typeLabel: Record<string, string> = {
    onboarding: "🎓 Onboarding",
    feature: "⭐ Feature",
    whats_new: "🆕 What's New",
    custom: "🏆 Custom",
  };

  return (
    <Shell title="Tour Builder">
      <PageHeader
        title="Tour Builder"
        description="Create and manage guided tours. Tours appear in the Help Center and as proactive nudges when users first visit a page."
        pageKey="tour-builder"
        actions={
          <Button
            className="bg-violet-600 hover:bg-violet-700 text-white"
            onClick={() => { setIsNew(true); setEditing(null); }}
          >
            <Plus className="h-4 w-4 mr-1" /> New Tour
          </Button>
        }
      />

      <div className="px-6 pb-8">
        {(!tours || tours.length === 0) && (
          <EmptyState
            icon={GraduationCap}
            title="No tours yet"
            description="Click New Tour to create your first guided tour"
          />
        )}

        <div className="flex flex-col gap-3">
          {tours?.map((tour) => (
            <div
              key={tour.id}
              className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-foreground">{tour.name}</p>
                  <span className="text-xs text-violet-500">{typeLabel[tour.type] ?? tour.type}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                    tour.status === "published" ? "bg-green-100 text-green-700" :
                    tour.status === "draft" ? "bg-amber-100 text-amber-700" :
                    "bg-muted text-muted-foreground"
                  }`}>
                    {tour.status}
                  </span>
                </div>
                {tour.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{tour.description}</p>
                )}
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-xs text-muted-foreground">{tour.steps?.length ?? 0} steps</span>
                  {tour.estimatedMinutes && (
                    <span className="text-xs text-muted-foreground">~{tour.estimatedMinutes} min</span>
                  )}
                  {tour.triggerPageKey && (
                    <span className="text-xs text-muted-foreground">Triggers on: {tour.triggerPageKey}</span>
                  )}
                </div>
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-violet-600"
                  onClick={() => { setEditing(tour); setIsNew(false); }}
                >
                  <Edit className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-red-500"
                  onClick={() => {
                    confirmAction({ title: `Delete tour "${tour.name}"?`, description: "This product tour will be permanently deleted. This cannot be undone.", confirmLabel: "Delete" }, () => { deleteMut.mutate({ id: tour.id }); });
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>

        {/* Record mode — capture steps by clicking through the app */}
        <RecorderPanel />
      </div>
    </Shell>
  );
}
