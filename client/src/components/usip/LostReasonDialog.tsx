/**
 * Why was this deal lost? Asked when a deal is moved to a lost stage, on
 * every path that can do it (audit 2026-10-20, F28): the board's drag, the
 * card's arrows and Move menu, the AI's suggested stage, the deal page's
 * stage picker and the alerts page's Move stage.
 *
 * The question never blocks the move. "Skip" moves the deal without a reason
 * and the server records it as "Not given"; closing the dialog leaves the
 * deal where it was, for a person who changed their mind.
 */
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LOST_REASON_MAX, LOST_REASON_OPTIONS } from "@shared/lostReason";

export function LostReasonDialog({ open, dealName, stageLabel, onSubmit, onCancel }: {
  open: boolean;
  dealName: string;
  stageLabel: string;
  /** The reason typed or picked, or null when the person skipped the question. */
  onSubmit: (reason: string | null) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  const finish = (r: string | null) => { setReason(""); onSubmit(r); };
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setReason(""); onCancel(); } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Why was this deal lost?</DialogTitle>
          <DialogDescription>
            Moving “{dealName}” to {stageLabel}. A reason helps win-loss reporting; you can skip it and add one later on the deal page.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => { e.preventDefault(); finish(reason.trim() || null); }}
        >
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common reasons">
            {LOST_REASON_OPTIONS.map((o) => (
              <Button key={o} type="button" size="sm" variant={reason === o ? "default" : "outline"} className="h-7 text-xs"
                aria-pressed={reason === o} onClick={() => setReason(o)}>
                {o}
              </Button>
            ))}
          </div>
          <label className="block text-xs font-medium" htmlFor="lost-reason-input">Reason</label>
          <Input id="lost-reason-input" aria-label="Loss reason" value={reason} maxLength={LOST_REASON_MAX}
            placeholder="Pick one above or type your own" onChange={(e) => setReason(e.target.value)} autoFocus />
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={() => finish(null)}>Skip, move without a reason</Button>
            <Button type="submit" disabled={!reason.trim()}>Mark lost</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Wraps a stage move so a move to a lost stage asks first. `ask` runs the move
 * at once for any other stage; for a lost one it opens the dialog and runs the
 * move with the answer (or with no reason, on Skip). Render `dialog`.
 */
export function useLostReasonPrompt<V extends object>(
  move: (vars: V & { lostReason?: string | null }) => void,
): {
  ask: (vars: V, opts: { isLost: boolean; dealName: string; stageLabel: string }) => void;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<{ vars: V; dealName: string; stageLabel: string } | null>(null);
  const ask = (vars: V, opts: { isLost: boolean; dealName: string; stageLabel: string }) => {
    if (!opts.isLost) { move(vars); return; }
    setPending({ vars, dealName: opts.dealName, stageLabel: opts.stageLabel });
  };
  const dialog = (
    <LostReasonDialog
      open={!!pending}
      dealName={pending?.dealName ?? ""}
      stageLabel={pending?.stageLabel ?? "Lost"}
      onCancel={() => setPending(null)}
      onSubmit={(reason) => {
        if (pending) move({ ...pending.vars, lostReason: reason });
        setPending(null);
      }}
    />
  );
  return { ask, dialog };
}
