import { useEffect } from "react";
import { useWorkspace } from "@/contexts/WorkspaceContext";

const DEFAULT_TITLE = "Velocity — Unified Revenue Intelligence";

/**
 * "Pipeline · LSI Media · Velocity" (audit 2026-10-20, U10; batch CONB,
 * 2026-11-08): the tab names the workspace too, so someone with two
 * workspaces open in two tabs can tell which is which before writing into
 * the wrong one (G11). Public pages have no workspace and keep "Page ·
 * Velocity".
 */
export function pageTitleFor(title: string | null | undefined, workspaceName?: string | null): string {
  const t = title?.trim();
  if (!t) return DEFAULT_TITLE;
  const ws = workspaceName?.trim();
  return ws ? `${t} · ${ws} · Velocity` : `${t} · Velocity`;
}

/**
 * The browser tab's title for this page (audit 2026-10-20, G70 and X5.6):
 * every page was "Velocity — Unified Revenue Intelligence", so tabs, history
 * and screen readers could not tell one page from another. Puts the default
 * back when the page goes, so a page without a title never shows the last one.
 * Signed-in pages add the current workspace's name (U10); outside the
 * workspace provider the context answers "none", so public pages are as before.
 */
export function usePageTitle(title: string | null | undefined) {
  const { current } = useWorkspace();
  const workspaceName = current?.name ?? null;
  useEffect(() => {
    document.title = pageTitleFor(title, workspaceName);
    return () => { document.title = DEFAULT_TITLE; };
  }, [title, workspaceName]);
}
