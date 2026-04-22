import { Button } from "@/components/ui/button";
import { Field, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Activity, GitBranch, Pause, Play, Plus, Power } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";

export default function Sequences() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const utils = trpc.useUtils();
  const { data } = trpc.sequences.list.useQuery();
  const create = trpc.sequences.create.useMutation({
    onSuccess: () => { utils.sequences.list.invalidate(); setOpen(false); toast.success("Sequence created"); },
  });
  const setStatus = trpc.sequences.setStatus.useMutation({ onSuccess: () => utils.sequences.list.invalidate() });
  const detail = trpc.sequences.get.useQuery({ id: selected! }, { enabled: !!selected });
  const enrollments = trpc.sequences.listEnrollments.useQuery({ sequenceId: selected! }, { enabled: !!selected });

  return (
    <Shell title="Sequences">
      <PageHeader title="Sequences" description="Multi-step outbound cadences with AI compose.">
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> New sequence</Button>
      </PageHeader>
      <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1">
          <Section title="All sequences">
            {(data ?? []).length === 0 ? <EmptyState icon={Activity} title="None yet" /> : (
              <ul className="divide-y">
                {data!.map((s) => (
                  <li key={s.id} className={`p-3 cursor-pointer hover:bg-secondary/40 ${selected === s.id ? "bg-secondary/60" : ""}`} onClick={() => setSelected(s.id)}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 text-sm font-medium truncate">{s.name}</div>
                      <StatusPill tone={s.status === "active" ? "success" : s.status === "paused" ? "warning" : "muted"}>{s.status}</StatusPill>
                    </div>
                    <div className="text-xs text-muted-foreground line-clamp-1">{s.description}</div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div className="lg:col-span-2 space-y-4">
          {!selected ? <EmptyState icon={Activity} title="Select a sequence" /> : detail.data ? (
            <>
              <Section title={detail.data.name} description={detail.data.description ?? ""}
                right={
                  <div className="flex gap-1">
                    <Link href={`/sequences/${detail.data.id}/canvas`}>
                      <Button size="sm" variant="outline"><GitBranch className="size-3.5" /> Open canvas</Button>
                    </Link>
                    <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: detail.data!.id, status: detail.data!.status === "active" ? "paused" : "active" })}>
                      {detail.data.status === "active" ? <><Pause className="size-3.5" /> Pause</> : <><Play className="size-3.5" /> Activate</>}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ id: detail.data!.id, status: "archived" })}><Power className="size-3.5" /> Archive</Button>
                  </div>
                }>
                <ol className="p-3 space-y-2">
                  {((detail.data.steps as any[]) ?? []).map((step, i) => (
                    <li key={i} className="border rounded p-2.5">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="font-mono">Step {i + 1}</span> · {step.type}{step.type === "wait" ? ` · ${step.days}d` : ""}</div>
                      {step.subject && <div className="text-sm font-medium mt-1">{step.subject}</div>}
                      {step.body && <div className="text-xs text-muted-foreground line-clamp-3 mt-1">{step.body}</div>}
                    </li>
                  ))}
                </ol>
              </Section>
              <Section title={`Enrollments (${enrollments.data?.length ?? 0})`}>
                {(enrollments.data ?? []).length === 0 ? (
                  <div className="p-3 text-sm text-muted-foreground">No enrollments yet.</div>
                ) : (
                  <ul className="divide-y">
                    {enrollments.data!.map((e) => (
                      <li key={e.id} className="p-3 flex items-center text-sm">
                        <div className="flex-1">Enrollment #{e.id} · step {e.currentStep}</div>
                        <StatusPill tone={e.status === "active" ? "success" : "muted"}>{e.status}</StatusPill>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </>
          ) : null}
        </div>
      </div>

      <FormDialog open={open} onOpenChange={setOpen} title="New sequence" isPending={create.isPending}
        onSubmit={(f) => create.mutate({
          name: String(f.get("name")), description: String(f.get("description") ?? "") || undefined,
          steps: [
            { type: "email", subject: String(f.get("step1Subject") ?? "Quick intro"), body: String(f.get("step1Body") ?? "") },
            { type: "wait", days: 3 },
            { type: "email", subject: "Following up", body: "Did this come at a bad time?" },
          ],
        })}>
        <Field name="name" label="Name" required />
        <TextareaField name="description" label="Description" />
        <Field name="step1Subject" label="Step 1 subject" />
        <TextareaField name="step1Body" label="Step 1 body" />
      </FormDialog>
    </Shell>
  );
}
