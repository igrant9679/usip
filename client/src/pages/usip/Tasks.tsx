import { Button } from "@/components/ui/button";
import { Field, fmtDate, FormDialog, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Check, ListChecks, Plus, X, CheckSquare } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function Tasks() {
  const [filter, setFilter] = useState<"open" | "done" | "all">("open");
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const { data } = trpc.tasks.list.useQuery({ status: filter === "all" ? undefined : filter });
  const setStatus = trpc.tasks.setStatus.useMutation({ onSuccess: () => utils.tasks.list.invalidate() });
  const create = trpc.tasks.create.useMutation({
    onSuccess: () => { utils.tasks.list.invalidate(); setOpen(false); toast.success("Task created"); },
  });
  return (
    <Shell title="Tasks">
      <PageHeader title="Tasks" description="Create, assign, and track tasks across every deal, account, and customer record." pageKey="tasks"
        icon={<CheckSquare className="size-5" />}
      >
        <div className="flex items-center gap-1 bg-secondary rounded-md p-0.5">
          {(["open", "done", "all"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`px-2 py-1 text-xs rounded ${filter === f ? "bg-card shadow-sm" : "text-muted-foreground"}`}>{f}</button>
          ))}
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New task</Button>
      </PageHeader>
      <div className="p-6">
        {(data ?? []).length === 0 ? <EmptyState icon={ListChecks} title="No tasks" /> : (
          <div className="rounded-lg border bg-card">
            <ul className="divide-y">
              {data!.map((t) => (
                <li key={t.id} className="p-3 flex items-center gap-3">
                  <button onClick={() => setStatus.mutate({ id: t.id, status: t.status === "done" ? "open" : "done" })} className="size-5 rounded border flex items-center justify-center">
                    {t.status === "done" && <Check className="size-3" />}
                  </button>
                  <div className="flex-1">
                    <div className={`text-sm ${t.status === "done" ? "line-through text-muted-foreground" : "font-medium"}`}>{t.title}</div>
                    {t.description && <div className="text-xs text-muted-foreground line-clamp-1">{t.description}</div>}
                  </div>
                  <StatusPill tone={t.priority === "high" || t.priority === "urgent" ? "danger" : t.priority === "normal" ? "warning" : "muted"}>{t.priority}</StatusPill>
                  <div className="text-xs text-muted-foreground w-24 text-right">{fmtDate(t.dueAt)}</div>
                  <button onClick={() => setStatus.mutate({ id: t.id, status: "cancelled" })} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <FormDialog open={open} onOpenChange={setOpen} title="New task" isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          title: String(f.get("title")),
          description: String(f.get("description") ?? "") || undefined,
          dueAt: f.get("dueAt") ? new Date(String(f.get("dueAt"))).toISOString() : undefined,
          priority: f.get("priority") as any,
        })}>
        <Field name="title" label="Title" required />
        <TextareaField name="description" label="Description" />
        <div className="grid grid-cols-2 gap-3">
          <Field name="dueAt" label="Due" type="date" />
          <SelectField name="priority" label="Priority" options={["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: p }))} defaultValue="normal" />
        </div>
      </FormDialog>
    </Shell>
  );
}
