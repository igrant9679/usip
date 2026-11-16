/**
 * AssistantDrawer — Elsie from anywhere in the app.
 *
 * One helper since 2026-11-15 (owner: "Merge Elsie and the assistant"). The
 * top bar used to carry two buttons: Elsie, a switch that only offered page
 * tours, and a sparkles button that opened this chat. The chat is Elsie now;
 * the switch for her unprompted tour offers lives in this header.
 *
 * Opened from the Elsie button in the top bar or Ctrl/Cmd+J (Shell wires
 * both); closes on Escape, the backdrop, or the ✕. Same conversation as the
 * full page (lib/assistantStore), so opening the drawer on Deals and later
 * the full page shows one thread. Anchored in the top bar and mounted by the
 * Shell — not a floating FAB.
 */
import { useEffect } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Compass, Maximize2 } from "lucide-react";
import { ELSIE_NAME, pageKeyForRoute, useElsieTourOffers } from "@/components/usip/Elsie";
import { addressOf } from "@/lib/lastPage";
import { AssistantChat } from "@/components/usip/AssistantChat";
import { assistantStore, useAssistantStore } from "@/lib/assistantStore";
import { useAssistPaneToggle } from "@/components/usip/ElsieAssistPane";

export function AssistantDrawer() {
  const { open } = useAssistantStore();
  const [location] = useLocation();
  const search = useSearch();
  const pageKey = pageKeyForRoute(location) ?? undefined;
  const [offers, toggleOffers] = useElsieTourOffers();
  const [assist, toggleAssist] = useAssistPaneToggle();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") assistantStore.close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <>
      <div aria-hidden="true" className="fixed inset-0 z-[9970] bg-black/20" onClick={() => assistantStore.close()} />
      <div role="dialog" aria-label={ELSIE_NAME} data-tour-id="assistant-drawer" className="fixed right-0 top-0 bottom-0 z-[9975] w-[440px] max-w-[100vw] bg-card shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 h-11 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Compass className="size-4 text-violet-600" />
            <span className="font-semibold text-sm">{ELSIE_NAME}</span>
            {pageKey && <span className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{pageKey}</span>}
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              role="switch"
              aria-checked={offers}
              onClick={toggleOffers}
              title={offers ? `${ELSIE_NAME} offers a tour when you open a page she has one for. Click to stop.` : `${ELSIE_NAME} only speaks when asked. Click to have her offer page tours.`}
              className={`h-7 px-2 rounded-lg text-[11px] font-medium transition-colors ${offers ? "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300" : "text-muted-foreground hover:bg-muted"}`}
            >
              Tour offers {offers ? "on" : "off"}
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={assist}
              onClick={toggleAssist}
              title={assist ? `${ELSIE_NAME} Assist is open beside the page. Click to close it.` : `Open ${ELSIE_NAME} Assist: her suggestions for the page you are on, beside the page.`}
              className={`h-7 px-2 rounded-lg text-[11px] font-medium transition-colors ${assist ? "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300" : "text-muted-foreground hover:bg-muted"}`}
            >
              Assist {assist ? "on" : "off"}
            </button>
            <Link href="/v2/ai-assistant" onClick={() => assistantStore.close()} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground" title="Open full page">
              <Maximize2 className="size-3.5" />
            </Link>
            <button type="button" onClick={() => assistantStore.close()} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground" aria-label="Close assistant">✕</button>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <AssistantChat pageKey={pageKey} pagePath={addressOf(location, search)} compact />
        </div>
      </div>
    </>
  );
}
