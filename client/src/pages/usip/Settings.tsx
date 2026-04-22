import { Section, fmt$, StatusPill } from "@/components/usip/Common";
import { PageHeader, Shell, StatCard } from "@/components/usip/Shell";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { trpc } from "@/lib/trpc";

export default function Settings() {
  const { current } = useWorkspace();
  const summary = trpc.workspace.summary.useQuery();
  return (
    <Shell title="Settings">
      <PageHeader title="Workspace settings" description="Information about this workspace and your role." />
      <div className="p-6 space-y-4">
        <Section title="Workspace">
          <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm min-w-0">
            <div className="min-w-0"><div className="text-xs text-muted-foreground">Name</div><div className="font-medium truncate" title={current?.name ?? "—"}>{current?.name ?? "—"}</div></div>
            <div className="min-w-0"><div className="text-xs text-muted-foreground">Slug</div><div className="font-mono truncate" title={current?.slug ?? "—"}>{current?.slug ?? "—"}</div></div>
            <div><div className="text-xs text-muted-foreground">Plan</div><StatusPill tone="info">{current?.plan ?? "—"}</StatusPill></div>
            <div><div className="text-xs text-muted-foreground">Your role</div><StatusPill tone={current?.role === "super_admin" ? "danger" : current?.role === "admin" ? "warning" : current?.role === "manager" ? "info" : "muted"}>{current?.role ?? "—"}</StatusPill></div>
          </div>
        </Section>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          <StatCard label="Accounts" value={summary.data?.accounts ?? 0} />
          <StatCard label="Contacts" value={summary.data?.contacts ?? 0} />
          <StatCard label="Leads" value={summary.data?.leads ?? 0} />
          <StatCard label="Opportunities" value={summary.data?.opportunities ?? 0} />
          <StatCard label="Open tasks" value={summary.data?.openTasks ?? 0} />
          <StatCard label="Pipeline value" value={fmt$(summary.data?.pipelineValue ?? 0)} />
          <StatCard label="Closed-won value" value={fmt$(summary.data?.closedWon ?? 0)} tone="success" />
          <StatCard label="Customers" value={summary.data?.customers ?? 0} />
        </div>
        <Section title="Visual editor & publishing">
          <div className="p-4 text-sm text-muted-foreground space-y-1">
            <p>Use the Manus management panel to publish, view dashboards, manage secrets, or rollback to a previous version.</p>
          </div>
        </Section>
      </div>
    </Shell>
  );
}
