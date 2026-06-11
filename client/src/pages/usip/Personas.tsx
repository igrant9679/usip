/**
 * Personas — reusable ICP templates (Job Titles + Industries + Company Size
 * + Location + Keywords) that can be applied to ARE campaigns, sequences,
 * and prospect search.
 *
 * Personas are grouped into user-defined categories: each category renders
 * as its own collapsible section that can be renamed, deleted (personas
 * fall back to Uncategorized), and reordered. Collapse state is local UI
 * preference (localStorage); section order is data (sortOrder on the
 * server) so it follows the user across devices.
 */
import { useState, type ReactNode } from "react";
import { Shell, PageHeader, QueryError, TableSkeleton } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Users, Plus, Pencil, Trash2, Sparkles, ChevronDown, ArrowUp, ArrowDown, FolderPlus } from "lucide-react";

interface PersonaForm {
  name: string;
  description: string;
  targetTitles: string[];
  targetIndustries: string[];
  targetGeographies: string[];
  employeeMin: number | null;
  employeeMax: number | null;
  keywords: string[];
  categoryId: number | null;
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
  categoryId: null,
};

/** Per-section collapse map, keyed "cat:<id>" / "uncat". UI-only state. */
const SECTIONS_LS_KEY = "velocity_personas_sections_collapsed";
function loadCollapsedSections(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(SECTIONS_LS_KEY) ?? "{}") ?? {}; } catch { return {}; }
}

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

/** Collapsible section card — header toggles, action buttons stay outside
 *  the toggle hit area so clicking them never collapses the section. */
function SectionCard({ title, count, collapsed, onToggle, actions, children }: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex w-full items-center gap-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="flex items-center gap-2 flex-1 min-w-0 text-left"
          >
            <CardTitle className="text-base truncate">
              {title} <span className="text-muted-foreground font-normal">({count})</span>
            </CardTitle>
            <ChevronDown className={`size-4 text-muted-foreground transition-transform shrink-0 ${collapsed ? "-rotate-90" : ""}`} />
          </button>
          {actions}
        </div>
      </CardHeader>
      {!collapsed && <CardContent>{children}</CardContent>}
    </Card>
  );
}

export default function Personas() {
  const { data: list = [], isLoading, error, refetch } = trpc.personas.list.useQuery();
  const { data: presets = [] } = trpc.personas.listPresets.useQuery();
  const { data: cats = [], refetch: refetchCats } = trpc.personas.listCategories.useQuery();
  const create = trpc.personas.create.useMutation();
  const update = trpc.personas.update.useMutation();
  const del = trpc.personas.delete.useMutation();
  const fromPreset = trpc.personas.createFromPreset.useMutation();
  const createCategory = trpc.personas.createCategory.useMutation();
  const updateCategory = trpc.personas.updateCategory.useMutation();
  const deleteCategory = trpc.personas.deleteCategory.useMutation();
  const reorderCategories = trpc.personas.reorderCategories.useMutation();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<PersonaForm>(EMPTY);

  // Category create/rename dialog
  const [catDialogOpen, setCatDialogOpen] = useState(false);
  const [catEditingId, setCatEditingId] = useState<number | null>(null);
  const [catName, setCatName] = useState("");

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

  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(loadCollapsedSections);
  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(SECTIONS_LS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const startCreate = (categoryId: number | null = null) => {
    setForm({ ...EMPTY, categoryId });
    setEditingId(null);
    setOpen(true);
  };
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
      categoryId: p.categoryId ?? null,
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

  // ── Category handlers ──────────────────────────────────────────────
  const startCreateCategory = () => { setCatName(""); setCatEditingId(null); setCatDialogOpen(true); };
  const startEditCategory = (c: any) => { setCatName(c.name); setCatEditingId(c.id); setCatDialogOpen(true); };

  const saveCategory = async () => {
    const name = catName.trim();
    if (!name) { toast.error("Category name is required"); return; }
    try {
      if (catEditingId) {
        await updateCategory.mutateAsync({ id: catEditingId, name });
        toast.success("Category renamed");
      } else {
        await createCategory.mutateAsync({ name });
        toast.success("Category created");
      }
      setCatDialogOpen(false);
      await refetchCats();
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    }
  };

  const removeCategory = async (c: any) => {
    if (!confirm(`Delete category "${c.name}"? Its personas move to Uncategorized.`)) return;
    try {
      await deleteCategory.mutateAsync({ id: c.id });
      await Promise.all([refetchCats(), refetch()]);
    } catch (e: any) {
      toast.error(e?.message ?? "Delete failed");
    }
  };

  const moveCategory = async (i: number, dir: -1 | 1) => {
    const ids = cats.map((c: any) => c.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try {
      await reorderCategories.mutateAsync({ ids });
      await refetchCats();
    } catch (e: any) {
      toast.error(e?.message ?? "Reorder failed");
    }
  };

  // Group personas by category. A categoryId pointing at a category that
  // no longer exists (deleted in another tab) falls back to Uncategorized
  // so the persona never silently disappears from the page.
  const catIds = new Set(cats.map((c: any) => c.id));
  const personasByCat = new Map<number | null, any[]>();
  for (const p of list as any[]) {
    const key = p.categoryId != null && catIds.has(p.categoryId) ? (p.categoryId as number) : null;
    const arr = personasByCat.get(key) ?? [];
    arr.push(p);
    personasByCat.set(key, arr);
  }
  const uncategorized = personasByCat.get(null) ?? [];

  const renderPersona = (p: any) => (
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
  );

  const personaList = (items: any[], emptyText: string) =>
    items.length === 0 ? (
      <div className="text-sm text-muted-foreground p-4 text-center">{emptyText}</div>
    ) : (
      <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
        {items.map(renderPersona)}
      </div>
    );

  return (
    <Shell>
      <PageHeader
        icon={<Users className="size-5" />}
        title="Personas"
        description="Reusable targeting templates you can apply to any campaign, sequence, or prospect search."
      >
        <Button variant="outline" onClick={startCreateCategory}>
          <FolderPlus className="size-4 mr-1" /> New category
        </Button>
        <Button onClick={() => startCreate()}>
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

      {/* Saved personas, one collapsible section per category */}
      {error ? (
        <Card className="shrink-0"><CardContent className="pt-6"><QueryError message={error.message} onRetry={() => refetch()} /></CardContent></Card>
      ) : isLoading ? (
        <Card className="shrink-0"><CardContent className="pt-6"><TableSkeleton rows={5} /></CardContent></Card>
      ) : (
        <div className="space-y-4">
          {cats.map((c: any, i: number) => (
            <SectionCard
              key={c.id}
              title={c.name}
              count={(personasByCat.get(c.id) ?? []).length}
              collapsed={!!collapsedSections[`cat:${c.id}`]}
              onToggle={() => toggleSection(`cat:${c.id}`)}
              actions={
                <div className="flex gap-1 shrink-0">
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="New persona in this category" onClick={() => startCreate(c.id)}>
                    <Plus className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Move up" disabled={i === 0 || reorderCategories.isPending} onClick={() => moveCategory(i, -1)}>
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Move down" disabled={i === cats.length - 1 || reorderCategories.isPending} onClick={() => moveCategory(i, 1)}>
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Rename category" onClick={() => startEditCategory(c)}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Delete category" onClick={() => removeCategory(c)}>
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </div>
              }
            >
              {personaList(personasByCat.get(c.id) ?? [], "No personas in this category yet. Use the + above to add one.")}
            </SectionCard>
          ))}

          {/* Uncategorized — always present when it has personas; doubles as
              the only section while no categories exist yet. Not movable or
              deletable since it's the fallback, not a real category. */}
          {(cats.length === 0 || uncategorized.length > 0) && (
            <SectionCard
              title={cats.length === 0 ? "Your personas" : "Uncategorized"}
              count={uncategorized.length}
              collapsed={!!collapsedSections["uncat"]}
              onToggle={() => toggleSection("uncat")}
            >
              {personaList(uncategorized, "No personas yet. Create one above or clone a preset.")}
            </SectionCard>
          )}
        </div>
      )}

      {/* Persona editor dialog */}
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
              <Label>Category</Label>
              <Select
                value={form.categoryId != null ? String(form.categoryId) : "none"}
                onValueChange={(v) => setForm({ ...form, categoryId: v === "none" ? null : Number(v) })}
              >
                <SelectTrigger><SelectValue placeholder="Uncategorized" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Uncategorized</SelectItem>
                  {cats.map((c: any) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

      {/* Category create/rename dialog */}
      <Dialog open={catDialogOpen} onOpenChange={setCatDialogOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{catEditingId ? "Rename category" : "New category"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={catName}
              onChange={(e) => setCatName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveCategory(); } }}
              placeholder="e.g. Enterprise targets"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCatDialogOpen(false)}>Cancel</Button>
            <Button onClick={saveCategory} disabled={createCategory.isPending || updateCategory.isPending}>
              {catEditingId ? "Save" : "Create category"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Shell>
  );
}
