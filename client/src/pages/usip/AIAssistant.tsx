/**
 * AIAssistant — the "AI Assistant" top-nav surface (/v2/ai-assistant).
 *
 * The full-page home of the conversational operator. The chat itself is
 * components/usip/AssistantChat (shared with the Shell drawer, Ctrl+J), and
 * the conversation lives in lib/assistantStore so it follows the user
 * between the drawer and this page.
 *
 * It looks things up through the app's own procedures, recommends, asks
 * when it needs a decision, hands out in-app links, and PROPOSES actions —
 * every action renders as a confirmation card and runs only when the user
 * presses Confirm (assistant.confirmAction). It can send only what the
 * approval queues already hold (approved drafts, proposed meetings), and
 * those cards say so.
 */
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { pageKeyForRoute } from "@/components/usip/Elsie";
import { lastPageBeforeAssistant } from "@/lib/lastPage";
import { AssistantChat } from "@/components/usip/AssistantChat";
import { assistantStore, useAssistantStore } from "@/lib/assistantStore";
import { Button } from "@/components/ui/button";
import { Sparkles, RotateCcw } from "lucide-react";

export default function AIAssistant() {
  const accent = useAccentColor();
  const { messages } = useAssistantStore();
  // Where the user came from — the page "here"/"this page" refers to.
  const pageKey = pageKeyForRoute(lastPageBeforeAssistant() ?? "") ?? undefined;

  return (
    <Shell title="AI Assistant">
      <div data-tour-id="ai-assistant-panel" className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Sparkles className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">AI Assistant</h1>
          <span className="text-[11px] text-muted-foreground hidden sm:inline">· looks things up, recommends, asks when it needs a decision, runs actions only when you confirm · Ctrl+J anywhere</span>
          <div className="flex-1" />
          {messages.length > 0 && (
            <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={() => assistantStore.reset()}><RotateCcw className="size-3.5" /> New chat</Button>
          )}
        </div>
        <div className="flex-1 min-h-0">
          <AssistantChat pageKey={pageKey} />
        </div>
      </div>
    </Shell>
  );
}
