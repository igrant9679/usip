/**
 * Whether the browser tab is showing this page right now, following
 * `visibilitychange`. For polls that should stop while nobody can see them
 * (audit 2026-10-20, U24): React Query skips an interval in a hidden tab only
 * by its default, which one option on one query can turn off without anyone
 * noticing, so a poll that must pause says so here as well.
 */
import { useEffect, useState } from "react";

export function isPageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(isPageVisible);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => setVisible(isPageVisible());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
