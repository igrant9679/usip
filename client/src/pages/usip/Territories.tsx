import { Button } from "@/components/ui/button";
import { Field, FormDialog, Section, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Map, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Territories() {
  const utils = trpc.useUtils();
  const { data } = trpc.territories.list.useQuery();
  const [open, setOpen] = useState(false);
  const create = trpc.territories.create.useMutation({ onSuccess: () => { utils.territories.list.invalidate(); setOpen(false); toast.success("Territory created"); } });
  const del = trpc.territories.delete.useMutation({ onSuccess: () => utils.territories.list.invalidate() });

  return (
    <Shell title="Territories">
      <PageHeader title="Territories" description="Define geographic or account-based territories and assign reps." pageKey="territories"
        icon={<Map className="size-5" />}
      >
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New territory</Button>
      </PageHeader>
      <div className="p-6">
        <Section title={`Territories (${data?.length ?? 0})`}>
          {(data ?? []).length === 0 ? <EmptyState icon={Map} title="None yet" /> : (
            <ul className="divide-y">
              {data!.map((t) => (
                <li key={t.id} className="p-3 flex items-center text-sm">
                  <div className="flex-1">
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">Rules: {JSON.stringify(t.rules ?? {})}</div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => del.mutate({ id: t.id })}><Trash2 className="size-3.5" /></Button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <FormDialog open={open} onOpenChange={setOpen} title="New territory" isPending={create.isPending}
        onSubmit={(f) => {
          let rules: any = {};
          try { rules = JSON.parse(String(f.get("rules") ?? "{}")); } catch {}
          create.mutate({ name: String(f.get("name")), rules });
        }}>
        <Field name="name" label="Name" required />
        <TextareaField name="rules" label="Rules (JSON)" defaultValue={`{"region":"NA","segment":"mid_market"}`} rows={3} />
      </FormDialog>
    </Shell>
  );
}
