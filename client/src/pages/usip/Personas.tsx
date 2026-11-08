/**
 * Personas — reusable ICP templates (Job Titles + Industries + Company Size
 * + Location + Keywords) that can be applied to ARE campaigns, sequences,
 * and prospect search.
 *
 * Since the Research module (2026-10-14) a persona can belong to a researched
 * sector and carries what the AI writers need about the buyer: what they care
 * about, pains, objections and the angle that works. The form is shared with
 * the sector page (components/usip/research/PersonaFormFields).
 *
 * Personas are grouped into user-defined categories: each category renders
 * as its own collapsible section that can be renamed, deleted (personas
 * fall back to Uncategorized), and reordered. Collapse state is local UI
 * preference (localStorage); section order is data (sortOrder on the
 * server) so it follows the user across devices.
 */
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
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
import { Users, Plus, Pencil, Trash2, Sparkles, ChevronDown, ArrowUp, ArrowDown, FolderPlus, Telescope } from "lucide-react";
import { PersonaResultsBadge, usePersonaResultSummaries } from "@/components/usip/research/ResearchResults";
import { confirmAction } from "@/components/usip/Common";
import { ResearchSubNav, reportDropped } from "@/components/usip/research/ResearchFields";
import { EMPTY_PERSONA, PersonaFormFields, personaFormFrom, personaPayload, type PersonaForm } from "@/components/usip/research/PersonaFormFields";
import { icpLabels } from "@shared/icpShape";
import { useWorkspaceRole } from "@/hooks/useWorkspaceRole";
import { filterPersonas, isFiltering, NO_PERSONA_FILTER, type PersonaFilter } from "@/lib/personaFilters";
import { personaResearchCompleteness } from "@shared/researchShape";
import { StartCampaignFromPersona } from "@/components/usip/research/StartCampaignFromPersona";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Per-section collapse map, keyed "cat:<id>" / "uncat". UI-only state. */
const SECTIONS_LS_KEY = "velocity_personas_sections_collapsed";
function loadCollapsedSections(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(SECTIONS_LS_KEY) ?? "{}") ?? {}; } catch { return {}; }
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
  const { data: sectorOptions = [] } = trpc.research.sectors.options.useQuery();
  const personaResults = usePersonaResultSummaries();
  const sectorName = new Map(sectorOptions.map((x) => [x.id, x.name]));
  const create = trpc.personas.create.useMutation();
  const update = trpc.personas.update.useMutation();
  const del = trpc.personas.delete.useMutation();
  const fromPreset = trpc.personas.createFromPreset.useMutation();
  const createCategory = trpc.personas.createCategory.useMutation();
  const updateCategory = trpc.personas.updateCategory.useMutation();
  const deleteCategory = trpc.personas.deleteCategory.useMutation();
  const reorderCategories = trpc.personas.reorderCategories.useMutation();
  const utils = trpc.useUtils();
  // A manager writes personas and categories, an admin deletes them (P31);
  // nobody is offered a control the server would refuse.
  const { isManager: canEdit, isAdmin: canDelete } = useWorkspaceRole();

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  // Search and filters (audit 2026-10-20, U18).
  const [filter, setFilter] = useState<PersonaFilter>(NO_PERSONA_FILTER);
  const filtering = isFiltering(filter);
  const [form, setForm] = useState<PersonaForm>(EMPTY_PERSONA);

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
    setForm({ ...EMPTY_PERSONA, categoryId });
    setEditingId(null);
    setOpen(true);
  };
  const startEdit = (p: any) => {
    setForm(personaFormFrom(p));
    setEditingId(p.id);
    setOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    try {
      // What the cleaner removed as personal data is said (audit 2026-10-20, P125).
      if (editingId) {
        reportDropped((await update.mutateAsync({ id: editingId, ...personaPayload(form) })).dropped);
        toast.success("Persona updated");
      } else {
        reportDropped((await create.mutateAsync(personaPayload(form))).dropped);
        toast.success("Persona created");
      }
      setOpen(false);
      await refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Save failed");
    }
  };

  const applyPreset = async (key: string) => {
    // One click, one persona: a second click while the first is saving made two (P125).
    if (fromPreset.isPending) return;
    try {
      await fromPreset.mutateAsync({ presetKey: key });
      toast.success("Preset added to your personas");
      await refetch();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed");
    }
  };

  const remove = async (id: number) => {
    // Which campaigns' writers use it, said before it goes; an active one stops it (P32).
    let campaigns: { name: string; status: string }[] = [];
    try {
      campaigns = (await utils.personas.usage.fetch({ id })).campaigns;
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't check which campaigns use this persona");
      return;
    }
    const live = campaigns.filter((c) => c.status === "active");
    if (live.length) {
      toast.error(`${live.length === 1 ? `The active campaign "${live[0].name}" uses` : `${live.length} active campaigns use`} this persona. Pause ${live.length === 1 ? "it" : "them"}, or give ${live.length === 1 ? "it" : "them"} another persona, first.`);
      return;
    }
    const used = campaigns.length
      ? ` ${campaigns.length === 1 ? `The campaign "${campaigns[0].name}" uses` : `${campaigns.length} campaigns use`} it and will be left with no persona.`
      : "";
    confirmAction({ title: "Delete this persona?", description: `This targeting template will be permanently deleted.${used} This cannot be undone.`, confirmLabel: "Delete" }, async () => {
      try {
        await del.mutateAsync({ id });
        toast.success("Persona deleted");
        await refetch();
      } catch (e: any) {
        toast.error(e?.message ?? "Delete failed");
      }
    });
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

  const removeCategory = (c: any) => {
    confirmAction(
      { title: `Delete category "${c.name}"?`, description: "Its personas move to Uncategorized.", confirmLabel: "Delete" },
      async () => {
        try {
          await deleteCategory.mutateAsync({ id: c.id });
          await Promise.all([refetchCats(), refetch()]);
        } catch (e: any) {
          toast.error(e?.message ?? "Delete failed");
        }
      },
    );
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
  const visible = filterPersonas(list as any[], filter, sectorName);
  for (const p of visible) {
    const key = p.categoryId != null && catIds.has(p.categoryId) ? (p.categoryId as number) : null;
    const arr = personasByCat.get(key) ?? [];
    arr.push(p);
    personasByCat.set(key, arr);
  }
  const uncategorized = personasByCat.get(null) ?? [];

  const renderPersona = (p: any) => {
    // Writers pass over a persona with no research; say so (U18).
    const research = personaResearchCompleteness(p);
    const used = p.campaignCount ?? 0;
    return (
    <div key={p.id} className="flex items-start justify-between border rounded p-3">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm">{p.name}</div>
        {p.description && <div className="text-xs text-muted-foreground">{p.description}</div>}
        <div className="flex flex-wrap gap-1 mt-1.5">
          {p.sectorId != null && sectorName.has(p.sectorId) && (
            <Link href={`/research/sectors/${p.sectorId}`}>
              <Badge variant="outline" className="text-[10px] gap-1 cursor-pointer hover:bg-accent">
                <Telescope className="size-3" /> {sectorName.get(p.sectorId)}
              </Badge>
            </Link>
          )}
          {icpLabels(p.targetTitles, "title").slice(0, 4).map((t) => (
            <Badge key={"t-" + t} variant="secondary" className="text-[10px]">{t}</Badge>
          ))}
          {icpLabels(p.targetIndustries, "industry").slice(0, 3).map((t) => (
            <Badge key={"i-" + t} variant="outline" className="text-[10px]">{t}</Badge>
          ))}
          {(p.employeeMin || p.employeeMax) && (
            <Badge variant="outline" className="text-[10px]">
              {p.employeeMin ?? 0}–{p.employeeMax ?? "∞"} emp
            </Badge>
          )}
          <PersonaResultsBadge personaId={p.id} name={p.name} tally={personaResults[p.id]} />
          <Badge
            variant="outline"
            className={`text-[10px] ${research.level === "complete" ? "border-emerald-300 text-emerald-700 dark:text-emerald-300" : research.level === "partial" ? "border-amber-300 text-amber-700 dark:text-amber-300" : "border-rose-300 text-rose-700 dark:text-rose-300"}`}
            title={research.level === "none" ? "The AI writers skip a persona with no research when they match by job title." : research.missing.length ? `Missing: ${research.missing.join(", ")}` : "What they care about, pains, objections and the angle are all filled in."}
          >
            {research.level === "none" ? "No research: writers skip it" : `Research ${research.filled} of ${research.of}`}
          </Badge>
          <Badge variant="outline" className="text-[10px]" title={used ? `${p.activeCampaignCount ?? 0} of them active` : "No Revenue Engine campaign uses this persona"}>
            {used ? `Used by ${used} campaign${used === 1 ? "" : "s"}` : "Not used by a campaign"}
          </Badge>
        </div>
      </div>
      <div className="flex gap-1 shrink-0 items-start">
        <StartCampaignFromPersona persona={p} sectorName={p.sectorId != null ? sectorName.get(p.sectorId) ?? null : null} />
        {canEdit && (
          <Button aria-label="Edit persona" size="sm" variant="ghost" onClick={() => startEdit(p)}>
            <Pencil className="size-3.5" />
          </Button>
        )}
        {canDelete && (
          <Button aria-label="Delete persona" size="sm" variant="ghost" onClick={() => remove(p.id)}>
            <Trash2 className="size-3.5 text-destructive" />
          </Button>
        )}
      </div>
    </div>
    );
  };

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
        description="The buyers you sell to: who to find, what they care about, and what they push back on."
      >
        {canEdit && (
          <>
            <Button variant="outline" onClick={startCreateCategory}>
              <FolderPlus className="size-4 mr-1" /> New category
            </Button>
            <Button onClick={() => startCreate()}>
              <Plus className="size-4 mr-1" /> New persona
            </Button>
          </>
        )}
      </PageHeader>
      <ResearchSubNav />

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
            <CardDescription>{canEdit ? "One-click starting points. Click to clone into your personas list." : "Starting points a manager can clone into your personas list."}</CardDescription>
          )}
        </CardHeader>
        {!presetsCollapsed && (
          <CardContent>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 max-h-[40vh] overflow-y-auto pr-1">
              {presets.map((p: any) => (
                <button
                  key={p.key}
                  onClick={() => applyPreset(p.key)}
                  disabled={!canEdit || fromPreset.isPending}
                  className="text-left border rounded p-3 hover:bg-accent transition disabled:opacity-60 disabled:pointer-events-none"
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

      {/* Search and filters (U18) */}
      {(list as any[]).length > 0 && (
        <Card className="mb-4 shrink-0">
          <CardContent className="pt-6 flex flex-wrap items-end gap-3">
            <div className="space-y-1 flex-1 min-w-[12rem]">
              <Label htmlFor="persona-search" className="text-xs">Search</Label>
              <Input id="persona-search" placeholder="Name, title, industry, keyword or sector" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Sector</Label>
              <Select value={String(filter.sector)} onValueChange={(v) => setFilter({ ...filter, sector: v === "any" || v === "none" ? v : Number(v) })}>
                <SelectTrigger aria-label="Sector" className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any sector</SelectItem>
                  <SelectItem value="none">No sector</SelectItem>
                  {sectorOptions.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Research</Label>
              <Select value={filter.research} onValueChange={(v) => setFilter({ ...filter, research: v as PersonaFilter["research"] })}>
                <SelectTrigger aria-label="Research" className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  <SelectItem value="complete">Complete</SelectItem>
                  <SelectItem value="partial">Partly filled in</SelectItem>
                  <SelectItem value="none">None</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Campaigns</Label>
              <Select value={filter.use} onValueChange={(v) => setFilter({ ...filter, use: v as PersonaFilter["use"] })}>
                <SelectTrigger aria-label="Campaigns" className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  <SelectItem value="used">Used by a campaign</SelectItem>
                  <SelectItem value="unused">Not used</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {filtering && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground pb-2">
                <span role="status">{visible.length} of {(list as any[]).length} match</span>
                <Button size="sm" variant="ghost" className="h-7" onClick={() => setFilter(NO_PERSONA_FILTER)}>Clear</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Saved personas, one collapsible section per category */}
      {error ? (
        <Card className="shrink-0"><CardContent className="pt-6"><QueryError message={error.message} onRetry={() => refetch()} /></CardContent></Card>
      ) : isLoading ? (
        <Card className="shrink-0"><CardContent className="pt-6"><TableSkeleton rows={5} /></CardContent></Card>
      ) : (
        <div className="space-y-4">
          {filtering && visible.length === 0 && (
            <Card className="shrink-0"><CardContent className="pt-6 text-sm text-muted-foreground text-center">No personas match. <Button size="sm" variant="link" onClick={() => setFilter(NO_PERSONA_FILTER)}>Clear the filters</Button></CardContent></Card>
          )}
          {/* While filtering, a category with no match is left out. */}
          {cats.map((c: any, i: number) => (filtering && !(personasByCat.get(c.id) ?? []).length) ? null : (
            <SectionCard
              key={c.id}
              title={c.name}
              count={(personasByCat.get(c.id) ?? []).length}
              collapsed={!!collapsedSections[`cat:${c.id}`]}
              onToggle={() => toggleSection(`cat:${c.id}`)}
              actions={(canEdit || canDelete) &&
                <div className="flex gap-1 shrink-0">
                  {canEdit && (<>
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
                  </>)}
                  {canDelete && (
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" title="Delete category" onClick={() => removeCategory(c)}>
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  )}
                </div>
              }
            >
              {personaList(personasByCat.get(c.id) ?? [], canEdit ? "No personas in this category yet. Use the + above to add one." : "No personas in this category yet.")}
            </SectionCard>
          ))}

          {/* Uncategorized — always present when it has personas; doubles as
              the only section while no categories exist yet. Not movable or
              deletable since it's the fallback, not a real category. */}
          {(uncategorized.length > 0 || (!filtering && cats.length === 0)) && (
            <SectionCard
              title={cats.length === 0 ? "Your personas" : "Uncategorized"}
              count={uncategorized.length}
              collapsed={!!collapsedSections["uncat"]}
              onToggle={() => toggleSection("uncat")}
            >
              {personaList(uncategorized, canEdit ? "No personas yet. Create one above or clone a preset." : "No personas yet.")}
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
          <PersonaFormFields form={form} setForm={setForm} categories={cats} sectors={sectorOptions} />
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
            <Input aria-label="Name"
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
