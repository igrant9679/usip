/**
 * The selection interface a workflow card opens: the app's small params-dialog
 * pattern (AreBulkActionBar) — one question, a radio list with hints, Cancel /
 * Apply. Generic over the card's option vocabulary; Apply is disabled until
 * something is picked so a click can never store nothing.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { CardOption } from "./jobFlow";

export function CardPickerDialog({
  open,
  title,
  options,
  value,
  onCancel,
  onApply,
}: {
  open: boolean;
  title: string;
  options: CardOption[];
  /** The current selection, so re-opening shows what is already chosen. */
  value: string | null;
  onCancel: () => void;
  onApply: (value: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(value);
  // Re-seed local state each time the dialog opens for a (possibly different) card.
  useEffect(() => {
    if (open) setPicked(value);
  }, [open, value]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
        </DialogHeader>
        <RadioGroup value={picked ?? ""} onValueChange={(v) => setPicked(v)} className="gap-1.5 py-1">
          {options.map((o) => (
            <Label
              key={o.value}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors ${picked === o.value ? "border-primary/50 bg-primary/5" : "border-border hover:border-primary/30"}`}
            >
              <RadioGroupItem value={o.value} className="mt-0.5" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-medium leading-tight">{o.label}</span>
                {o.hint && <span className="text-[11px] font-normal text-muted-foreground leading-tight">{o.hint}</span>}
              </span>
            </Label>
          ))}
        </RadioGroup>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" disabled={picked == null || picked === ""} onClick={() => picked && onApply(picked)}>
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
