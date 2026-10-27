import type { KeyboardEvent } from "react";

/**
 * Tab strips built from plain buttons (audit 2026-10-20, X5.2): a screen
 * reader heard a row of unrelated buttons with no way to tell which one was
 * showing. Spread these on the strip and its buttons for the ARIA tab
 * pattern: one stop in the Tab order (the selected tab), arrow keys, Home and
 * End move between tabs and open them.
 *
 *   <div {...tablistProps("Sequence sections")}>
 *     {TABS.map((t) => <button {...tabProps(tab === t)} onClick={() => setTab(t)}>…)}
 */
export function tablistProps(label?: string) {
  return {
    role: "tablist" as const,
    ...(label ? { "aria-label": label } : {}),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const strip = e.currentTarget;
      const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]')).filter((t) => t.closest('[role="tablist"]') === strip);
      const i = tabs.indexOf(document.activeElement as HTMLElement);
      if (i < 0 || !tabs.length) return;
      const n = tabs.length;
      const next = e.key === "ArrowRight" ? (i + 1) % n
        : e.key === "ArrowLeft" ? (i - 1 + n) % n
        : e.key === "Home" ? 0
        : e.key === "End" ? n - 1
        : -1;
      if (next < 0) return;
      e.preventDefault();
      tabs[next].focus();
      tabs[next].click();
    },
  };
}

export function tabProps(selected: boolean) {
  return { role: "tab" as const, "aria-selected": selected, tabIndex: selected ? 0 : -1 };
}
