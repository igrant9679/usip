import { Button } from "@/components/ui/button";
import { ConfirmButton, Field, fmt$, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, QueryError, Shell, TableSkeleton } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Archive, ArchiveRestore, Package, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type ProductRow = {
  id: number; sku: string; name: string; description: string | null; category: string | null;
  listPrice: string; cost: string | null; billingCycle: "one_time" | "monthly" | "annual"; active: boolean;
};

const CYCLES = [{ value: "annual", label: "annual" }, { value: "monthly", label: "monthly" }, { value: "one_time", label: "one_time" }];

/** The fields both dialogs read, from the form they submit. */
function productFields(f: FormData) {
  return {
    sku: String(f.get("sku")), name: String(f.get("name")),
    description: String(f.get("description") ?? "") || undefined,
    category: String(f.get("category") ?? "") || undefined,
    listPrice: Number(f.get("listPrice")), cost: Number(f.get("cost") ?? 0),
    billingCycle: f.get("billingCycle") as ProductRow["billingCycle"],
  };
}

export default function Products() {
  const utils = trpc.useUtils();
  const { data, isLoading, error, refetch } = trpc.products.list.useQuery();
  const [open, setOpen] = useState(false);
  // Products can be edited (audit 2026-10-20, R75): a typo in a price or a
  // name could only be fixed by deleting the product, which broke every line
  // that used it.
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const create = trpc.products.create.useMutation({ onSuccess: () => { utils.products.list.invalidate(); setOpen(false); toast.success("Product added"); }, onError: (e) => toast.error(e.message) });
  const update = trpc.products.update.useMutation({ onSuccess: () => { utils.products.list.invalidate(); setEditing(null); toast.success("Product saved"); }, onError: (e) => toast.error(e.message) });
  const setActive = trpc.products.update.useMutation({
    onSuccess: (_d, vars) => { utils.products.list.invalidate(); toast.success(vars.patch.active ? "Product restored" : "Product archived"); },
    onError: (e) => toast.error(e.message),
  });
  // Refused by the server while a deal or quote line uses the product (R75);
  // its message says to archive instead.
  const del = trpc.products.delete.useMutation({ onSuccess: () => { utils.products.list.invalidate(); toast.success("Product deleted"); }, onError: (e) => toast.error(e.message) });

  return (
    <Shell title="Product Catalog">
      <PageHeader title="Product catalog" description="The products and services you sell: SKU, list price, cost and billing cycle. Active products can be added to quotes and deal line items; archive one to take it off new quotes without touching the lines that already use it." pageKey="products"
        icon={<Package className="size-5" />}
      >
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New product</Button>
      </PageHeader>
      <div className="p-4 md:p-5">
        <Section title={`Products (${data?.length ?? 0})`}>
          {error ? <QueryError message={error.message} onRetry={() => refetch()} /> : isLoading ? <TableSkeleton rows={6} /> : (data ?? []).length === 0 ? <EmptyState icon={Package} title="No products yet" description="Add the products and services you sell. They power opportunity line items and quotes." /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary/50 text-xs uppercase">
                  <tr><th className="text-left p-2">SKU</th><th className="text-left p-2">Name</th><th className="text-left p-2">Category</th><th className="text-right p-2">List price</th><th className="text-left p-2">Cycle</th><th className="text-left p-2">Status</th><th></th></tr>
                </thead>
                <tbody>
                  {(data as ProductRow[]).map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-2 font-mono text-xs whitespace-nowrap">{p.sku}</td>
                      <td className="p-2 font-medium">{p.name}</td>
                      <td className="p-2 text-muted-foreground">{p.category ?? "—"}</td>
                      <td className="p-2 text-right font-mono tabular-nums whitespace-nowrap">{fmt$(Number(p.listPrice))}</td>
                      <td className="p-2 text-muted-foreground">{p.billingCycle}</td>
                      <td className="p-2"><StatusPill tone={p.active ? "success" : "muted"}>{p.active ? "active" : "archived"}</StatusPill></td>
                      <td className="p-2 text-right whitespace-nowrap">
                        <Button aria-label={`Edit ${p.name}`} size="sm" variant="ghost" onClick={() => setEditing(p)}><Pencil className="size-3.5" /></Button>
                        {p.active
                          ? <ConfirmButton size="sm" variant="ghost" destructive={false} ariaLabel={`Archive ${p.name}`} title={`Archive "${p.name}"?`}
                              description="It leaves the product picker for new quotes. Deals and quotes that already have it keep their lines. You can restore it here."
                              confirmLabel="Archive" onConfirm={() => setActive.mutate({ id: p.id, patch: { active: false } })}><Archive className="size-3.5" /></ConfirmButton>
                          : <Button aria-label={`Restore ${p.name}`} size="sm" variant="ghost" disabled={setActive.isPending} onClick={() => setActive.mutate({ id: p.id, patch: { active: true } })}><ArchiveRestore className="size-3.5" /></Button>}
                        <ConfirmButton size="sm" variant="ghost" ariaLabel={`Delete ${p.name}`} title={`Delete "${p.name}"?`}
                          description="Removes the product for good. A product on any deal or quote line can't be deleted — archive it instead."
                          confirmLabel="Delete" onConfirm={() => del.mutate({ id: p.id })}><Trash2 className="size-3.5" /></ConfirmButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>

      <FormDialog open={open} onOpenChange={setOpen} title="New product" isPending={create.isPending}
        onSubmit={(f) => create.mutate(productFields(f))}>
        <div className="grid grid-cols-2 gap-2">
          <Field name="sku" label="SKU" required /><Field name="name" label="Name" required />
        </div>
        <Field name="category" label="Category" />
        <TextareaField name="description" label="Description" rows={2} />
        <div className="grid grid-cols-3 gap-2">
          <Field name="listPrice" label="List price" type="money" required />
          <Field name="cost" label="Cost" type="money" defaultValue={0} />
          <SelectField name="billingCycle" label="Cycle" options={CYCLES} defaultValue="annual" />
        </div>
      </FormDialog>

      {/* Keyed by product so each edit starts from that product's values. */}
      <FormDialog key={editing?.id ?? "none"} open={!!editing} onOpenChange={(v) => { if (!v) setEditing(null); }} title={`Edit ${editing?.name ?? "product"}`} submitLabel="Save" isPending={update.isPending}
        onSubmit={(f) => { if (editing) update.mutate({ id: editing.id, patch: { ...productFields(f), description: String(f.get("description") ?? "") || null, category: String(f.get("category") ?? "") || null } }); }}>
        <div className="grid grid-cols-2 gap-2">
          <Field name="sku" label="SKU" required defaultValue={editing?.sku} /><Field name="name" label="Name" required defaultValue={editing?.name} />
        </div>
        <Field name="category" label="Category" defaultValue={editing?.category ?? ""} />
        <TextareaField name="description" label="Description" rows={2} defaultValue={editing?.description ?? ""} />
        <div className="grid grid-cols-3 gap-2">
          <Field name="listPrice" label="List price" type="money" required defaultValue={editing ? Number(editing.listPrice) : undefined} />
          <Field name="cost" label="Cost" type="money" defaultValue={editing ? Number(editing.cost ?? 0) : 0} />
          <SelectField name="billingCycle" label="Cycle" options={CYCLES} defaultValue={editing?.billingCycle ?? "annual"} />
        </div>
      </FormDialog>
    </Shell>
  );
}
