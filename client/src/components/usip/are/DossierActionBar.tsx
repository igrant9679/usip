/**
 * The dossier's action bar (audit 2026-10-20, U23): approve, reject with a
 * reason, enrich, generate a sequence and open in Sequences, without leaving
 * the dossier for the Prospects tab.
 *
 * It reuses the procedures the Prospects tab's row runs (are.prospects.approve,
 * enrich, generateSequence; reject through the tab's own dialog, with the same
 * reason presets), and offers each one on the same states the row does. The
 * two that spend — enrich and generate — say what they can spend and ask
 * first (@shared/spendPreview), as every paid control does.
 */
import { toast } from "sonner";
import { CheckCircle2, FlaskConical, ListOrdered, Loader2, RefreshCw, Sparkles, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { confirmAction } from "@/components/usip/Common";
import { useSourceBudgets } from "@/components/usip/SpendPreview";
import type { RejectTarget } from "./RejectProspectDialog";

export interface DossierProspect {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  enrichmentStatus: string;
  sequenceStatus: string;
}

/** Which actions a prospect in this state is offered — the Prospects row's rules. */
export function dossierActions(p: Pick<DossierProspect, "enrichmentStatus" | "sequenceStatus">) {
  const undecided = p.sequenceStatus === "pending" || p.sequenceStatus === "canceled";
  return {
    approve: p.enrichmentStatus === "complete" && undecided,
    // A replied or finished prospect is not rejectable; a rejected one already is.
    reject: !["replied", "completed", "skipped"].includes(p.sequenceStatus),
    enrich: p.enrichmentStatus === "pending" || p.enrichmentStatus === "failed",
    generate: p.enrichmentStatus === "complete" && undecided,
    // The Sequences tab lists every state but rejected.
    openInSequences: p.sequenceStatus !== "skipped",
  };
}

export function DossierActionBar({ prospect, campaignId, onReject, onOpenInSequences, onChanged }: {
  prospect: DossierProspect;
  campaignId: number;
  /** Opens the tab's Reject dialog (its reason presets, its Undo). */
  onReject: (t: RejectTarget) => void;
  /** Switches to the Sequences tab with this prospect's sequence open. */
  onOpenInSequences: (p: DossierProspect) => void;
  /** Refreshes every tab after a change. */
  onChanged: () => void;
}) {
  const can = dossierActions(prospect);
  const name = `${prospect.firstName ?? ""} ${prospect.lastName ?? ""}`.trim() || "this prospect";
  // What is left today, read while a paid action is on offer, so the confirm can say it.
  const budgets = useSourceBudgets(can.enrich || can.generate);

  const approve = trpc.are.prospects.approve.useMutation({
    onSuccess: () => { toast.success(`${name} approved for sequencing — now under Approved`); onChanged(); },
    onError: (e) => toast.error(e.message),
  });
  const enrich = trpc.are.prospects.enrich.useMutation({
    onSuccess: () => { toast.success("Enrichment started"); setTimeout(onChanged, 3000); },
    onError: (e) => toast.error(e.message),
  });
  const generate = trpc.are.prospects.generateSequence.useMutation({
    onSuccess: (r) => {
      toast.success(r.reused ? `Sequence already existed (${r.steps} steps) — reused` : `Sequence created — ${r.steps} step${r.steps === 1 ? "" : "s"}, quality ${r.qualityScore}/40`, { duration: 6000 });
      onChanged();
    },
    onError: (e) => toast.error(`Sequence generation failed: ${e.message}`, { duration: 10000 }),
  });

  const askEnrich = () => {
    confirmAction({
      title: `Enrich ${name}?`,
      cost: { kind: "areEnrich", people: 1, budgets: budgets.data },
      confirmLabel: "Spend and enrich",
      destructive: false,
    }, () => enrich.mutate({ prospectId: prospect.id }));
  };
  const askGenerate = () => {
    confirmAction({
      title: `Write ${name}'s sequence?`,
      cost: { kind: "areGenerate", ai: budgets.data?.ai },
      confirmLabel: "Spend and generate",
      destructive: false,
    }, () => generate.mutate({ prospectId: prospect.id, campaignId }));
  };

  return (
    <div role="toolbar" aria-label="Prospect actions" className="flex flex-wrap items-center gap-1.5 pt-3">
      {can.approve && (
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-emerald-700 dark:text-emerald-400" disabled={approve.isPending}
          onClick={() => approve.mutate({ prospectId: prospect.id })}>
          {approve.isPending ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />} Approve
        </Button>
      )}
      {can.reject && (
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 hover:text-destructive"
          onClick={() => onReject({ id: prospect.id, name, sequenceStatus: prospect.sequenceStatus })}>
          <X className="size-3" /> Reject…
        </Button>
      )}
      {can.enrich && (
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" disabled={enrich.isPending} onClick={askEnrich}>
          {enrich.isPending ? <Loader2 className="size-3 animate-spin" /> : prospect.enrichmentStatus === "failed" ? <RefreshCw className="size-3" /> : <FlaskConical className="size-3" />}
          {prospect.enrichmentStatus === "failed" ? "Retry enrichment" : "Enrich"}
        </Button>
      )}
      {can.generate && (
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" disabled={generate.isPending} onClick={askGenerate}>
          {generate.isPending ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
          {generate.isPending ? "Generating…" : "Generate sequence"}
        </Button>
      )}
      {can.openInSequences && (
        <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => onOpenInSequences(prospect)}>
          <ListOrdered className="size-3" /> Open in Sequences
        </Button>
      )}
    </div>
  );
}
