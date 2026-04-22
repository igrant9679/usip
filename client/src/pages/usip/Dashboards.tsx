import { Button } from "@/components/ui/button";
import { Field, FormDialog, Section, SelectField, StatusPill } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Edit2, LayoutDashboard, Pencil, Plus, Send, Settings2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { toast } from "sonner";

const METRICS_KPI = [
  { value: "pipeline_value", label: "Pipeline value" },
  { value: "closed_won_qtr", label: "Closed-won (qtr)" },
  { value: "win_rate", label: "Win rate" },
  { value: "avg_deal", label: "Avg deal size" },
];

function WidgetCard({ widgetId, onRemove, onMove, onSwap, idx, total, customizeMode }: { widgetId: number; onRemove: () => void; onMove: (dir: -1 | 1) => void; onSwap: (sourceId: number) => void; idx: number; total: number; customizeMode?: boolean }) {
  const { data } = trpc.dashboards.resolveWidget.useQuery({ id: widgetId });
  const [over, setOver] = useState(false);
  if (!data) return <div className="border rounded-lg bg-card p-3 text-xs text-muted-foreground">Loading…</div>;
  return (
    <div
      className={`@container border rounded-lg bg-card p-3 transition ${over ? "border-[#14B89A] ring-2 ring-[#14B89A]/40" : ""}`}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", String(widgetId)); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const src = Number(e.dataTransfer.getData("text/plain")); if (src && src !== widgetId) onSwap(src); }}
    >
      <div className="flex items-center mb-2">
        <div className="text-xs uppercase font-semibold text-muted-foreground tracking-wide flex-1">{data.title}</div>
        {customizeMode && (
          <>
            <Button size="sm" variant="ghost" disabled={idx === 0} onClick={() => onMove(-1)}>↑</Button>
            <Button size="sm" variant="ghost" disabled={idx === total - 1} onClick={() => onMove(1)}>↓</Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={onRemove}><X className="size-3.5" /></Button>
          </>
        )}
      </div>
      {data.type === "kpi" && (
        <div className="font-mono tabular-nums text-xl @[14rem]:text-2xl truncate" title={String(data.value ?? "")}>
          {data.format === "currency" ? `$${Number(data.value ?? 0).toLocaleString()}` :
           data.format === "percent" ? `${data.value ?? 0}%` :
           Number(data.value ?? 0).toLocaleString()}
        </div>
      )}
      {data.type === "funnel" && (
        <ul className="space-y-1 text-xs">
          {(data as any).series?.map((s: any) => (
            <li key={s.stage} className="flex items-center gap-2">
              <span className="capitalize w-24">{s.stage}</span>
              <div className="flex-1 h-2 bg-secondary rounded"><div className="h-full bg-primary rounded" style={{ width: `${Math.min(100, (s.count / Math.max(...((data as any).series.map((x: any) => x.count) || [1]))) * 100)}%` }} /></div>
              <span className="font-mono tabular-nums w-16 text-right shrink-0">{s.count}</span>
            </li>
          ))}
        </ul>
      )}
      {data.type === "bar" && (
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={(data as any).series ?? []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Bar dataKey="value" fill="#14B89A" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {data.type === "table" && (
        <ul className="text-xs divide-y">{((data as any).rows ?? []).map((r: any) => (
          <li key={r.id} className="py-1 flex gap-2 min-w-0"><span className="flex-1 truncate">#{r.id}</span><span className="font-mono tabular-nums whitespace-nowrap shrink-0">${Number(r.value).toLocaleString()}</span></li>
        ))}</ul>
      )}
    </div>
  );
}

export default function Dashboards() {
  const utils = trpc.useUtils();
  const list = trpc.dashboards.list.useQuery();
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => { if (!selected && list.data?.[0]) setSelected(list.data[0].id); }, [list.data, selected]);
  const dash = trpc.dashboards.get.useQuery({ id: selected! }, { enabled: !!selected });
  const schedules = trpc.dashboards.listSchedules.useQuery();

  const [openNew, setOpenNew] = useState(false);
  const [openWidget, setOpenWidget] = useState(false);
  const [openSched, setOpenSched] = useState(false);
  const [openRename, setOpenRename] = useState(false);
  const [customizeMode, setCustomizeMode] = useState(false);

  const create = trpc.dashboards.create.useMutation({ onSuccess: (r) => { utils.dashboards.list.invalidate(); setSelected(r.id); setOpenNew(false); } });
  const rename = trpc.dashboards.rename.useMutation({ onSuccess: () => { utils.dashboards.list.invalidate(); utils.dashboards.get.invalidate(); setOpenRename(false); toast.success("Dashboard renamed"); }, onError: (e: any) => toast.error(e.message) });
  const addW = trpc.dashboards.addWidget.useMutation({ onSuccess: () => { utils.dashboards.get.invalidate(); setOpenWidget(false); toast.success("Widget added"); } });
  const delW = trpc.dashboards.deleteWidget.useMutation({ onSuccess: () => utils.dashboards.get.invalidate() });
  const saveLayout = trpc.dashboards.saveLayout.useMutation();
  const createSched = trpc.dashboards.createSchedule.useMutation({ onSuccess: () => { utils.dashboards.listSchedules.invalidate(); setOpenSched(false); } });
  const sendNow = trpc.dashboards.sendScheduleNow.useMutation({ onSuccess: () => { utils.dashboards.listSchedules.invalidate(); toast.success("Sent (stub)"); } });
  const delSched = trpc.dashboards.deleteSchedule.useMutation({ onSuccess: () => utils.dashboards.listSchedules.invalidate() });
  const delDash = trpc.dashboards.delete.useMutation({ onSuccess: () => { utils.dashboards.list.invalidate(); setSelected(null); } });

  const widgets = (dash.data as any)?.widgets ?? [];
  const persist = (ord: number[]) => {
    const positions = ord.map((wid: number, k: number) => ({ id: wid, x: 0, y: k, w: 4, h: 3 }));
    saveLayout.mutate({ dashboardId: selected!, positions }, { onSuccess: () => utils.dashboards.get.invalidate() });
  };
  const move = (id: number, dir: -1 | 1) => {
    const ord = widgets.map((w: any) => w.id);
    const i = ord.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ord.length) return;
    [ord[i], ord[j]] = [ord[j], ord[i]];
    persist(ord);
  };
  const swap = (sourceId: number, targetId: number) => {
    const ord = widgets.map((w: any) => w.id);
    const si = ord.indexOf(sourceId);
    const ti = ord.indexOf(targetId);
    if (si < 0 || ti < 0) return;
    const [moved] = ord.splice(si, 1);
    ord.splice(ti, 0, moved!);
    persist(ord);
  };

  return (
    <Shell title="Dashboards">
      <PageHeader title="Custom dashboards" description="Drag widgets to reorder. Widgets resolve server-side.">
        {selected && (
          <>
            <Button variant="ghost" size="sm" onClick={() => setCustomizeMode((v) => !v)}>
              {customizeMode ? <><X className="size-4" /> Done</> : <><Settings2 className="size-4" /> Customize</>}
            </Button>
            <Button variant="outline" onClick={() => setOpenRename(true)} disabled={!selected}><Pencil className="size-4" /> Rename</Button>
          </>
        )}
        <Button variant="outline" onClick={() => setOpenSched(true)} disabled={!selected}><Send className="size-4" /> Schedule</Button>
        <Button onClick={() => setOpenNew(true)}><Plus className="size-4" /> New dashboard</Button>
      </PageHeader>
      <div className="p-6 grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="space-y-3">
          <Section title={`Dashboards (${list.data?.length ?? 0})`}>
            {(list.data ?? []).length === 0 ? <EmptyState icon={LayoutDashboard} title="None" /> : (
              <ul className="divide-y">{list.data!.map((d) => (
                <li key={d.id} className={`p-3 cursor-pointer hover:bg-secondary/40 ${selected === d.id ? "bg-secondary/60" : ""}`} onClick={() => setSelected(d.id)}>
                  <div className="text-sm font-medium">{d.name}</div>
                  <div className="text-xs text-muted-foreground">{d.description ?? ""}</div>
                </li>
              ))}</ul>
            )}
          </Section>
          <Section title={`Schedules (${schedules.data?.length ?? 0})`}>
            {(schedules.data ?? []).length === 0 ? <div className="p-3 text-xs text-muted-foreground">None set.</div> : (
              <ul className="divide-y">{schedules.data!.map((s) => (
                <li key={s.id} className="p-3 text-xs">
                  <div className="flex items-center gap-2"><StatusPill tone="info">{s.frequency}</StatusPill><span className="font-mono">{(s.recipients as string[]).length} recipients</span></div>
                  <div className="text-muted-foreground mt-1 truncate">{(s.recipients as string[]).join(", ")}</div>
                  <div className="mt-1 flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => sendNow.mutate({ id: s.id })}>Send now</Button>
                    <Button size="sm" variant="ghost" onClick={() => delSched.mutate({ id: s.id })}><Trash2 className="size-3.5" /></Button>
                  </div>
                </li>
              ))}</ul>
            )}
          </Section>
        </div>
        <div className="lg:col-span-3 space-y-3">
          {selected && (
            <div className="flex items-center mb-3 gap-2">
              <div className="text-sm font-semibold">{(dash.data as any)?.name}</div>
              {customizeMode && (
                <span className="text-[10px] bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Customize mode — drag to reorder, × to remove</span>
              )}
              <div className="ml-auto flex gap-1">
                <Button size="sm" variant="outline" onClick={() => setOpenWidget(true)}><Plus className="size-3.5" /> Add widget</Button>
                {customizeMode && (
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => { if (confirm("Delete this dashboard?")) delDash.mutate({ id: selected }); }}><Trash2 className="size-3.5" /></Button>
                )}
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {widgets.map((w: any, i: number) => (
              <WidgetCard key={w.id} widgetId={w.id} idx={i} total={widgets.length}
                customizeMode={customizeMode}
                onRemove={() => delW.mutate({ id: w.id })} onMove={(dir) => move(w.id, dir)} onSwap={(src) => swap(src, w.id)} />
            ))}
            {selected && widgets.length === 0 && <EmptyState icon={LayoutDashboard} title="No widgets" description="Click Add widget to populate this dashboard." />}
          </div>
        </div>
      </div>

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

      <FormDialog open={openWidget} onOpenChange={setOpenWidget} title="Add widget" isPending={addW.isPending}
        onSubmit={(f) => {
          const type = f.get("type") as any;
          let config: any = {};
          if (type === "kpi") config = { metric: f.get("metric") };
          if (type === "bar") config = { metric: "closed_won" };
          if (type === "funnel") config = {};
          if (type === "table") config = { entity: "accounts", limit: 5 };
          addW.mutate({ dashboardId: selected!, type, title: String(f.get("title")), config });
        }}>
        <Field name="title" label="Title" required />
        <SelectField name="type" label="Type" options={[{ value: "kpi", label: "KPI" }, { value: "bar", label: "Bar (closed-won by month)" }, { value: "funnel", label: "Pipeline funnel" }, { value: "table", label: "Top accounts" }]} defaultValue="kpi" />
        <SelectField name="metric" label="KPI metric (only for KPI)" options={METRICS_KPI} defaultValue="pipeline_value" />
      </FormDialog>

      <FormDialog open={openSched} onOpenChange={setOpenSched} title="Schedule export" isPending={createSched.isPending}
        onSubmit={(f) => createSched.mutate({
          dashboardId: selected!,
          frequency: f.get("frequency") as any,
          recipients: String(f.get("recipients")).split(",").map((s) => s.trim()).filter(Boolean),
        })}>
        <SelectField name="frequency" label="Frequency" options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }]} defaultValue="weekly" />
        <Field name="recipients" label="Recipients (comma-separated)" required />
        <p className="text-xs text-muted-foreground">Send-now is wired; recurring delivery requires an external cron.</p>
      </FormDialog>
    </Shell>
  );
}
