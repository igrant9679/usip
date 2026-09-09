/**
 * assistantStore — one conversation, reachable from anywhere in the app.
 *
 * The AI Assistant used to live only on /v2/ai-assistant, so every visit
 * started a fresh chat and the user had to leave their page to ask anything.
 * The owner's ask (2026-09-08): "accessible from anywhere within the app …
 * so that I'm never lost or don't know what to do next." The drawer in the
 * Shell and the full page now share THIS store, so a conversation started on
 * the Deals page continues in the drawer on Campaigns and on the full page.
 *
 * Deliberately tiny: a module singleton + useSyncExternalStore. No provider
 * to mount, no dependency, survives route changes (the Shell never unmounts).
 */
import { useSyncExternalStore } from "react";

export type PendingAction = { nonce: string; tool: string; args: Record<string, unknown>; description: string; expiresAt?: string };
export type AssistantQuestion = { text: string; options: string[] };
export type AssistantMessage = {
  role: "user" | "assistant";
  body: string;
  toolEvents?: Array<{ tool: string; summary: string }>;
  navigations?: Array<{ href: string; label: string }>;
  pendingActions?: PendingAction[];
  /** Per-nonce outcome once a card was confirmed/declined, so it disarms. */
  resolved?: Record<string, "done" | "declined">;
  question?: AssistantQuestion | null;
  /** Set once the user picked an option (or typed instead), so the chips disarm. */
  answered?: boolean;
};

type State = {
  open: boolean;
  conversationId: number | null;
  messages: AssistantMessage[];
  loading: boolean;
};

let state: State = { open: false, conversationId: null, messages: [], loading: false };
const listeners = new Set<() => void>();

function emit() { for (const l of Array.from(listeners)) l(); }
function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  emit();
}

export const assistantStore = {
  get: () => state,
  subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  open: () => set({ open: true }),
  close: () => set({ open: false }),
  toggle: () => set((s) => ({ open: !s.open })),
  setConversationId: (id: number | null) => set({ conversationId: id }),
  setLoading: (loading: boolean) => set({ loading }),
  push: (m: AssistantMessage) => set((s) => ({ messages: [...s.messages, m] })),
  update: (index: number, patch: Partial<AssistantMessage>) =>
    set((s) => ({ messages: s.messages.map((m, i) => (i === index ? { ...m, ...patch } : m)) })),
  reset: () => set({ conversationId: null, messages: [], loading: false }),
};

export function useAssistantStore(): State {
  return useSyncExternalStore(assistantStore.subscribe, assistantStore.get, assistantStore.get);
}
