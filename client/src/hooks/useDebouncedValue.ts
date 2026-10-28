import { useEffect, useState } from "react";

/** How long typing must pause before a search goes to the server. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * The value once it has stopped changing for `ms` (audit 2026-10-20, X4.3):
 * a search box bound to a query sent one request per keystroke. Feed the
 * input from the live value and the query from this one.
 */
export function useDebouncedValue<T>(value: T, ms: number = SEARCH_DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
