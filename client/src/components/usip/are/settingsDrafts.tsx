/**
 * One Save for a campaign's Settings tab (audit 2026-10-20, U11).
 *
 * The tab's cards each kept their own draft and their own Save — prompts,
 * targeting and research apart from the rest — so a person could save one
 * card, leave, and lose the edits in another with nothing saying so. Cards
 * that hold their own draft register it here (what it is, how many changes,
 * how to save and discard it); the tab's one Save bar counts every
 * registered draft beside its own, saves them all, and the page asks before
 * anyone leaves with something unsaved.
 *
 * A card outside a provider (the hook finds none) behaves as it always did.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { navigate } from "wouter/use-browser-location";
import { confirmAction } from "@/components/usip/Common";

export interface DraftEntry {
  /** The card's name in the Save bar ("Targeting"). */
  label: string;
  /** How many changes it holds; 0 means nothing to save. */
  count: number;
  /** Saves the card's draft; rejects when the save failed (the card says why). */
  save: () => Promise<unknown>;
  discard: () => void;
}

type Registry = { set: (key: string, entry: DraftEntry | null) => void };
const DraftsContext = createContext<Registry | null>(null);

/** The tab's side: the registered drafts, and the provider that collects them. */
export function useSettingsDrafts() {
  const [entries, setEntries] = useState<Record<string, DraftEntry>>({});
  const set = useCallback((key: string, entry: DraftEntry | null) => {
    setEntries((prev) => {
      if (!entry) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: entry };
    });
  }, []);
  const registry = useMemo<Registry>(() => ({ set }), [set]);
  const Provider = useCallback(({ children }: { children: ReactNode }) => (
    <DraftsContext.Provider value={registry}>{children}</DraftsContext.Provider>
  ), [registry]);
  return { entries, Provider };
}

/** A card's side: register its draft while it has changes. */
export function useRegisterDraft(key: string, entry: DraftEntry) {
  const registry = useContext(DraftsContext);
  // The latest save/discard, so the registered entry never calls a stale closure.
  const latest = useRef(entry);
  latest.current = entry;
  const { label, count } = entry;
  useEffect(() => {
    if (!registry) return;
    registry.set(key, count > 0 ? {
      label, count,
      save: () => latest.current.save(),
      discard: () => latest.current.discard(),
    } : null);
  }, [registry, key, label, count]);
  useEffect(() => () => registry?.set(key, null), [registry, key]);
  return registry !== null;
}

export const UNSAVED_LEAVE_MESSAGE = "You have unsaved changes on this campaign's Settings. Leave without saving them?";

/**
 * Ask before leaving with unsaved changes: closing or reloading the browser
 * tab (beforeunload, the browser's own prompt), and following a link inside
 * the app: the click on an <a href> to another path is held, the in-app
 * confirm asks, and a yes goes there.
 */
export function useUnsavedChangesGuard(dirty: boolean, message: string = UNSAVED_LEAVE_MESSAGE) {
  useEffect(() => {
    if (!dirty || typeof window === "undefined") return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const to = new URL(a.href, window.location.href);
      if (to.origin !== window.location.origin || to.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      const dest = to.pathname + to.search + to.hash;
      confirmAction({ title: "Leave without saving?", description: message, confirmLabel: "Leave", cancelLabel: "Stay" }, () => navigate(dest));
    };
    window.addEventListener("beforeunload", onUnload);
    // Capture, so the check runs before the router's own click handler.
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, message]);
}
