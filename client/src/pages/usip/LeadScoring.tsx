import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Loader2, RefreshCw, Save, Sparkles, Target, Gauge } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

type Cfg = {
  firmoOrgTypeWeight: number;
  firmoTitleWeight: number;
  firmoCompletenessWeight: number;
  behavOpenPoints: number;
  behavOpenMax: number;
  behavClickPoints: number;
  behavClickMax: number;
  behavReplyPoints: number;
  behavStepPoints: number;
  behavBouncePenalty: number;
  behavUnsubPenalty: number;
  behavDecayPctPer30d: number;
  aiFitMax: number;
  tierWarmMin: number;
  tierHotMin: number;
  tierSalesReadyMin: number;
  notifyOnSalesReady: boolean;
};

const DEFAULTS: Cfg = {
  firmoOrgTypeWeight: 15, firmoTitleWeight: 15, firmoCompletenessWeight: 10,
  behavOpenPoints: 5, behavOpenMax: 15, behavClickPoints: 10, behavClickMax: 20,
  behavReplyPoints: 25, behavStepPoints: 3, behavBouncePenalty: -10, behavUnsubPenalty: -15,
  behavDecayPctPer30d: 10, aiFitMax: 30,
  tierWarmMin: 31, tierHotMin: 61, tierSalesReadyMin: 81, notifyOnSalesReady: true,
};

export default function LeadScoring() {
  const { data: serverCfg, isLoading } = trpc.leadScoring.getConfig.useQuery();
  const [cfg, setCfg] = useState<Cfg>(DEFAULTS);
  const utils = trpc.useUtils();

  useEffect(() => {
    if (serverCfg) {
      setCfg({
        firmoOrgTypeWeight: serverCfg.firmoOrgTypeWeight ?? 15,
        firmoTitleWeight: serverCfg.firmoTitleWeight ?? 15,
        firmoCompletenessWeight: serverCfg.firmoCompletenessWeight ?? 10,
        behavOpenPoints: serverCfg.behavOpenPoints ?? 5,
        behavOpenMax: serverCfg.behavOpenMax ?? 15,
        behavClickPoints: serverCfg.behavClickPoints ?? 10,
        behavClickMax: serverCfg.behavClickMax ?? 20,
        behavReplyPoints: serverCfg.behavReplyPoints ?? 25,
        behavStepPoints: serverCfg.behavStepPoints ?? 3,
        behavBouncePenalty: serverCfg.behavBouncePenalty ?? -10,
        behavUnsubPenalty: serverCfg.behavUnsubPenalty ?? -15,
        behavDecayPctPer30d: serverCfg.behavDecayPctPer30d ?? 10,
        aiFitMax: serverCfg.aiFitMax ?? 30,
        tierWarmMin: serverCfg.tierWarmMin ?? 31,
        tierHotMin: serverCfg.tierHotMin ?? 61,
        tierSalesReadyMin: serverCfg.tierSalesReadyMin ?? 81,
        notifyOnSalesReady: (serverCfg as any).notifyOnSalesReady ?? true,
      });
    }
  }, [serverCfg]);

  const save = trpc.leadScoring.saveConfig.useMutation({
    onSuccess: () => { toast.success("Scoring rules saved"); utils.leadScoring.getConfig.invalidate(); },
  });
  const recomputeAll = trpc.leadScoring.recomputeAll.useMutation({
    onSuccess: (r) => toast.success(`Re-scored ${r.recomputed} leads (${r.failed} failed)`),
  });

  const firmoMax = cfg.firmoOrgTypeWeight + cfg.firmoTitleWeight + cfg.firmoCompletenessWeight;
  const totalMax = firmoMax + (cfg.behavOpenMax + cfg.behavClickMax + cfg.behavReplyPoints + cfg.behavStepPoints * 5) + cfg.aiFitMax;
  const tierBands = useMemo(() => ([
    { name: "Cold", min: 0, max: cfg.tierWarmMin - 1, color: "#64748b" },
    { name: "Warm", min: cfg.tierWarmMin, max: cfg.tierHotMin - 1, color: "#eab308" },
    { name: "Hot", min: cfg.tierHotMin, max: cfg.tierSalesReadyMin - 1, color: "#ea580c" },
    { name: "Sales Ready", min: cfg.tierSalesReadyMin, max: 100, color: "#16a34a" },
  ]), [cfg]);

  return (
    <Shell title="Lead Scoring">
      <PageHeader title="Lead Scoring Engine" pageKey="lead-scoring" description={`Three-component model. Current configuration max-possible = ${totalMax} pts (capped at 100). Default 40 + 30 + 30 = 100.`}
        icon={<Gauge className="size-5" />}
      >
        <Button variant="outline" className="bg-card" onClick={() => recomputeAll.mutate()} disabled={recomputeAll.isPending}>
          <RefreshCw className={`size-4 ${recomputeAll.isPending ? "animate-spin" : ""}`} /> Recompute all
        </Button>
        <Button onClick={() => save.mutate(cfg)} disabled={save.isPending}><Save className="size-4" /> Save</Button>
      </PageHeader>

      {isLoading ? (
        <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : (
        <div className="p-6 grid gap-6 lg:grid-cols-3">
          {/* Firmographic */}
          <Card title="Firmographic" subtitle={`Max ${firmoMax} pts`}>
            <NumField label="Org type weight (B2B vs free email)" value={cfg.firmoOrgTypeWeight} onChange={(v) => setCfg({ ...cfg, firmoOrgTypeWeight: v })} />
            <NumField label="Title seniority weight (C-suite=full)" value={cfg.firmoTitleWeight} onChange={(v) => setCfg({ ...cfg, firmoTitleWeight: v })} />
            <NumField label="Profile completeness weight" value={cfg.firmoCompletenessWeight} onChange={(v) => setCfg({ ...cfg, firmoCompletenessWeight: v })} />
          </Card>

          {/* Behavioral */}
          <Card title="Behavioral" subtitle="Email + sequence engagement">
            <div className="grid grid-cols-2 gap-3">
              <NumField label="Pts/open" value={cfg.behavOpenPoints} onChange={(v) => setCfg({ ...cfg, behavOpenPoints: v })} />
              <NumField label="Open cap" value={cfg.behavOpenMax} onChange={(v) => setCfg({ ...cfg, behavOpenMax: v })} />
              <NumField label="Pts/click" value={cfg.behavClickPoints} onChange={(v) => setCfg({ ...cfg, behavClickPoints: v })} />
              <NumField label="Click cap" value={cfg.behavClickMax} onChange={(v) => setCfg({ ...cfg, behavClickMax: v })} />
              <NumField label="Pts/reply" value={cfg.behavReplyPoints} onChange={(v) => setCfg({ ...cfg, behavReplyPoints: v })} />
              <NumField label="Pts/step" value={cfg.behavStepPoints} onChange={(v) => setCfg({ ...cfg, behavStepPoints: v })} />
              <NumField label="Bounce penalty" value={cfg.behavBouncePenalty} onChange={(v) => setCfg({ ...cfg, behavBouncePenalty: v })} />
              <NumField label="Unsub penalty" value={cfg.behavUnsubPenalty} onChange={(v) => setCfg({ ...cfg, behavUnsubPenalty: v })} />
              <NumField label="Decay %/30d" value={cfg.behavDecayPctPer30d} onChange={(v) => setCfg({ ...cfg, behavDecayPctPer30d: v })} />
            </div>
          </Card>

          {/* AI Fit + Tiers */}
          <Card title="AI Fit + Tiers" subtitle="LLM evaluation + segmentation thresholds">
            <NumField label="AI Fit max points" value={cfg.aiFitMax} onChange={(v) => setCfg({ ...cfg, aiFitMax: v })} />
            <div className="my-2 border-t" />
            <NumField label="Warm threshold" value={cfg.tierWarmMin} onChange={(v) => setCfg({ ...cfg, tierWarmMin: v })} />
            <NumField label="Hot threshold" value={cfg.tierHotMin} onChange={(v) => setCfg({ ...cfg, tierHotMin: v })} />
            <NumField label="Sales-Ready threshold" value={cfg.tierSalesReadyMin} onChange={(v) => setCfg({ ...cfg, tierSalesReadyMin: v })} />
            <label className="flex items-center gap-2 text-xs text-muted-foreground pt-2">
              <input type="checkbox" checked={cfg.notifyOnSalesReady} onChange={(e) => setCfg({ ...cfg, notifyOnSalesReady: e.target.checked })} />
              Notify owner on Sales-Ready threshold cross
            </label>
          </Card>

          {/* Tier band visualization */}
          <div className="lg:col-span-3 rounded-lg border bg-card p-4">
            <div className="text-sm font-medium mb-2 flex items-center gap-2"><Target className="size-4" /> Tier bands (0-100)</div>
            <div className="flex h-8 rounded overflow-hidden border">
              {tierBands.map((b) => (
                <div key={b.name} title={`${b.name}: ${b.min}-${b.max}`} style={{ background: b.color, width: `${b.max - b.min + 1}%` }} className="text-[10px] text-white flex items-center justify-center font-medium">
                  {b.name}
                </div>
              ))}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span>0</span><span>{cfg.tierWarmMin}</span><span>{cfg.tierHotMin}</span><span>{cfg.tierSalesReadyMin}</span><span>100</span>
            </div>
          </div>

          <BreakdownPreview />
        </div>
      )}
    </Shell>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div>
        <div className="text-sm font-semibold flex items-center gap-2"><Sparkles className="size-4 text-emerald-600" /> {title}</div>
        {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-8" />
    </div>
  );
}

function BreakdownPreview() {
  const { data: leads } = trpc.leads.list.useQuery({});
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    if (!selected && leads && leads.length) setSelected(leads[0].id);
  }, [leads, selected]);
  const { data: bd, isFetching } = trpc.leadScoring.breakdown.useQuery(
    { leadId: selected ?? 0 },
    { enabled: !!selected },
  );
  const utils = trpc.useUtils();
  const recompute = trpc.leadScoring.recompute.useMutation({
    onSuccess: () => { utils.leadScoring.breakdown.invalidate(); utils.leads.list.invalidate(); toast.success("Recomputed"); },
  });

  return (
    <div className="lg:col-span-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm font-semibold">Live breakdown preview</div>
          <div className="text-xs text-muted-foreground">Pick a lead to inspect each component &amp; recent score history.</div>
        </div>
        <div className="flex items-center gap-2">
          <select className="h-9 rounded border bg-background px-2 text-sm" value={selected ?? ""} onChange={(e) => setSelected(Number(e.target.value))}>
            <option value="">Select a lead…</option>
            {(leads ?? []).map((l) => <option key={l.id} value={l.id}>{l.firstName} {l.lastName} — {l.company ?? ""}</option>)}
          </select>
          <Button size="sm" disabled={!selected || recompute.isPending} onClick={() => selected && recompute.mutate({ leadId: selected })}>
            <RefreshCw className={`size-3.5 ${recompute.isPending ? "animate-spin" : ""}`} /> Recompute
          </Button>
        </div>
      </div>

      {!selected ? (
        <div className="text-xs text-muted-foreground py-6 text-center">Select a lead to view breakdown.</div>
      ) : isFetching || !bd ? (
        <div className="text-xs text-muted-foreground py-6 text-center"><Loader2 className="size-4 animate-spin inline" /> Loading…</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <Bar label="Firmographic" value={bd.firmographic.value} max={bd.firmographic.max} reasons={bd.firmographic.reasons} />
          <Bar label="Behavioral" value={Math.max(0, bd.behavioral.value)} max={bd.behavioral.max} reasons={bd.behavioral.reasons} />
          <Bar label="AI Fit" value={bd.aiFit.value} max={bd.aiFit.max} reasons={[`Tier: ${bd.tier}`, `Total ${bd.total}/100 (Grade ${bd.grade ?? "—"})`]} />
          <div className="md:col-span-3">
            <div className="text-xs font-medium mb-1">90-day history</div>
            <Sparkline values={(bd.history ?? []).map((h) => h.total)} />
          </div>
        </div>
      )}
    </div>
  );
}

function Bar({ label, value, max, reasons }: { label: string; value: number; max: number; reasons: string[] }) {
  const pct = Math.max(0, Math.min(100, Math.round((value / Math.max(1, max)) * 100)));
  return (
    <div className="rounded border p-3 bg-background">
      <div className="flex items-baseline justify-between"><div className="text-xs uppercase text-muted-foreground">{label}</div><div className="font-mono text-sm tabular-nums">{value}/{max}</div></div>
      <div className="h-2 mt-1 mb-2 bg-muted rounded overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div>
      <ul className="text-[11px] text-muted-foreground space-y-0.5">{reasons.slice(0, 6).map((r, i) => <li key={i}>• {r}</li>)}</ul>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (!values.length) return <div className="text-[11px] text-muted-foreground">No history yet — recompute to populate.</div>;
  const w = 600, h = 40, pad = 2;
  const max = Math.max(100, ...values);
  const pts = values.map((v, i) => `${pad + (i * (w - pad * 2)) / Math.max(1, values.length - 1)},${h - pad - (v / max) * (h - pad * 2)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-10">
      <polyline points={pts} fill="none" stroke="#16a34a" strokeWidth="1.5" />
    </svg>
  );
}
