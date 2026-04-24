import { Button } from "@/components/ui/button";
import { Section, StatusPill, fmtDate } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Activity, Download } from "lucide-react";
import { useState } from "react";

function downloadCsv(rows: any[], filename: string) {
  if (!rows.length) return;
  const headers = ["id", "action", "entityType", "entityId", "actorUserId", "createdAt"];
  const lines = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => JSON.stringify(r[h] ?? "")).join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

export default function Audit() {
  const [entityType, setEntityType] = useState<string>("");
  const { data, error } = trpc.audit.list.useQuery({ entityType: entityType || undefined, limit: 500 });

  return (
    <Shell title="Audit log">
      <PageHeader title="Audit log" description="All record creates, updates, and deletes with before/after values. Admin only." />
      <div className="p-6 space-y-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Filter:</label>
          <select className="text-sm border rounded h-9 px-2" value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">All</option>
            {["account", "contact", "lead", "opportunity", "customer", "quote", "campaign", "workflow_rule", "social_post"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => downloadCsv(data ?? [], `audit-log-${Date.now()}.csv`)}
            disabled={!data?.length}
          >
            <Download className="size-4 mr-1" /> Export CSV
          </Button>
        </div>
        <Section title={error ? "Forbidden — admin role required" : `Recent activity (${data?.length ?? 0})`}>
          {error ? (
            <EmptyState icon={Activity} title="Access denied" description={error.message} />
          ) : (data ?? []).length === 0 ? (
            <EmptyState icon={Activity} title="No audit entries" />
          ) : (
            <ul className="divide-y">
              {data!.map((a) => (
                <li key={a.id} className="p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <StatusPill tone={a.action === "create" ? "success" : a.action === "delete" ? "danger" : "info"}>{a.action}</StatusPill>
                    <span className="font-mono text-xs">{a.entityType}#{a.entityId}</span>
                    <div className="ml-auto text-xs text-muted-foreground">{fmtDate(a.createdAt)} · user {a.actorUserId ?? "—"}</div>
                  </div>
                  {(a.before != null || a.after != null) ? (
                    <details className="mt-1.5">
                      <summary className="text-xs text-muted-foreground cursor-pointer">View diff</summary>
                      <div className="grid grid-cols-2 gap-2 mt-1.5">
                        <div><div className="text-[11px] uppercase text-muted-foreground">Before</div><pre className="bg-secondary/50 p-2 rounded text-[11px] overflow-x-auto">{JSON.stringify(a.before, null, 2)}</pre></div>
                        <div><div className="text-[11px] uppercase text-muted-foreground">After</div><pre className="bg-secondary/50 p-2 rounded text-[11px] overflow-x-auto">{JSON.stringify(a.after, null, 2)}</pre></div>
                      </div>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </Shell>
  );
}
