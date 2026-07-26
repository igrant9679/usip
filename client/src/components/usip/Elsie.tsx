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
 * The preference is per-user and per-device (localStorage). It is a UI
 * preference on a control the user can see and flip in one click, so it does
 * not justify a migration — but it does mean it will not follow them to another
 * machine.
 *
 * Offering is rate-limited by memory of what was already offered: a guide that
 * re-asks on every route change is not a guide, it is a popup.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useTourEngine, type Tour } from "./TourEngine";
import { Compass, X } from "lucide-react";
import { cn } from "@/lib/utils";

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

export function setElsieEnabled(v: boolean) {
  enabledState = v;
  try {
    localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
  } catch {
    /* private mode — the toggle still works for this session */
  }
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
  ["/sequences", "sequences"],
  ["/unified-inbox", "unified-inbox"],
  ["/social", "social"],
  ["/ai-pipeline", "ai-pipeline"],
  ["/email-drafts", "email-drafts"],
  ["/connected-accounts", "connected-accounts"],
  ["/v2/chat", "chat"],
  ["/v2/settings/data-sources", "data-sources"],
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

/* ─── Toggle (top bar) ───────────────────────────────────────────────────── */

/**
 * The on/off control. Lives in Shell's top bar — deliberately not a floating
 * action button, which this product does not use.
 */
export function ElsieToggle() {
  const [enabled, setEnabled] = useElsieEnabled();
  return (
    <button
      onClick={() => setEnabled(!enabled)}
      title={enabled ? `${ELSIE_NAME} is on — click to turn guidance off` : `${ELSIE_NAME} is off — click to turn guidance on`}
      aria-pressed={enabled}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm transition-colors shrink-0",
        enabled ? "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300" : "text-muted-foreground hover:bg-secondary",
      )}
    >
      <Compass className={cn("size-4", enabled && "animate-none")} />
      <span className="hidden sm:inline font-medium">{ELSIE_NAME}</span>
      <span className={cn("hidden md:inline text-[10px] px-1 rounded", enabled ? "bg-violet-200/70 dark:bg-violet-400/20" : "bg-muted")}>
        {enabled ? "ON" : "OFF"}
      </span>
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

  const pageKey = useMemo(() => pageKeyForRoute(location), [location]);
  const [dismissed, setDismissed] = useState(false);
  /** Pages already offered this session — never ask twice for the same one. */
  const offered = useRef<Set<string>>(new Set());

  // A fresh page is a fresh offer; the same page is not.
  useEffect(() => { setDismissed(false); }, [pageKey]);

  const canAsk = enabled && !!pageKey && !activeTour && !dismissed && !offered.current.has(pageKey);

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

  if (!canAsk || !suggestion) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[9980] w-80 rounded-xl border bg-popover text-popover-foreground shadow-xl p-4 animate-in slide-in-from-bottom-4">
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
          <div className="flex items-center gap-2 mt-2.5">
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
        </div>
        <button onClick={dismiss} aria-label="Dismiss" className="text-muted-foreground hover:text-foreground shrink-0">
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
