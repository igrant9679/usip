import { Button } from "@/components/ui/button";
import { fmt$, fmtDate, Field, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell, StatCard } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, FolderOpen, Heart, TrendingUp, HeartHandshake } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const TIER_TONE: Record<string, "success" | "info" | "warning" | "danger"> = {
  thriving: "success", healthy: "info", neutral: "info", at_risk: "warning", critical: "danger",
};

export default function Customers() {
  const [selected, setSelected] = useState<number | null>(null);
  const utils = trpc.useUtils();
  const { data: list } = trpc.cs.list.useQuery();
  const { data: kpis } = trpc.cs.kpis.useQuery();
  const detail = trpc.cs.get.useQuery({ id: selected! }, { enabled: !!selected });
  const amendments = trpc.cs.listAmendments.useQuery({ customerId: selected! }, { enabled: !!selected });
  const submitNps = trpc.cs.submitNps.useMutation({ onSuccess: () => { utils.cs.list.invalidate(); utils.cs.get.invalidate({ id: selected! }); toast.success("NPS recorded"); } });
  const updateHealth = trpc.cs.updateHealthComponents.useMutation({ onSuccess: () => { utils.cs.list.invalidate(); utils.cs.get.invalidate({ id: selected! }); } });
  const [amendOpen, setAmendOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ id: number; name: string } | null>(null);

  const churnRisk = (s: number): { tier: "low" | "medium" | "high"; tone: "success" | "warning" | "danger" } => {
    if (s < 45) return { tier: "high", tone: "danger" };
    if (s < 65) return { tier: "medium", tone: "warning" };
    return { tier: "low", tone: "success" };
  };
  const addAmendment = trpc.cs.addAmendment.useMutation({ onSuccess: () => { utils.cs.listAmendments.invalidate({ customerId: selected! }); utils.cs.list.invalidate(); setAmendOpen(false); toast.success("Amendment added"); } });

  return (
    <Shell title="Customers">
      <PageHeader title="Customers" description="Track health scores, renewal risk, NPS, and expansion potential." pageKey="customers" 
        icon={<HeartHandshake className="size-5" />}
      />
      <div className="p-6 space-y-4">
        {kpis && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard label="ARR" value={fmt$(kpis.arr)} />
            <StatCard label="Expansion" value={fmt$(kpis.expansion)} tone="success" />
            <StatCard label="At-risk" value={kpis.atRisk} tone={kpis.atRisk > 0 ? "warning" : "default"} />
            <StatCard label="Renewing 90d" value={kpis.renewing90} />
            <StatCard label="Avg NPS" value={kpis.avgNps} />
            <StatCard label="NPS band" value={kpis.npsBand} />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <Section title="All customers">
              {(list ?? []).length === 0 ? <EmptyState icon={Heart} title="No customers" /> : (
                <table className="w-full text-sm">
                  <thead className="bg-secondary/50 text-xs uppercase text-muted-foreground"><tr>
                    <th className="text-left px-3 py-2">Account</th><th className="text-left px-3 py-2">Tier</th>
                    <th className="text-right px-3 py-2">Health</th><th className="text-right px-3 py-2">ARR</th>
                    <th className="text-right px-3 py-2">NPS</th><th className="text-right px-3 py-2">Renewal</th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {list!.map((c: any) => (
                      <tr key={c.id} onClick={() => setSelected(c.id)} className={`cursor-pointer hover:bg-secondary/30 ${selected === c.id ? "bg-secondary/40" : ""}`}>
                        <td className="px-3 py-2 font-medium">{c.account?.name ?? "—"}</td>
                        <td className="px-3 py-2"><StatusPill tone={TIER_TONE[c.healthTier] ?? "muted"}>{c.healthTier}</StatusPill></td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{c.healthScore}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">{fmt$(Number(c.arr ?? 0))}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{c.npsScore}</td>
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">{fmtDate(c.renewalDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </div>
          <div className="space-y-4">
            {!selected || !detail.data ? <EmptyState icon={Heart} title="Select a customer" /> : (
              <>
                {(() => {
                  const r = churnRisk(detail.data.healthScore);
                  return r.tier !== "low" ? (
                    <div className={`rounded-md border p-3 flex items-start gap-2 text-xs ${r.tone === "danger" ? "bg-rose-50 border-rose-300" : "bg-amber-50 border-amber-300"}`}>
                      <AlertTriangle className="size-4 mt-0.5" />
                      <div>
                        <div className="font-semibold uppercase tracking-wide">Churn risk: {r.tier}</div>
                        <div className="text-muted-foreground mt-0.5">{detail.data.aiPlay ?? "Recommend exec sponsor outreach + roadmap alignment."}</div>
                      </div>
                    </div>
                  ) : null;
                })()}
                <Section title={detail.data.account?.name ?? "Customer"} description={`Health ${detail.data.healthScore} · ${detail.data.healthTier}`} right={<Button size="sm" variant="outline" className="bg-card" onClick={() => setDrawer({ id: detail.data!.id, name: detail.data!.account?.name ?? "Customer" })}><FolderOpen className="size-3 mr-1" />Timeline & files</Button>}>
                  <div className="p-3 space-y-2 text-xs">
                    <SliderRow label="Usage" value={detail.data.usageScore} onChange={(v) => updateHealth.mutate({ id: detail.data!.id, usage: v, engagement: detail.data!.engagementScore, support: detail.data!.supportScore })} />
                    <SliderRow label="Engagement" value={detail.data.engagementScore} onChange={(v) => updateHealth.mutate({ id: detail.data!.id, usage: detail.data!.usageScore, engagement: v, support: detail.data!.supportScore })} />
                    <SliderRow label="Support" value={detail.data.supportScore} onChange={(v) => updateHealth.mutate({ id: detail.data!.id, usage: detail.data!.usageScore, engagement: detail.data!.engagementScore, support: v })} />
                  </div>
                  <div className="px-3 py-2 border-t flex items-center gap-3 text-xs">
                    <TrendingUp className="size-3 text-emerald-600" />
                    <span className="text-muted-foreground">Expansion potential</span>
                    <span className="ml-auto font-mono font-semibold text-emerald-700">{fmt$(Number(detail.data.expansionPotential ?? 0))}</span>
                  </div>
                </Section>
                <Section title="NPS trend">
                  <NpsSparkline history={(detail.data as any).npsHistory ?? []} current={detail.data.npsScore ?? 0} />
                </Section>
                <Section title="Submit NPS">
                  <form className="p-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); const v = Number(new FormData(e.currentTarget).get("nps")); submitNps.mutate({ id: detail.data!.id, score: v }); e.currentTarget.reset(); }}>
                    <input name="nps" type="number" min={-100} max={100} placeholder="-100 to 100" className="flex-1 border rounded px-2 py-1.5 text-sm" />
                    <Button size="sm" type="submit">Submit</Button>
                  </form>
                </Section>
                <Section title="Contract amendments" right={<Button size="sm" variant="ghost" onClick={() => setAmendOpen(true)}>+ Add</Button>}>
                  <ul className="divide-y">
                    {(amendments.data ?? []).length === 0 ? <li className="p-3 text-xs text-muted-foreground">No amendments yet.</li> : amendments.data!.map((a) => (
                      <li key={a.id} className="p-3 text-xs">
                        <div className="flex items-center gap-2"><StatusPill tone="info">{a.type}</StatusPill><span className="font-mono tabular-nums whitespace-nowrap">{fmt$(Number(a.arrDelta ?? 0))}</span><span className="text-muted-foreground ml-auto whitespace-nowrap">{fmtDate(a.effectiveAt)}</span></div>
                        <div className="text-muted-foreground mt-1">{a.notes}</div>
                      </li>
                    ))}
                  </ul>
                </Section>
              </>
            )}
          </div>
        </div>
      </div>

      <FormDialog open={amendOpen} onOpenChange={setAmendOpen} title="New amendment" isPending={addAmendment.isPending}
        onSubmit={(f) => addAmendment.mutate({
          customerId: selected!,
          type: f.get("type") as any,
          arrDelta: Number(f.get("arrDelta") ?? 0),
          effectiveAt: f.get("effectiveAt") ? new Date(String(f.get("effectiveAt"))).toISOString() : new Date().toISOString(),
          notes: String(f.get("notes") ?? "") || undefined,
        })}>
        <SelectField name="type" label="Type" options={["upgrade", "downgrade", "addon", "renewal", "termination", "price_change"].map((t) => ({ value: t, label: t }))} defaultValue="upgrade" />
        <Field name="arrDelta" label="Δ ARR" type="number" defaultValue={0} />
        <Field name="effectiveAt" label="Effective" type="date" />
        <TextareaField name="notes" label="Notes" />
      </FormDialog>
      <RecordDrawer open={!!drawer} onOpenChange={(v) => !v && setDrawer(null)} relatedType="customer" relatedId={drawer?.id ?? null} title={drawer?.name ?? ""} />
    </Shell>
  );
}

function NpsSparkline({ history, current }: { history: Array<{ month: number; score: number }>; current: number }) {
  const series = (history.length ? history : [{ month: 0, score: current }]).slice(-12);
  const max = 100, min = -100, h = 60, w = 220;
  const pts = series.map((p, i) => {
    const x = (i / Math.max(series.length - 1, 1)) * w;
    const y = h - ((p.score - min) / (max - min)) * h;
    return `${x},${y}`;
  }).join(" ");
  const last = series[series.length - 1]?.score ?? current;
  return (
    <div className="p-3 text-xs">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-muted-foreground">Current</span>
        <span className="font-mono tabular-nums font-semibold text-base">{last}</span>
        <span className="ml-auto text-muted-foreground">{series.length} pts</span>
      </div>
      <svg width={w} height={h} className="w-full">
        <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke="#e5e7eb" strokeDasharray="2 2" />
        <polyline fill="none" stroke="#14B89A" strokeWidth={2} points={pts} />
      </svg>
    </div>
  );
}

function SliderRow({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-20">{label}</div>
      <input type="range" min={0} max={100} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1" />
      <div className="w-10 text-right font-mono tabular-nums">{value}</div>
    </div>
  );
}
