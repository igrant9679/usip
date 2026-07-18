import { fmt$, fmtDate, StatusPill } from "@/components/usip/Common";
import { PageHeader, QueryError, Shell, TableSkeleton } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { RefreshCw, Sparkles, AlertTriangle } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";

/**
 * Column ids MUST match the customers.renewalStage enum in drizzle/schema.ts:
 *   early | ninety | sixty | thirty | at_risk | renewed | churned
 *
 * The first column used to be `"secure"`, which is not a value the enum can
 * ever hold. The real first value, `"early"`, is the column DEFAULT and is set
 * on every newly-won deal (wonToCustomer.ts), so `buckets["early"]` was
 * undefined and `?.push()` silently dropped every new customer — they appeared
 * in no column at all, while "Secure" sat permanently empty. Reps were
 * systematically undercounting their book.
 */
const STAGES = [
  { id: "early", label: "Early", tone: "success" as const },
  { id: "thirty", label: "30 days", tone: "info" as const },
  { id: "sixty", label: "60 days", tone: "info" as const },
  { id: "ninety", label: "90 days", tone: "warning" as const },
  { id: "at_risk", label: "At risk", tone: "danger" as const },
  { id: "renewed", label: "Renewed", tone: "muted" as const },
  { id: "churned", label: "Churned", tone: "muted" as const },
];

export default function Renewals() {
  const utils = trpc.useUtils();
  const { data, isLoading, error, refetch } = trpc.cs.renewalsBoard.useQuery();
  const scoreChurn = trpc.csAi.scoreChurnRisk.useMutation({
    onSuccess: () => utils.cs.renewalsBoard.invalidate(),
    onError: (e: any) => toast.error(e.message),
  });
  const grouped = useMemo(() => {
    const buckets: Record<string, any[]> = {};
    STAGES.forEach((s) => (buckets[s.id] = []));
    // Safety net: a stage with no column lands in `_unbucketed` instead of
    // being silently discarded, so if the enum gains a value the board hasn't
    // been taught about, the records stay visible instead of vanishing.
    buckets._unbucketed = [];
    (data ?? []).forEach((c: any) => {
      (buckets[c.renewalStage] ?? buckets._unbucketed).push(c);
    });
    return buckets;
  }, [data]);
  const unbucketed = grouped._unbucketed ?? [];

  return (
    <Shell title="Renewals">
      <PageHeader title="Renewal pipeline" description="Manage the full renewal cycle from early-warning flags through negotiation to signed renewals. Automate renewal reminders, track contract status, and surface expansion opportunities at renewal time." pageKey="renewals"
        icon={<RefreshCw className="size-5" />}
      />
      {error ? <QueryError message={error.message} onRetry={() => refetch()} /> : isLoading ? <TableSkeleton rows={6} className="p-4" /> : (
      <div className="p-4 overflow-x-auto">
        <div className="flex gap-3 min-w-max" data-tour-id="renewals-board">
          {STAGES.map((s) => {
            const items = grouped[s.id] ?? [];
            const total = items.reduce((sum, c) => sum + Number(c.arr ?? 0), 0);
            return (
              <div key={s.id} className="w-72 shrink-0 bg-secondary/40 border rounded-lg flex flex-col">
                <div className="px-3 py-2 border-b flex items-center">
                  <StatusPill tone={s.tone}>{s.label}</StatusPill>
                  <div className="ml-auto text-[11px] text-muted-foreground">{items.length} · {fmt$(total)}</div>
                </div>
                <div className="flex-1 p-2 space-y-2 min-h-[60vh]">
                  {items.map((c) => (
                    <div key={c.id} className="bg-card border rounded p-2.5">
                      <div className="text-sm font-medium truncate">{c.account?.name ?? "—"}</div>
                      <div className="flex items-center justify-between mt-1.5">
                        <div className="font-mono text-sm tabular-nums whitespace-nowrap">{fmt$(Number(c.arr ?? 0))}</div>
                        <StatusPill tone={c.healthTier === "thriving" || c.healthTier === "healthy" ? "success" : c.healthTier === "at_risk" ? "warning" : c.healthTier === "critical" ? "danger" : "muted"}>
                          {c.healthScore}
                        </StatusPill>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1">Renewal {fmtDate(c.renewalDate)}</div>

                      {/* AI churn-risk score */}
                      {(c as any).churnRiskScore != null ? (
                        <div className={`mt-1.5 flex items-center gap-1 text-[11px] font-medium ${
                          (c as any).churnRiskScore >= 70 ? "text-rose-600" :
                          (c as any).churnRiskScore >= 40 ? "text-amber-600" :
                          "text-emerald-600"
                        }`}>
                          <AlertTriangle className="size-3" />
                          AI churn risk: {(c as any).churnRiskScore}%
                          {(c as any).churnRiskRationale && (
                            <span className="text-muted-foreground font-normal truncate ml-1" title={(c as any).churnRiskRationale}>
                              · {(c as any).churnRiskRationale.slice(0, 40)}{(c as any).churnRiskRationale.length > 40 ? "…" : ""}
                            </span>
                          )}
                        </div>
                      ) : (
                        <button
                          data-tour-id="renewals-score-churn"
                          className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => scoreChurn.mutate({ customerId: c.id })}
                          disabled={scoreChurn.isPending}
                        >
                          <Sparkles className="size-3" /> Score churn risk
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {/* Only renders when a renewalStage has no matching column — a
              visible signal that the board is out of date with the enum,
              rather than the records disappearing. */}
          {unbucketed.length > 0 && (
            <div className="w-72 shrink-0 bg-secondary/40 border border-dashed rounded-lg flex flex-col">
              <div className="px-3 py-2 border-b flex items-center">
                <StatusPill tone="warning">Unrecognised stage</StatusPill>
                <div className="ml-auto text-[11px] text-muted-foreground">{unbucketed.length}</div>
              </div>
              <div className="flex-1 p-2 space-y-2 min-h-[60vh]">
                {unbucketed.map((c: any) => (
                  <div key={c.id} className="bg-card border rounded p-2.5">
                    <div className="text-sm font-medium truncate">{c.account?.name ?? "—"}</div>
                    <div className="text-[11px] text-muted-foreground mt-1">
                      Stage: <code>{String(c.renewalStage)}</code>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      )}
    </Shell>
  );
}
