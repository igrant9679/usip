import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, QueryError, Shell, SubNav } from "@/components/usip/Shell";
import { confirmAction } from "@/components/usip/Common";
import { trpc } from "@/lib/trpc";
import { LEAD_ASSIGNMENT_NAV } from "@/lib/leadAssignmentNav";
import { readableErrorMessage } from "@/lib/trpcErrorMessage";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useWorkspaceRole } from "@/hooks/useWorkspaceRole";
import { componentMaxes, tierBands as bandsFor, tierThresholdProblem } from "@shared/leadScoreModel";
import { leadTierLabel, type LeadTier } from "@shared/leadTier";
import { savedScoreLine, type SavedScore } from "@/lib/leadScoreText";
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

/** Field names as the form labels them, for a refused save (P121). */
const FIELD_LABELS: Record<string, string> = {
  firmoOrgTypeWeight: "Org type weight", firmoTitleWeight: "Title seniority weight", firmoCompletenessWeight: "Profile completeness weight",
  behavOpenPoints: "Points per open", behavOpenMax: "Open cap", behavClickPoints: "Points per click", behavClickMax: "Click cap",
  behavReplyPoints: "Reply points", behavStepPoints: "Points per step", behavBouncePenalty: "Bounce penalty", behavUnsubPenalty: "Unsub penalty",
  behavDecayPctPer30d: "Decay %/30d", aiFitMax: "AI Fit max points",
  tierWarmMin: "Warm threshold", tierHotMin: "Hot threshold", tierSalesReadyMin: "Sales-Ready threshold",
};

const BAND_COLOR: Record<string, string> = { Cold: "#64748b", Warm: "#eab308", Hot: "#ea580c", "Sales Ready": "#16a34a" };

export default function LeadScoring() {
  const { data: serverCfg, isLoading, error: cfgError, refetch: refetchCfg } = trpc.leadScoring.getConfig.useQuery();
  const [cfg, setCfg] = useState<Cfg>(DEFAULTS);
  const utils = trpc.useUtils();
  // Save, Recompute all and Cancel are an admin's on the server (P120). Anyone
  // may still try weights here and see the preview.
  const isAdmin = useWorkspaceRole().isAdmin;

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
    // A refused value reads as a sentence, not zod's issue list (P121).
    onError: (e) => toast.error(readableErrorMessage(e, FIELD_LABELS)),
  });
  // "Recompute all" is a background job (audit P11): asked with the count and
  // what it costs, shown while it runs, and one at a time per workspace.
  const recomputeJob = trpc.leadScoring.recomputeJob.useQuery(undefined, {
    refetchInterval: (q) => (q.state.data && ["queued", "running"].includes(q.state.data.status) ? 3000 : false),
  });
  const recomputeAll = trpc.leadScoring.recomputeAll.useMutation({
    onSuccess: (r) => {
      toast.success(r.existing ? "Leads are already being re-scored — progress is shown below." : `Re-scoring ${r.total.toLocaleString()} leads in the background.`);
      utils.leadScoring.recomputeJob.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const cancelRecompute = trpc.leadScoring.cancelRecompute.useMutation({
    onSuccess: () => utils.leadScoring.recomputeJob.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const job = recomputeJob.data;
  const jobActive = !!job && (job.status === "queued" || job.status === "running");
  const askRecompute = async () => {
    const p = await utils.leadScoring.recomputeAllPreview.fetch();
    if (p.running) { toast.info("Leads are already being re-scored."); return; }
    confirmAction({
      title: `Re-score ${p.leads.toLocaleString()} leads?`,
      description: `Each lead is one AI call on this workspace's AI budget (${p.leads.toLocaleString()} calls). Leads that cross Sales Ready notify their owner, and can be enrolled into sequences that start on a score. It runs in the background; you can leave this page.`,
      confirmLabel: "Re-score",
    }, () => recomputeAll.mutate());
  };

  // The server's own maximums (P22): behaviour can reach 75 with the default
  // weights, so the old forty-thirty-thirty line was not the model.
  const max = componentMaxes(cfg);
  const firmoMax = max.firmographic;
  const tierBands = useMemo(() => bandsFor(cfg).map((b) => ({ ...b, color: BAND_COLOR[b.name] })), [cfg]);
  // Out-of-order thresholds can't be saved (P116); say why next to Save.
  const tierProblem = tierThresholdProblem(cfg);

  return (
    <Shell title="Lead Scoring">
      <PageHeader title="Lead Scoring Engine" pageKey="lead-scoring" description={`Three components, added up and capped at 100: firmographic up to ${max.firmographic}, behavioral up to ${max.behavioral}, AI fit up to ${max.aiFit} (${max.sum} pts in all).`}
        icon={<Gauge className="size-5" />}
      >
        {isAdmin && (
          <>
            <Button variant="outline" className="bg-card" onClick={askRecompute} disabled={recomputeAll.isPending || jobActive}>
              <RefreshCw className={`size-4 ${recomputeAll.isPending || jobActive ? "animate-spin" : ""}`} /> Recompute all
            </Button>
            {/* Live only once the saved weights are loaded (P35): before that, or
                after a failed load, cfg is the defaults and Save would write them
                over the real ones. */}
            <Button onClick={() => save.mutate(cfg)} disabled={save.isPending || !serverCfg || !!tierProblem} title={tierProblem ?? undefined}><Save className="size-4" /> Save</Button>
          </>
        )}
      </PageHeader>
      <SubNav items={LEAD_ASSIGNMENT_NAV} />
      {!isAdmin && (
        <div className="px-4 md:px-5 pt-3 text-[13px] text-muted-foreground">An admin changes the scoring rules. You can try weights here and see the preview; they are not saved.</div>
      )}
      {serverCfg && tierProblem && (
        <div role="alert" className="px-4 md:px-5 pt-3 text-[13px] text-rose-600">{tierProblem}</div>
      )}

      {job && (jobActive || job.finishedAt) && (
        <div className="px-4 md:px-5 pt-3 text-[13px] text-muted-foreground flex items-center gap-2 flex-wrap">
          {jobActive ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              <span>Re-scoring leads: {job.done.toLocaleString()} of {job.total.toLocaleString()}{job.failed ? ` (${job.failed} failed)` : ""}</span>
              {isAdmin && <Button size="sm" variant="ghost" className="h-6" disabled={cancelRecompute.isPending} onClick={() => cancelRecompute.mutate({ jobId: job.id })}>Cancel</Button>}
            </>
          ) : (
            <span>
              Last re-score {job.status === "canceled" ? "canceled" : job.status === "failed" ? "stopped" : "finished"} {new Date(job.finishedAt!).toLocaleString()}: {job.done.toLocaleString()} scored{job.failed ? `, ${job.failed} failed` : ""}.
            </span>
          )}
        </div>
      )}
      {isLoading ? (
        <div className="p-4 md:p-5 flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>
      ) : !serverCfg ? (
        // Not the defaults: saving them would overwrite the real weights.
        <QueryError what="the scoring weights" message={cfgError?.message} onRetry={() => refetchCfg()} />
      ) : (
        <div className="p-4 md:p-5 grid gap-6 lg:grid-cols-3">
          {/* Firmographic */}
          <Card title="Firmographic" subtitle={`Max ${firmoMax} pts`}>
            <NumField label="Org type weight (B2B vs free email)" value={cfg.firmoOrgTypeWeight} onChange={(v) => setCfg({ ...cfg, firmoOrgTypeWeight: v })} />
            <NumField label="Title seniority weight (C-suite=full)" value={cfg.firmoTitleWeight} onChange={(v) => setCfg({ ...cfg, firmoTitleWeight: v })} />
            <NumField label="Profile completeness weight" value={cfg.firmoCompletenessWeight} onChange={(v) => setCfg({ ...cfg, firmoCompletenessWeight: v })} />
          </Card>

          {/* Behavioral */}
          <Card title="Behavioral" subtitle={`Email + sequence engagement · Max ${max.behavioral} pts`}>
            <div className="grid grid-cols-2 gap-3">
              <NumField label="Pts/open" value={cfg.behavOpenPoints} onChange={(v) => setCfg({ ...cfg, behavOpenPoints: v })} />
              <NumField label="Open cap" value={cfg.behavOpenMax} onChange={(v) => setCfg({ ...cfg, behavOpenMax: v })} />
              <NumField label="Pts/click" value={cfg.behavClickPoints} onChange={(v) => setCfg({ ...cfg, behavClickPoints: v })} />
              <NumField label="Click cap" value={cfg.behavClickMax} onChange={(v) => setCfg({ ...cfg, behavClickMax: v })} />
              {/* Given once for replying, however many replies (P119). */}
              <NumField label="Pts for replying (once)" value={cfg.behavReplyPoints} onChange={(v) => setCfg({ ...cfg, behavReplyPoints: v })} />
              <NumField label="Pts/step" value={cfg.behavStepPoints} onChange={(v) => setCfg({ ...cfg, behavStepPoints: v })} />
              <NumField label="Bounce penalty" value={cfg.behavBouncePenalty} onChange={(v) => setCfg({ ...cfg, behavBouncePenalty: v })} />
              <NumField label="Unsub penalty" value={cfg.behavUnsubPenalty} onChange={(v) => setCfg({ ...cfg, behavUnsubPenalty: v })} />
              <NumField label="Decay %/30d" value={cfg.behavDecayPctPer30d} onChange={(v) => setCfg({ ...cfg, behavDecayPctPer30d: v })} />
            </div>
          </Card>

          {/* AI Fit + Tiers */}
          <Card title="AI Fit + Tiers" subtitle={`LLM evaluation (max ${max.aiFit} pts) + segmentation thresholds`}>
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
                <div key={b.name} title={`${b.name}: ${b.min}-${b.max}`} style={{ background: b.color, width: `${b.widthPct}%` }} className="text-[10px] text-white flex items-center justify-center font-medium">
                  {b.name}
                </div>
              ))}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span>0</span><span>{cfg.tierWarmMin}</span><span>{cfg.tierHotMin}</span><span>{cfg.tierSalesReadyMin}</span><span>100</span>
            </div>
          </div>

          <BreakdownPreview cfg={cfg} unsaved={Object.keys(FIELD_LABELS).some((k) => (cfg as Record<string, unknown>)[k] !== (serverCfg as Record<string, unknown>)[k])} />
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
      <Input aria-label={label} type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-8" />
    </div>
  );
}

/** Leads the preview's picker shows for a search (P44). */
const PICKER_LIMIT = 20;

function BreakdownPreview({ cfg, unsaved }: { cfg: Cfg; unsaved: boolean }) {
  // A search box and the first matches, not 500 whole lead rows in a select
  // (audit 2026-10-20, P44).
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim());
  const { data: leads } = trpc.leads.list.useQuery({ search: query || undefined, limit: PICKER_LIMIT });
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    if (!selected && leads && leads.length) setSelected(leads[0].id);
  }, [leads, selected]);
  // Scored with the weights on screen while they are unsaved (P118), once
  // typing pauses; the preview had always shown the saved weights.
  const weights = useMemo(() => {
    const { notifyOnSalesReady: _n, ...w } = cfg;
    return w;
  }, [cfg]);
  const previewCfg = useDebouncedValue(weights);
  const { data: bd, isFetching, error: bdError, refetch: refetchBd } = trpc.leadScoring.breakdown.useQuery(
    { leadId: selected ?? 0, cfg: unsaved ? previewCfg : undefined },
    { enabled: !!selected, placeholderData: (prev) => prev },
  );
  const utils = trpc.useUtils();
  const recompute = trpc.leadScoring.recompute.useMutation({
    onSuccess: () => { utils.leadScoring.breakdown.invalidate(); utils.leads.invalidate(); toast.success("Recomputed"); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="lg:col-span-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div>
          <div className="text-sm font-semibold flex items-center gap-2">Live breakdown preview {isFetching && bd && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}</div>
          <div className="text-xs text-muted-foreground">Pick a lead to see each component with the weights above, saved or not, and its recent score history.</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Input aria-label="Search leads" placeholder="Search leads…" className="h-9 w-44" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select aria-label="Lead" className="h-9 rounded border bg-background px-2 text-sm max-w-[16rem]" value={selected ?? ""} onChange={(e) => setSelected(Number(e.target.value) || null)}>
            <option value="">{leads && leads.length === 0 ? "No leads match" : "Select a lead…"}</option>
            {(leads ?? []).map((l) => <option key={l.id} value={l.id}>{l.firstName} {l.lastName} — {l.company ?? ""}</option>)}
          </select>
          <Button size="sm" disabled={!selected || recompute.isPending} onClick={() => selected && recompute.mutate({ leadId: selected })}>
            <RefreshCw className={`size-3.5 ${recompute.isPending ? "animate-spin" : ""}`} /> Recompute
          </Button>
        </div>
      </div>

      {!selected ? (
        <div className="text-xs text-muted-foreground py-6 text-center">Select a lead to view breakdown.</div>
      ) : bdError && !isFetching ? (
        <QueryError compact what="this lead's breakdown" message={readableErrorMessage(bdError, FIELD_LABELS)} onRetry={() => refetchBd()} />
      ) : !bd ? (
        <div className="text-xs text-muted-foreground py-6 text-center"><Loader2 className="size-4 animate-spin inline" /> Loading…</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {/* The three add up to the total (P34), behaviour below zero included (P33). */}
          <Bar label="Firmographic" value={bd.firmographic.value} max={bd.firmographic.max} reasons={bd.firmographic.reasons} />
          <Bar label="Behavioral" value={bd.behavioral.value} max={bd.behavioral.max} reasons={bd.behavioral.reasons} />
          <Bar label="AI Fit" value={bd.aiFit.value} max={bd.aiFit.max} reasons={bd.aiFit.reasons} />
          <div className="md:col-span-3 text-xs space-y-0.5">
            <div className="font-medium">
              Total {bd.total}/100 · {leadTierLabel(bd.tier as LeadTier)} (Grade {bd.grade}) — the three added up, capped at 0-100
            </div>
            <div className="text-muted-foreground">{savedScoreLine(bd.saved as SavedScore, bd.total, { unsavedWeights: unsaved })}</div>
          </div>
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
