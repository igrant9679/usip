/**
 * ProspectSourceRegistryCard — the back office for prospect-data vendors:
 * every registered source with its capability manifest, credential status,
 * circuit state and live budget; plus the search-run inspector (per-source
 * breakdown and the vendor's raw payload for any staged row).
 *
 * Enable/order live on Revenue Engine → Settings ("Prospect Sources &
 * Checking Order") — that card is the ONE order+mask control and this view
 * only reports what it says.
 */
import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FILTER_LABELS, type FilterType } from "@shared/prospectSources";
import { Database, ChevronDown, ChevronRight, Loader2 } from "lucide-react";

function CapChips({ supported, approximated }: { supported: FilterType[]; approximated: FilterType[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {supported.map((f) => <Badge key={f} variant="secondary" className="text-[10px] bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">{FILTER_LABELS[f]}</Badge>)}
      {approximated.map((f) => <Badge key={f} variant="outline" className="text-[10px] border-dashed text-muted-foreground" title="Applied loosely (keyword-matched)">{FILTER_LABELS[f]} ≈</Badge>)}
    </div>
  );
}

export function ProspectSourceRegistryCard() {
  const describe = trpc.prospectSources.describe.useQuery(undefined);
  const runs = trpc.prospectSources.listRuns.useQuery({ limit: 15 });
  const [openRun, setOpenRun] = useState<number | null>(null);
  const [rawId, setRawId] = useState<number | null>(null);
  const run = trpc.prospectSources.getRun.useQuery({ runId: openRun ?? 0 }, { enabled: openRun != null });
  const raw = trpc.prospectSources.resultRaw.useQuery({ resultId: rawId ?? 0 }, { enabled: rawId != null });

  const rows = (describe.data ?? []).slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

  return (
    <section data-tour-id="prospect-source-registry" className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-4">
      <div className="flex items-start gap-2.5">
        <Database className="size-4 mt-0.5 shrink-0 text-sky-500" />
        <div className="flex-1">
          <h2 className="text-[15px] font-semibold">Prospect source registry</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            Every vendor Velocity can search, what each can filter on, and its budget. Searches run down this list in order and stop at the batch target, so a lower source is never paid for a person a higher one already found. Reorder or disable sources under <Link href="/are/settings" className="underline">Revenue Engine → Settings</Link>.
          </p>
        </div>
      </div>

      {describe.isLoading ? <div className="text-[12px] text-muted-foreground flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" /> Loading registry…</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
              <tr className="text-left">
                <th className="py-1.5 pr-3 font-medium">#</th>
                <th className="py-1.5 pr-3 font-medium">Source</th>
                <th className="py-1.5 pr-3 font-medium">Filters (native · ≈ approximate)</th>
                <th className="py-1.5 pr-3 font-medium">Preview</th>
                <th className="py-1.5 pr-3 font-medium">Credential</th>
                <th className="py-1.5 pr-3 font-medium">Budget</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const lead = s.budget.find((b) => b.bucket === "leads");
                return (
                  <tr key={s.slug} className={cn("border-t border-border/60 align-top", !s.enabled && "opacity-60")}>
                    <td className="py-2 pr-3 tabular-nums text-muted-foreground">{s.order != null ? s.order + 1 : "—"}</td>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{s.displayName}</div>
                      <div className="text-[10.5px] text-muted-foreground">
                        {!s.implemented ? "available, not configured (stub)" : s.enabled ? "enabled" : "disabled in Settings"}
                        {s.capabilities.geographicCoverage.length ? ` · ${s.capabilities.geographicCoverage.join("/")}` : " · global"}
                        {s.capabilities.supportsMobilePhone ? "" : " · no mobile"}
                      </div>
                    </td>
                    <td className="py-2 pr-3 max-w-[320px]"><CapChips supported={s.capabilities.supportedFilters} approximated={s.capabilities.approximatedFilters} /></td>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {s.capabilities.supportsFreePreview ? (s.capabilities.returnsMaskedPreview ? "free, masked" : "free") : "billable"}
                      <div className="text-[10.5px]">{s.acquisition === "on_demand" ? "acquire net-new" : "no acquisition"}</div>
                    </td>
                    <td className="py-2 pr-3">
                      {!s.credential.configured ? <span className="text-muted-foreground">not connected</span>
                        : s.credential.status === "valid" ? <span className="text-emerald-700 dark:text-emerald-400">valid{s.credential.lastValidatedAt ? <span className="text-muted-foreground"> · {new Date(s.credential.lastValidatedAt).toLocaleDateString()}</span> : null}</span>
                        : s.credential.status === "invalid" ? <span className="text-rose-700 dark:text-rose-400" title={s.credential.validationError ?? ""}>invalid</span>
                        : <span className="text-amber-700 dark:text-amber-400">untested</span>}
                      {s.circuit.open && <div className="text-[10.5px] text-amber-700 dark:text-amber-400">paused ({s.circuit.failures} failures)</div>}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">
                      {!s.credential.configured ? <span className="text-muted-foreground">—</span>
                        : s.leadsRemaining != null ? <>{s.leadsRemaining.toLocaleString()} left{lead?.limit != null ? <span className="text-muted-foreground"> / {lead.limit.toLocaleString()}</span> : null}</>
                        : <span className="text-muted-foreground">{lead?.fundedBy ?? "uncapped"}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[12px] font-medium">Recent searches</div>
        {(runs.data ?? []).length === 0 ? <p className="text-[12px] text-muted-foreground">No staged searches yet — run one from Data Enrichment → Source search.</p> : (
          <div className="space-y-1">
            {(runs.data ?? []).map((r) => {
              const per = (r.perSource ?? {}) as Record<string, any>;
              const open = openRun === r.id;
              return (
                <div key={r.id} className="rounded-lg border border-border/60">
                  <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px]" onClick={() => { setOpenRun(open ? null : r.id); setRawId(null); }}>
                    {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    <span className="font-medium">Run #{r.id}</span>
                    <Badge variant="outline" className="text-[10px]">{r.status}</Badge>
                    <span className="text-muted-foreground">{new Date(r.createdAt).toLocaleString()} · target {r.batchTarget} · {r.recordsNetNew} net-new of {r.recordsReturned}</span>
                  </button>
                  {open && (
                    <div className="px-3 pb-3 space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11.5px]">
                        {Object.keys(per).map((slug) => {
                          const p = per[slug];
                          return (
                            <div key={slug} className="rounded border border-border/60 px-2 py-1.5">
                              <span className="font-medium">{slug}</span>{" "}
                              {p.skipped ? <span className="text-muted-foreground">skipped — {p.detail ?? p.skipped}</span>
                                : p.error ? <span className="text-rose-700 dark:text-rose-400">{p.error}</span>
                                : <span className="text-muted-foreground">{p.verdict} · searched {p.searched} · net-new {p.netNew} · acquired {p.acquired} · {p.unitsSpent} units{p.fundedBy ? ` (${p.fundedBy})` : ""}</span>}
                            </div>
                          );
                        })}
                      </div>
                      {r.error && <div className="text-[11.5px] text-rose-700 dark:text-rose-400">{r.error}</div>}
                      {run.data && run.data.run.id === r.id && (
                        <div className="max-h-56 overflow-auto rounded border border-border/60">
                          <table className="w-full text-[11px]">
                            <tbody>
                              {run.data.results.slice(0, 100).map((x) => {
                                const n = x.normalized as any;
                                return (
                                  <tr key={x.id} className="border-t border-border/40">
                                    <td className="px-2 py-1">{n?.firstName} {n?.lastName}</td>
                                    <td className="px-2 py-1 text-muted-foreground">{n?.companyName ?? "—"}</td>
                                    <td className="px-2 py-1"><Badge variant="outline" className="text-[9.5px]">{x.sourceSlug}</Badge></td>
                                    <td className="px-2 py-1 text-muted-foreground">{x.isNetNew ? "net-new" : `dup ${x.dedupeKey?.split(":")[0] ?? ""}`}{x.emailIsMasked ? " · masked" : ""}{x.wasCharged ? " · charged" : ""}{x.promotedProspectId ? " · promoted" : ""}</td>
                                    <td className="px-2 py-1 text-right"><Button variant="ghost" size="sm" className="h-6 text-[10.5px]" onClick={() => setRawId(x.id)}>raw</Button></td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {rawId != null && raw.data && (
                        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-[10.5px]">{JSON.stringify(raw.data.rawPayload, null, 2)}</pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export default ProspectSourceRegistryCard;
