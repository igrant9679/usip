/**
 * assistPaneStore — whether the Elsie Assist pane is open, and what the user
 * has waved away this session.
 *
 * Open or closed follows the ACCOUNT (the elsieAssist.prefs endpoint), exactly
 * like the colour theme: localStorage is only what paints the pane in the
 * right state before the first round trip. Closed until the user opens it.
 *
 * A module singleton, like assistantStore: the button is in the top bar, the
 * switch is in Elsie's drawer and the pane is a column of the Shell, and none
 * of them shares a parent worth threading a provider through.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "velocity.elsieAssist.open";

function readCached(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function cache(open: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
  } catch {
    /* private mode: the pane still works for this session */
  }
}

type State = { open: boolean; adopted: boolean; dismissed: ReadonlySet<string>; tourSlot: HTMLElement | null };

let state: State = { open: false, adopted: false, dismissed: new Set(), tourSlot: null };
let booted = false;
const listeners = new Set<() => void>();

function emit() { for (const l of Array.from(listeners)) l(); }
function boot() {
  if (booted) return;
  booted = true;
  state = { ...state, open: readCached() };
}

export const assistPaneStore = {
  get: (): State => { boot(); return state; },
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  /** The user's own choice: the caller also saves it to the account. */
  setOpen: (open: boolean) => { boot(); state = { ...state, open }; cache(open); emit(); },
  /** The account's stored value, taken once per page load. Not a choice, so nothing is written back. */
  adoptServer: (open: boolean) => {
    boot();
    if (state.adopted) return;
    state = { ...state, open, adopted: true };
    cache(open);
    emit();
  },
  /** Hide one suggestion until the fact behind it changes (its id changes with it) or the page reloads. */
  dismiss: (id: string) => {
    boot();
    const dismissed = new Set(state.dismissed);
    dismissed.add(id);
    state = { ...state, dismissed };
    emit();
  },
  /**
   * The place inside the open pane that takes Elsie's tour offer: the pane's
   * ref callback, so the element while the pane is on screen and null once it
   * is not. Elsie.tsx puts the offer there instead of floating it, because the
   * floating card and the pane's footer are the same corner of the window.
   */
  setTourSlot: (el: HTMLElement | null) => {
    if (state.tourSlot === el) return;
    state = { ...state, tourSlot: el };
    emit();
  },
};

export function useAssistPane(): State {
  return useSyncExternalStore(assistPaneStore.subscribe, assistPaneStore.get, assistPaneStore.get);
}
