import { fmt$, fmtDate, StatusPill } from "@/components/usip/Common";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { useMemo } from "react";

const STAGES = [
  { id: "secure", label: "Secure", tone: "success" as const },
  { id: "thirty", label: "30 days", tone: "info" as const },
  { id: "sixty", label: "60 days", tone: "info" as const },
  { id: "ninety", label: "90 days", tone: "warning" as const },
  { id: "at_risk", label: "At risk", tone: "danger" as const },
  { id: "renewed", label: "Renewed", tone: "muted" as const },
  { id: "churned", label: "Churned", tone: "muted" as const },
];

export default function Renewals() {
  const { data } = trpc.cs.renewalsBoard.useQuery();
  const grouped = useMemo(() => {
    const buckets: Record<string, any[]> = {};
    STAGES.forEach((s) => (buckets[s.id] = []));
    (data ?? []).forEach((c: any) => buckets[c.renewalStage]?.push(c));
    return buckets;
  }, [data]);

  return (
    <Shell title="Renewals">
      <PageHeader title="Renewal pipeline" description="Customers grouped by days to renewal." pageKey="renewals" />
      <div className="p-4 overflow-x-auto">
        <div className="flex gap-3 min-w-max">
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
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Shell>
  );
}
