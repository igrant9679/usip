/**
 * SearchSettingsSheet — the right-hand "Search settings" panel and its two
 * drill-in sub-panels (Fields, Filters). One component, two modes:
 *
 *   mode="settings"  → gear-button panel: just the Fields + Filters rows.
 *   mode="create"    → "Save as new search" flow: a required name field, the
 *                      same Fields/Filters rows, Visibility (Restricted) and
 *                      Subscription (None) rows, and a Cancel / Create search
 *                      footer that stays disabled until a name is entered.
 *
 * Fields sub-panel: the displayed columns with drag handles (native reorder),
 * icon, label and a remove ✕ (core Name/Actions columns are locked), plus an
 * "Add fields to table" expander with a search box, Person/Company tabs and the
 * grouped available-field catalogue. Adding/removing updates the live table
 * columns. Filters sub-panel: the applied filters as removable pills, grouped
 * by filter; removing one updates the active filter count.
 *
 * The sheet relies on SheetContent's built-in top-right ✕ to close; the back
 * arrow only returns a sub-panel to the main view.
 */
import { useEffect, useMemo, useState } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  ChevronRight,
  ChevronDown,
  GripVertical,
  X,
  Plus,
  Search,
  Lock,
  ListFilter,
  AlignLeft,
  Bell,
  ListChecks,
} from "lucide-react";
import {
  COLUMN_REGISTRY,
  PERSON_FIELD_GROUPS,
  COMPANY_FIELD_GROUPS,
  type ColumnKey,
} from "./peopleShared";

export type AppliedFilter = { id: string; group: string; label: string };

type View = "main" | "fields" | "filters";

export function SearchSettingsSheet({
  open,
  onOpenChange,
  mode,
  columns,
  onColumnsChange,
  filters,
  onRemoveFilter,
  onCreateSearch,
  initialView = "main",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mode: "settings" | "create";
  columns: ColumnKey[];
  onColumnsChange: (cols: ColumnKey[]) => void;
  filters: AppliedFilter[];
  onRemoveFilter: (id: string) => void;
  onCreateSearch?: (name: string) => void;
  /** Jump straight to a sub-panel on open (e.g. "+ Add column" → fields). */
  initialView?: View;
}) {
  const [view, setView] = useState<View>(initialView);
  const [name, setName] = useState("");

  // Each fresh open starts on the requested view; create-mode clears the name.
  useEffect(() => {
    if (open) { setView(initialView); if (mode === "create") setName(""); }
  }, [open, mode, initialView]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-sm p-0 gap-0 flex flex-col">
        {view === "main" && (
          <MainView
            mode={mode}
            name={name}
            setName={setName}
            fieldCount={columns.length}
            filterCount={filters.length}
            onFields={() => setView("fields")}
            onFilters={() => setView("filters")}
            onCancel={() => onOpenChange(false)}
            onCreate={() => { onCreateSearch?.(name.trim()); onOpenChange(false); }}
          />
        )}
        {view === "fields" && (
          <FieldsView columns={columns} onColumnsChange={onColumnsChange} onBack={() => setView("main")} />
        )}
        {view === "filters" && (
          <FiltersView filters={filters} onRemoveFilter={onRemoveFilter} onBack={() => setView("main")} />
        )}
      </SheetContent>
    </Sheet>
  );
}

/* ──────────────────────────────── main ────────────────────────────────── */

function MainView({
  mode, name, setName, fieldCount, filterCount, onFields, onFilters, onCancel, onCreate,
}: {
  mode: "settings" | "create";
  name: string;
  setName: (s: string) => void;
  fieldCount: number;
  filterCount: number;
  onFields: () => void;
  onFilters: () => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const canCreate = name.trim().length > 0;
  return (
    <>
      <div className="px-4 pt-4 pb-2 pr-10 shrink-0">
        <SheetTitle className="text-base">Search settings</SheetTitle>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2 space-y-5">
        {mode === "create" && (
          <div className="space-y-1.5">
            <label className="text-[13px] font-medium">
              Saved search name <span className="text-rose-500">*</span>
            </label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Choose a search name" className="h-9" />
          </div>
        )}

        <div className="space-y-2">
          <div className="text-[12px] font-medium text-muted-foreground">Fields</div>
          <SettingRow icon={ListChecks} label="Fields" trailing={String(fieldCount)} onClick={onFields} chevron />
        </div>

        <div className="space-y-2">
          <div className="text-[12px] font-medium text-muted-foreground">Applied filters</div>
          <SettingRow icon={AlignLeft} label="Filters" trailing={String(filterCount)} onClick={onFilters} chevron />
        </div>

        {mode === "create" && (
          <div className="space-y-2">
            <div className="text-[12px] font-medium text-muted-foreground">More settings</div>
            <SettingRow icon={Lock} label="Visibility and sharing" trailing="Restricted" />
            <SettingRow icon={Bell} label="Subscription alerts" trailing="None" />
          </div>
        )}
      </div>

      {mode === "create" && (
        <div className="shrink-0 border-t p-3 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button disabled={!canCreate} onClick={onCreate}>Create search</Button>
        </div>
      )}
    </>
  );
}

function SettingRow({
  icon: Icon, label, trailing, onClick, chevron,
}: {
  icon: any;
  label: string;
  trailing?: string;
  onClick?: () => void;
  chevron?: boolean;
}) {
  const Cmp: any = onClick ? "button" : "div";
  return (
    <Cmp
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2.5 rounded-md px-2 py-2 text-[13px] text-left",
        onClick && "hover:bg-muted",
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex-1">{label}</span>
      {trailing && <span className="text-[13px] text-muted-foreground tabular-nums">{trailing}</span>}
      {chevron && <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
    </Cmp>
  );
}

/* ─────────────────────────────── fields ───────────────────────────────── */

function FieldsView({
  columns, onColumnsChange, onBack,
}: {
  columns: ColumnKey[];
  onColumnsChange: (cols: ColumnKey[]) => void;
  onBack: () => void;
}) {
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(true);
  const [tab, setTab] = useState<"person" | "company">("person");
  const [q, setQ] = useState("");

  const visible = useMemo(() => new Set(columns), [columns]);
  const groups = tab === "person" ? PERSON_FIELD_GROUPS : COMPANY_FIELD_GROUPS;

  const remove = (key: ColumnKey) => {
    if (COLUMN_REGISTRY[key].locked) return;
    onColumnsChange(columns.filter((c) => c !== key));
  };
  const add = (key: ColumnKey) => {
    if (visible.has(key)) return;
    onColumnsChange([...columns, key]);
  };

  const reorder = (from: number, to: number) => {
    if (from === to) return;
    const next = [...columns];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onColumnsChange(next);
  };

  // count of available (table-mapped, not-yet-added) fields across the catalogue
  const availableCount = useMemo(() => {
    const keys = new Set<ColumnKey>();
    [...PERSON_FIELD_GROUPS, ...COMPANY_FIELD_GROUPS].forEach((g) =>
      g.fields.forEach((f) => { if (f.columnKey && !visible.has(f.columnKey)) keys.add(f.columnKey); }),
    );
    return keys.size;
  }, [visible]);

  return (
    <>
      <PanelHeader title="Fields" onBack={onBack} />

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
        <div className="text-[12px] text-muted-foreground mb-2">
          Displayed fields <span className="ml-1 font-medium text-foreground tabular-nums">{columns.length}</span>
        </div>

        <div className="space-y-1.5">
          {columns.map((key, i) => {
            const def = COLUMN_REGISTRY[key];
            const locked = !!def.locked;
            return (
              <div
                key={key}
                draggable={!locked}
                onDragStart={() => setDragIdx(i)}
                onDragEnter={() => setOverIdx(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { if (dragIdx !== null) reorder(dragIdx, i); setDragIdx(null); setOverIdx(null); }}
                onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                className={cn(
                  "flex items-center gap-2 rounded-md border bg-card px-2 py-2 text-[13px]",
                  locked && "opacity-55",
                  overIdx === i && dragIdx !== null && dragIdx !== i && "border-violet-400 ring-1 ring-violet-300",
                )}
              >
                <GripVertical className={cn("size-4 shrink-0 text-muted-foreground", locked ? "cursor-not-allowed" : "cursor-grab")} />
                <def.icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{def.label}</span>
                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/70" />
                <button
                  type="button"
                  onClick={() => remove(key)}
                  disabled={locked}
                  className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label={`Remove ${def.label}`}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>

        {/* add fields to table */}
        <div className="mt-4 border-t pt-3">
          <button
            type="button"
            onClick={() => setAddOpen((v) => !v)}
            className="w-full flex items-center gap-2 text-[13px] font-medium text-violet-600 dark:text-violet-400"
          >
            <Plus className="size-4" /> Add fields to table
            <span className="ml-auto flex items-center gap-1 text-muted-foreground tabular-nums">
              {availableCount}
              <ChevronRight className={cn("size-3.5 transition-transform", addOpen && "rotate-90")} />
            </span>
          </button>

          {addOpen && (
            <div className="mt-3 rounded-lg border">
              <div className="p-2 border-b">
                <div className="flex items-center gap-2 px-2 h-8 rounded-md border bg-background">
                  <Search className="size-3.5 text-muted-foreground shrink-0" />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="flex-1 bg-transparent outline-none text-[13px] min-w-0" />
                </div>
              </div>
              <div className="flex items-center gap-4 px-3 pt-2 border-b text-[13px]">
                {(["person", "company"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={cn(
                      "pb-2 -mb-px border-b-2 capitalize transition-colors",
                      tab === t ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div className="max-h-60 overflow-y-auto py-1">
                {groups.map((g) => {
                  const fields = g.fields.filter((f) => !q || f.label.toLowerCase().includes(q.toLowerCase()));
                  if (fields.length === 0) return null;
                  return (
                    <div key={g.title}>
                      <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground">{g.title}</div>
                      {fields.map((f) => {
                        const added = f.columnKey ? visible.has(f.columnKey) : false;
                        const actionable = !!f.columnKey && !added;
                        return (
                          <button
                            key={`${g.title}-${f.label}`}
                            type="button"
                            disabled={!actionable}
                            onClick={() => f.columnKey && add(f.columnKey)}
                            className={cn(
                              "w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-left",
                              actionable ? "hover:bg-muted" : "opacity-45 cursor-default",
                            )}
                          >
                            <f.icon className="size-4 shrink-0 text-muted-foreground" />
                            <span className="flex-1 truncate">{f.label}</span>
                            {f.count != null && <span className="text-[12px] text-muted-foreground tabular-nums">{f.count}</span>}
                            {f.drill ? (
                              <ChevronRight className="size-3.5 text-muted-foreground" />
                            ) : added ? (
                              <span className="text-[11px] text-muted-foreground">Added</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              <div className="border-t p-2 flex justify-end">
                <Button variant="outline" size="sm">Create field</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/* ─────────────────────────────── filters ──────────────────────────────── */

function FiltersView({
  filters, onRemoveFilter, onBack,
}: {
  filters: AppliedFilter[];
  onRemoveFilter: (id: string) => void;
  onBack: () => void;
}) {
  // group filters by their `group` label, preserving first-seen order
  const grouped = useMemo(() => {
    const map = new Map<string, AppliedFilter[]>();
    filters.forEach((f) => {
      const arr = map.get(f.group) ?? [];
      arr.push(f);
      map.set(f.group, arr);
    });
    return [...map.entries()];
  }, [filters]);

  return (
    <>
      <PanelHeader title="Filters" onBack={onBack} />
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4">
        {grouped.length === 0 ? (
          <div className="text-center py-10">
            <ListFilter className="size-8 mx-auto text-muted-foreground/50" />
            <p className="mt-2 text-[13px] text-muted-foreground">No filters applied. Add filters from the left rail.</p>
          </div>
        ) : (
          grouped.map(([group, items]) => (
            <div key={group} className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-violet-600 dark:text-violet-400">
                <ChevronDown className="size-3.5" /> {group}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {items.map((f) => (
                  <span key={f.id} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-[12px]">
                    {f.label}
                    <button
                      type="button"
                      onClick={() => onRemoveFilter(f.id)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={`Remove ${f.label}`}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

/* shared sub-panel header (back arrow + title; X is SheetContent's built-in). */
function PanelHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 h-12 border-b pr-12">
      <button type="button" onClick={onBack} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted" aria-label="Back">
        <ArrowLeft className="size-4" />
      </button>
      <SheetTitle className="text-base">{title}</SheetTitle>
    </div>
  );
}
