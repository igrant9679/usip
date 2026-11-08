/**
 * A/B variants for a sequence's email steps, in the v2 editor (audit
 * 2026-10-20, U14: one sequence editor). Ported from the legacy /sequences
 * A/B tab, with three things the legacy tab got wrong put right:
 *
 *  - The numbers are the DERIVED ones. Legacy read `sequenceAb.getStats`,
 *    which returns the table's sentCount/openCount/replyCount columns, and
 *    nothing writes those (see the note on `sequenceAb.list`): every variant
 *    read 0 sent and 0% for ever. `sequenceAb.list` overlays what the drafts
 *    actually did, the same numbers automatic promotion reads.
 *  - It says what a variant does to sending. Once a step has a variant, each
 *    person gets one variant's subject and body at random by the split, and
 *    the step's own copy is not sent (sequenceEngine's variant pick). Legacy
 *    never said so.
 *  - It says what "Promote" does. The engine keeps picking by the split, so a
 *    winner is a marking for reporting that also stops automatic promotion;
 *    to send only the winner, give it the whole split or delete the others.
 *
 * Changes are refused by the server while the sequence is active or archived;
 * the buttons say so instead of failing.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Activity, FlaskConical, Pencil, Plus, Trash2, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmButton } from "@/components/usip/Common";
import { trpc } from "@/lib/trpc";

type StepLike = { type: string; subject?: string; enabled?: boolean };
type Variant = {
  id: number;
  stepIndex: number;
  variantLabel: string;
  subject: string;
  body: string;
  splitPct: number;
  sentCount: number;
  openRate: number;
  replyRate: number;
  isWinner: boolean;
  promotedAt?: string | Date | null;
  minSendsForPromotion?: number | null;
};

type Draft = { id?: number; variantLabel: string; subject: string; body: string; splitPct: string };

const pct = (n: number, sent: number) => (sent > 0 ? `${Math.round(n)}%` : "—");

export function SequenceAbTests({ sequenceId, steps, locked, accent }: {
  sequenceId: number;
  steps: readonly StepLike[];
  /** Why changes are refused right now, or null when they are allowed. */
  locked: string | null;
  accent: string;
}) {
  const emailSteps = steps.map((s, index) => ({ ...s, index })).filter((s) => s.type === "email");
  const [picked, setPicked] = useState<number | null>(null);
  const stepIndex = picked ?? emailSteps[0]?.index ?? 0;
  const utils = trpc.useUtils();
  const query = trpc.sequenceAb.list.useQuery({ sequenceId, stepIndex }, { enabled: emailSteps.length > 0 });
  const variants = (query.data ?? []) as Variant[];
  const refresh = () => utils.sequenceAb.list.invalidate({ sequenceId });

  const [draft, setDraft] = useState<Draft | null>(null);
  const [minEdit, setMinEdit] = useState<{ id: number; value: string } | null>(null);
  const create = trpc.sequenceAb.create.useMutation({
    onSuccess: () => { refresh(); setDraft(null); toast.success("Variant added"); },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.sequenceAb.update.useMutation({
    onSuccess: () => { refresh(); setDraft(null); toast.success("Variant saved"); },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.sequenceAb.delete.useMutation({
    onSuccess: () => { refresh(); toast.success("Variant deleted"); },
    onError: (e) => toast.error(e.message),
  });
  const promote = trpc.sequenceAb.promoteWinner.useMutation({
    onSuccess: () => { refresh(); toast.success("Marked as the winner"); },
    onError: (e) => toast.error(e.message),
  });
  const setMinSends = trpc.sequenceAb.setMinSends.useMutation({
    onSuccess: () => { refresh(); setMinEdit(null); toast.success("Minimum sends saved"); },
    onError: (e) => toast.error(e.message),
  });

  if (emailSteps.length === 0) {
    return (
      <div className="max-w-3xl mx-auto p-4 md:p-6">
        <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
          <FlaskConical className="size-8 mx-auto mb-2 opacity-40" />
          A/B tests compare versions of an email step. Add an email step first.
        </div>
      </div>
    );
  }

  const splitTotal = variants.reduce((n, v) => n + (v.splitPct || 0), 0);
  const winner = variants.find((v) => v.isWinner);
  const saving = create.isPending || update.isPending;
  const submit = () => {
    if (!draft) return;
    const split = Math.max(1, Math.min(99, Math.round(Number(draft.splitPct) || 50)));
    if (!draft.subject.trim()) { toast.error("A variant needs a subject line."); return; }
    if (draft.id) update.mutate({ id: draft.id, subject: draft.subject, body: draft.body, splitPct: split, variantLabel: draft.variantLabel.trim() || undefined });
    else {
      if (!draft.variantLabel.trim()) { toast.error("Give the variant a label, such as B."); return; }
      create.mutate({ sequenceId, stepIndex, variantLabel: draft.variantLabel.trim(), subject: draft.subject, body: draft.body, splitPct: split });
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
      <div className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <FlaskConical className="size-4" style={{ color: accent }} />
          <h2 className="text-sm font-semibold">A/B tests</h2>
          <div className="flex-1" />
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            Email step
            <select
              aria-label="Email step to test"
              className="h-8 rounded-md border bg-background px-2 text-[13px] text-foreground"
              value={stepIndex}
              onChange={(e) => setPicked(Number(e.target.value))}
            >
              {emailSteps.map((s) => (
                <option key={s.index} value={s.index}>
                  Step {s.index + 1}: {s.subject || "(no subject)"}{s.enabled === false ? " (skipped)" : ""}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" className="h-8 gap-1.5" style={{ backgroundColor: accent }} disabled={!!locked} title={locked ?? undefined}
            onClick={() => setDraft({ variantLabel: "", subject: "", body: "", splitPct: "50" })}>
            <Plus className="size-3.5" /> Add variant
          </Button>
        </div>
        <p className="text-[12px] text-muted-foreground">
          When a step has variants, each person gets one of them at random, weighted by its split, and the step's own copy
          is not sent. Variants belong to the step's place in the sequence.
        </p>
        {locked && <p className="text-[12px] text-amber-700 dark:text-amber-300">{locked}</p>}
      </div>

      {winner ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <Trophy className="size-4 shrink-0 mt-0.5" />
          <span>
            Variant {winner.variantLabel} is marked the winner{winner.promotedAt ? ` (${new Date(winner.promotedAt).toLocaleDateString()})` : ""}.
            Sends still follow the splits: give it the whole split, or delete the others, to send only this one.
          </span>
        </div>
      ) : variants.length >= 2 ? (
        <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[12px] text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-200">
          <Activity className="size-4 shrink-0 mt-0.5" />
          <span>Testing. Once every variant reaches its minimum sends and one has been opened or replied to, the one with the best reply rate is marked the winner automatically.</span>
        </div>
      ) : null}

      <div className="rounded-xl border bg-card shadow-sm overflow-x-auto">
        {query.isLoading ? (
          <div className="p-4 text-sm text-muted-foreground">Reading variants…</div>
        ) : query.isError ? (
          <div className="p-4 text-sm text-destructive">Variants could not be read{query.error?.message ? `: ${query.error.message}` : "."}</div>
        ) : variants.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No variants for this step. It sends its own copy to everyone.</div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Variant</th>
                <th className="px-2 py-2 font-medium">Subject</th>
                <th className="px-2 py-2 font-medium text-right">Split</th>
                <th className="px-2 py-2 font-medium text-right">Sent</th>
                <th className="px-2 py-2 font-medium text-right">Opened</th>
                <th className="px-2 py-2 font-medium text-right">Replied</th>
                <th className="px-2 py-2 font-medium text-right">Min sends</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {variants.map((v) => (
                <tr key={v.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-mono font-semibold">
                    {v.variantLabel}
                    {v.isWinner && <span className="ml-1.5 inline-flex items-center gap-0.5 text-amber-600"><Trophy className="size-3" /> Winner</span>}
                  </td>
                  <td className="px-2 py-2 max-w-[200px] truncate" title={v.subject}>{v.subject}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{splitTotal > 0 ? `${Math.round((v.splitPct / splitTotal) * 100)}%` : "—"}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{v.sentCount}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{pct(v.openRate, v.sentCount)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{pct(v.replyRate, v.sentCount)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {minEdit?.id === v.id ? (
                      <span className="inline-flex items-center gap-1">
                        <Input aria-label={`Minimum sends for variant ${v.variantLabel}`} type="number" min={1} max={10000} className="h-6 w-16 px-1 text-[12px]"
                          value={minEdit.value} onChange={(e) => setMinEdit({ id: v.id, value: e.target.value })} />
                        <Button size="sm" className="h-6 px-1.5 text-[11px]" disabled={setMinSends.isPending}
                          onClick={() => setMinSends.mutate({ id: v.id, minSendsForPromotion: Math.max(1, Math.min(10000, Math.round(Number(minEdit.value) || 100))) })}>Save</Button>
                      </span>
                    ) : (
                      <button type="button" className="underline-offset-2 hover:underline" title="Change the minimum sends before automatic promotion"
                        onClick={() => setMinEdit({ id: v.id, value: String(v.minSendsForPromotion ?? 100) })}>
                        {v.minSendsForPromotion ?? 100}
                      </button>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex justify-end gap-1">
                      {!v.isWinner && (
                        <Button size="sm" variant="outline" className="h-6 px-1.5 text-[11px]" disabled={promote.isPending}
                          title="Mark as the winner: for reporting, and it stops automatic promotion. Sends still follow the splits."
                          onClick={() => promote.mutate({ sequenceId, stepIndex, winnerId: v.id })}>
                          <Trophy className="size-3 mr-0.5" /> Mark winner
                        </Button>
                      )}
                      <Button aria-label={`Edit variant ${v.variantLabel}`} size="sm" variant="ghost" className="h-6 px-1.5" disabled={!!locked} title={locked ?? undefined}
                        onClick={() => setDraft({ id: v.id, variantLabel: v.variantLabel, subject: v.subject, body: v.body, splitPct: String(v.splitPct) })}>
                        <Pencil className="size-3" />
                      </Button>
                      <ConfirmButton
                        ariaLabel={`Delete variant ${v.variantLabel}`}
                        className="h-6 px-1.5 text-destructive"
                        disabled={!!locked || remove.isPending}
                        title={`Delete variant ${v.variantLabel}?`}
                        description="Its copy stops being sent. Emails it already sent keep their record."
                        confirmLabel="Delete"
                        onConfirm={() => remove.mutate({ id: v.id })}
                      >
                        <Trash2 className="size-3" />
                      </ConfirmButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {variants.length > 0 && splitTotal !== 100 && (
        <p className="text-[11px] text-muted-foreground">The splits add up to {splitTotal}%, so each one is a weight: the shares above are each split divided by {splitTotal}.</p>
      )}

      <Dialog open={!!draft} onOpenChange={(o) => { if (!o) setDraft(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{draft?.id ? `Edit variant ${draft.variantLabel}` : `Add a variant to step ${stepIndex + 1}`}</DialogTitle></DialogHeader>
          {draft && (
            <div className="space-y-3 py-1">
              <label className="block text-[12px] font-medium space-y-1">
                <span>Label</span>
                <Input aria-label="Variant label" value={draft.variantLabel} maxLength={32} placeholder="B" onChange={(e) => setDraft({ ...draft, variantLabel: e.target.value })} />
              </label>
              <label className="block text-[12px] font-medium space-y-1">
                <span>Subject line</span>
                <Input aria-label="Variant subject line" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
              </label>
              <label className="block text-[12px] font-medium space-y-1">
                <span>Body</span>
                <Textarea aria-label="Variant body" rows={6} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
              </label>
              <label className="block text-[12px] font-medium space-y-1">
                <span>Split (weight, 1 to 99)</span>
                <Input aria-label="Variant split" type="number" min={1} max={99} className="w-24" value={draft.splitPct} onChange={(e) => setDraft({ ...draft, splitPct: e.target.value })} />
              </label>
              <p className="text-[11px] text-muted-foreground">Merge tags like {"{{firstName}}"} work here as they do in the step.</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
            <Button style={{ backgroundColor: accent }} disabled={saving} onClick={submit}>{saving ? "Saving…" : "Save variant"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** How many A/B variants each step position holds, from one `sequenceAb.list` read. */
export function variantCountsByStep(rows: readonly { stepIndex: number }[] | undefined): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of rows ?? []) out.set(r.stepIndex, (out.get(r.stepIndex) ?? 0) + 1);
  return out;
}
