/**
 * AIAssistant — the "AI Assistant" top-nav surface (/v2/ai-assistant).
 *
 * A full-page conversational assistant with a BOUNDED action tool set
 * (assistant.chat): it looks things up through the app's own procedures,
 * hands out in-app links, and PROPOSES actions — a proposed action renders
 * as a confirmation card and runs only when the user presses Confirm
 * (assistant.confirmAction). It cannot send email or LinkedIn messages;
 * sends stay behind the autopilot dials and approval queues.
 *
 * Conversations persist through the same helpCenter conversation store the
 * Help drawer uses (helpCenter.startConversation).
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { pageKeyForRoute } from "@/components/usip/Elsie";
import { lastPageBeforeAssistant } from "@/lib/lastPage";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Sparkles, Send, Loader2, RotateCcw, Wrench, ArrowRight, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";

/** The server holds the proposal; the client holds only its nonce (0168). */
type PendingAction = { nonce: string; tool: string; args: Record<string, unknown>; description: string; expiresAt?: string };
type Message = {
  role: "user" | "assistant";
  body: string;
  toolEvents?: Array<{ tool: string; summary: string }>;
  navigations?: Array<{ href: string; label: string }>;
  pendingAction?: PendingAction | null;
  /** Set once the pending action was confirmed/declined so the card disarms. */
  actionResolved?: "done" | "declined";
};

const SUGGESTED = [
  "What's waiting on me today?",
  "Find everyone at Amentum",
  "Walk me through onboarding step by step",
  "Create follow-up tasks for my newest prospects",
];

export default function AIAssistant() {
  const accent = useAccentColor();
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const startConv = trpc.helpCenter.startConversation.useMutation({ onError: (e) => toast.error(e.message) });
  const chat = trpc.assistant.chat.useMutation({ onError: (e) => toast.error(e.message) });
  const confirm = trpc.assistant.confirmAction.useMutation({ onError: (e) => toast.error(e.message) });
  const decline = trpc.assistant.declineAction.useMutation({ meta: { silentError: true } });
  // Where the user came from — the page "here"/"this page" refers to.
  const pageKey = pageKeyForRoute(lastPageBeforeAssistant() ?? "") ?? undefined;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  async function send(override?: string) {
    const userMsg = (override ?? input).trim();
    if (!userMsg || isLoading) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", body: userMsg }]);
    setIsLoading(true);
    try {
      let convId = conversationId;
      if (!convId) {
        const res = await startConv.mutateAsync();
        convId = res.conversationId;
        setConversationId(convId);
      }
      const res = await chat.mutateAsync({ conversationId: convId, message: userMsg, pageKey });
      setMessages((m) => [...m, {
        role: "assistant",
        body: res.answer,
        toolEvents: res.toolEvents,
        navigations: res.navigations,
        pendingAction: res.pendingAction,
      }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", body: "Sorry, I couldn't process that. Please try again." }]);
    } finally {
      setIsLoading(false);
    }
  }

  async function runPending(index: number, action: PendingAction) {
    setIsLoading(true);
    try {
      const r = await confirm.mutateAsync({ nonce: action.nonce });
      setMessages((m) => m.map((msg, i) => (i === index ? { ...msg, actionResolved: "done" as const } : msg))
        .concat([{ role: "assistant", body: `Done — ${r.summary}.` }]));
    } catch (e: any) {
      setMessages((m) => m.concat([{ role: "assistant", body: `That didn't work: ${e?.message ?? "unknown error"}` }]));
    } finally {
      setIsLoading(false);
    }
  }

  const declinePending = (index: number, action?: PendingAction) => {
    // Consume the proposal server-side too, so "Not now" can never become "yes" later.
    if (action?.nonce) decline.mutate({ nonce: action.nonce });
    setMessages((m) => m.map((msg, i) => (i === index ? { ...msg, actionResolved: "declined" as const } : msg)));
  };

  const reset = () => { setMessages([]); setConversationId(null); setInput(""); };

  return (
    <Shell title="AI Assistant">
      <div data-tour-id="ai-assistant-panel" className="flex flex-col h-full min-h-0">
        {/* compact header */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Sparkles className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">AI Assistant</h1>
          <span className="text-[11px] text-muted-foreground hidden sm:inline">· looks things up, proposes actions, runs them only when you confirm</span>
          <div className="flex-1" />
          {messages.length > 0 && (
            <Button variant="ghost" size="sm" className="h-7 gap-1.5" onClick={reset}><RotateCcw className="size-3.5" /> New chat</Button>
          )}
        </div>

        {/* chat */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 py-6">
            {messages.length === 0 ? (
              <div className="text-center py-10">
                <div className="mx-auto size-12 rounded-xl text-white flex items-center justify-center mb-4 shadow-sm" style={{ backgroundColor: accent }}>
                  <Sparkles className="size-6" />
                </div>
                <h2 className="text-lg font-semibold">Ask the Velocity Assistant</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  It can search your workspace, guide you step-by-step, and take bounded actions — always confirming with you first. It never sends outreach.
                </p>
                <div className="mt-5 grid sm:grid-cols-2 gap-2 text-left">
                  {SUGGESTED.map((p) => (
                    <button
                      key={p}
                      onClick={() => send(p)}
                      className="rounded-lg border bg-card px-3 py-2.5 text-[13px] hover:bg-muted transition-colors"
                      style={{ borderColor: `${accent}3a` }}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((m, i) => (
                  <div key={i} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                    <div
                      className="max-w-[85%] rounded-2xl px-3.5 py-2 text-sm"
                      style={m.role === "user" ? { backgroundColor: accent, color: "white" } : { backgroundColor: "hsl(var(--muted))" }}
                    >
                      {/* what the assistant looked up on the way to this answer */}
                      {m.role === "assistant" && (m.toolEvents?.length ?? 0) > 0 && (
                        <div className="mb-1.5 flex flex-wrap gap-1">
                          {m.toolEvents!.map((t, j) => (
                            <span key={j} className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                              <Wrench className="size-2.5" /> {t.summary}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>
                      {/* in-app links it handed out */}
                      {m.role === "assistant" && (m.navigations?.length ?? 0) > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {m.navigations!.map((n, j) => (
                            <Link key={j} href={n.href} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium hover:bg-background transition-colors" style={{ borderColor: `${accent}55`, color: accent }}>
                              {n.label} <ArrowRight className="size-3" />
                            </Link>
                          ))}
                        </div>
                      )}
                      {/* a proposed action awaiting the human */}
                      {m.role === "assistant" && m.pendingAction && (
                        <div className="mt-2 rounded-lg border bg-background/70 p-2.5" style={{ borderColor: `${accent}55` }}>
                          <div className="flex items-center gap-1.5 text-[12px] font-medium">
                            <ShieldCheck className="size-3.5" style={{ color: accent }} /> Proposed action
                          </div>
                          <p className="mt-1 text-[13px]">{m.pendingAction.description}</p>
                          {m.actionResolved ? (
                            <p className="mt-1.5 text-[11px] text-muted-foreground">{m.actionResolved === "done" ? "Confirmed and run." : "Declined."}</p>
                          ) : (
                            <div className="mt-2 flex gap-2">
                              <Button size="sm" className="h-7 text-[12px]" style={{ backgroundColor: accent }} disabled={isLoading} onClick={() => runPending(i, m.pendingAction!)}>
                                {isLoading ? <Loader2 className="size-3.5 animate-spin" /> : null} Confirm
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 text-[12px]" disabled={isLoading} onClick={() => declinePending(i, m.pendingAction ?? undefined)}>
                                <X className="size-3.5" /> Not now
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {isLoading && (
                  <div className="flex justify-start">
                    <div className="rounded-2xl px-3.5 py-2.5 bg-muted">
                      <div className="flex gap-1">
                        {[0, 150, 300].map((d) => (
                          <span key={d} className="size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: `${d}ms` }} />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </div>

        {/* input */}
        <div className="shrink-0 border-t border-border bg-card/40 px-4 py-3">
          <div className="max-w-2xl mx-auto flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Ask for anything — search, guidance, or an action…"
              rows={1}
              className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 max-h-32"
              style={{ ["--tw-ring-color" as any]: `${accent}66` }}
            />
            <Button onClick={() => send()} disabled={isLoading || !input.trim()} className="gap-1.5" style={{ backgroundColor: accent }}>
              {isLoading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send
            </Button>
          </div>
          <p className="max-w-2xl mx-auto mt-1.5 text-[11px] text-muted-foreground">Actions run only after you confirm, under your own permissions. The assistant cannot send outreach.</p>
        </div>
      </div>
    </Shell>
  );
}
