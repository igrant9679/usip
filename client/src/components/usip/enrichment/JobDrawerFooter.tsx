/**
 * The drawer's fixed footer: right-aligned primary action, pinned below the
 * scrolling body. `shrink-0` is load-bearing — a bare flex row under a
 * flex-col shell collapses (the app's flex-collapse class).
 */
import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function JobDrawerFooter({
  label,
  disabled,
  disabledReason,
  onClick,
  left,
}: {
  label: string;
  disabled: boolean;
  /** Shown as the button's tooltip while disabled, so the gate explains itself. */
  disabledReason?: string;
  onClick: () => void;
  /** Optional left-side slot (secondary action / note). */
  left?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border bg-card/40 p-3 shrink-0">
      {left && <div className="mr-auto min-w-0">{left}</div>}
      <Button size="sm" disabled={disabled} title={disabled ? disabledReason : undefined} onClick={onClick}>
        {label}
      </Button>
    </div>
  );
}
