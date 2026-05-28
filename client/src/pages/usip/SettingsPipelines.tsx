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
 * since migration 0082). Renaming the label has no data impact; renaming
 * the key requires a follow-up backfill (not exposed yet).
 */
import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Shell, PageHeader, EmptyState } from "@/components/usip/Shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Field, FormDialog, SelectField } from "@/components/usip/Common";
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
  });
  const renamePipeline = trpc.crmPipelines.renamePipeline.useMutation({ onSuccess: () => { invalidateAll(); toast.success("Renamed"); } });
  const setDefault = trpc.crmPipelines.setDefault.useMutation({ onSuccess: () => { invalidateAll(); toast.success("Default updated"); } });
  const deletePipeline = trpc.crmPipelines.deletePipeline.useMutation({
    onSuccess: () => { invalidateAll(); setSelectedId(null); toast.success("Deleted"); },
    onError: (e) => toast.error(e.message),
  });
  const createStage = trpc.crmPipelines.createStage.useMutation({ onSuccess: () => invalidateAll() });
  const updateStage = trpc.crmPipelines.updateStage.useMutation({ onSuccess: () => invalidateAll() });
  const deleteStage = trpc.crmPipelines.deleteStage.useMutation({ onSuccess: () => invalidateAll() });
  const reorderStages = trpc.crmPipelines.reorderStages.useMutation({ onSuccess: () => invalidateAll() });

  const [newOpen, setNewOpen] = useState(false);
  const [newStageOpen, setNewStageOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");

  const stages = detail?.stages ?? [];

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

      <div className="p-6 grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
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
                      onClick={() => { if (confirm(`Delete pipeline "${detail.pipeline.name}"? Stages will be removed; existing opportunities keep their stage value.`)) deletePipeline.mutate({ id: detail.pipeline.id }); }}>
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
                      <div className="text-[11px] text-muted-foreground mt-0.5">key: <code>{s.key}</code></div>
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
                        <input type="checkbox" checked={s.isWon} onChange={(e) => updateStage.mutate({ id: s.id, patch: { isWon: e.target.checked, isLost: e.target.checked ? false : s.isLost } })} />
                        Won
                      </label>
                      <label className="text-xs flex items-center gap-1">
                        <input type="checkbox" checked={s.isLost} onChange={(e) => updateStage.mutate({ id: s.id, patch: { isLost: e.target.checked, isWon: e.target.checked ? false : s.isWon } })} />
                        Lost
                      </label>
                      <Button size="icon" variant="ghost" className="size-7 text-destructive"
                        onClick={() => { if (confirm(`Delete stage "${s.label}"? Opportunities currently in this stage keep their stored value.`)) deleteStage.mutate({ id: s.id }); }}>
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

      {detail && (
        <FormDialog open={newStageOpen} onOpenChange={setNewStageOpen} title="New stage" isPending={createStage.isPending}
          onSubmit={(f) => {
            createStage.mutate({
              pipelineId: detail.pipeline.id,
              key: String(f.get("key")).toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 60) || `stage_${Date.now()}`,
              label: String(f.get("label")),
              sortOrder: (stages[stages.length - 1]?.sortOrder ?? 0) + 10,
              defaultWinProb: Number(f.get("defaultWinProb") ?? 20),
              isWon: false,
              isLost: false,
            });
            setNewStageOpen(false);
          }}>
          <Field name="label" label="Label" required placeholder="e.g. Demo scheduled" />
          <Field name="key" label="Key (lowercase, no spaces)" required placeholder="demo_scheduled" />
          <SelectField name="defaultWinProb" label="Default win probability"
            options={[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((p) => ({ value: String(p), label: `${p}%` }))}
            defaultValue="20" />
        </FormDialog>
      )}
    </Shell>
  );
}
