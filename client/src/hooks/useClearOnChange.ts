import { useEffect, useRef } from "react";

/**
 * Clear a bulk selection when the rows it was made from change (audit
 * 2026-10-20, R4).
 *
 * The list pages kept their checkbox selection across a new search, filter or
 * sort, so "Delete", "Opt out", "Enrol" and "Export" acted on rows the user
 * could no longer see — and could never have reviewed together. Pass the
 * page's query (everything that decides which rows are listed) as `scope`;
 * the selection is cleared whenever it changes, never on the first render.
 */
export function useClearOnChange(scope: unknown, clear: () => void): void {
  const key = JSON.stringify(scope ?? null);
  const seen = useRef(key);
  useEffect(() => {
    if (seen.current === key) return;
    seen.current = key;
    clear();
    // `clear` is a fresh closure each render; only the scope decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
