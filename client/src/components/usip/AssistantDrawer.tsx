/**
 * AssistantDrawer — the AI Assistant from anywhere in the app.
 *
 * Opened from the sparkles button in the top bar or Ctrl/Cmd+J (Shell wires
 * both); closes on Escape, the backdrop, or the ✕. Same conversation as the
 * full page (lib/assistantStore), so opening the drawer on Deals and later
 * the full page shows one thread. Anchored in the top bar and mounted by the
 * Shell — not a floating FAB.
 */
import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Sparkles, Maximize2 } from "lucide-react";
import { pageKeyForRoute } from "@/components/usip/Elsie";
import { AssistantChat } from "@/components/usip/AssistantChat";
import { assistantStore, useAssistantStore } from "@/lib/assistantStore";

export function AssistantDrawer() {
  const { open } = useAssistantStore();
  const [location] = useLocation();
  const pageKey = pageKeyForRoute(location) ?? undefined;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") assistantStore.close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-[9970] bg-black/20" onClick={() => assistantStore.close()} />
      <div role="dialog" aria-label="AI Assistant" data-tour-id="assistant-drawer" className="fixed right-0 top-0 bottom-0 z-[9975] w-[440px] max-w-[100vw] bg-card shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 h-11 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-violet-600" />
            <span className="font-semibold text-sm">AI Assistant</span>
            {pageKey && <span className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{pageKey}</span>}
          </div>
          <div className="flex items-center gap-1">
            <Link href="/v2/ai-assistant" onClick={() => assistantStore.close()} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground" title="Open full page">
              <Maximize2 className="size-3.5" />
            </Link>
            <button type="button" onClick={() => assistantStore.close()} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-muted text-muted-foreground" aria-label="Close assistant">✕</button>
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <AssistantChat pageKey={pageKey} compact />
        </div>
      </div>
    </>
  );
}
