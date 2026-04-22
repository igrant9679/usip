import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, fmt$, fmtDate, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell, StatCard } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Megaphone, Plus, Rocket, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Campaigns() {
  const utils = trpc.useUtils();
  const { data } = trpc.campaigns.list.useQuery();
  const [selected, setSelected] = useState<number | null>(null);
  const [openNew, setOpenNew] = useState(false);
  const [openComp, setOpenComp] = useState(false);
  const detail = trpc.campaigns.get.useQuery({ id: selected! }, { enabled: !!selected });
  const components = trpc.campaigns.components.useQuery({ campaignId: selected! }, { enabled: !!selected });
  const analytics = trpc.campaigns.analytics.useQuery({ id: selected! }, { enabled: !!selected });

  const create = trpc.campaigns.create.useMutation({ onSuccess: (r) => { utils.campaigns.list.invalidate(); setSelected(r.id); setOpenNew(false); toast.success("Campaign created"); } });
  const launch = trpc.campaigns.launch.useMutation({
    onSuccess: () => { utils.campaigns.list.invalidate(); utils.campaigns.get.invalidate(); toast.success("Launched"); },
    onError: (e) => toast.error(e.message),
  });
  const tog = trpc.campaigns.toggleChecklist.useMutation({ onSuccess: () => utils.campaigns.get.invalidate() });
  const attach = trpc.campaigns.attachComponent.useMutation({ onSuccess: () => { utils.campaigns.components.invalidate(); setOpenComp(false); } });
  const del = trpc.campaigns.delete.useMutation({ onSuccess: () => { utils.campaigns.list.invalidate(); setSelected(null); } });
  const remove = trpc.campaigns.removeComponent.useMutation({ onSuccess: () => utils.campaigns.components.invalidate() });

  const checklist: any[] = (detail.data as any)?.checklist ?? [];
  const incomplete = checklist.filter((x) => !x.done).length;

  return (
    <Shell title="Campaigns">
      <PageHeader title="Multi-channel campaigns" description="Group sequences, social posts, ads, and content with unified analytics.">
        <Button onClick={() => setOpenNew(true)}><Plus className="size-4" /> New campaign</Button>
      </PageHeader>
      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div>
          <Section title={`Campaigns (${data?.length ?? 0})`}>
            {(data ?? []).length === 0 ? <EmptyState icon={Megaphone} title="None yet" /> : (
              <ul className="divide-y">
                {data!.map((c) => (
                  <li key={c.id} className={`p-3 cursor-pointer hover:bg-secondary/40 ${selected === c.id ? "bg-secondary/60" : ""}`} onClick={() => setSelected(c.id)}>
                    <div className="text-sm font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex gap-2 items-center">
                      <StatusPill tone={c.status === "live" ? "success" : c.status === "planning" ? "info" : "muted"}>{c.status}</StatusPill>
                      <span className="font-mono tabular-nums">{fmt$(Number(c.budget))}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div className="lg:col-span-2 space-y-4">
          {!selected ? <EmptyState icon={Megaphone} title="Select a campaign" /> : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <StatCard label="Pipeline" value={fmt$(analytics.data?.pipelineValue ?? 0)} />
                <StatCard label="Won" value={fmt$(analytics.data?.wonValue ?? 0)} tone="success" />
                <StatCard label="Posts" value={analytics.data?.socialPosts ?? 0} />
                <StatCard label="Impressions" value={(analytics.data?.socialImpressions ?? 0).toLocaleString()} />
              </div>

              <Section title="Launch checklist" description={incomplete > 0 ? `${incomplete} item(s) remaining` : "Ready to launch"}
                right={
                  <div className="flex gap-1">
                    <Button size="sm" disabled={launch.isPending} onClick={() => launch.mutate({ id: selected })}><Rocket className="size-3.5" /> Launch</Button>
                    <Button size="sm" variant="ghost" onClick={() => del.mutate({ id: selected })}><Trash2 className="size-3.5" /></Button>
                  </div>
                }>
                <ul className="divide-y">
                  {checklist.map((item) => (
                    <li key={item.id} className="p-3 flex items-center gap-2 text-sm">
                      <Checkbox checked={item.done} onCheckedChange={(v) => tog.mutate({ id: selected, itemId: item.id, done: !!v })} />
                      <span className={item.done ? "line-through text-muted-foreground" : ""}>{item.label}</span>
                    </li>
                  ))}
                </ul>
              </Section>

              <Section title={`Components (${components.data?.length ?? 0})`}
                right={<Button size="sm" variant="ghost" onClick={() => setOpenComp(true)}><Plus className="size-3.5" /> Attach</Button>}>
                {(components.data ?? []).length === 0 ? <div className="p-3 text-sm text-muted-foreground">None attached.</div> : (
                  <ul className="divide-y">
                    {components.data!.map((c) => (
                      <li key={c.id} className="p-3 flex items-center text-sm gap-2">
                        <StatusPill tone="info">{c.componentType}</StatusPill>
                        <div className="flex-1">{c.label}</div>
                        <Button size="sm" variant="ghost" onClick={() => remove.mutate({ id: c.id })}><Trash2 className="size-3.5" /></Button>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          )}
        </div>
      </div>

      <FormDialog open={openNew} onOpenChange={setOpenNew} title="New campaign" isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          name: String(f.get("name")),
          objective: String(f.get("objective") ?? "") || undefined,
          description: String(f.get("description") ?? "") || undefined,
          budget: Number(f.get("budget") ?? 0),
          startsAt: f.get("startsAt") ? new Date(String(f.get("startsAt"))).toISOString() : undefined,
          endsAt: f.get("endsAt") ? new Date(String(f.get("endsAt"))).toISOString() : undefined,
        })}>
        <Field name="name" label="Name" required />
        <Field name="objective" label="Objective" placeholder="Pipeline / awareness / launch" />
        <TextareaField name="description" label="Description" />
        <div className="grid grid-cols-2 gap-2">
          <Field name="budget" label="Budget" type="number" defaultValue={0} />
          <Field name="startsAt" label="Starts" type="date" />
        </div>
        <Field name="endsAt" label="Ends" type="date" />
      </FormDialog>

      <FormDialog open={openComp} onOpenChange={setOpenComp} title="Attach component" isPending={attach.isPending}
        onSubmit={(f) => attach.mutate({
          campaignId: selected!,
          componentType: f.get("componentType") as any,
          label: String(f.get("label")),
          notes: String(f.get("notes") ?? "") || undefined,
        })}>
        <SelectField name="componentType" label="Type" options={["sequence", "social_post", "ad", "content", "event"].map((v) => ({ value: v, label: v }))} defaultValue="sequence" />
        <Field name="label" label="Label" required />
        <TextareaField name="notes" label="Notes" />
      </FormDialog>
    </Shell>
  );
}
