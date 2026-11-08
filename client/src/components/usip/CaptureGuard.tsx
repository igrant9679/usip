/**
 * The public capture pages' side of the bot checks (audit 2026-10-20, F47;
 * server/services/publicCaptureGuard.ts holds the rules).
 *
 *  - The page keeps the FIRST submit token it was served. A refetch (window
 *    focus, a retry) would mint a new one and restart the minimum-time clock,
 *    and a person who comes back to the tab and presses Submit would be told
 *    they were too quick.
 *  - Cloudflare Turnstile is drawn only when the server sent a site key, which
 *    it does only when a key and a secret are both configured. With none, no
 *    script is loaded and nothing contacts Cloudflare.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window { turnstile?: TurnstileApi }
}

let loader: Promise<TurnstileApi | null> | null = null;
function loadTurnstile(): Promise<TurnstileApi | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loader) {
    loader = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = TURNSTILE_SCRIPT;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve(window.turnstile ?? null);
      s.onerror = () => { loader = null; resolve(null); };
      document.head.appendChild(s);
    });
  }
  return loader;
}

export function TurnstileWidget({ siteKey, onToken }: { siteKey: string; onToken: (t: string | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  useEffect(() => {
    let id: string | null = null;
    let cancelled = false;
    void loadTurnstile().then((ts) => {
      if (cancelled || !ts || !ref.current) return;
      id = ts.render(ref.current, {
        sitekey: siteKey,
        callback: (t: string) => cb.current(t),
        "expired-callback": () => cb.current(null),
        "error-callback": () => cb.current(null),
      });
    });
    return () => {
      cancelled = true;
      try { if (id && window.turnstile) window.turnstile.remove(id); } catch { /* already gone */ }
    };
  }, [siteKey]);
  return <div ref={ref} className="min-h-[65px]" />;
}

/**
 * What a capture page needs: the token to send, the challenge's answer, and
 * the widget to draw. `reset()` after a refused submit: a Turnstile answer is
 * single-use, so the widget is drawn again for a fresh one.
 */
export function useCaptureGuard(served: { submitToken?: string | null; turnstileSiteKey?: string | null } | null | undefined) {
  const [submitToken, setSubmitToken] = useState<string | undefined>(undefined);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!submitToken && served?.submitToken) setSubmitToken(served.submitToken);
  }, [served?.submitToken, submitToken]);
  const siteKey = served?.turnstileSiteKey || null;
  const reset = useCallback(() => { setTurnstileToken(null); setRound((r) => r + 1); }, []);
  return {
    submitToken,
    turnstileToken: turnstileToken ?? undefined,
    /** True while a configured challenge has not been answered. */
    waiting: !!siteKey && !turnstileToken,
    reset,
    widget: siteKey ? <TurnstileWidget key={round} siteKey={siteKey} onToken={setTurnstileToken} /> : null,
  };
}
