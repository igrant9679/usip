import { Button } from "@/components/ui/button";
import { Field, FormDialog, SelectField, StatusPill, TextareaField } from "@/components/usip/Common";
import { EmptyState, PageHeader, Shell } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Check, ChevronDown, ChevronRight, FileText, Send, Sparkles, X, Zap } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";

function SubjectABPanel({ draftId }: { draftId: number }) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const { data: variants = [], refetch } = trpc.subjectAB.list.useQuery({ emailDraftId: draftId }, { enabled: open });
  const generate = trpc.subjectAB.generate.useMutation({
    onSuccess: () => { refetch(); toast.success("Variants generated"); },
    onError: (e) => toast.error(e.message),
  });
  const select = trpc.subjectAB.select.useMutation({
    onSuccess: () => { utils.emailDrafts.list.invalidate(); refetch(); toast.success("Subject applied"); },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="mt-3 border-t pt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Zap className="h-3.5 w-3.5 text-amber-500" />
        Subject A/B + Spam Analyzer
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => generate.mutate({ emailDraftId: draftId })}
            disabled={generate.isPending}
          >
            {generate.isPending ? "Generating…" : "Generate 3 variants"}
          </Button>
          {variants.map((v: any) => (
            <div
              key={v.id}
              className={`rounded-md border px-3 py-2 text-xs space-y-1 ${
                v.isSelected ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/30" : "bg-muted/30"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium flex-1">{v.subject}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Badge
                    variant="outline"
                    className={`text-xs ${
                      Number(v.spamScore) <= 10
                        ? "border-emerald-400 text-emerald-700"
                        : Number(v.spamScore) <= 25
                        ? "border-amber-400 text-amber-700"
                        : "border-red-400 text-red-700"
                    }`}
                  >
                    Spam {v.spamScore}
                  </Badge>
                  {!v.isSelected && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs px-2"
                      onClick={() => select.mutate({ variantId: v.id, emailDraftId: draftId })}
                      disabled={select.isPending}
                    >
                      Use
                    </Button>
                  )}
                  {v.isSelected && <span className="text-emerald-600 font-semibold">✓ Active</span>}
                </div>
              </div>
              {v.spamFlags && v.spamFlags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {v.spamFlags.map((f: any, i: number) => (
                    <span key={i} className="text-xs bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-300 px-1.5 py-0.5 rounded">
                      {f.rule}
                    </span>
                  ))}
                </div>
              )}
              {v.aiRationale && <p className="text-muted-foreground italic">{v.aiRationale}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
            <SubjectABPanel draftId={d.id} />
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
