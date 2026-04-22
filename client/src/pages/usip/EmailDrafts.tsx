import { Button } from "@/components/ui/button";
import { Field, FormDialog, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Check, FileText, Send, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export default function EmailDrafts() {
  const [composeOpen, setComposeOpen] = useState(false);
  const [filter, setFilter] = useState<"pending_review" | "approved" | "sent" | "rejected" | "all">("pending_review");
  const utils = trpc.useUtils();
  const { data } = trpc.emailDrafts.list.useQuery({ status: filter === "all" ? undefined : filter });
  const { data: contacts } = trpc.contacts.list.useQuery();
  const compose = trpc.emailDrafts.compose.useMutation({
    onSuccess: () => { utils.emailDrafts.list.invalidate(); setComposeOpen(false); toast.success("Draft created — review it below"); },
  });
  const approve = trpc.emailDrafts.approve.useMutation({ onSuccess: () => utils.emailDrafts.list.invalidate() });
  const reject = trpc.emailDrafts.reject.useMutation({ onSuccess: () => utils.emailDrafts.list.invalidate() });
  const send = trpc.emailDrafts.send.useMutation({ onSuccess: () => utils.emailDrafts.list.invalidate() });

  return (
    <Shell title="Email Drafts">
      <PageHeader title="Email Drafts" description="AI-generated outbound that requires human review before send.">
        <div className="flex items-center gap-1 bg-secondary rounded-md p-0.5">
          {(["pending_review", "approved", "sent", "rejected", "all"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`px-2 py-1 text-xs rounded ${filter === f ? "bg-card shadow-sm" : "text-muted-foreground"}`}>{f.replace("_", " ")}</button>
          ))}
        </div>
        <Button onClick={() => setComposeOpen(true)}><Sparkles className="size-4" /> AI compose</Button>
      </PageHeader>
      <div className="p-6 space-y-3">
        {(data ?? []).length === 0 ? <EmptyState icon={FileText} title="No drafts" /> : data!.map((d) => (
          <div key={d.id} className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2">
              <StatusPill tone={d.status === "pending_review" ? "warning" : d.status === "approved" ? "info" : d.status === "sent" ? "success" : "muted"}>{d.status}</StatusPill>
              <div className="text-sm font-medium flex-1 truncate">{d.subject}</div>
              <div className="flex gap-1">
                {d.status === "pending_review" && <>
                  <Button size="sm" variant="ghost" onClick={() => approve.mutate({ id: d.id })}><Check className="size-3.5" /> Approve</Button>
                  <Button size="sm" variant="ghost" onClick={() => reject.mutate({ id: d.id })}><X className="size-3.5" /> Reject</Button>
                </>}
                {d.status === "approved" && <Button size="sm" onClick={() => send.mutate({ id: d.id })}><Send className="size-3.5" /> Send</Button>}
              </div>
            </div>
            <div className="text-sm whitespace-pre-wrap mt-3 text-muted-foreground">{d.body}</div>
          </div>
        ))}
      </div>

      <FormDialog open={composeOpen} onOpenChange={setComposeOpen} title="AI compose email" isPending={compose.isPending}
        onSubmit={(f) => compose.mutate({
          prompt: String(f.get("prompt")),
          tone: f.get("tone") as any,
          toContactId: Number(f.get("toContactId")) || undefined,
        })}>
        <SelectField name="toContactId" label="To contact" options={[{ value: "", label: "—" }, ...((contacts ?? []).map((c) => ({ value: String(c.id), label: `${c.firstName} ${c.lastName}` })))]} />
        <SelectField name="tone" label="Tone" options={["concise", "warm", "formal", "punchy"].map((t) => ({ value: t, label: t }))} defaultValue="concise" />
        <TextareaField name="prompt" label="What's the angle?" required placeholder="Follow up on our demo last week, propose a 30-min call to scope phase 2" rows={5} />
      </FormDialog>
    </Shell>
  );
}
