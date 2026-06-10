/**
 * Personas — reusable ICP templates (Job Titles + Industries + Company Size
 * + Location + Keywords) that can be applied to ARE campaigns, sequences,
 * and prospect search.
 */
import { useState } from "react";
import { Shell, PageHeader, QueryError, TableSkeleton } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Users, Plus, Pencil, Trash2, Sparkles, ChevronDown } from "lucide-react";

interface PersonaForm {
  name: string;
  description: string;
  targetTitles: string[];
  targetIndustries: string[];
  targetGeographies: string[];
  employeeMin: number | null;
  employeeMax: number | null;
  keywords: string[];
}

const EMPTY: PersonaForm = {
  name: "",
  description: "",
  targetTitles: [],
  targetIndustries: [],
  targetGeographies: [],
  employeeMin: null,
  employeeMax: null,
  keywords: [],
};

function TagInput({ label, value, onChange, placeholder }: { label: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setText("");
  };
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5 min-h-[28px]">
        {value.map((v) => (
          <Badge key={v} variant="secondary" className="text-xs gap-1">
            {v}
            <button onClick={() => onChange(value.filter((x) => x !== v))} className="ml-0.5 hover:opacity-70">×</button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" size="sm" onClick={add}>Add</Button>
      </div>
    </div>
  );
}

export default function Personas() {
  const { data: list = [], isLoading, error, refetch } = trpc.personas.list.useQuery();
  const { data: presets = [] } = trpc.personas.listPresets.useQuery();
  const create = trpc.personas.create.useMutation();
  const update = trpc.personas.update.useMutation();
  const del = trpc.personas.delete.useMutation();
  const fromPreset = trpc.personas.createFromPreset.useMutation();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<PersonaForm>(EMPTY);
  const [presetsCollapsed, setPresetsCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("velocity_personas_presets_collapsed") === "1"; } catch { return false; }
  });
  const togglePresets = () => {
    setPresetsCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("velocity_personas_presets_collapsed", next ? "1" : "0"); } catch {}
      return next;
    });
  };
  const [personasCollapsed, setPersonasCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("velocity_personas_list_collapsed") === "1"; } catch { return false; }
  });
  const togglePersonas = () => {
    setPersonasCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem("velocity_personas_list_collapsed", next ? "1" : "0"); } catch {}
      return next;
    });
  };

  const startCreate = () => { setForm(EMPTY); setEditingId(null); setOpen(true); };
  const startEdit = (p: any) => {
    setForm({
      name: p.name,
      description: p.description ?? "",
      targetTitles: (p.targetTitles as string[]) ?? [],
      targetIndustries: (p.targetIndustries as string[]) ?? [],
      targetGeographies: (p.targetGeographies as string[]) ?? [],
      employeeMin: p.employeeMin ?? null,
      employeeMax: p.employeeMax ?? null,
      keywords: (p.keywords as string[]) ?? [],
    });
    setEditingId(p.id);
    setOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    try {
      if (editingId) {
        await update.mutateAsync({ id: editingId, ...form });
        toast.success("Persona updated");
      } else {
        await create.mutateAsync(form);
        toast.success("Persona created");
      }
      setOpen(false);
      await refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    }
  };

  const applyPreset = async (key: string) => {
    try {
      await fromPreset.mutateAsync({ presetKey: key });
      toast.success("Preset added to your personas");
      await refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed");
    }
  };

  const remove = async (id: number) => {
    if (!confirm("Delete this persona?")) return;
    try {
      await del.mutateAsync({ id });
      await refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Delete failed");
    }
  };

  return (
    <Shell>
      <PageHeader
        icon={<Users className="size-5" />}
        title="Personas"
        description="Reusable targeting templates you can apply to any campaign, sequence, or prospect search."
      >
        <Button onClick={startCreate}>
          <Plus className="size-4 mr-1" /> New persona
        </Button>
      </PageHeader>

      {/* Preset library */}
      <Card className="mb-4 shrink-0">
        <CardHeader>
          <button
            type="button"
            onClick={togglePresets}
            aria-expanded={!presetsCollapsed}
            className="flex w-full items-center gap-2 text-left"
          >
            <CardTitle className="text-base flex items-center gap-2 flex-1">
              <Sparkles className="size-4" /> Preset library
            </CardTitle>
            <ChevronDown className={`size-4 text-muted-foreground transition-transform ${presetsCollapsed ? "-rotate-90" : ""}`} />
          </button>
          {!presetsCollapsed && (
            <CardDescription>One-click starting points. Click to clone into your personas list.</CardDescription>
          )}
        </CardHeader>
        {!presetsCollapsed && (
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 max-h-[40vh] overflow-y-auto pr-1">
              {presets.map((p: any) => (
                <button
                  key={p.key}
                  onClick={() => applyPreset(p.key)}
                  className="text-left border rounded p-3 hover:bg-accent transition"
                >
                  <div className="font-medium text-sm">{p.name}</div>
                  <div className="text-xs text-muted-foreground mt-1">{p.description}</div>
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(p.targetTitles as string[]).slice(0, 3).map((t) => (
                      <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        )}
      </Card>

      {/* Saved personas */}
      <Card className="shrink-0">
        <CardHeader>
          <button
            type="button"
            onClick={togglePersonas}
            aria-expanded={!personasCollapsed}
            className="flex w-full items-center gap-2 text-left"
          >
            <CardTitle className="text-base flex-1">Your personas ({list.length})</CardTitle>
            <ChevronDown className={`size-4 text-muted-foreground transition-transform ${personasCollapsed ? "-rotate-90" : ""}`} />
          </button>
        </CardHeader>
        {!personasCollapsed && (
        <CardContent>
          {error ? <QueryError message={error.message} onRetry={() => refetch()} /> : isLoading ? <TableSkeleton rows={5} /> : list.length === 0 ? (
            <div className="text-sm text-muted-foreground p-4 text-center">
              No personas yet. Create one above or clone a preset.
            </div>
          ) : (
            <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
              {list.map((p: any) => (
                <div key={p.id} className="flex items-start justify-between border rounded p-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-sm">{p.name}</div>
                    {p.description && <div className="text-xs text-muted-foreground">{p.description}</div>}
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {((p.targetTitles as string[]) ?? []).slice(0, 4).map((t) => (
                        <Badge key={"t-" + t} variant="secondary" className="text-[10px]">{t}</Badge>
                      ))}
                      {((p.targetIndustries as string[]) ?? []).slice(0, 3).map((t) => (
                        <Badge key={"i-" + t} variant="outline" className="text-[10px]">{t}</Badge>
                      ))}
                      {(p.employeeMin || p.employeeMax) && (
                        <Badge variant="outline" className="text-[10px]">
                          {p.employeeMin ?? 0}–{p.employeeMax ?? "∞"} emp
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(p)}>
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(p.id)}>
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
        )}
      </Card>

      {/* Editor dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit persona" : "New persona"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. SaaS RevOps Leaders" />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
            </div>
            <TagInput label="Job Titles" value={form.targetTitles} onChange={(v) => setForm({ ...form, targetTitles: v })} placeholder="VP of Sales…" />
            <TagInput label="Industries" value={form.targetIndustries} onChange={(v) => setForm({ ...form, targetIndustries: v })} placeholder="SaaS, Fintech…" />
            <TagInput label="Locations" value={form.targetGeographies} onChange={(v) => setForm({ ...form, targetGeographies: v })} placeholder="United States, UK…" />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Min employees</Label>
                <Input type="number" value={form.employeeMin ?? ""} onChange={(e) => setForm({ ...form, employeeMin: e.target.value ? Number(e.target.value) : null })} />
              </div>
              <div className="space-y-2">
                <Label>Max employees</Label>
                <Input type="number" value={form.employeeMax ?? ""} onChange={(e) => setForm({ ...form, employeeMax: e.target.value ? Number(e.target.value) : null })} />
              </div>
            </div>
            <TagInput label="Keywords" value={form.keywords} onChange={(v) => setForm({ ...form, keywords: v })} placeholder="revenue ops, salesforce…" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={create.isPending || update.isPending}>
              {editingId ? "Save changes" : "Create persona"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
