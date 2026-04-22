import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FormDialog, SelectField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { RecordDrawer } from "@/components/usip/RecordDrawer";
import { trpc } from "@/lib/trpc";
import { Plus, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Contacts() {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [drawer, setDrawer] = useState<{ id: number; name: string; subtitle: string } | null>(null);
  const utils = trpc.useUtils();
  const { data } = trpc.contacts.list.useQuery({ search });
  const { data: accounts } = trpc.accounts.list.useQuery();
  const create = trpc.contacts.create.useMutation({
    onSuccess: () => { utils.contacts.list.invalidate(); setOpen(false); toast.success("Contact added"); },
  });
  return (
    <Shell title="Contacts">
      <PageHeader title="Contacts" description="People at your accounts.">
        <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-56" />
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New contact</Button>
      </PageHeader>
      <div className="p-6">
        {(data ?? []).length === 0 ? (
          <EmptyState icon={Users} title="No contacts" description="Add one or convert a lead." />
        ) : (
          <div className="rounded-lg border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-secondary/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2">Name</th>
                  <th className="text-left px-3 py-2">Title</th>
                  <th className="text-left px-3 py-2">Account</th>
                  <th className="text-left px-3 py-2">Email</th>
                  <th className="text-left px-3 py-2">Phone</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {data!.map((c) => (
                  <tr key={c.id} className="hover:bg-secondary/30 cursor-pointer" onClick={() => setDrawer({ id: c.id, name: `${c.firstName} ${c.lastName}`, subtitle: `${c.title ?? ""} · ${(c as any).accountName ?? ""}` })}>
                    <td className="px-3 py-2 font-medium"><span className="underline-offset-2 hover:underline">{c.firstName} {c.lastName}</span></td>
                    <td className="px-3 py-2 text-muted-foreground">{c.title}</td>
                    <td className="px-3 py-2 text-muted-foreground">{(c as any).accountName}</td>
                    <td className="px-3 py-2 text-muted-foreground">{c.email}</td>
                    <td className="px-3 py-2 text-muted-foreground">{c.phone}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <FormDialog open={open} onOpenChange={setOpen} title="New contact" isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          firstName: String(f.get("firstName")), lastName: String(f.get("lastName")),
          email: String(f.get("email") ?? "") || undefined, title: String(f.get("title") ?? "") || undefined,
          phone: String(f.get("phone") ?? "") || undefined,
          accountId: Number(f.get("accountId")) || undefined,
        })}>
        <div className="grid grid-cols-2 gap-3">
          <Field name="firstName" label="First name" required />
          <Field name="lastName" label="Last name" required />
        </div>
        <Field name="email" label="Email" type="email" />
        <Field name="title" label="Title" />
        <Field name="phone" label="Phone" />
        <SelectField name="accountId" label="Account" options={[{ value: "", label: "—" }, ...((accounts ?? []).map((a) => ({ value: String(a.id), label: a.name })))]} />
      </FormDialog>
      <RecordDrawer open={!!drawer} onOpenChange={(v) => !v && setDrawer(null)} relatedType="contact" relatedId={drawer?.id ?? null} title={drawer?.name ?? ""} subtitle={drawer?.subtitle} />
    </Shell>
  );
}
