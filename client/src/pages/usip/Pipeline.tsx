import { Button } from "@/components/ui/button";
import { Field, fmt$, FormDialog, SelectField } from "@/components/usip/Common";
import { PageHeader, Shell } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { trpc } from "@/lib/trpc";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const STAGES = [
  { id: "discovery", label: "Discovery" },
  { id: "qualified", label: "Qualified" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
] as const;

export default function Pipeline() {
  const utils = trpc.useUtils();
  const { data } = trpc.opportunities.board.useQuery();
  const { data: accounts } = trpc.accounts.list.useQuery();
  const setStage = trpc.opportunities.setStage.useMutation({
    onMutate: async ({ id, stage }) => {
      await utils.opportunities.board.cancel();
      const prev = utils.opportunities.board.getData();
      utils.opportunities.board.setData(undefined, (old) => (old ?? []).map((o) => (o.id === id ? { ...o, stage } : o)));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) utils.opportunities.board.setData(undefined, ctx.prev); toast.error("Move failed"); },
    onSettled: () => utils.opportunities.board.invalidate(),
  });
  const [addOpen, setAddOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ id: number; name: string; subtitle: string } | null>(null);
  const create = trpc.opportunities.create.useMutation({
    onSuccess: () => { utils.opportunities.board.invalidate(); setAddOpen(false); toast.success("Opportunity created"); },
  });

  const grouped = useMemo(() => {
    const buckets: Record<string, typeof data> = {};
    STAGES.forEach((s) => (buckets[s.id] = []));
    (data ?? []).forEach((o) => buckets[o.stage]?.push(o));
    return buckets;
  }, [data]);

  return (
    <Shell title="Pipeline">
      <PageHeader title="Pipeline" description="Drag cards between stages.">
        <Button onClick={() => setAddOpen(true)}><Plus className="size-4" /> New opportunity</Button>
      </PageHeader>

      <div className="p-4 overflow-x-auto">
        <div className="flex gap-3 min-w-max">
          {STAGES.map((s) => {
            const items = grouped[s.id] ?? [];
            const total = items.reduce((sum, o) => sum + Number(o.value ?? 0), 0);
            return (
              <div
                key={s.id}
                className="w-72 shrink-0 bg-secondary/40 border rounded-lg flex flex-col"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const id = Number(e.dataTransfer.getData("text/plain"));
                  if (id) setStage.mutate({ id, stage: s.id });
                }}
              >
                <div className="px-3 py-2 border-b flex items-center">
                  <div className="text-sm font-medium">{s.label}</div>
                  <div className="ml-auto text-[11px] text-muted-foreground">{items.length} · {fmt$(total)}</div>
                </div>
                <div className="flex-1 p-2 space-y-2 min-h-[60vh]">
                  {items.map((o) => (
                    <div
                      key={o.id}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("text/plain", String(o.id))}
                      onClick={() => setDrawer({ id: o.id, name: o.name, subtitle: `${o.accountName} · ${fmt$(Number(o.value))} · ${o.winProb}%` })}
                      className="bg-card border rounded p-2.5 cursor-pointer hover:shadow hover:border-[#14B89A]"
                    >
                      <div className="text-sm font-medium truncate">{o.name}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{o.accountName}</div>
                      <div className="flex items-center justify-between mt-1.5">
                        <div className="font-mono text-sm">{fmt$(Number(o.value))}</div>
                        <div className="text-[11px] text-muted-foreground">{o.winProb}%</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <FormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="New opportunity"
        isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          name: String(f.get("name")),
          accountId: Number(f.get("accountId")),
          value: Number(f.get("value")),
          stage: f.get("stage") as any,
          winProb: Number(f.get("winProb") ?? 25),
        })}
      >
        <Field name="name" label="Name" required />
        <SelectField
          name="accountId"
          label="Account"
          options={(accounts ?? []).map((a) => ({ value: String(a.id), label: a.name }))}
        />
        <div className="grid grid-cols-3 gap-3">
          <Field name="value" label="Value ($)" type="number" required defaultValue={10000} />
          <SelectField name="stage" label="Stage" options={STAGES.map((s) => ({ value: s.id, label: s.label }))} defaultValue="discovery" />
          <Field name="winProb" label="Win %" type="number" defaultValue={25} />
        </div>
      </FormDialog>
      <RecordDrawer open={!!drawer} onOpenChange={(v) => !v && setDrawer(null)} relatedType="opportunity" relatedId={drawer?.id ?? null} title={drawer?.name ?? ""} subtitle={drawer?.subtitle} />
    </Shell>
  );
}
