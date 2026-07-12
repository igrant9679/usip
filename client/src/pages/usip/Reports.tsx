/**
 * Reports — the customizable report builder (/reports).
 *
 * Left panel = the spec: object, columns, filters, optional group-by with an
 * aggregate, sort, row cap. Right panel = live results. Reports save per
 * workspace (reports.save/list) and export to CSV. All field access is
 * validated server-side against per-object whitelists (reports.schema).
 */
import { useMemo, useState } from "react";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  BarChart3, Download, FolderOpen, Loader2, Play, Plus, Save, Trash2, X,
} from "lucide-react";

type Filter = { field: string; op: string; value?: string };
type Spec = {
  object: string;
  columns: string[];
  filters: Filter[];
  groupBy?: string;
  aggregate?: "count" | "sum_value" | "avg_value";
  aggregateField?: string;
  sort?: { field: string; dir: "asc" | "desc" };
  limit: number;
};

const OBJECT_LABELS: Record<string, string> = {
  deals: "Deals",
  leads: "Leads",
  prospects: "Prospects",
  contacts: "Contacts",
  activities: "Activities",
};

const OPS: Array<{ value: string; label: string; needsValue: boolean }> = [
  { value: "eq", label: "equals", needsValue: true },
  { value: "neq", label: "not equal", needsValue: true },
  { value: "contains", label: "contains", needsValue: true },
  { value: "gt", label: ">", needsValue: true },
  { value: "gte", label: "≥", needsValue: true },
  { value: "lt", label: "<", needsValue: true },
  { value: "lte", label: "≤", needsValue: true },
  { value: "is_empty", label: "is empty", needsValue: false },
  { value: "not_empty", label: "is not empty", needsValue: false },
];

function fmtCell(v: unknown, kind: string): string {
  if (v == null || v === "") return "—";
  if (kind === "date") {
    const d = new Date(v as string);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  if (kind === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString() : String(v);
  }
  return String(v);
}

const selectCls = "h-8 rounded-md border border-border bg-background px-2 text-[12.5px]";

export default function Reports() {
  const accent = useAccentColor();
  const schema = trpc.reports.schema.useQuery();
  const saved = trpc.reports.list.useQuery();

  const [spec, setSpec] = useState<Spec>({ object: "deals", columns: [], filters: [], limit: 200 });
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const [loadedName, setLoadedName] = useState<string>("");
  const [saveOpen, setSaveOpen] = useState(false);
  const [armed, setArmed] = useState(false); // true once the user hits Run

  const objSchema = schema.data?.[spec.object];
  // Seed default columns once the schema arrives / object changes.
  const effectiveColumns = spec.columns.length ? spec.columns : (objSchema?.defaultColumns ?? []);
  const runnableSpec = useMemo(
    () => ({ ...spec, columns: effectiveColumns }) as Spec,
    [spec, effectiveColumns],
  );

  const result = trpc.reports.run.useQuery(runnableSpec as never, {
    enabled: armed && effectiveColumns.length > 0,
  });
  const exportCsv = trpc.reports.exportCsv.useMutation({
    onSuccess: (r) => {
      const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(loadedName || spec.object)}-report.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${r.rows} rows`);
    },
    onError: (e) => toast.error(e.message),
  });
  const utils = trpc.useUtils();
  const save = trpc.reports.save.useMutation({
    onSuccess: (r) => { utils.reports.list.invalidate(); setLoadedId(r.id); setSaveOpen(false); toast.success("Report saved"); },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.reports.remove.useMutation({
    onSuccess: () => { utils.reports.list.invalidate(); toast.success("Report deleted"); },
    onError: (e) => toast.error(e.message),
  });

  const setObject = (object: string) => {
    setSpec({ object, columns: [], filters: [], limit: 200 });
    setLoadedId(null); setLoadedName(""); setArmed(false);
  };
  const toggleColumn = (key: string) => {
    setSpec((s) => {
      const cols = (s.columns.length ? s.columns : (objSchema?.defaultColumns ?? []));
      return { ...s, columns: cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key] };
    });
  };
  const loadSaved = (r: Record<string, any>) => {
    setSpec(r.config as Spec);
    setLoadedId(r.id);
    setLoadedName(r.name);
    setArmed(true);
  };

  const columnsMeta = objSchema?.columns ?? [];
  const numericFields = columnsMeta.filter((c) => c.kind === "number");

  return (
    <Shell title="Reports">
      <div className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <BarChart3 className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Reports</h1>
          {loadedName && <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{loadedName}</span>}
          <div className="flex-1" />
          <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={!armed || exportCsv.isPending} onClick={() => exportCsv.mutate(runnableSpec as never)}>
            {exportCsv.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Export CSV
          </Button>
          <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => setSaveOpen(true)} disabled={effectiveColumns.length === 0}>
            <Save className="size-3.5" /> Save
          </Button>
          <Button size="sm" className="h-7 gap-1.5" onClick={() => setArmed(true)} disabled={effectiveColumns.length === 0}>
            <Play className="size-3.5" /> Run
          </Button>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* ── builder panel ── */}
          <aside className="w-72 shrink-0 border-r border-border overflow-y-auto p-3 space-y-4 bg-card/30">
            {/* saved reports */}
            {(saved.data ?? []).length > 0 && (
              <section>
                <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Saved reports</h2>
                <div className="space-y-0.5">
                  {(saved.data as Record<string, any>[]).map((r) => (
                    <div key={r.id} className={cn("group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] hover:bg-muted", loadedId === r.id && "bg-muted font-medium")}>
                      <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => loadSaved(r)}>
                        <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{r.name}</span>
                        <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">{OBJECT_LABELS[r.object] ?? r.object}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${r.name}`}
                        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:text-rose-600 group-hover:opacity-100"
                        onClick={() => { if (confirm(`Delete report "${r.name}"?`)) remove.mutate({ id: r.id }); }}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* object */}
            <section>
              <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Report on</h2>
              <select value={spec.object} onChange={(e) => setObject(e.target.value)} className={cn(selectCls, "w-full")}>
                {Object.entries(OBJECT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </section>

            {/* columns */}
            <section>
              <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Columns</h2>
              <div className="space-y-1">
                {columnsMeta.map((c) => (
                  <label key={c.key} className="flex cursor-pointer items-center gap-2 text-[12.5px]">
                    <input type="checkbox" className="accent-current" checked={effectiveColumns.includes(c.key)} onChange={() => toggleColumn(c.key)} />
                    {c.label}
                  </label>
                ))}
              </div>
            </section>

            {/* filters */}
            <section>
              <div className="mb-1.5 flex items-center justify-between">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Filters</h2>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-[11.5px] font-medium hover:underline"
                  style={{ color: accent }}
                  onClick={() => setSpec((s) => ({ ...s, filters: [...s.filters, { field: columnsMeta[0]?.key ?? "", op: "contains", value: "" }] }))}
                >
                  <Plus className="size-3" /> Add
                </button>
              </div>
              <div className="space-y-2">
                {spec.filters.map((f, i) => {
                  const op = OPS.find((o) => o.value === f.op);
                  const patch = (p: Partial<Filter>) => setSpec((s) => ({ ...s, filters: s.filters.map((x, j) => (j === i ? { ...x, ...p } : x)) }));
                  return (
                    <div key={i} className="space-y-1 rounded-md border border-border/70 p-1.5">
                      <div className="flex items-center gap-1">
                        <select value={f.field} onChange={(e) => patch({ field: e.target.value })} className={cn(selectCls, "min-w-0 flex-1")}>
                          {columnsMeta.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                        </select>
                        <button type="button" aria-label="Remove filter" className="shrink-0 rounded p-1 text-muted-foreground hover:text-rose-600" onClick={() => setSpec((s) => ({ ...s, filters: s.filters.filter((_, j) => j !== i) }))}>
                          <X className="size-3.5" />
                        </button>
                      </div>
                      <div className="flex items-center gap-1">
                        <select value={f.op} onChange={(e) => patch({ op: e.target.value })} className={cn(selectCls, "w-28 shrink-0")}>
                          {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        {op?.needsValue !== false && (
                          <Input value={f.value ?? ""} onChange={(e) => patch({ value: e.target.value })} placeholder="value" className="h-8 min-w-0 flex-1 text-[12.5px]" />
                        )}
                      </div>
                    </div>
                  );
                })}
                {spec.filters.length === 0 && <p className="text-[11.5px] text-muted-foreground">No filters — all rows.</p>}
              </div>
            </section>

            {/* group by */}
            <section>
              <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Group by</h2>
              <select
                value={spec.groupBy ?? ""}
                onChange={(e) => setSpec((s) => ({ ...s, groupBy: e.target.value || undefined, aggregate: e.target.value ? (s.aggregate ?? "count") : undefined }))}
                className={cn(selectCls, "w-full")}
              >
                <option value="">No grouping (row list)</option>
                {columnsMeta.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
              {spec.groupBy && (
                <div className="mt-1.5 flex items-center gap-1.5">
                  <select
                    value={spec.aggregate ?? "count"}
                    onChange={(e) => setSpec((s) => ({ ...s, aggregate: e.target.value as Spec["aggregate"] }))}
                    className={cn(selectCls, "flex-1")}
                  >
                    <option value="count">Count rows</option>
                    <option value="sum_value">Sum of…</option>
                    <option value="avg_value">Average of…</option>
                  </select>
                  {spec.aggregate && spec.aggregate !== "count" && (
                    <select
                      value={spec.aggregateField ?? numericFields[0]?.key ?? ""}
                      onChange={(e) => setSpec((s) => ({ ...s, aggregateField: e.target.value }))}
                      className={cn(selectCls, "flex-1")}
                    >
                      {numericFields.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select>
                  )}
                </div>
              )}
            </section>

            {/* sort + limit */}
            {!spec.groupBy && (
              <section>
                <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sort & limit</h2>
                <div className="flex items-center gap-1.5">
                  <select
                    value={spec.sort?.field ?? ""}
                    onChange={(e) => setSpec((s) => ({ ...s, sort: e.target.value ? { field: e.target.value, dir: s.sort?.dir ?? "desc" } : undefined }))}
                    className={cn(selectCls, "min-w-0 flex-1")}
                  >
                    <option value="">Default order</option>
                    {columnsMeta.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                  {spec.sort && (
                    <select value={spec.sort.dir} onChange={(e) => setSpec((s) => ({ ...s, sort: s.sort ? { ...s.sort, dir: e.target.value as "asc" | "desc" } : undefined }))} className={cn(selectCls, "w-20 shrink-0")}>
                      <option value="desc">Desc</option>
                      <option value="asc">Asc</option>
                    </select>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-2 text-[12.5px] text-muted-foreground">
                  Max rows
                  <select value={spec.limit} onChange={(e) => setSpec((s) => ({ ...s, limit: Number(e.target.value) }))} className={cn(selectCls, "w-24")}>
                    {[50, 200, 500, 1000].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </section>
            )}
          </aside>

          {/* ── results ── */}
          <div className="flex-1 min-w-0 overflow-auto">
            {!armed ? (
              <div className="flex h-full items-center justify-center p-8">
                <div className="max-w-md text-center">
                  <BarChart3 className="mx-auto size-10 opacity-40" style={{ color: accent }} />
                  <div className="mt-3 text-[15px] font-semibold">Build a report</div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                    Pick an object and columns on the left, stack filters, optionally group with a count / sum /
                    average — then hit <span className="font-medium text-foreground">Run</span>. Save reports
                    you'll reuse and export any result to CSV.
                  </p>
                </div>
              </div>
            ) : result.isLoading ? (
              <div className="space-y-2 p-4">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-9 rounded bg-muted/50 animate-pulse" />)}</div>
            ) : result.error ? (
              <div className="p-8 text-center text-[13px] text-muted-foreground">Couldn't run the report: {result.error.message}</div>
            ) : (
              <>
                <div className="flex items-center gap-2 border-b border-border/70 px-4 py-2 text-[12px] text-muted-foreground">
                  <span className="font-medium text-foreground tabular-nums">{result.data?.rows.length ?? 0}</span>
                  {result.data?.grouped ? "groups" : "rows"}
                  {result.isFetching && <Loader2 className="size-3 animate-spin" />}
                </div>
                <table className="w-full border-separate border-spacing-0 text-[13px]">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      {(result.data?.columns ?? []).map((c) => (
                        <th key={c.key} className="sticky top-0 z-10 whitespace-nowrap border-b border-border bg-card px-3 py-2 font-semibold">{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(result.data?.rows ?? []).map((r, i) => (
                      <tr key={i} className="bg-background hover:bg-muted/40">
                        {(result.data?.columns ?? []).map((c) => (
                          <td key={c.key} className={cn("border-b border-border/60 px-3 py-2 align-middle", c.kind === "number" && "tabular-nums")}>
                            {fmtCell(r[c.key], c.kind)}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {(result.data?.rows ?? []).length === 0 && (
                      <tr><td colSpan={(result.data?.columns ?? []).length || 1} className="px-4 py-10 text-center text-muted-foreground">No rows match this report.</td></tr>
                    )}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      </div>

      {/* save dialog */}
      <Dialog open={saveOpen} onOpenChange={(o) => !o && setSaveOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{loadedId ? "Save report" : "Save new report"}</DialogTitle>
            <DialogDescription>Saved reports keep the object, columns, filters, grouping and sort.</DialogDescription>
          </DialogHeader>
          <SaveForm
            initialName={loadedName}
            canUpdate={!!loadedId}
            saving={save.isPending}
            onSave={(name, asNew) => save.mutate({ ...(loadedId && !asNew ? { id: loadedId } : {}), name, spec: runnableSpec as never })}
          />
        </DialogContent>
      </Dialog>
    </Shell>
  );
}

function SaveForm({
  initialName, canUpdate, saving, onSave,
}: {
  initialName: string;
  canUpdate: boolean;
  saving: boolean;
  onSave: (name: string, asNew: boolean) => void;
}) {
  const [name, setName] = useState(initialName);
  return (
    <div className="space-y-3">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Open deals by stage" autoFocus />
      <div className="flex justify-end gap-2">
        {canUpdate && (
          <Button variant="outline" size="sm" disabled={!name.trim() || saving} onClick={() => onSave(name.trim(), true)}>
            Save as new
          </Button>
        )}
        <Button size="sm" disabled={!name.trim() || saving} onClick={() => onSave(name.trim(), false)} className="gap-1.5">
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} {canUpdate ? "Update" : "Save"}
        </Button>
      </div>
    </div>
  );
}
