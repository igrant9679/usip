import { Button } from "@/components/ui/button";
import { Field, fmt$, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Package, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Products() {
  const utils = trpc.useUtils();
  const { data } = trpc.products.list.useQuery();
  const [open, setOpen] = useState(false);
  const create = trpc.products.create.useMutation({ onSuccess: () => { utils.products.list.invalidate(); setOpen(false); toast.success("Product added"); }, onError: (e) => toast.error(e.message) });
  const del = trpc.products.delete.useMutation({ onSuccess: () => utils.products.list.invalidate() });

  return (
    <Shell title="Product Catalog">
      <PageHeader title="Product catalog" description="Manage your product catalogue including SKUs, pricing tiers, billing cycles, and line-item configuration. Products are available for selection in quotes, proposals, and opportunity records." pageKey="products"
        icon={<Package className="size-5" />}
      >
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New product</Button>
      </PageHeader>
      <div className="p-6">
        <Section title={`Products (${data?.length ?? 0})`}>
          {(data ?? []).length === 0 ? <EmptyState icon={Package} title="No products" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary/50 text-xs uppercase">
                  <tr><th className="text-left p-2">SKU</th><th className="text-left p-2">Name</th><th className="text-left p-2">Category</th><th className="text-right p-2">List price</th><th className="text-left p-2">Cycle</th><th className="text-left p-2">Status</th><th></th></tr>
                </thead>
                <tbody>
                  {data!.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-2 font-mono text-xs whitespace-nowrap">{p.sku}</td>
                      <td className="p-2 font-medium">{p.name}</td>
                      <td className="p-2 text-muted-foreground">{p.category ?? "—"}</td>
                      <td className="p-2 text-right font-mono tabular-nums whitespace-nowrap">{fmt$(Number(p.listPrice))}</td>
                      <td className="p-2 text-muted-foreground">{p.billingCycle}</td>
                      <td className="p-2"><StatusPill tone={p.active ? "success" : "muted"}>{p.active ? "active" : "inactive"}</StatusPill></td>
                      <td className="p-2 text-right"><Button size="sm" variant="ghost" onClick={() => del.mutate({ id: p.id })}><Trash2 className="size-3.5" /></Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      <FormDialog open={open} onOpenChange={setOpen} title="New product" isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          sku: String(f.get("sku")), name: String(f.get("name")),
          description: String(f.get("description") ?? "") || undefined,
          category: String(f.get("category") ?? "") || undefined,
          listPrice: Number(f.get("listPrice")), cost: Number(f.get("cost") ?? 0),
          billingCycle: f.get("billingCycle") as any,
        })}>
        <div className="grid grid-cols-2 gap-2">
          <Field name="sku" label="SKU" required /><Field name="name" label="Name" required />
        </div>
        <Field name="category" label="Category" />
        <TextareaField name="description" label="Description" rows={2} />
        <div className="grid grid-cols-3 gap-2">
          <Field name="listPrice" label="List price" type="number" required />
          <Field name="cost" label="Cost" type="number" defaultValue={0} />
          <SelectField name="billingCycle" label="Cycle" options={[{ value: "annual", label: "annual" }, { value: "monthly", label: "monthly" }, { value: "one_time", label: "one_time" }]} defaultValue="annual" />
        </div>
      </FormDialog>
    </Shell>
  );
}
