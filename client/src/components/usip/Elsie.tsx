/**
 * Elsie — the LSI Media guide. ("L-S-I", said aloud.)
 *
 * The walkthrough machinery already existed: TourEngine draws the spotlight,
 * pulsing ring, arrows and step card, tours.* stores 10 authored tours, and the
 * whole thing is mounted in App.tsx. What was missing was any way for a user to
 * turn guidance ON and leave it on — tours were reachable only by digging into
 * the Help Center, and `TourNudge` was written, exported, and never rendered by
 * anything, so the "proactive trigger" in TourEngine's header never happened.
 *
 * Elsie is that missing layer, and only that layer. She owns no tour content
 * and draws no highlights herself:
 *   • a toggle in the top bar (NOT a floating button — house rule)
 *   • while on, she watches the route, asks for the tour recommended for that
 *     page, and offers it
 *   • starting one hands off to the existing TourEngine
 *
 * The preference follows the ACCOUNT (users.elsie_enabled, migration 0133),
 * exactly like themePalette. localStorage is kept, but demoted to an
 * instant-boot cache: it is what renders the toggle in the right state before
 * the first round trip, and the server value overrides it once per mount.
 * Without that cache the toggle visibly flips on every page load.
 *
 * Offering is rate-limited by memory of what was already offered: a guide that
 * re-asks on every route change is not a guide, it is a popup.
 *
 * ONE HELPER (owner, 2026-11-15: "Merge Elsie and the assistant"). The top bar
 * carried two things a user had to tell apart: this toggle, which only offered
 * tours, and a sparkles button that opened the AI Assistant, which answers
 * questions and does the work. They are one Elsie now:
 *   • the top-bar button opens her (the assistant drawer, Ctrl/Cmd+J)
 *   • the chat can hand back a tour as a "Show me" button (find_tours)
 *   • the old on/off preference still exists, and still means exactly what it
 *     did, "offer me a tour when I open a page": it moved into her drawer
 *   • the unprompted card gained "Ask Elsie", so an offer is never a dead end
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useTourEngine, type Tour } from "./TourEngine";
import { Compass, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { assistantStore, useAssistantStore } from "@/lib/assistantStore";
import { useAssistPane } from "@/lib/assistPaneStore";

/** Her name, in one place, so renaming her is a one-line change. */
export const ELSIE_NAME = "Elsie";

const STORAGE_KEY = "velocity.elsie.enabled";

/* ─── Preference ─────────────────────────────────────────────────────────── */

function readEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // Default ON: a new user is exactly who this exists for, and the toggle is
    // one visible click away for everyone else.
    return raw === null ? true : raw === "1";
  } catch {
    return true;
  }
}

function cacheEnabled(v: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
  } catch {
    /* private mode — the toggle still works for this session */
  }
}

/**
 * Adopt the account's stored value. Called once per mount from Shell, which
 * already fetches appearance for the colour theme, so this costs no extra
 * request. Updates the cache but does NOT write back to the server — this is
 * the server telling us, not the user choosing.
 */
export function adoptServerElsiePref(v: boolean) {
  if (enabledState === v) return;
  enabledState = v;
  cacheEnabled(v);
  listeners.forEach((fn) => fn(v));
}

/**
 * Shared on/off state. A plain module-level listener set rather than a context,
 * because the toggle lives in Shell's top bar and the controller is mounted up
 * in App.tsx — putting a provider around both would mean threading it through
 * every page that renders its own Shell.
 */
const listeners = new Set<(v: boolean) => void>();
let enabledState: boolean | null = null;

function getEnabled(): boolean {
  if (enabledState === null) enabledState = readEnabled();
  return enabledState;
}

/** Local-only update. The toggle also persists to the account; see ElsieToggle. */
export function setElsieEnabled(v: boolean) {
  enabledState = v;
  cacheEnabled(v);
  listeners.forEach((fn) => fn(v));
}

export function useElsieEnabled(): [boolean, (v: boolean) => void] {
  const [enabled, setLocal] = useState(getEnabled);
  useEffect(() => {
    listeners.add(setLocal);
    return () => { listeners.delete(setLocal); };
  }, []);
  return [enabled, setElsieEnabled];
}

/* ─── Route → tour pageKey ───────────────────────────────────────────────── */

/**
 * Authored tours are keyed by page, so a route has to resolve to one. Longest
 * prefix wins, so /prospects/123 still resolves to the prospects tour.
 * A route with no entry simply has no guidance — Elsie stays silent rather
 * than offering something unrelated.
 */
const ROUTE_PAGE_KEYS: Array<[string, string]> = [
  ["/v2/home", "dashboard"],
  ["/find-prospects", "find-prospects"],
  ["/prospects", "prospects"],
  ["/leads", "leads"],
  ["/pipeline", "pipeline"],
  ["/v2/sequences", "sequences"],
  ["/social", "social"],
  ["/connected-accounts", "connected-accounts"],
  ["/v2/ai-assistant", "ai-assistant"],
  // The one reply workspace (F25); its tours point at its tabs.
  ["/v2/inbox", "inbox"],
  ["/calendar", "calendar"],
  ["/v2/companies", "companies"],
  ["/v2/lists", "lists"],
  // "Every page, explained" and "Navigating the app" are filed under this key.
  ["/v2/library", "library"],
  ["/v2/data-enrichment", "data-enrichment"],
  // Research had no key, so its Help drawer was empty and the assistant was
  // told the user was on an unknown page (2026-11-15).
  ["/research", "research"],
  ["/data-health", "data-health"],
  ["/import", "import"],
  ["/v2/emails", "emails"],
  ["/v2/calls", "calls"],
  ["/email-builder", "email-builder"],
  ["/segments", "segments"],
  ["/pipeline-alerts", "pipeline-alerts"],
  ["/proposals", "proposals"],
  ["/products", "products"],
  ["/customers", "customers"],
  ["/renewals", "renewals"],
  ["/qbrs", "qbrs"],
  ["/brand-voice", "brand-voice"],
  ["/personas", "personas"],
  ["/lead-scoring", "lead-scoring"],
  ["/lead-routing", "lead-routing"],
  ["/reports", "reports"],
  ["/dashboards", "dashboards"],
  ["/mindmaps", "mindmaps"],
  // No "contacts" rows here, deliberately (2026-09-20). /contacts and
  // /accounts redirect away on mount, and nothing is filed under pageKey
  // "contacts" any more — not a tour, not an article. The four rows that used
  // to sit here also duplicated /v2/people and /v2/companies, and a duplicate
  // prefix is worse than a dead one: pageKeyForRoute below keeps `best` on a
  // STRICT `prefix.length > best.len`, so on equal-length duplicates the FIRST
  // entry wins silently. That is how the People page spent a month offering a
  // tour of a retired page instead of "People and Companies", and how its Help
  // drawer showed an empty article list. server/tourAnchors.test.ts now fails
  // on any duplicate prefix.
  ["/v2/meetings", "meetings"],
  ["/v2/tasks", "tasks"],
  ["/v2/forms", "forms"],
  ["/v2/landing-pages", "landing-pages"],
  ["/v2/website-visitors", "website-visitors"],
  ["/v2/people", "people"],
  ["/v2/deliverability", "deliverability"],
  ["/v2/analytics", "analytics"],
  ["/v2/chat", "chat"],
  ["/v2/settings/data-sources", "data-sources"],
  ["/v2/settings", "admin-setup"],

  ["/v2/workflows", "workflows"],
  ["/workflows", "workflows"],
  ["/are", "are"],
  ["/", "dashboard"],
];

export function pageKeyForRoute(path: string): string | null {
  let best: { key: string; len: number } | null = null;
  for (const [prefix, key] of ROUTE_PAGE_KEYS) {
    const matches = prefix === "/" ? path === "/" : path === prefix || path.startsWith(`${prefix}/`);
    if (matches && (!best || prefix.length > best.len)) best = { key, len: prefix.length };
  }
  return best?.key ?? null;
}

/* ─── Tour-offer preference ──────────────────────────────────────────────── */

/**
 * Whether Elsie offers a tour unprompted, and the switch for it. The switch
 * sits in her drawer's header (AssistantDrawer); the value still follows the
 * account (users.elsie_enabled).
 */
export function useElsieTourOffers(): [boolean, () => void] {
  const [enabled, setEnabled] = useElsieEnabled();
  // Best-effort account sync: the local state flips immediately either way, so
  // a failed write costs this device's session rather than the interaction.
  const save = trpc.profile.updateMyAppearance.useMutation({ meta: { silentError: true } });
  const toggle = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    save.mutate({ elsieEnabled: next });
  }, [enabled, setEnabled, save]);
  return [enabled, toggle];
}

/* ─── Button (top bar) ───────────────────────────────────────────────────── */

/**
 * The one way in. Lives in Shell's top bar — deliberately not a floating
 * action button, which this product does not use. It opens Elsie's drawer;
 * it is no longer an on/off switch (that is "Tour offers" inside the drawer).
 */
export function ElsieButton() {
  const { open } = useAssistantStore();
  return (
    <button
      type="button"
      data-tour-id="assistant-button"
      onClick={() => assistantStore.toggle()}
      title={`${ELSIE_NAME}: ask anything, get shown around, or have it done (Ctrl+J)`}
      aria-label={`Open ${ELSIE_NAME}, your guide and assistant`}
      aria-expanded={open}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm transition-colors shrink-0",
        "bg-violet-100 text-violet-700 hover:bg-violet-200/80 dark:bg-violet-500/15 dark:text-violet-300 dark:hover:bg-violet-500/25",
      )}
    >
      <Compass className="size-4" />
      <span className="hidden sm:inline font-medium">{ELSIE_NAME}</span>
    </button>
  );
}

/* ─── Controller ─────────────────────────────────────────────────────────── */

/**
 * Watches the route while Elsie is on and offers the tour for that page.
 * Renders nothing when off, and runs no query either — turning her off has to
 * actually stop the work, not just hide the card.
 */
export function ElsieController() {
  const [enabled] = useElsieEnabled();
  const [location] = useLocation();
  const { startTour, activeTour } = useTourEngine();
  // Her drawer is the same corner of the screen: no card over an open chat.
  const { open: drawerOpen } = useAssistantStore();
  // The Assist pane is that corner too. While it is on screen it gives the
  // offer a place of its own; null whenever the pane is closed or not mounted.
  const { tourSlot } = useAssistPane();

  const pageKey = useMemo(() => pageKeyForRoute(location), [location]);
  const [dismissed, setDismissed] = useState(false);
  /** Pages already offered this session — never ask twice for the same one. */
  const offered = useRef<Set<string>>(new Set());

  // A fresh page is a fresh offer; the same page is not.
  useEffect(() => { setDismissed(false); }, [pageKey]);

  /**
   * Elsie renders OUTSIDE AuthGate, so it also mounts on the sign-in page —
   * where `pageKeyForRoute("/")` returns "dashboard" and this used to fire
   * `tours.getRecommended`, a workspaceProcedure. Logged out that throws
   * UNAUTHED_ERR_MSG, which the query-cache subscriber in main.tsx turned into
   * a navigation to "/" — the page already showing. Hence the sign-in flicker.
   *
   * main.tsx no longer reloads the page it is on, so the loop cannot recur;
   * this stops the pointless 401 on every signed-out page load as well. There
   * are no tours to recommend to someone with no session.
   */
  const { user } = useAuth();
  const canAsk = !!user && enabled && !!pageKey && !activeTour && !dismissed && !offered.current.has(pageKey);

  const rec = trpc.tours.getRecommended.useQuery(
    { pageKey: pageKey ?? undefined },
    { enabled: canAsk, retry: false, staleTime: 5 * 60_000 },
  );

  const full = trpc.tours.get.useQuery(
    { id: (rec.data as any)?.[0]?.id ?? 0 },
    { enabled: canAsk && !!(rec.data as any)?.[0]?.id, retry: false },
  );

  const suggestion = (rec.data as any)?.[0] as { id: number; name: string; estimatedMinutes?: number } | undefined;

  const begin = useCallback(() => {
    const tour = full.data as Tour | undefined;
    if (!tour) return;
    if (pageKey) offered.current.add(pageKey);
    startTour(tour);
  }, [full.data, pageKey, startTour]);

  const dismiss = useCallback(() => {
    if (pageKey) offered.current.add(pageKey);
    setDismissed(true);
  }, [pageKey]);

  if (!canAsk || !suggestion || drawerOpen) return null;

  // With the Assist pane open the offer goes inside it, above its footer.
  // Floating, the card lay over that footer (the pane's Ask button and its
  // AI-wording line) at every window width: beside the page on a wide screen
  // and over it on a narrow one, the pane is the bottom-right corner. It needs
  // no Ask button of its own here, the pane's is the next thing down.
  if (tourSlot) {
    return createPortal(
      <div className="rounded-lg border bg-background p-3" data-elsie-tour-offer="pane">
        <p className="text-[13px] font-semibold">{ELSIE_NAME} can walk you through this</p>
        <p className="text-[12px] text-muted-foreground mt-0.5">
          {suggestion.name}
          {suggestion.estimatedMinutes ? ` · about ${suggestion.estimatedMinutes} min` : ""}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2.5 [&>button]:whitespace-nowrap">
          <button
            onClick={begin}
            disabled={!full.data}
            className="px-3 py-1.5 text-[12px] font-medium text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-60 rounded-lg"
          >
            Show me
          </button>
          <button onClick={dismiss} className="px-2 py-1.5 text-[12px] text-muted-foreground hover:text-foreground">
            Not now
          </button>
        </div>
      </div>,
      tourSlot,
    );
  }

  return (
    // 24rem since 2026-11-15: at 20rem the three buttons had about 218px and
    // their labels wrapped onto two lines. Never wider than a phone's screen.
    <div className="fixed bottom-6 right-6 z-[9980] w-96 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover text-popover-foreground shadow-xl p-4 animate-in slide-in-from-bottom-4">
      <div className="flex items-start gap-3">
        <div className="size-8 rounded-full bg-violet-100 dark:bg-violet-500/20 flex items-center justify-center shrink-0">
          <Compass className="size-4 text-violet-600 dark:text-violet-300" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-semibold">{ELSIE_NAME} can walk you through this</p>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            {suggestion.name}
            {suggestion.estimatedMinutes ? ` · about ${suggestion.estimatedMinutes} min` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2.5 [&>button]:whitespace-nowrap">
            <button
              onClick={begin}
              disabled={!full.data}
              className="px-3 py-1.5 text-[12px] font-medium text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-60 rounded-lg"
            >
              Show me
            </button>
            <button
              onClick={() => { dismiss(); assistantStore.open(); }}
              className="px-2 py-1.5 text-[12px] font-medium text-violet-700 dark:text-violet-300 hover:underline"
            >
              Ask {ELSIE_NAME}
            </button>
            <button onClick={dismiss} className="px-2 py-1.5 text-[12px] text-muted-foreground hover:text-foreground">
              Not now
            </button>
          </div>
        </div>
        <button onClick={dismiss} aria-label="Dismiss" className="text-muted-foreground hover:text-foreground shrink-0">
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
