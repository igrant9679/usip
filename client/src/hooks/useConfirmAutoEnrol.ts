/**
 * Before a segment → sequence rule is turned on: read how many contacts it
 * would enrol now, show it, and go ahead only on a confirm (audit 2026-10-20,
 * P57). The confirmed count travels with the save, and the server refuses to
 * turn the rule on for more than that.
 */
import { toast } from "sonner";
import { confirmAction } from "@/components/usip/Common";
import { trpc } from "@/lib/trpc";
import { turnOnSummary, type RulePreview } from "@/lib/segmentAutoEnrol";

export function useConfirmAutoEnrol() {
  const utils = trpc.useUtils();
  return async (rule: { segmentId: number; sequenceId: number }, turnOn: (confirmedWouldEnrol: number) => void) => {
    let p: RulePreview;
    try {
      p = await utils.segmentRules.preview.fetch({ segmentId: rule.segmentId, sequenceId: rule.sequenceId }, { staleTime: 0 });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't count who this rule would enrol.");
      return;
    }
    const { title, description } = turnOnSummary(p);
    confirmAction({ title, description, confirmLabel: "Turn on", destructive: false }, () => turnOn(p.wouldEnrol));
  };
}
