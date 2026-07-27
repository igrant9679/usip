/**
 * ChatLauncher — the chat agent's bubble on the pages Velocity hosts itself
 * (/l/:slug landing pages, /b/:slug booking pages).
 *
 * The in-app twin of the /v/chat.js snippet an external site pastes. They share
 * nothing but the URL contract (/c/:slug in an iframe) on purpose: one runs
 * inside this React app, the other on a stranger's page with no build step.
 *
 * The iframe mounts on FIRST OPEN and then stays mounted while hidden, so a
 * visitor who closes the panel and reopens it keeps their transcript — closing
 * a chat is not the same as ending it.
 *
 * Renders nothing without a slug: the server only sends one when a published,
 * non-`off` agent is installed, so "no agent" is silent rather than broken.
 */
import { useEffect, useState } from "react";
import { MessageSquare, X } from "lucide-react";

interface Props {
  /** Public agent slug (/c/:slug), or null/empty when none is installed. */
  slug?: string | null;
  /** Accent colour; defaults to the house teal. */
  color?: string;
  /** Accessible name for the launcher button. */
  label?: string;
}

export default function ChatLauncher({ slug, color = "#14B89A", label = "Chat with us" }: Props) {
  const storageKey = `_vlchat_open_${slug ?? ""}`;
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Survive a hop from a landing page to its booking page.
  useEffect(() => {
    if (!slug) return;
    try {
      if (sessionStorage.getItem(storageKey) === "1") {
        setOpen(true);
        setLoaded(true);
      }
    } catch { /* private mode — the bubble still works, it just forgets */ }
  }, [slug, storageKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!slug) return null;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) setLoaded(true);
    try { sessionStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* ignore */ }
  };

  return (
    <>
      {loaded && (
        <iframe
          title={label}
          src={`/c/${encodeURIComponent(slug)}?embed=1`}
          // An iframe is a replaced element: `w-auto` would resolve to its
          // intrinsic 300px, not to left/right, so the small-screen width is
          // explicit. See the same note in server/chatWidget.ts.
          className={`fixed bottom-[88px] right-5 max-sm:left-3 max-sm:right-auto max-sm:bottom-[84px] w-[380px] max-sm:w-[calc(100%-24px)] h-[560px] max-h-[calc(100vh-116px)] max-sm:h-[calc(100vh-100px)] rounded-2xl border-0 bg-white shadow-2xl overflow-hidden z-[2147483000] ${
            open ? "" : "hidden"
          }`}
        />
      )}
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-expanded={open}
        className="fixed bottom-5 right-5 size-14 rounded-full flex items-center justify-center text-white shadow-xl transition-transform hover:scale-105 z-[2147483000]"
        style={{ backgroundColor: color }}
      >
        {open ? <X className="size-5" /> : <MessageSquare className="size-6" />}
      </button>
    </>
  );
}
