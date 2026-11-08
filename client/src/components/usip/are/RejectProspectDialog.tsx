/**
 * "Reject…" on one prospect of a campaign's Prospects tab (audit 2026-10-20,
 * A51; tracker 9).
 *
 * The row's only way out was an unlabelled ✕ that ran `skip`: no reason, no
 * confirmation, and nothing to undo it with. It now asks why (the bulk bar's
 * reasons, or one typed), says what happens to a sequence already running,
 * and the toast after it offers Undo, which puts the prospect back in review.
 * The server refuses a replied or finished prospect and stops a running
 * sequence's unsent steps (are.prospects.reject).
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { invalidateCampaignReads } from "@/lib/entityCache";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";

export interface RejectTarget { id: number; name: string; sequenceStatus: string }

/** What rejecting does to this prospect, in the words the dialog shows. */
export function rejectConsequence(sequenceStatus: string): string {
  if (sequenceStatus === "enrolled" || sequenceStatus === "paused") {
    return "Their sequence stops: steps not yet sent are canceled, sent ones stay in their history.";
  }
  if (sequenceStatus === "approved") return "They were approved, so nothing has sent yet; nothing will.";
  return "They leave the review queue and nothing is sent to them.";
}

/** The reason picker: preset chips and a free-text box. */
export function RejectReasonPicker({ presets, reason, onChange }: { presets: readonly string[]; reason: string; onChange: (r: string) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Reason (optional — shown on the Rejections tab)</Label>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((t) => (
          <button key={t} type="button" aria-pressed={reason === t} onClick={() => onChange(t)}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${reason === t ? "border-primary/50 bg-primary/10 text-primary font-medium" : "border-border text-muted-foreground hover:border-primary/30"}`}>
            {t}
          </button>
        ))}
      </div>
      <Textarea aria-label="Reason" value={reason} onChange={(e) => onChange(e.target.value)} rows={2} className="text-sm" placeholder="Or type a reason…" />
    </div>
  );
}

export function RejectProspectDialog({ target, presets, onClose, onChanged }: {
  target: RejectTarget | null;
  presets: readonly string[];
  onClose: () => void;
  /** After a reject or an Undo: the tab refreshes its rows and counts. */
  onChanged: () => void;
}) {
  const [reason, setReason] = useState("");
  // Every screen showing the prospect refreshes (X1.7); onChanged is the page's own extra.
  const utils = trpc.useUtils();
  const restore = trpc.are.prospects.restore.useMutation({
    onSuccess: () => { toast.success("Back in the review queue"); invalidateCampaignReads(utils); onChanged(); },
    onError: (e) => toast.error(e.message),
  });
  const reject = trpc.are.prospects.reject.useMutation({
    onSuccess: (r, vars) => {
      const stopped = r.stepsStopped > 0 ? ` — ${r.stepsStopped} unsent step${r.stepsStopped === 1 ? "" : "s"} canceled` : "";
      toast.success(`${target?.name ?? "Prospect"} rejected${stopped}`, {
        duration: 10000,
        action: { label: "Undo", onClick: () => restore.mutate({ prospectId: vars.prospectId }) },
      });
      setReason("");
      onClose();
      invalidateCampaignReads(utils);
      onChanged();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) { setReason(""); onClose(); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject {target?.name ?? "prospect"}?</DialogTitle>
          <DialogDescription>{rejectConsequence(target?.sequenceStatus ?? "pending")} You can undo it, or restore them later from the Rejections tab.</DialogDescription>
        </DialogHeader>
        <RejectReasonPicker presets={presets} reason={reason} onChange={setReason} />
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => { setReason(""); onClose(); }}>Cancel</Button>
          <Button variant="destructive" size="sm" disabled={!target || reject.isPending}
            onClick={() => target && reject.mutate({ prospectId: target.id, reason: reason.trim() || undefined })}>
            {reject.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null} Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
