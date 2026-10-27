/**
 * lazyChunk — React.lazy for a code-split chunk: a route, or a heavy component
 * most visits never open (audit 2026-10-20, Phase 4, X2.4).
 *
 * App.tsx imported all 114 pages up front, so the first visit (the sign-in
 * page included) downloaded the whole app as one 10 MB script. Each page is
 * now its own chunk, fetched when its route first renders, and so are the
 * rich-text editor and the Markdown renderer.
 *
 * One recovery: after a deploy, a tab still running the previous build asks
 * for chunk files that no longer exist, and the import fails. The page then
 * reloads once to pick up the new build. Not more than once a minute, so a
 * chunk that is genuinely missing reaches the error boundary instead of
 * reloading forever.
 */
import { lazy, type ComponentType } from "react";

const RELOADED_AT = "usip_chunk_reload_at";
const RELOAD_WINDOW_MS = 60_000;

/** Reload for a newer build unless this tab already did in the last minute. Returns whether it reloads. */
export function reloadForNewBuild(now: number = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
    if (now - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOADED_AT, String(now));
  } catch {
    // No sessionStorage (private mode, blocked): no way to tell a loop from a
    // first try, so do not reload.
    return false;
  }
  window.location.reload();
  return true;
}

/** `load`, except that a failed chunk reloads the page once instead of failing. */
export function withReload<T>(load: () => Promise<T>, reload: () => boolean = reloadForNewBuild): () => Promise<T> {
  return () =>
    load().catch((err: unknown) => {
      // While the reload happens, render nothing new: a promise that never
      // settles keeps the Suspense fallback up instead of flashing an error.
      if (reload()) return new Promise<never>(() => {});
      throw err;
    });
}

export function lazyChunk<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(withReload(load));
}
