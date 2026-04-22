import { Section, StatusPill, fmtDate } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Users } from "lucide-react";

export default function Team() {
  const { data } = trpc.workspace.members.useQuery();
  return (
    <Shell title="Team">
      <PageHeader title="Workspace team" description="Members provisioned via OAuth or SCIM. Roles enforce access." />
      <div className="p-6">
        <Section title={`Members (${data?.length ?? 0})`}>
          {(data ?? []).length === 0 ? <EmptyState icon={Users} title="No members" /> : (
            <ul className="divide-y">
              {data!.map((m) => (
                <li key={m.memberId ?? m.id} className="p-3 flex items-center text-sm">
                  <div className="flex-1">
                    <div className="font-medium">{m.name ?? m.email}</div>
                    <div className="text-xs text-muted-foreground">{m.email}{m.title ? ` · ${m.title}` : ""}</div>
                  </div>
                  <StatusPill tone={m.role === "super_admin" ? "danger" : m.role === "admin" ? "warning" : m.role === "manager" ? "info" : "muted"}>{m.role}</StatusPill>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </Shell>
  );
}
