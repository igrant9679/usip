import type { KeyboardEvent, SyntheticEvent } from "react";

/**
 * A clickable row, card or list item that also works from the keyboard
 * (audit 2026-10-20, X5.3): it takes focus, Enter or Space does what a click
 * does, and it says it is a button. Spread it in place of the onClick:
 *
 *   <div {...pressable(() => open(id))}>
 *
 * Table rows keep their row role — a row that calls itself a button breaks
 * the table for a screen reader — so pass { row: true } there. Keys pressed
 * in a control inside (a checkbox, a menu button) are left to that control.
 */
export function pressable<T extends Element = Element>(
  onActivate: (e: SyntheticEvent<T>) => void,
  opts: { row?: boolean; label?: string } = {},
) {
  return {
    ...(opts.row ? {} : { role: "button" as const }),
    ...(opts.label ? { "aria-label": opts.label } : {}),
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent<T>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate(e);
      }
    },
  };
}
