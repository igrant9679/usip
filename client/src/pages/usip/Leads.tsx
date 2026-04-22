import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { trpc } from "@/lib/trpc";
import { Loader2, Plus, Sparkles, Target, UserCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

const GRADE_TONE: Record<string, string> = { A: "bg-emerald-100 text-emerald-800", B: "bg-blue-100 text-blue-800", C: "bg-amber-100 text-amber-800", D: "bg-rose-100 text-rose-800" };

const TIER_TONE: Record<string, { label: string; cls: string }> = {
  cold: { label: "Cold", cls: "bg-slate-200 text-slate-700" },
  warm: { label: "Warm", cls: "bg-yellow-100 text-yellow-800" },
  hot: { label: "Hot", cls: "bg-orange-100 text-orange-800" },
  sales_ready: { label: "Sales Ready", cls: "bg-emerald-100 text-emerald-800" },
};
function tierFromScore(s: number | null | undefined): keyof typeof TIER_TONE {
  const n = s ?? 0;
  if (n >= 81) return "sales_ready";
  if (n >= 61) return "hot";
  if (n >= 31) return "warm";
  return "cold";
}

export default function Leads() {
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ id: number; name: string; subtitle: string } | null>(null);
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.leads.list.useQuery({ search });
  const rescore = trpc.leadScoring.recompute.useMutation({
    onSuccess: () => { utils.leads.list.invalidate(); toast.success("Re-scored"); },
  });
  const convert = trpc.leads.convert.useMutation({
    onSuccess: () => { utils.leads.list.invalidate(); utils.workspace.summary.invalidate(); toast.success("Converted to account + contact + opportunity"); },
  });

  return (
    <Shell title="Leads">
      <PageHeader title="Leads" description="Inbound + outbound lead inbox with AI grading.">
        <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-56" />
        <Button onClick={() => setCreateOpen(true)}><Plus className="size-4" /> New lead</Button>
      </PageHeader>
      <div className="p-6">
        {isLoading ? <Loader2 className="animate-spin size-4" /> : (data ?? []).length === 0 ? (
          <EmptyState icon={Target} title="No leads yet" description="Create one or wait for inbound." />
        ) : (
          <div className="rounded-lg border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Title / Company</th>
                  <th className="text-left px-3 py-2">Email</th>
                  <th className="text-left px-3 py-2">Source</th>
                  <th className="text-left px-3 py-2">Score</th>
                  <th className="text-left px-3 py-2">Status</th>
                  <th className="text-right px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data!.map((l) => (
                  <tr key={l.id} className="hover:bg-secondary/30 cursor-pointer" onClick={() => setDrawer({ id: l.id, name: `${l.firstName} ${l.lastName}`, subtitle: `${l.title ?? ""} · ${l.company ?? ""}` })}>
                    <td className="px-3 py-2 font-medium"><span className="underline-offset-2 hover:underline">{l.firstName} {l.lastName}</span></td>
                    <td className="px-3 py-2 text-muted-foreground">{l.title} · {l.company}</td>
                    <td className="px-3 py-2 text-muted-foreground">{l.email}</td>
                    <td className="px-3 py-2 text-muted-foreground">{l.source}</td>
                    <td className="px-3 py-2">
                      <span className="font-mono tabular-nums">{l.score}</span>
                      <span className={`ml-2 inline-block px-1.5 rounded text-xs ${GRADE_TONE[l.grade ?? "C"] ?? ""}`}>{l.grade ?? "—"}</span>
                      {(() => { const t = tierFromScore(l.score); return <span className={`ml-1 inline-block px-1.5 rounded text-xs ${TIER_TONE[t].cls}`}>{TIER_TONE[t].label}</span>; })()}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{l.status}</td>
                    <td className="px-3 py-2 text-right space-x-1" onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="ghost" onClick={() => rescore.mutate({ leadId: l.id })} disabled={rescore.isPending}><Sparkles className="size-3.5" /> AI score</Button>
                      {l.status !== "converted" && (
                        <Button size="sm" variant="outline" className="bg-card" onClick={() => convert.mutate({ id: l.id, createOpportunity: true })} disabled={convert.isPending}><UserCheck className="size-3.5" /> Convert</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateLeadDialog open={createOpen} onOpenChange={setCreateOpen} />
      <RecordDrawer open={!!drawer} onOpenChange={(v) => !v && setDrawer(null)} relatedType="lead" relatedId={drawer?.id ?? null} title={drawer?.name ?? ""} subtitle={drawer?.subtitle} />
    </Shell>
  );
}

function CreateLeadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const utils = trpc.useUtils();
  const create = trpc.leads.create.useMutation({
    onSuccess: () => { utils.leads.list.invalidate(); onOpenChange(false); toast.success("Lead created"); },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>New lead</DialogTitle></DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            create.mutate({
              firstName: String(f.get("firstName")),
              lastName: String(f.get("lastName")),
              email: String(f.get("email") ?? "") || undefined,
              company: String(f.get("company") ?? "") || undefined,
              title: String(f.get("title") ?? "") || undefined,
              source: String(f.get("source") ?? "manual") || "manual",
            });
          }}
          className="space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <Field name="firstName" label="First name" required />
            <Field name="lastName" label="Last name" required />
          </div>
          <Field name="email" label="Email" type="email" />
          <div className="grid grid-cols-2 gap-3">
            <Field name="title" label="Title" />
            <Field name="company" label="Company" />
          </div>
          <Field name="source" label="Source" placeholder="manual / webform / event…" />
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>Create</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field(props: { name: string; label: string; type?: string; required?: boolean; placeholder?: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={props.name}>{props.label}</Label>
      <Input id={props.name} name={props.name} type={props.type ?? "text"} required={props.required} placeholder={props.placeholder} />
    </div>
  );
}
