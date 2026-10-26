/**
 * /settings/pipelines — configure pipelines and stages per workspace.
 *
 * Each workspace gets a Default pipeline seeded on first read. From this
 * page users can:
 *   - Create / rename / delete pipelines (default is undeletable)
 *   - Set the workspace default
 *   - Add / rename / reorder / delete stages
 *   - Set per-stage default win probability and won/lost flags
 *
 * Stage `key` strings are stored in `opportunities.stage` (VARCHAR(60)
 * since migration 0082). Renaming the label has no data impact; a new key
 * carries the stage's deals with it (server side).
 *
 * Audit 2026-10-20, Phase 2 (R18): deleting a stage or pipeline left its deals
 * on no board while every number still counted them, and deleting Won turned
 * past wins into open pipeline. Each stage now shows how many deals it holds;
 * deleting one that has deals asks where they go (a stage of the same kind),
 * and changing Won/Lost on a stage with deals says what that reclassifies.
 */
import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader, EmptyState } from "@/components/usip/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { confirmAction, Field, FormDialog, SelectField } from "@/components/usip/Common";
import { toast } from "sonner";
import { Plus, Star, Trash2, KanbanSquare, ChevronUp, ChevronDown, Check, X } from "lucide-react";

export default function SettingsPipelines() {
  const utils = trpc.useUtils();
  const { data: pipelines } = trpc.crmPipelines.list.useQuery();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const activeId = selectedId ?? pipelines?.find((p) => p.isDefault)?.id ?? pipelines?.[0]?.id ?? null;
  const { data: detail } = trpc.crmPipelines.get.useQuery(activeId ? { pipelineId: activeId } : undefined as any, { enabled: !!activeId });

  const invalidateAll = () => {
    utils.crmPipelines.list.invalidate();
    if (activeId) utils.crmPipelines.get.invalidate({ pipelineId: activeId });
  };

  const createPipeline = trpc.crmPipelines.createPipeline.useMutation({
    onSuccess: ({ id }) => { invalidateAll(); setSelectedId(id); setNewOpen(false); toast.success("Pipeline created"); },
    onError: (e) => toast.error(e.message),
  });
  const renamePipeline = trpc.crmPipelines.renamePipeline.useMutation({ onSuccess: () => { invalidateAll(); toast.success("Renamed"); }, onError: (e) => toast.error(e.message) });
  const setDefault = trpc.crmPipelines.setDefault.useMutation({ onSuccess: () => { invalidateAll(); toast.success("Default updated"); }, onError: (e) => toast.error(e.message) });
  const deletePipeline = trpc.crmPipelines.deletePipeline.useMutation({
    onSuccess: (r) => {
      invalidateAll(); utils.opportunities.board.invalidate(); setSelectedId(null); setPipelineDeleteOpen(false);
      toast.success(r.moved ? `Deleted — ${r.moved} deal${r.moved === 1 ? "" : "s"} moved` : "Deleted");
    },
    onError: (e) => toast.error(e.message),
  });
  const createStage = trpc.crmPipelines.createStage.useMutation({ onSuccess: () => invalidateAll(), onError: (e) => toast.error(e.message) });
  const updateStage = trpc.crmPipelines.updateStage.useMutation({ onSuccess: () => invalidateAll(), onError: (e) => toast.error(e.message) });
  const deleteStage = trpc.crmPipelines.deleteStage.useMutation({
    onSuccess: (r) => { invalidateAll(); utils.opportunities.board.invalidate(); setStageToDelete(null); if (r.moved) toast.success(`Deleted — ${r.moved} deal${r.moved === 1 ? "" : "s"} moved`); },
    onError: (e) => toast.error(e.message),
  });
  const reorderStages = trpc.crmPipelines.reorderStages.useMutation({ onSuccess: () => invalidateAll(), onError: (e) => toast.error(e.message) });

  const [newOpen, setNewOpen] = useState(false);
  const [newStageOpen, setNewStageOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [stageToDelete, setStageToDelete] = useState<(typeof stages)[number] | null>(null);
  const [pipelineDeleteOpen, setPipelineDeleteOpen] = useState(false);

  const stages = detail?.stages ?? [];
  const kindOf = (s: { isWon: boolean; isLost: boolean }) => (s.isLost ? "lost" : s.isWon ? "won" : "open");
  const kindLabel = { open: "open", won: "Won", lost: "Lost" } as const;
  const plural = (n: number) => `${n} deal${n === 1 ? "" : "s"}`;

  function askDeleteStage(s: (typeof stages)[number]) {
    if (s.dealCount === 0) {
      confirmAction({ title: `Delete stage "${s.label}"?`, description: "No deals are in this stage.", confirmLabel: "Delete" }, () => { deleteStage.mutate({ id: s.id }); });
      return;
    }
    const targets = stages.filter((t) => t.id !== s.id && kindOf(t) === kindOf(s));
    if (targets.length === 0) {
      toast.error(`${plural(s.dealCount)} ${s.dealCount === 1 ? "is" : "are"} in this stage. Add another ${kindLabel[kindOf(s)]} stage to move ${s.dealCount === 1 ? "it" : "them"} to first.`);
      return;
    }
    setStageToDelete(s);
  }

  /** Won/Lost decide what counts as revenue; changing them on a stage with deals says so first. */
  function setFlags(s: (typeof stages)[number], patch: { isWon: boolean; isLost: boolean }) {
    const apply = () => updateStage.mutate({ id: s.id, patch });
    if (s.dealCount === 0) return apply();
    const now = kindOf(s);
    const next = kindOf(patch);
    const leaving = now === "won" ? "leave revenue and quota" : now === "open" ? "leave the open pipeline" : "stop counting as lost";
    const joining = next === "open" ? "count as open pipeline again" : `count as ${next} from when they entered this stage`;
    confirmAction({
      title: `Count ${plural(s.dealCount)} as ${next === "open" ? "open pipeline" : next}?`,
      description: `The ${plural(s.dealCount)} in "${s.label}" ${leaving} and ${joining}.`,
      confirmLabel: "Change",
    }, apply);
  }

  function move(stageId: number, dir: -1 | 1) {
    const idx = stages.findIndex((s) => s.id === stageId);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= stages.length) return;
    reorderStages.mutate({ items: [
      { id: stages[idx].id, sortOrder: stages[j].sortOrder },
      { id: stages[j].id, sortOrder: stages[idx].sortOrder },
    ]});
  }

  return (
    <Shell title="Pipelines">
      <PageHeader title="Pipelines" description="Define the stages opportunities move through. Each workspace can have multiple pipelines for different sales motions." icon={<KanbanSquare className="size-5" />}>
        <Button asChild variant="outline" size="sm"><Link href="/pipeline">Back to pipeline</Link></Button>
        <Button size="sm" onClick={() => setNewOpen(true)}><Plus className="size-4 mr-1" /> New pipeline</Button>
      </PageHeader>

      <div className="p-4 md:p-5 grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
        {/* Left: pipeline list */}
        <Card><CardContent className="pt-4 space-y-1">
          {!pipelines ? <div className="text-sm text-muted-foreground">Loading…</div> :
            pipelines.length === 0 ? <EmptyState title="No pipelines yet" /> :
            pipelines.map((p) => (
              <button key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={`w-full text-left rounded-md px-3 py-2 text-sm flex items-center gap-2 ${activeId === p.id ? "bg-secondary" : "hover:bg-secondary/50"}`}>
                <span className="flex-1 truncate">{p.name}</span>
                {p.isDefault && <Badge variant="outline" className="text-[10px]"><Star className="size-2.5 mr-0.5" /> default</Badge>}
              </button>
            ))
          }
        </CardContent></Card>

        {/* Right: stages of active pipeline */}
        <Card><CardContent className="pt-4">
          {!detail ? <div className="text-sm text-muted-foreground">Select a pipeline.</div> : (
            <>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-lg">{detail.pipeline.name}</h3>
                  {detail.pipeline.isDefault && <Badge variant="outline" className="text-[10px]">default</Badge>}
                </div>
                <div className="flex items-center gap-1">
                  {!detail.pipeline.isDefault && (
                    <Button size="sm" variant="ghost"
                      onClick={() => setDefault.mutate({ id: detail.pipeline.id })}>
                      <Star className="size-3.5 mr-1" /> Make default
                    </Button>
                  )}
                  <Button size="sm" variant="ghost"
                    onClick={() => {
                      const next = prompt("Rename pipeline", detail.pipeline.name);
                      if (next && next.trim() && next !== detail.pipeline.name) renamePipeline.mutate({ id: detail.pipeline.id, name: next.trim() });
                    }}>
                    Rename
                  </Button>
                  {!detail.pipeline.isDefault && (
                    <Button size="sm" variant="ghost" className="text-destructive"
                      onClick={() => {
                        if (detail.dealCount > 0) { setPipelineDeleteOpen(true); return; }
                        confirmAction({ title: `Delete pipeline "${detail.pipeline.name}"?`, description: "No deals are in this pipeline. Its stages are removed.", confirmLabel: "Delete" }, () => { deletePipeline.mutate({ id: detail.pipeline.id }); });
                      }}>
                      <Trash2 className="size-3.5 mr-1" /> Delete
                    </Button>
                  )}
                </div>
              </div>

              <ul className="rounded-lg border bg-background divide-y">
                {stages.map((s, idx) => (
                  <li key={s.id} className="p-3 flex items-center gap-3">
                    <div className="flex flex-col">
                      <button className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        disabled={idx === 0} onClick={() => move(s.id, -1)}><ChevronUp className="size-3.5" /></button>
                      <button className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        disabled={idx === stages.length - 1} onClick={() => move(s.id, 1)}><ChevronDown className="size-3.5" /></button>
                    </div>
                    <div className="flex-1 min-w-0">
                      {editingId === s.id ? (
                        <div className="flex gap-2">
                          <Input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} autoFocus />
                          <Button size="sm" onClick={() => { updateStage.mutate({ id: s.id, patch: { label: editLabel } }); setEditingId(null); }}>
                            <Check className="size-3.5" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}><X className="size-3.5" /></Button>
                        </div>
                      ) : (
                        <button className="text-sm font-medium text-left hover:underline" onClick={() => { setEditingId(s.id); setEditLabel(s.label); }}>
                          {s.label}
                        </button>
                      )}
                      <div className="text-[11px] text-muted-foreground mt-0.5">key: <code>{s.key}</code> · {plural(s.dealCount)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Win %</span>
                      <Input type="number" min={0} max={100} className="w-16 h-7 text-xs"
                        defaultValue={s.defaultWinProb}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v !== s.defaultWinProb) updateStage.mutate({ id: s.id, patch: { defaultWinProb: v } });
                        }} />
                      <label className="text-xs flex items-center gap-1">
                        <input type="checkbox" checked={s.isWon} onChange={(e) => setFlags(s, { isWon: e.target.checked, isLost: e.target.checked ? false : s.isLost })} />
                        Won
                      </label>
                      <label className="text-xs flex items-center gap-1">
                        <input type="checkbox" checked={s.isLost} onChange={(e) => setFlags(s, { isLost: e.target.checked, isWon: e.target.checked ? false : s.isWon })} />
                        Lost
                      </label>
                      <Button size="icon" variant="ghost" className="size-7 text-destructive"
                        onClick={() => askDeleteStage(s)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-3">
                <Button size="sm" variant="outline" onClick={() => setNewStageOpen(true)}><Plus className="size-3.5 mr-1" /> Add stage</Button>
              </div>
            </>
          )}
        </CardContent></Card>
      </div>

      <FormDialog open={newOpen} onOpenChange={setNewOpen} title="New pipeline" isPending={createPipeline.isPending}
        onSubmit={(f) => createPipeline.mutate({
          name: String(f.get("name")),
          cloneFromPipelineId: activeId ?? undefined,
        })}>
        <Field name="name" label="Name" required placeholder="e.g. SMB Renewals" />
        <p className="text-xs text-muted-foreground">Stages will be cloned from the currently selected pipeline.</p>
      </FormDialog>

      {stageToDelete && (
        <FormDialog open onOpenChange={(v) => { if (!v) setStageToDelete(null); }} title={`Delete stage "${stageToDelete.label}"`}
          submitLabel="Move deals and delete" isPending={deleteStage.isPending}
          onSubmit={(f) => deleteStage.mutate({ id: stageToDelete.id, moveToKey: String(f.get("moveToKey")) })}>
          <p className="text-sm text-muted-foreground">
            {plural(stageToDelete.dealCount)} {stageToDelete.dealCount === 1 ? "is" : "are"} in this stage. Pick
            another {kindLabel[kindOf(stageToDelete)]} stage to move {stageToDelete.dealCount === 1 ? "it" : "them"} to — the
            same kind, so won deals stay won and the pipeline stays the pipeline.
          </p>
          <SelectField name="moveToKey" label="Move deals to"
            options={stages.filter((t) => t.id !== stageToDelete.id && kindOf(t) === kindOf(stageToDelete)).map((t) => ({ value: t.key, label: t.label }))} />
        </FormDialog>
      )}

      {detail && pipelineDeleteOpen && (
        <FormDialog open onOpenChange={setPipelineDeleteOpen} title={`Delete pipeline "${detail.pipeline.name}"`}
          submitLabel="Move deals and delete" isPending={deletePipeline.isPending}
          onSubmit={(f) => deletePipeline.mutate({ id: detail.pipeline.id, moveToPipelineId: Number(f.get("moveToPipelineId")) })}>
          <p className="text-sm text-muted-foreground">
            {plural(detail.dealCount)} {detail.dealCount === 1 ? "is" : "are"} in this pipeline. Pick a pipeline to move
            {detail.dealCount === 1 ? " it" : " them"} to. Each keeps its stage where that pipeline has the same one,
            otherwise it goes to that pipeline's first stage of the same kind.
          </p>
          <SelectField name="moveToPipelineId" label="Move deals to"
            options={(pipelines ?? []).filter((p) => p.id !== detail.pipeline.id).map((p) => ({ value: String(p.id), label: p.name }))} />
        </FormDialog>
      )}

      {detail && (
        <FormDialog open={newStageOpen} onOpenChange={setNewStageOpen} title="New stage" isPending={createStage.isPending}
          onSubmit={(f) => {
            createStage.mutate({
              pipelineId: detail.pipeline.id,
              key: String(f.get("key")).toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 60) || `stage_${Date.now()}`,
              label: String(f.get("label")),
              sortOrder: (stages[stages.length - 1]?.sortOrder ?? 0) + 10,
              defaultWinProb: Number(f.get("defaultWinProb") ?? 20),
              // The dialog always sent false/false, so a new closing stage had to
              // be created and then edited before it counted as anything.
              // Lost wins when both are ticked, matching shared/stageSemantics.
              isWon: f.get("isWon") === "on" && f.get("isLost") !== "on",
              isLost: f.get("isLost") === "on",
            });
            setNewStageOpen(false);
          }}>
          <Field name="label" label="Label" required placeholder="e.g. Demo scheduled" />
          <Field name="key" label="Key (lowercase, no spaces)" required placeholder="demo_scheduled" />
          <SelectField name="defaultWinProb" label="Default win probability"
            options={[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((p) => ({ value: String(p), label: `${p}%` }))}
            defaultValue="20" />
          <div className="flex items-center gap-4">
            <label className="text-xs flex items-center gap-1"><input type="checkbox" name="isWon" /> Counts as Won</label>
            <label className="text-xs flex items-center gap-1"><input type="checkbox" name="isLost" /> Counts as Lost</label>
          </div>
          <p className="text-xs text-muted-foreground">These flags — not the stage key — decide what counts as revenue, what counts as a loss, and what the forecast treats as still open.</p>
        </FormDialog>
      )}
    </Shell>
  );
}
