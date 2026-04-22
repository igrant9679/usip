import { Button } from "@/components/ui/button";
import { Field, fmtDate, FormDialog, Section, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { CalendarCheck2, Plus, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function QBRs() {
  const utils = trpc.useUtils();
  const { data } = trpc.cs.listQbrs.useQuery();
  const { data: customers } = trpc.cs.list.useQuery();
  const cMap = new Map((customers ?? []).map((c: any) => [c.id, c]));
  const [open, setOpen] = useState(false);
  const [completeFor, setCompleteFor] = useState<number | null>(null);
  const schedule = trpc.cs.scheduleQbr.useMutation({ onSuccess: () => { utils.cs.listQbrs.invalidate(); setOpen(false); toast.success("QBR scheduled"); } });
  const genPrep = trpc.cs.generateQbrPrep.useMutation({ onSuccess: () => { utils.cs.listQbrs.invalidate(); toast.success("AI prep generated"); } });
  const complete = trpc.cs.completeQbr.useMutation({ onSuccess: () => { utils.cs.listQbrs.invalidate(); setCompleteFor(null); toast.success("QBR completed"); } });

  return (
    <Shell title="QBRs">
      <PageHeader title="Quarterly Business Reviews" description="Schedule, AI-prep, and complete QBRs.">
        <Button onClick={() => setOpen(true)}><Plus className="size-4" /> Schedule QBR</Button>
      </PageHeader>
      <div className="p-6 space-y-3">
        {(data ?? []).length === 0 ? <EmptyState icon={CalendarCheck2} title="No QBRs" /> : data!.map((q) => {
          const c: any = cMap.get(q.customerId);
          const prep: any = q.aiPrep;
          return (
            <Section key={q.id} title={c?.account?.name ?? "Customer"} description={`${q.status} · ${fmtDate(q.scheduledAt)}`}
              right={
                <div className="flex gap-1">
                  {q.status !== "completed" && <Button size="sm" variant="ghost" onClick={() => genPrep.mutate({ qbrId: q.id })} disabled={genPrep.isPending}><Sparkles className="size-3.5" /> AI prep</Button>}
                  {q.status === "scheduled" && <Button size="sm" onClick={() => setCompleteFor(q.id)}>Complete</Button>}
                </div>
              }>
              {prep ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-3 text-sm">
                  {(["wins", "risks", "asks", "agenda"] as const).map((k) => (
                    <div key={k}>
                      <div className="text-[11px] uppercase font-semibold text-muted-foreground mb-1">{k}</div>
                      <ul className="space-y-1 text-xs">{(prep[k] ?? []).map((x: string, i: number) => <li key={i} className="text-muted-foreground">• {x}</li>)}</ul>
                    </div>
                  ))}
                </div>
              ) : <div className="p-3 text-xs text-muted-foreground">No prep generated yet.</div>}
              {q.notes && <div className="px-3 pb-3 text-xs text-muted-foreground">Notes: {q.notes}</div>}
            </Section>
          );
        })}
      </div>

      <FormDialog open={open} onOpenChange={setOpen} title="Schedule QBR" isPending={schedule.isPending}
        onSubmit={(f) => schedule.mutate({ customerId: Number(f.get("customerId")), scheduledAt: new Date(String(f.get("scheduledAt"))).toISOString() })}>
        <SelectField name="customerId" label="Customer" options={(customers ?? []).map((c: any) => ({ value: String(c.id), label: c.account?.name ?? "Customer" }))} />
        <Field name="scheduledAt" label="When" type="date" required />
      </FormDialog>

      <FormDialog open={!!completeFor} onOpenChange={(v) => !v && setCompleteFor(null)} title="Complete QBR" isPending={complete.isPending}
        onSubmit={(f) => complete.mutate({
          id: completeFor!,
          notes: String(f.get("notes") ?? "") || undefined,
          nextActions: String(f.get("nextActions") ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
        })}>
        <TextareaField name="notes" label="Meeting notes" rows={4} />
        <TextareaField name="nextActions" label="Next actions (one per line)" rows={4} />
      </FormDialog>
    </Shell>
  );
}
