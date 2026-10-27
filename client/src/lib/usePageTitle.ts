import { useEffect } from "react";

const DEFAULT_TITLE = "Velocity — Unified Revenue Intelligence";

/**
 * The browser tab's title for this page (audit 2026-10-20, G70 and X5.6):
 * every page was "Velocity — Unified Revenue Intelligence", so tabs, history
 * and screen readers could not tell one page from another. Puts the default
 * back when the page goes, so a page without a title never shows the last one.
 */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    const t = title?.trim();
    document.title = t ? `${t} · Velocity` : DEFAULT_TITLE;
    return () => { document.title = DEFAULT_TITLE; };
  }, [title]);
}
