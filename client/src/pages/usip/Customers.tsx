import { Button } from "@/components/ui/button";
import { ConfirmButton, fmt$, fmtDate, Field, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, QueryError, Shell, StatCard, TableSkeleton } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { isAdminRole, rankOf } from "@shared/roleRank";
import { trpc } from "@/lib/trpc";
import { invalidateCustomerReads } from "@/lib/crmCache";
import { AlertTriangle, FolderOpen, Heart, TrendingUp, HeartHandshake, Trash2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { pressable } from "@/lib/pressable";
import { churnRiskFor, HEALTH_TIER_TONE } from "@shared/customerHealth";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { RecordRenewalOrChurn } from "@/components/usip/RecordRenewalOrChurn";

type CustomerSort = "health" | "arr" | "renewal" | "name" | "nps";

// The tiers the server writes, coloured from the one shared reading (R58).
// This listed "thriving" and "neutral", which no customer holds, and missed
// "watch", so a watch customer's pill had no colour.
const TIER_TONE: Record<string, "success" | "info" | "warning" | "danger"> = HEALTH_TIER_TONE;

export default function Customers() {
  const [selected, setSelected] = useState<number | null>(null);
  const utils = trpc.useUtils();
  // Search, sort and pages on the server (audit 2026-10-20, U26): the table
  // loaded every customer and could only be read in health order.
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q.trim());
  const [sort, setSort] = useState<CustomerSort>("health");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  const { data: listData, isLoading: listLoading, error: listError, refetch: listRefetch } = trpc.cs.search.useQuery({ q: query || undefined, sort, dir, page, pageSize: PAGE_SIZE });
  const list = listData?.rows;
  const total = listData?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const sortBy = (s: CustomerSort) => {
    if (s === sort) setDir(dir === "asc" ? "desc" : "asc");
    else { setSort(s); setDir(s === "name" || s === "renewal" ? "asc" : "desc"); }
    setPage(1);
  };
  const header = (s: CustomerSort, label: string, align: "left" | "right" = "left") => (
    <th className={`px-3 py-2 text-${align}`} aria-sort={sort === s ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-foreground" onClick={() => sortBy(s)}>
        {label}{sort === s ? (dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
  const { data: kpis } = trpc.cs.kpis.useQuery();
  const detail = trpc.cs.get.useQuery({ id: selected! }, { enabled: !!selected });
  const amendments = trpc.cs.listAmendments.useQuery({ customerId: selected! }, { enabled: !!selected });
  const submitNps = trpc.cs.submitNps.useMutation({ onSuccess: () => { invalidateCustomerReads(utils); toast.success("NPS recorded"); }, onError: (e) => toast.error(e.message) });
  const updateHealth = trpc.cs.updateHealthComponents.useMutation({ onSuccess: () => { invalidateCustomerReads(utils); }, onError: (e) => toast.error(e.message) });
  const [amendOpen, setAmendOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ id: number; name: string } | null>(null);

  // Churn risk IS the health tier, read as a risk (R58): this had its own
  // 45 / 65 cut-offs, so a 60 was "watch" in the table and "medium risk" here
  // while a 50 was "at risk" there and "medium" here.
  const churnRisk = (healthTier: string): { tier: "low" | "medium" | "high"; tone: "success" | "warning" | "danger" } => {
    const tier = churnRiskFor(healthTier);
    return { tier, tone: tier === "high" ? "danger" : tier === "medium" ? "warning" : "success" };
  };
  const addAmendment = trpc.cs.addAmendment.useMutation({ onSuccess: () => { invalidateCustomerReads(utils); setAmendOpen(false); toast.success("Amendment added"); }, onError: (e) => toast.error(e.message) });
  const { current } = useWorkspace();
  const removeCustomer = trpc.cs.delete.useMutation({
    onSuccess: (_d, vars) => {
      invalidateCustomerReads(utils);
      if (selected === vars.id) setSelected(null);
      toast.success("Customer deleted");
    },
    onError: (e) => toast.error("Failed to delete customer", { description: e.message }),
  });
  const resetCs = trpc.cs.clearAll.useMutation({
    onSuccess: (data) => {
      invalidateCustomerReads(utils);
      setSelected(null);
      toast.success(`Reset — cleared ${data.deletedCustomers} customer record${data.deletedCustomers === 1 ? "" : "s"}`);
    },
    onError: (e) => toast.error("Failed to reset", { description: e.message }),
  });

  return (
    <Shell title="Customers">
      <PageHeader title="Customers" description="Track customer health scores, renewal risk, NPS trends, and expansion potential post-close. Identify at-risk accounts early and surface upsell opportunities before they go cold." pageKey="customers"
        icon={<HeartHandshake className="size-5" />}
      >
        {isAdminRole(current?.role) && (list?.length ?? 0) > 0 && (
          <ConfirmButton
            size="sm"
            variant="outline"
            className="text-muted-foreground hover:text-destructive"
            onConfirm={() => resetCs.mutate()}
            disabled={resetCs.isPending}
            ariaLabel="Delete every customer-success record for this workspace"
            title="Reset ALL customer-success data?"
            count={{ n: list?.length ?? 0, one: "customer record" }}
            description={`This deletes every customer, QBR, support ticket, and contract amendment (${list?.length ?? 0} customer records). The underlying accounts, contacts, and opportunities stay intact. This cannot be undone.`}
            confirmLabel="Reset CS data"
          >
            <RotateCcw className="size-3.5 mr-1" />
            Reset CS data
          </ConfirmButton>
        )}
      </PageHeader>
      <div className="p-4 md:p-5 space-y-4">
        {kpis && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard label="ARR" value={fmt$(kpis.arr)} hint={kpis.churnedArrThisQuarter > 0 ? `${fmt$(kpis.churnedArrThisQuarter)} churned this quarter` : undefined} />
            <StatCard label="Expansion" value={fmt$(kpis.expansion)} tone="success" />
            <StatCard label="At-risk" value={kpis.atRisk} tone={kpis.atRisk > 0 ? "warning" : "default"} />
            <StatCard label="Renewing 90d" value={kpis.renewing90} />
            <StatCard label="Avg NPS" value={kpis.avgNps} />
            <StatCard label="NPS band" value={kpis.npsBand} />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <Section title="All customers" description={total > 0 ? `${total.toLocaleString()} customer${total === 1 ? "" : "s"}${query ? ` matching “${query}”` : ""}` : undefined}
              right={<input aria-label="Search customers" type="search" value={q} placeholder="Search by company…"
                onChange={(e) => { setQ(e.target.value); setPage(1); }}
                className="h-8 w-48 rounded-md border bg-background px-2 text-sm" />}>
              {listError ? <QueryError message={listError.message} onRetry={() => listRefetch()} /> : listLoading ? <TableSkeleton rows={6} /> : (list ?? []).length === 0 ? <EmptyState icon={Heart} title={query ? "No customers match" : "No customers"} /> : (
                <div className="overflow-x-auto"><table className="w-full text-sm">
                  <thead className="bg-secondary/50 text-xs uppercase text-muted-foreground"><tr>
                    {header("name", "Account")}<th className="text-left px-3 py-2">Tier</th>
                    {header("health", "Health", "right")}{header("arr", "ARR", "right")}
                    {header("nps", "NPS", "right")}{header("renewal", "Renewal", "right")}
                    <th className="w-8 px-1"></th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {list!.map((c: any) => (
                      <tr key={c.id} {...pressable(() => setSelected(c.id), { row: true })} className={`cursor-pointer hover:bg-secondary/30 ${selected === c.id ? "bg-secondary/40" : ""}`}>
                        <td className="px-3 py-2 font-medium">{c.account?.name ?? "—"}</td>
                        <td className="px-3 py-2"><StatusPill tone={TIER_TONE[c.healthTier] ?? "muted"}>{c.healthTier}</StatusPill></td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{c.healthScore}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">{fmt$(Number(c.arr ?? 0))}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{c.npsScore}</td>
                        {/* contractEnd, not renewalDate — the latter is not a
                            column, so this cell was always empty. */}
                        <td className="px-3 py-2 text-right text-xs text-muted-foreground">{fmtDate(c.contractEnd)}</td>
                        <td className="px-1 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                          {rankOf(current?.role) >= rankOf("manager") && <ConfirmButton
                            className="text-muted-foreground hover:text-destructive p-1 h-auto rounded"
                            ariaLabel="Delete customer (CS overlay only — account stays)"
                            title="Delete this customer record?"
                            description={`"${c.account?.name ?? "This customer"}" and all its QBRs, tickets, and amendments will be deleted. The underlying account stays. This cannot be undone.`}
                            confirmLabel="Delete"
                            onConfirm={() => removeCustomer.mutate({ id: c.id })}
                          >
                            <Trash2 className="size-3.5" />
                          </ConfirmButton>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
              {total > PAGE_SIZE && (
                <div className="flex items-center justify-end gap-2 px-3 py-2 border-t text-xs text-muted-foreground">
                  <span>{((page - 1) * PAGE_SIZE + 1).toLocaleString()}–{Math.min(page * PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()}</span>
                  <Button size="sm" variant="outline" className="h-7" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                  <Button size="sm" variant="outline" className="h-7" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
                </div>
              )}
            </Section>
          </div>
          <div className="space-y-4">
            {/* "Select a customer" only when none is selected (R99): it also
                showed while the picked one loaded, and when it failed. */}
            {!selected ? <EmptyState icon={Heart} title="Select a customer" /> : detail.isLoading ? <TableSkeleton rows={4} /> : detail.error ? <QueryError message={detail.error.message} what="this customer" onRetry={() => detail.refetch()} /> : !detail.data ? <EmptyState icon={Heart} title="Customer not found" description="It may have been deleted." /> : (
              <>
                {(() => {
                  const r = churnRisk(detail.data.healthTier);
                  return r.tier !== "low" ? (
                    <div className={`rounded-md border p-3 flex items-start gap-2 text-xs ${r.tone === "danger" ? "bg-rose-50 border-rose-300" : "bg-amber-50 border-amber-300"}`}>
                      <AlertTriangle className="size-4 mt-0.5" />
                      <div>
                        <div className="font-semibold uppercase tracking-wide">Churn risk: {r.tier}</div>
                        {/* The stored play only (R74): a canned line stood in
                            for it, read as advice written for this customer. */}
                        {detail.data.aiPlay && <div className="text-muted-foreground mt-0.5">{detail.data.aiPlay}</div>}
                      </div>
                    </div>
                  ) : null;
                })()}
                {/* The renewal or churn, recorded in one step (F36). */}
                <div className="flex items-center gap-2 text-xs">
                  <RecordRenewalOrChurn customer={detail.data} accountName={detail.data.account?.name ?? null} />
                  {detail.data.renewalStage === "churned" && (detail.data as any).churnReason && (
                    <span className="text-muted-foreground">Churned{(detail.data as any).churnedAt ? ` ${fmtDate((detail.data as any).churnedAt)}` : ""}: {(detail.data as any).churnReason}</span>
                  )}
                </div>
                <Section title={detail.data.account?.name ?? "Customer"} description={`Health ${detail.data.healthScore} · ${detail.data.healthTier}`} right={<Button size="sm" variant="outline" className="bg-card" onClick={() => setDrawer({ id: detail.data!.id, name: detail.data!.account?.name ?? "Customer" })}><FolderOpen className="size-3 mr-1" />Timeline & files</Button>}>
                  <div className="p-3 space-y-2 text-xs">
                    {/* Each slider saves when it is let go, and sends only
                        its own value (R58): every step of a drag sent all
                        three from the loaded detail, so the sliders wrote
                        over each other with stale numbers. */}
                    <SliderRow key={`u-${detail.data.id}`} label="Usage" value={detail.data.usageScore} onCommit={(v) => updateHealth.mutate({ id: detail.data!.id, usage: v })} />
                    <SliderRow key={`e-${detail.data.id}`} label="Engagement" value={detail.data.engagementScore} onCommit={(v) => updateHealth.mutate({ id: detail.data!.id, engagement: v })} />
                    <SliderRow key={`s-${detail.data.id}`} label="Support" value={detail.data.supportScore} onCommit={(v) => updateHealth.mutate({ id: detail.data!.id, support: v })} />
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
                  {/* An empty box is not a score of 0 (R58): Number("") is 0,
                      and a blank submit recorded a neutral NPS. */}
                  <form className="p-3 flex gap-2" onSubmit={(e) => {
                    e.preventDefault();
                    const raw = String(new FormData(e.currentTarget).get("nps") ?? "").trim();
                    const v = Number(raw);
                    if (raw === "" || !Number.isInteger(v) || v < -100 || v > 100) { toast.error("Enter a whole number from -100 to 100"); return; }
                    submitNps.mutate({ id: detail.data!.id, score: v });
                    e.currentTarget.reset();
                  }}>
                    <input aria-label="NPS score" name="nps" type="number" min={-100} max={100} placeholder="-100 to 100" className="flex-1 border rounded px-2 py-1.5 text-sm" />
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
        <Field name="arrDelta" label="Δ ARR" type="money" allowNegative defaultValue={0} />
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
      {/* viewBox (R99): with only width and height the line was drawn at
          220px inside a box CSS stretched to full width, so it filled the
          left part and was cut off on narrow panels. */}
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full">
        <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke="#e5e7eb" strokeDasharray="2 2" />
        <polyline fill="none" stroke="#14B89A" strokeWidth={2} points={pts} />
      </svg>
    </div>
  );
}

/**
 * A health slider that follows the hand while it moves and saves once, when
 * it is let go (pointer up, key up, or leaving the control) — and only when
 * the value changed (R58).
 */
function SliderRow({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };
  return (
    <div className="flex items-center gap-2">
      <div className="w-20">{label}</div>
      <input aria-label={label} type="range" min={0} max={100} value={shown}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit}
        className="flex-1" />
      <div className="w-10 text-right font-mono tabular-nums">{shown}</div>
    </div>
  );
}
