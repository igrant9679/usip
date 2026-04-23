/**
 * Dashboards — Custom Dashboard builder with:
 *   - react-grid-layout drag-to-resize and drag-to-reorder
 *   - 11 chart types (line, bar, stacked_bar, area, pie, donut, funnel,
 *     scatter, heatmap, gauge, single_value)
 *   - 6 widget types (leaderboard, activity_feed, goal_progress,
 *     comparison, pipeline_stage, rep_performance)
 *   - 9 KPI metrics
 *   - Global filter bar (date range presets, owner, stage, source)
 *   - Add/remove/resize/reorder widgets
 */
import "react-grid-layout/css/styles.css";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DashboardChartRenderer } from "@/components/usip/DashboardChartRenderer";
import {
  DashboardFilterBar,
  DashboardFilters,
} from "@/components/usip/DashboardFilterBar";
import { WidgetDataRenderer } from "@/components/usip/DashboardWidgets";
import { Field, FormDialog, Section, SelectField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import {
  BarChart2,
  LayoutDashboard,
  Pencil,
  Plus,
  Send,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GridLayout } from "react-grid-layout";
import type { Layout, LayoutItem } from "react-grid-layout";
import { toast } from "sonner";

/* ─── Constants ──────────────────────────────────────────────────────────── */

const CHART_TYPES = [
  { value: "line",          label: "Line chart" },
  { value: "bar",           label: "Bar chart" },
  { value: "stacked_bar",   label: "Stacked bar chart" },
  { value: "area",          label: "Area chart" },
  { value: "pie",           label: "Pie chart" },
  { value: "donut",         label: "Donut chart" },
  { value: "funnel",        label: "Funnel chart" },
  { value: "scatter",       label: "Scatter plot" },
  { value: "heatmap",       label: "Heatmap" },
  { value: "gauge",         label: "Gauge" },
  { value: "single_value",  label: "Single-value KPI" },
];

const WIDGET_TYPES = [
  { value: "kpi",            label: "KPI card" },
  { value: "leaderboard",    label: "Leaderboard" },
  { value: "activity_feed",  label: "Activity feed" },
  { value: "goal_progress",  label: "Goal progress bar" },
  { value: "comparison",     label: "Period comparison" },
  { value: "pipeline_stage", label: "Pipeline stage breakdown" },
  { value: "rep_performance",label: "Rep performance table" },
  { value: "email_health",   label: "Email health" },
  { value: "table",          label: "Top accounts table" },
];

const KPI_METRICS = [
  { value: "pipeline_value",    label: "Pipeline value" },
  { value: "revenue",           label: "Revenue (closed-won)" },
  { value: "closed_won_qtr",    label: "Closed-won (all time)" },
  { value: "win_rate",          label: "Win rate %" },
  { value: "avg_deal",          label: "Avg deal size" },
  { value: "sales_cycle_length",label: "Sales cycle length (days)" },
  { value: "activity_counts",   label: "Activity counts" },
  { value: "meetings_booked",   label: "Meetings booked" },
  { value: "response_rate",     label: "Response rate %" },
  { value: "reply_rate",        label: "Reply rate %" },
];

const CHART_METRICS = [
  { value: "closed_won",       label: "Closed-won revenue by month" },
  { value: "revenue",          label: "Revenue by month" },
  { value: "pipeline_created", label: "Pipeline created by month" },
  { value: "activities",       label: "Activity counts by month" },
];

const TIME_SERIES_TYPES = new Set(["line", "bar", "stacked_bar", "area"]);
const CHART_RENDERER_TYPES = new Set([
  "line", "bar", "stacked_bar", "area", "pie", "donut",
  "funnel", "scatter", "heatmap", "gauge", "single_value", "pipeline_stage",
]);

function defaultSize(type: string): { w: number; h: number } {
  switch (type) {
    case "kpi": case "single_value": case "gauge": case "goal_progress": case "comparison":
      return { w: 3, h: 4 };
    case "leaderboard": case "activity_feed": case "rep_performance": case "table":
      return { w: 4, h: 6 };
    case "heatmap":
      return { w: 6, h: 5 };
    case "pipeline_stage": case "funnel":
      return { w: 4, h: 5 };
    case "email_health":
      return { w: 3, h: 6 };
    default:
      return { w: 4, h: 5 };
  }
}

/* ─── Widget card ────────────────────────────────────────────────────────── */
interface WidgetCardProps {
  widgetId: number;
  filters: DashboardFilters;
  customizeMode: boolean;
  onRemove: () => void;
}

function WidgetCard({ widgetId, filters, customizeMode, onRemove }: WidgetCardProps) {
  const resolvedFilters = useMemo(() => {
    if (filters.preset === "all") return undefined;
    return {
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      ownerUserId: filters.ownerUserId,
      stage: filters.stage,
      source: filters.source,
    };
  }, [filters]);

  const { data, isLoading } = trpc.dashboards.resolveWidget.useQuery(
    { id: widgetId, filters: resolvedFilters },
    { refetchOnWindowFocus: false },
  );

  const isChartType = data ? CHART_RENDERER_TYPES.has(data.type) : false;

  return (
    <div className="h-full flex flex-col bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex items-center px-3 pt-2.5 pb-1.5 gap-2 shrink-0">
        <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wide flex-1 truncate">
          {data?.title ?? "Loading…"}
        </span>
        {data && (
          <Badge variant="secondary" className="text-[9px] px-1 py-0 h-4 capitalize shrink-0">
            {data.type.replace(/_/g, " ")}
          </Badge>
        )}
        {customizeMode && (
          <button
            className="text-destructive hover:text-destructive/80 transition-colors shrink-0 drag-cancel"
            onClick={onRemove}
            title="Remove widget"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto px-3 pb-3 min-h-0">
        {isLoading && (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">Loading…</div>
        )}
        {!isLoading && data && (
          isChartType
            ? <DashboardChartRenderer data={data} />
            : <WidgetDataRenderer data={data} />
        )}
        {!isLoading && !data && (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No data</div>
        )}
      </div>

      {customizeMode && (
        <div
          className="drag-handle shrink-0 h-5 flex items-center justify-center cursor-grab active:cursor-grabbing bg-secondary/30 border-t border-border"
          title="Drag to reorder"
        >
          <div className="flex gap-0.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="w-0.5 h-2 bg-muted-foreground/40 rounded-full" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Add Widget dialog ──────────────────────────────────────────────────── */
interface AddWidgetDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdd: (payload: { type: string; title: string; config: Record<string, any>; position: { x: number; y: number; w: number; h: number } }) => void;
  isPending: boolean;
}

function AddWidgetDialog({ open, onOpenChange, onAdd, isPending }: AddWidgetDialogProps) {
  const [type, setType] = useState("kpi");
  const [title, setTitle] = useState("");
  const [metric, setMetric] = useState("pipeline_value");
  const [chartMetric, setChartMetric] = useState("closed_won");
  const [goalTarget, setGoalTarget] = useState("1000000");

  const isKpi = type === "kpi" || type === "single_value" || type === "gauge";
  const isTimeSeries = TIME_SERIES_TYPES.has(type);
  const isGoal = type === "goal_progress";

  const handleAdd = () => {
    if (!title.trim()) { toast.error("Title is required"); return; }
    let config: Record<string, any> = {};
    if (isKpi) config = { metric };
    else if (isTimeSeries) config = { metric: chartMetric };
    else if (isGoal) config = { target: Number(goalTarget) };
    else if (type === "table") config = { entity: "accounts", limit: 5 };
    else if (type === "leaderboard") config = { limit: 10 };
    else if (type === "activity_feed") config = { limit: 20 };
    else if (type === "rep_performance") config = { limit: 10 };
    const size = defaultSize(type);
    onAdd({ type, title: title.trim(), config, position: { x: 0, y: 9999, ...size } });
    setTitle("");
    setType("kpi");
    setMetric("pipeline_value");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add widget</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Pipeline value" className="h-8 text-sm" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Widget type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Charts</div>
                {CHART_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                <div className="px-2 py-1 mt-1 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold border-t border-border">Widgets</div>
                {WIDGET_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {isKpi && (
            <div className="space-y-1.5">
              <Label className="text-xs">KPI metric</Label>
              <Select value={metric} onValueChange={setMetric}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>{KPI_METRICS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {isTimeSeries && (
            <div className="space-y-1.5">
              <Label className="text-xs">Data series</Label>
              <Select value={chartMetric} onValueChange={setChartMetric}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>{CHART_METRICS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {isGoal && (
            <div className="space-y-1.5">
              <Label className="text-xs">Revenue target ($)</Label>
              <Input type="number" value={goalTarget} onChange={(e) => setGoalTarget(e.target.value)} className="h-8 text-sm" min={0} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={handleAdd} disabled={isPending}>{isPending ? "Adding…" : "Add widget"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN PAGE
═══════════════════════════════════════════════════════════════════════════ */
export default function Dashboards() {
  const utils = trpc.useUtils();
  const list = trpc.dashboards.list.useQuery();
  const members = trpc.workspace.members.useQuery();

  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    if (!selected && list.data?.[0]) setSelected(list.data[0].id);
  }, [list.data, selected]);

  const dash = trpc.dashboards.get.useQuery({ id: selected! }, { enabled: !!selected });
  const schedules = trpc.dashboards.listSchedules.useQuery();

  const [openNew, setOpenNew] = useState(false);
  const [openWidget, setOpenWidget] = useState(false);
  const [openSched, setOpenSched] = useState(false);
  const [openRename, setOpenRename] = useState(false);
  const [customizeMode, setCustomizeMode] = useState(false);
  const [filters, setFilters] = useState<DashboardFilters>({ preset: "all" });

  const gridRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(900);
  useEffect(() => {
    if (!gridRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setGridWidth(w);
    });
    obs.observe(gridRef.current);
    return () => obs.disconnect();
  }, []);

  /* ─── Mutations ─────────────────────────────────────────────────────────── */
  const create = trpc.dashboards.create.useMutation({
    onSuccess: (r) => { utils.dashboards.list.invalidate(); setSelected(r.id); setOpenNew(false); },
  });
  const rename = trpc.dashboards.rename.useMutation({
    onSuccess: () => { utils.dashboards.list.invalidate(); utils.dashboards.get.invalidate(); setOpenRename(false); toast.success("Dashboard renamed"); },
    onError: (e: any) => toast.error(e.message),
  });
  const delDash = trpc.dashboards.delete.useMutation({
    onSuccess: () => { utils.dashboards.list.invalidate(); setSelected(null); setCustomizeMode(false); },
  });
  const addW = trpc.dashboards.addWidget.useMutation({
    onSuccess: () => { utils.dashboards.get.invalidate(); setOpenWidget(false); toast.success("Widget added"); },
  });
  const delW = trpc.dashboards.deleteWidget.useMutation({
    onSuccess: () => utils.dashboards.get.invalidate(),
  });
  const saveLayout = trpc.dashboards.saveLayout.useMutation();
  const createSched = trpc.dashboards.createSchedule.useMutation({
    onSuccess: () => { utils.dashboards.listSchedules.invalidate(); setOpenSched(false); },
  });
  const sendNow = trpc.dashboards.sendScheduleNow.useMutation({
    onSuccess: () => { utils.dashboards.listSchedules.invalidate(); toast.success("Sent (stub)"); },
  });
  const delSched = trpc.dashboards.deleteSchedule.useMutation({
    onSuccess: () => utils.dashboards.listSchedules.invalidate(),
  });

  /* ─── Derived ───────────────────────────────────────────────────────────── */
  const widgets: any[] = (dash.data as any)?.widgets ?? [];

  const layout: Layout = useMemo(() =>
    widgets.map((w: any) => ({
      i: String(w.id),
      x: w.position?.x ?? 0,
      y: w.position?.y ?? 0,
      w: w.position?.w ?? 4,
      h: w.position?.h ?? 5,
      minW: 2,
      minH: 3,
    })),
    [widgets],
  );

  const memberOptions = useMemo(() =>
    (members.data ?? []).map((m: any) => ({ userId: m.userId, name: m.name ?? `User #${m.userId}` })),
    [members.data],
  );

  const onLayoutChange = useCallback((newLayout: Layout) => {
    if (!selected || !customizeMode) return;
    const positions = (newLayout as LayoutItem[]).map((l) => ({ id: Number(l.i), x: l.x, y: l.y, w: l.w, h: l.h }));
    saveLayout.mutate({ dashboardId: selected, positions });
  }, [selected, customizeMode, saveLayout]);

  const cols = gridWidth >= 1200 ? 12 : gridWidth >= 800 ? 9 : gridWidth >= 600 ? 6 : 3;

  return (
    <Shell>
      <PageHeader title="Dashboards" description="Custom analytics dashboards with drag-to-resize widgets">
        <Button size="sm" variant="outline" onClick={() => setOpenSched(true)}>
          <Send className="h-3.5 w-3.5 mr-1" /> Schedule
        </Button>
        <Button size="sm" variant={customizeMode ? "default" : "outline"}
          onClick={() => setCustomizeMode((v) => !v)}>
          <Settings2 className="h-3.5 w-3.5 mr-1" />
          {customizeMode ? "Done editing" : "Customize"}
        </Button>
      </PageHeader>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Sidebar */}
        <div className="lg:col-span-1 space-y-4">
          <Section
            title="Dashboards"
            right={<Button size="sm" variant="ghost" onClick={() => setOpenNew(true)}><Plus className="h-3.5 w-3.5" /></Button>}
          >
            <ul className="space-y-0.5">
              {(list.data ?? []).map((d: any) => (
                <li key={d.id}>
                  <button
                    onClick={() => setSelected(d.id)}
                    className={`w-full text-left text-xs px-2 py-1.5 rounded-md transition-colors flex items-center gap-2 ${
                      selected === d.id
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                    }`}
                  >
                    <BarChart2 className="h-3 w-3 shrink-0" />
                    <span className="truncate">{d.name}</span>
                  </button>
                </li>
              ))}
              {list.data?.length === 0 && (
                <li className="text-xs text-muted-foreground px-2 py-1">No dashboards yet</li>
              )}
            </ul>
          </Section>

          <Section title="Scheduled exports">
            {(schedules.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No scheduled exports</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {(schedules.data ?? []).map((s: any) => (
                  <li key={s.id} className="border rounded-lg p-2">
                    <div className="font-medium capitalize">{s.frequency}</div>
                    <div className="text-muted-foreground mt-0.5 truncate">{(s.recipients as string[]).join(", ")}</div>
                    <div className="mt-1 flex gap-1">
                      <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => sendNow.mutate({ id: s.id })}>Send now</Button>
                      <Button size="sm" variant="ghost" className="h-6 text-xs text-destructive" onClick={() => delSched.mutate({ id: s.id })}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>

        {/* Main canvas */}
        <div className="lg:col-span-3 space-y-3">
          {selected ? (
            <>
              {/* Dashboard toolbar */}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-semibold">{(dash.data as any)?.name}</span>
                  {customizeMode && (
                    <>
                      <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => setOpenRename(true)} title="Rename">
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive"
                        onClick={() => { if (confirm("Delete this dashboard?")) delDash.mutate({ id: selected }); }}
                        title="Delete dashboard">
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </>
                  )}
                </div>
                {customizeMode && (
                  <Badge variant="secondary" className="text-[10px]">
                    Drag handle to reorder · Resize from corners · × to remove
                  </Badge>
                )}
                <div className="ml-auto">
                  <Button size="sm" onClick={() => setOpenWidget(true)}>
                    <Plus className="h-3.5 w-3.5 mr-1" /> Add widget
                  </Button>
                </div>
              </div>

              {/* Filter bar */}
              <DashboardFilterBar filters={filters} onChange={setFilters} members={memberOptions} />

              {/* Grid */}
              <div ref={gridRef} className="w-full">
                {widgets.length === 0 ? (
                  <EmptyState icon={LayoutDashboard} title="No widgets" description="Click Add widget to populate this dashboard." />
                ) : (
                  <GridLayout
                    layout={layout}
                    width={gridWidth}
                    onLayoutChange={onLayoutChange}
                    gridConfig={{ cols, rowHeight: 60, margin: [12, 12], containerPadding: [0, 0] }}
                    dragConfig={{ enabled: customizeMode, handle: ".drag-handle" }}
                    resizeConfig={{ enabled: customizeMode, handles: ["se", "sw", "ne", "nw"] }}
                  >
                    {widgets.map((w: any) => (
                      <div key={String(w.id)}>
                        <WidgetCard
                          widgetId={w.id}
                          filters={filters}
                          customizeMode={customizeMode}
                          onRemove={() => delW.mutate({ id: w.id })}
                        />
                      </div>
                    ))}
                  </GridLayout>
                )}
              </div>
            </>
          ) : (
            <EmptyState icon={LayoutDashboard} title="No dashboard selected" description="Create a dashboard or select one from the sidebar." />
          )}
        </div>
      </div>

      {/* Dialogs */}
      <FormDialog open={openNew} onOpenChange={setOpenNew} title="New dashboard" isPending={create.isPending}
        onSubmit={(f) => create.mutate({ name: String(f.get("name")), description: String(f.get("description") ?? "") || undefined })}>
        <Field name="name" label="Name" required />
        <Field name="description" label="Description" />
      </FormDialog>

      <FormDialog open={openRename} onOpenChange={setOpenRename} title="Rename dashboard" isPending={rename.isPending}
        onSubmit={(f) => rename.mutate({ id: selected!, name: String(f.get("name")), description: String(f.get("description") ?? "") || undefined })}>
        <Field name="name" label="New name" required defaultValue={(dash.data as any)?.name ?? ""} />
        <Field name="description" label="Description" defaultValue={(dash.data as any)?.description ?? ""} />
      </FormDialog>

      <AddWidgetDialog
        open={openWidget}
        onOpenChange={setOpenWidget}
        isPending={addW.isPending}
        onAdd={({ type, title, config, position }) =>
          addW.mutate({ dashboardId: selected!, type: type as any, title, config, position })
        }
      />

      <FormDialog open={openSched} onOpenChange={setOpenSched} title="Schedule export" isPending={createSched.isPending}
        onSubmit={(f) => createSched.mutate({
          dashboardId: selected!,
          frequency: f.get("frequency") as any,
          recipients: String(f.get("recipients")).split(",").map((s) => s.trim()).filter(Boolean),
        })}>
        <SelectField name="frequency" label="Frequency"
          options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }]}
          defaultValue="weekly" />
        <Field name="recipients" label="Recipients (comma-separated)" required />
        <p className="text-xs text-muted-foreground">Send-now is wired; recurring delivery requires an external cron.</p>
      </FormDialog>
    </Shell>
  );
}
