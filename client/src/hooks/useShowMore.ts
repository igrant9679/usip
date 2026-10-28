import { useState } from "react";
import { useClearOnChange } from "./useClearOnChange";

/** Rows a long list renders before "Show more". */
export const SHOW_MORE_STEP = 50;

/**
 * The first `step` items, and a way to show the next `step` (audit
 * 2026-10-20, X4.2). Lists that rendered every row at once built pages of
 * 10,000–20,000 DOM nodes (/v2/tasks, /audit); the rest now wait for a click.
 * Pass the list's filters as `scope`: a new filter starts over at one step,
 * a refetch of the same list does not.
 */
export function useShowMore<T>(items: readonly T[], scope: unknown = null, step: number = SHOW_MORE_STEP) {
  const [count, setCount] = useState(step);
  useClearOnChange(scope, () => setCount(step));
  return {
    shown: items.slice(0, count),
    remaining: Math.max(0, items.length - count),
    showMore: () => setCount((c) => c + step),
  };
}
