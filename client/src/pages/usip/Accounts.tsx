import { Button } from "@/components/ui/button";
import { Field, fmt$, FormDialog, SelectField, Section, StatusPill } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { trpc } from "@/lib/trpc";
import { Building2, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Accounts() {
  const [open, setOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ id: number; name: string; subtitle: string } | null>(null);
  const utils = trpc.useUtils();
  const { data: list } = trpc.accounts.list.useQuery();
  const { data: tree } = trpc.accounts.hierarchy.useQuery();
  const create = trpc.accounts.create.useMutation({
    onSuccess: () => { utils.accounts.list.invalidate(); utils.accounts.hierarchy.invalidate(); setOpen(false); toast.success("Account created"); },
  });

  return (
    <Shell title="Accounts">
      <PageHeader title="Accounts" description="Companies you sell to. Parent → child rollup of ARR is computed automatically.">
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New account</Button>
      </PageHeader>
      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <Section title="All accounts">
            {(list ?? []).length === 0 ? <EmptyState icon={Building2} title="No accounts" /> : (
              <table className="w-full text-sm">
                <thead className="bg-secondary/50 text-xs uppercase text-muted-foreground">
                  <tr><th className="text-left px-3 py-2">Name</th><th className="text-left px-3 py-2">Industry</th><th className="text-left px-3 py-2">Region</th><th className="text-right px-3 py-2">ARR</th><th className="text-right px-3 py-2">Employees</th></tr>
                </thead>
                <tbody className="divide-y">
                  {list!.map((a) => (
                    <tr key={a.id} className="hover:bg-secondary/30 cursor-pointer" onClick={() => setDrawer({ id: a.id, name: a.name, subtitle: `${a.industry ?? ""} · ${a.region ?? ""}` })}>
                      <td className="px-3 py-2 font-medium"><span className="underline-offset-2 hover:underline">{a.name}</span> {a.parentAccountId && <StatusPill tone="muted">child</StatusPill>}</td>
                      <td className="px-3 py-2 text-muted-foreground">{a.industry ?? "—"}</td>
                      <td className="px-3 py-2 text-muted-foreground">{a.region ?? "—"}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">{fmt$(Number(a.arr ?? 0))}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">{a.employeeBand ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </div>
        <div>
          <Section title="Hierarchy" description="ARR rolled up to parent.">
            <div className="p-3 space-y-2">
              {((tree as any)?.roots ?? []).map((node: any) => <Node key={node.id} node={node} depth={0} />)}
            </div>
          </Section>
        </div>
      </div>

      <FormDialog open={open} onOpenChange={setOpen} title="New account" isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          name: String(f.get("name")),
          industry: String(f.get("industry") ?? "") || undefined,
          region: String(f.get("region") ?? "") || undefined,
          parentAccountId: Number(f.get("parentAccountId")) || undefined,
        })}>
        <Field name="name" label="Name" required />
        <Field name="industry" label="Industry" />
        <Field name="region" label="Region" />
        <SelectField name="parentAccountId" label="Parent (optional)" options={[{ value: "", label: "— None —" }, ...((list ?? []).map((a) => ({ value: String(a.id), label: a.name })))]} />
      </FormDialog>
      <RecordDrawer open={!!drawer} onOpenChange={(v) => !v && setDrawer(null)} relatedType="account" relatedId={drawer?.id ?? null} title={drawer?.name ?? ""} subtitle={drawer?.subtitle} />
    </Shell>
  );
}

function Node({ node, depth }: { node: any; depth: number }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm py-1 hover:bg-secondary/30 rounded px-1" style={{ paddingLeft: depth * 16 + 4 }}>
        {node.children?.length ? <ChevronRight className="size-3.5 text-muted-foreground" /> : <span className="size-3.5" />}
        <span className="flex-1 truncate">{node.name}</span>
        <span className="font-mono tabular-nums text-xs whitespace-nowrap shrink-0">{fmt$(Number(node.rolledArr ?? node.arr ?? 0))}</span>
      </div>
      {node.children?.map((c: any) => <Node key={c.id} node={c} depth={depth + 1} />)}
    </div>
  );
}
