import { Button } from "@/components/ui/button";
import { Section, StatusPill, fmtDate } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { usePermissions } from "@/hooks/usePermissions";
import { Activity, ClipboardList, Download, Loader2, User } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Audit() {
  // 2026-09-20: a real boundary now, not only UX. The CSV used to be built here
  // from the rows audit.list had already returned — capped at the 500 on screen,
  // missing the before/after diff the page copy promises, and escaped with
  // JSON.stringify (backslashes, which Excel reads wrong). It is rendered by
  // audit.exportCsv on the server, which enforces export_data itself.
  const { can } = usePermissions();
  const [entityType, setEntityType] = useState<string>("");
  const [actorUserId, setActorUserId] = useState<number | undefined>(undefined);

  const { data, error } = trpc.audit.list.useQuery({
    entityType: entityType || undefined,
    actorUserId,
    limit: 500,
  });

  // Load team members for the member filter dropdown
  const { data: teamData } = trpc.team.list.useQuery(undefined);
  const activeMembers = (teamData ?? []).filter((m: any) => !m.deactivatedAt);

  // Derived from what this workspace has recorded, rather than a hardcoded list
  // — the old one offered four types nothing ever writes and omitted ~60 real
  // ones, so most of the log could not be filtered or exported at all.
  const { data: entityTypes } = trpc.audit.entityTypes.useQuery(undefined);

  const exportCsv = trpc.audit.exportCsv.useMutation({
    onSuccess: (r) => {
      if (!r.rows) { toast.info("Nothing to export with these filters"); return; }
      const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      if (r.capped) toast.warning(`Exported the ${r.rows} most recent of ${r.total} matching entries — narrow the filters to export the rest`);
      else toast.success(`Exported ${r.rows} entries`);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Shell title="Audit log">
      <PageHeader title="Audit log" description="A complete audit trail of all record creates, updates, and deletes with before-and-after field values. Restricted to workspace admins for compliance and security review." pageKey="audit" icon={<ClipboardList className="size-5" />} />
      <div className="p-4 md:p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Entity type filter */}
          <label className="text-xs text-muted-foreground">Entity:</label>
          <select
            className="text-sm border rounded h-9 px-2 bg-background"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
          >
            <option value="">All entities</option>
            {(entityTypes ?? []).map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          {/* Member filter */}
          <label className="text-xs text-muted-foreground ml-2">
            <User className="size-3 inline-block mr-1 align-middle" />
            Member:
          </label>
          <select
            className="text-sm border rounded h-9 px-2 bg-background"
            value={actorUserId ?? ""}
            onChange={(e) => setActorUserId(e.target.value ? Number(e.target.value) : undefined)}
          >
            <option value="">All members</option>
            {activeMembers.map((m: any) => (
              <option key={m.userId} value={m.userId}>
                {m.name ?? m.email ?? `User ${m.userId}`}
              </option>
            ))}
          </select>

          {/* Clear filters */}
          {(entityType || actorUserId) && (
            <Button
              size="sm"
              variant="ghost"
              className="text-xs h-9"
              onClick={() => { setEntityType(""); setActorUserId(undefined); }}
            >
              Clear filters
            </Button>
          )}

          {can("export_data") && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => exportCsv.mutate({ entityType: entityType || undefined, actorUserId })}
            disabled={exportCsv.isPending}
          >
            {exportCsv.isPending ? <Loader2 className="size-4 mr-1 animate-spin" /> : <Download className="size-4 mr-1" />} Export CSV
          </Button>
          )}
        </div>

        <Section
          title={
            error
              ? "Forbidden — admin role required"
              : actorUserId
              ? `Activity for ${activeMembers.find((m: any) => m.userId === actorUserId)?.name ?? `User ${actorUserId}`} (${data?.length ?? 0})`
              : `Recent activity (${data?.length ?? 0})`
          }
        >
          {error ? (
            <EmptyState icon={Activity} title="Access denied" description={error.message} />
          ) : (data ?? []).length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No audit entries"
              description={actorUserId ? "No activity found for this member with the current filters." : undefined}
            />
          ) : (
            <ul className="divide-y">
              {data!.map((a) => (
                <li key={a.id} className="p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <StatusPill tone={a.action === "create" ? "success" : a.action === "delete" ? "danger" : "info"}>
                      {a.action}
                    </StatusPill>
                    <span className="font-mono text-xs">{a.entityType}#{a.entityId}</span>
                    <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                      {a.actorUserId && (
                        <button
                          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                          title="Filter by this member"
                          onClick={() => setActorUserId(a.actorUserId ?? undefined)}
                        >
                          <User className="size-3" />
                          {activeMembers.find((m: any) => m.userId === a.actorUserId)?.name ?? `User ${a.actorUserId}`}
                        </button>
                      )}
                      <span>{fmtDate(a.createdAt)}</span>
                    </div>
                  </div>
                  {(a.before != null || a.after != null) ? (
                    <details className="mt-1.5">
                      <summary className="text-xs text-muted-foreground cursor-pointer">View diff</summary>
                      <div className="grid grid-cols-2 gap-2 mt-1.5">
                        <div>
                          <div className="text-[11px] uppercase text-muted-foreground">Before</div>
                          <pre className="bg-secondary/50 p-2 rounded text-[11px] overflow-x-auto">
                            {JSON.stringify(a.before, null, 2)}
                          </pre>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase text-muted-foreground">After</div>
                          <pre className="bg-secondary/50 p-2 rounded text-[11px] overflow-x-auto">
                            {JSON.stringify(a.after, null, 2)}
                          </pre>
                        </div>
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
