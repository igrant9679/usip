/**
 * Source search — the capability-aware vendor search (Data Enrichment tab).
 *
 *   1. Filter panel: the UNION of every registered source's filters.
 *   2. Source strip: as filters change, each connected source shows
 *      full match / approximate / cannot honour, with the reason on hover —
 *      the thing that makes multi-source legible instead of mysterious.
 *   3. Batch target beside the combined remaining allowance; a warning
 *      when the target exceeds it.
 *   4. Run → the waterfall previews for free (masked), the page polls,
 *      results land in a reviewable table with source badge, net-new flag
 *      and masked-email indicator.
 *   5. Select and promote to People. The units the selection will spend
 *      are shown before confirming; acquisition happens only then.
 *
 * No credentials at all → routes to Settings → Data sources, never an error.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { confirmAction } from "@/components/usip/Common";
import { FILTER_LABELS, activeFilters, emptyCriteria, filterUnion, type FilterType, type ProspectSourceSlug, type SearchCriteria } from "@shared/prospectSources";
import { Loader2, Search, ShieldCheck, AlertTriangle, EyeOff, Sparkles } from "lucide-react";

function Chips({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState("");
  const add = () => { const t = text.trim(); if (t && !value.includes(t)) onChange([...value, t]); setText(""); };
  return (
    <div className="space-y-1">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((v) => <Badge key={v} variant="secondary" className="text-[11px] gap-1">{v}<button type="button" onClick={() => onChange(value.filter((x) => x !== v))} className="hover:opacity-70">×</button></Badge>)}
        </div>
      )}
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }} onBlur={add} className="h-8 text-[12.5px]" />
    </div>
  );
}

const LIST_FIELDS: Array<{ f: FilterType; key: keyof SearchCriteria; placeholder: string }> = [
  { f: "jobTitle", key: "jobTitles", placeholder: "Executive Director, CFO…" },
  { f: "seniority", key: "seniorities", placeholder: "C-level, VP, Director…" },
  { f: "department", key: "departments", placeholder: "Finance, Operations…" },
  { f: "industry", key: "industries", placeholder: "Nonprofit, Higher education…" },
  { f: "country", key: "countries", placeholder: "US, CA (ISO codes)" },
  { f: "stateProvince", key: "stateProvinces", placeholder: "Texas, Ontario…" },
  { f: "city", key: "cities", placeholder: "Austin…" },
  { f: "postalCode", key: "postalCodes", placeholder: "78701…" },
  { f: "companyName", key: "companyNames", placeholder: "Acme…" },
  { f: "companyDomain", key: "companyDomains", placeholder: "acme.org…" },
  { f: "keyword", key: "keywords", placeholder: "grants, scholarship…" },
  { f: "technology", key: "technologies", placeholder: "Salesforce…" },
];

export function SourceSearchPanel() {
  const utils = trpc.useUtils();
  const [criteria, setCriteria] = useState<SearchCriteria>(() => ({ ...emptyCriteria(), hasEmail: true }));
  const [target, setTarget] = useState("25");
  const [runId, setRunId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // Per-run source picker (owner ask 2026-09-22). null = every usable source,
  // which is what the page ran before it had a picker. A source that is not
  // usable (no key, disabled, circuit open, invalid key) cannot be chosen.
  const [chosen, setChosen] = useState<Set<ProspectSourceSlug> | null>(null);

  const describe = trpc.prospectSources.describe.useQuery({ criteria }, { placeholderData: (prev) => prev });
  const sources = describe.data ?? [];
  const connected = sources.filter((s) => s.credential.configured && s.implemented);
  const union = useMemo(() => filterUnion(sources.map((s) => s.capabilities)), [sources]);
  const active = activeFilters(criteria);
  const usableSlugs = useMemo(
    () => sources.filter((s) => s.implemented && s.credential.configured && s.enabled && !s.circuit.open && s.credential.status !== "invalid").map((s) => s.slug),
    [sources],
  );
  const chosenSet = useMemo(() => chosen ?? new Set<ProspectSourceSlug>(usableSlugs), [chosen, usableSlugs]);
  const runSources = usableSlugs.filter((slug) => chosenSet.has(slug));
  const toggleSource = (slug: ProspectSourceSlug) => setChosen((prev) => {
    const next = new Set<ProspectSourceSlug>(prev ?? usableSlugs);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    return next;
  });
  const combinedRemaining = useMemo(() => {
    let sum = 0; let uncapped = false;
    for (const s of connected) { if (!s.enabled || !chosenSet.has(s.slug)) continue; if (s.leadsRemaining == null) uncapped = true; else sum += s.leadsRemaining; }
    return { sum, uncapped };
  }, [connected, chosenSet]);
  const targetNum = Math.max(1, Math.min(200, Math.floor(Number(target) || 25)));

  const start = trpc.prospectSources.startSearch.useMutation({
    onSuccess: (r) => { setRunId(r.runId); setSelected(new Set()); toast.success(`Search #${r.runId} started`); },
    onError: (e: any) => toast.error(e?.message ?? "Could not start the search"),
  });
  const run = trpc.prospectSources.getRun.useQuery({ runId: runId ?? 0 }, {
    enabled: runId != null,
    refetchInterval: (q) => { const st = (q.state.data as any)?.run?.status; return st === "queued" || st === "running" ? 1500 : false; },
  });
  const results = run.data?.results ?? [];
  const status = run.data?.run.status;
  const selIds = Array.from(selected);
  const estimate = trpc.prospectSources.estimatePromotion.useQuery({ runId: runId ?? 0, resultIds: selIds }, { enabled: runId != null && selIds.length > 0 });
  const promote = trpc.prospectSources.promote.useMutation({
    onSuccess: (r) => {
      utils.prospectSources.getRun.invalidate(); utils.prospectSources.describe.invalidate(); utils.prospectSources.listRuns.invalidate();
      setSelected(new Set());
      toast.success(`Promoted ${r.promoted} to People${r.acquired ? ` · acquired ${r.acquired} (${r.unitsSpent} units)` : ""}${r.failed ? ` · ${r.failed} could not be acquired` : ""}`);
      if (r.errors?.length) toast.warning(r.errors.join(" · "));
    },
    onError: (e: any) => toast.error(e?.message ?? "Promotion failed"),
  });

  useEffect(() => { setSelected(new Set()); }, [runId]);

  if (describe.isLoading) return <div className="text-[12.5px] text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading sources…</div>;

  if (connected.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center space-y-3">
        <ShieldCheck className="size-6 mx-auto text-muted-foreground" />
        <div className="text-[14px] font-medium">No prospect-data vendor connected yet</div>
        <p className="text-[12.5px] text-muted-foreground max-w-md mx-auto">Source search runs down your connected vendors in order and stops at your batch target. Add a WarmySender, QuickEnrich or Apollo key and this page fills in — it gets better with every key you add.</p>
        <Button asChild size="sm"><Link href="/v2/settings/data-sources">Open Settings → Data sources</Link></Button>
      </div>
    );
  }

  const set = (key: keyof SearchCriteria, v: string[]) => setCriteria((c) => ({ ...c, [key]: v }));
  const netNewCount = results.filter((r) => r.isNetNew).length;
  const toAcquire = estimate.data?.units ?? 0;

  return (
    <div className="space-y-5">
      {/* 1. Filters — the union of every source's declared filters */}
      <div className="rounded-xl border border-border/70 bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-semibold flex items-center gap-2"><Search className="size-4" /> Filters</div>
          <div className="text-[11px] text-muted-foreground">Union of every source's filters · ≈ marks a filter some source only approximates</div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {LIST_FIELDS.filter((x) => union.includes(x.f)).map((x) => {
            const approxOnly = sources.every((s) => !s.capabilities.supportedFilters.includes(x.f));
            return (
              <div key={x.f} className="space-y-1">
                <Label className="text-[11.5px]">{FILTER_LABELS[x.f]}{approxOnly ? " ≈" : ""}</Label>
                <Chips value={criteria[x.key] as string[]} onChange={(v) => set(x.key, v)} placeholder={x.placeholder} />
              </div>
            );
          })}
          {union.includes("headcountRange") && (
            <div className="space-y-1">
              <Label className="text-[11.5px]">{FILTER_LABELS.headcountRange}</Label>
              <div className="flex gap-2">
                <Input type="number" placeholder="min" className="h-8 text-[12.5px]" value={criteria.headcountRange?.min ?? ""} onChange={(e) => setCriteria((c) => ({ ...c, headcountRange: { ...(c.headcountRange ?? {}), min: e.target.value === "" ? undefined : Number(e.target.value) } }))} />
                <Input type="number" placeholder="max" className="h-8 text-[12.5px]" value={criteria.headcountRange?.max ?? ""} onChange={(e) => setCriteria((c) => ({ ...c, headcountRange: { ...(c.headcountRange ?? {}), max: e.target.value === "" ? undefined : Number(e.target.value) } }))} />
              </div>
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-[11.5px]">Presence</Label>
            <div className="flex items-center gap-4 h-8 text-[12px]">
              <label className="flex items-center gap-1.5"><Checkbox checked={criteria.hasEmail === true} onCheckedChange={(v) => setCriteria((c) => ({ ...c, hasEmail: v ? true : undefined }))} /> Has email</label>
              <label className="flex items-center gap-1.5"><Checkbox checked={criteria.hasPhone === true} onCheckedChange={(v) => setCriteria((c) => ({ ...c, hasPhone: v ? true : undefined }))} /> Has phone</label>
            </div>
          </div>
        </div>
      </div>

      {/* 2. Source strip */}
      <div className="flex flex-wrap gap-2">
        {sources.filter((s) => s.implemented).map((s) => {
          const m = s.match;
          const usable = s.credential.configured && s.enabled && !s.circuit.open && s.credential.status !== "invalid";
          const tone = !usable ? "border-border text-muted-foreground" : !m || active.length === 0 ? "border-border text-muted-foreground"
            : m.verdict === "full" ? "border-emerald-500/50 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300"
            : m.verdict === "approximate" ? "border-amber-500/50 bg-amber-500/5 text-amber-800 dark:text-amber-300"
            : "border-rose-500/40 bg-rose-500/5 text-rose-800 dark:text-rose-300";
          const reason = !s.credential.configured ? "not connected" : !s.enabled ? "disabled in Settings" : s.circuit.open ? `paused after ${s.circuit.failures} failures` : s.credential.status === "invalid" ? `key rejected: ${s.credential.validationError ?? ""}`
            : active.length === 0 ? "set a filter" : !m ? "" : m.verdict === "full" ? "every filter honoured natively"
            : m.verdict === "approximate" ? `approximates ${m.approximated.map((f) => FILTER_LABELS[f]).join(", ")}` : `cannot filter on ${m.missing.map((f) => FILTER_LABELS[f]).join(", ")}`;
          return (
            <div key={s.slug} title={reason} className={cn("rounded-lg border px-2.5 py-1.5 text-[11.5px] flex items-center gap-1.5", tone)}>
              {usable && (
                <Checkbox className="size-3.5" aria-label={`Use ${s.displayName} in this run`} checked={chosenSet.has(s.slug)} onCheckedChange={() => toggleSource(s.slug)} />
              )}
              <span className="font-medium">{s.displayName}</span>
              <span className="opacity-80">· {!usable ? reason : active.length === 0 ? "—" : m?.verdict === "full" ? "full match" : m?.verdict === "approximate" ? "approximate" : "cannot honour"}</span>
              {usable && s.leadsRemaining != null && <span className="opacity-70 tabular-nums">· {s.leadsRemaining} left</span>}
            </div>
          );
        })}
      </div>

      {/* 3. Batch target + combined remaining */}
      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-border/70 bg-card p-4">
        <div className="space-y-1">
          <Label className="text-[11.5px]">Batch target</Label>
          <Input type="number" min={1} max={200} value={target} onChange={(e) => setTarget(e.target.value)} className="h-8 w-28 text-[12.5px]" />
        </div>
        <div className="text-[12px] text-muted-foreground pb-2">
          Combined remaining allowance: <span className="font-medium text-foreground tabular-nums">{combinedRemaining.sum.toLocaleString()}{combinedRemaining.uncapped ? "+" : ""}</span>
          {!combinedRemaining.uncapped && targetNum > combinedRemaining.sum && <span className="ml-2 inline-flex items-center gap-1 text-amber-700 dark:text-amber-400"><AlertTriangle className="size-3.5" /> target exceeds what your sources can acquire today</span>}
        </div>
        <Button size="sm" className="gap-1.5" disabled={start.isPending || active.length === 0 || runSources.length === 0 || status === "running" || status === "queued"}
          onClick={() => start.mutate({ criteria, batchTarget: targetNum, sources: runSources })}>
          {start.isPending || status === "running" || status === "queued" ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Run search (free preview)
        </Button>
        {active.length === 0 && <span className="text-[11.5px] text-muted-foreground pb-2">Set at least one filter.</span>}
        {active.length > 0 && runSources.length === 0 && <span className="text-[11.5px] text-muted-foreground pb-2">Pick at least one source.</span>}
      </div>

      {/* 4. Results */}
      {runId != null && (
        <div className="rounded-xl border border-border/70 bg-card">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border/60 text-[12px]">
            <span className="font-medium">Search #{runId}</span>
            <Badge variant="outline" className="text-[10px]">{status}</Badge>
            {run.data && <span className="text-muted-foreground">{netNewCount} net-new of {results.length} previewed · target {run.data.run.batchTarget}</span>}
            {run.data?.run.error && <span className="text-rose-700 dark:text-rose-400">{run.data.run.error}</span>}
            {!!run.data?.run.perSource && (
              <span className="text-muted-foreground">
                {Object.entries(run.data.run.perSource as Record<string, any>).map(([slug, p]) => (
                  <span key={slug} className="mr-2">{slug}: {p.skipped ? `skipped (${p.detail ?? p.skipped})` : p.error ? `error — ${p.error}` : `${p.netNew} net-new / ${p.searched}`}</span>
                ))}
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {selIds.length > 0 && (
                <span className="text-muted-foreground">
                  {selIds.length} selected · will spend <span className="font-medium text-foreground">{estimate.isFetching ? "…" : toAcquire}</span> unit{toAcquire === 1 ? "" : "s"}
                  {estimate.data?.perSource.some((p) => p.remaining != null && p.toAcquire > p.remaining) && <span className="ml-1 text-amber-700 dark:text-amber-400">(exceeds remaining allowance)</span>}
                </span>
              )}
              <Button size="sm" disabled={selIds.length === 0 || promote.isPending || estimate.isFetching}
                onClick={() => confirmAction({
                  title: `Promote ${selIds.length} to People?`,
                  description: toAcquire > 0
                    ? `${toAcquire} record${toAcquire === 1 ? "" : "s"} will be acquired now (${toAcquire} lead unit${toAcquire === 1 ? "" : "s"} spent — only net-new people are charged). Previews already held are free. Every address still goes through verification before it can be mailed.`
                    : "Nothing will be spent — these records are already held or come from free sources.",
                  confirmLabel: toAcquire > 0 ? `Spend ${toAcquire} and promote` : "Promote",
                }, () => promote.mutate({ runId, resultIds: selIds }))}>
                {promote.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Promote selected
              </Button>
            </div>
          </div>
          {(status === "queued" || status === "running") && <div className="px-4 py-6 text-[12.5px] text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Walking your sources in order — free previews only, nothing is spent yet.</div>}
          {status === "complete" && results.length === 0 && <div className="px-4 py-6 text-[12.5px] text-muted-foreground">No results. Check the source strip above — a source that "cannot honour" a filter never runs; try removing the narrowest filter.</div>}
          {results.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
                  <tr className="text-left">
                    <th className="px-3 py-2 w-8"><Checkbox checked={selIds.length > 0 && selIds.length === results.filter((r) => r.isNetNew && !r.promotedProspectId).length} onCheckedChange={(v) => setSelected(v ? new Set(results.filter((r) => r.isNetNew && !r.promotedProspectId).map((r) => r.id)) : new Set())} /></th>
                    <th className="px-3 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 font-medium">Company</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => {
                    const n = r.normalized as any;
                    const checked = selected.has(r.id);
                    const selectable = r.isNetNew && !r.promotedProspectId;
                    return (
                      <tr key={r.id} className={cn("border-t border-border/50", !r.isNetNew && "opacity-60")}>
                        <td className="px-3 py-1.5"><Checkbox disabled={!selectable} checked={checked} onCheckedChange={(v) => setSelected((s) => { const n2 = new Set(s); if (v) n2.add(r.id); else n2.delete(r.id); return n2; })} /></td>
                        <td className="px-3 py-1.5"><div className="font-medium">{n?.firstName} {n?.lastName}</div><div className="text-[10.5px] text-muted-foreground">{n?.jobTitle ?? "—"}</div></td>
                        <td className="px-3 py-1.5"><div>{n?.companyName ?? "—"}</div><div className="text-[10.5px] text-muted-foreground">{n?.companyDomain ?? [n?.city, n?.stateProvince].filter(Boolean).join(", ")}</div></td>
                        <td className="px-3 py-1.5">{r.emailIsMasked ? <span className="inline-flex items-center gap-1 text-muted-foreground"><EyeOff className="size-3" /> masked until acquired</span> : n?.email ? <span>{n.email}</span> : <span className="text-muted-foreground">— (found in enrichment)</span>}</td>
                        <td className="px-3 py-1.5"><Badge variant="outline" className="text-[10px]">{r.sourceSlug}</Badge></td>
                        <td className="px-3 py-1.5 text-[11px]">{r.promotedProspectId ? <span className="text-emerald-700 dark:text-emerald-400">promoted</span> : r.isNetNew ? <span className="text-emerald-700 dark:text-emerald-400">net-new</span> : <span className="text-muted-foreground" title={r.dedupeKey ?? ""}>already in People / a campaign</span>}{r.wasCharged ? <span className="text-muted-foreground"> · charged</span> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SourceSearchPanel;
