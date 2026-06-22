/**
 * AIAssistant — the "AI Assistant" top-nav surface (/v2/ai-assistant).
 *
 * A full-page conversational assistant grounded in the workspace's Help
 * articles. Tied to the existing helpCenter chat backend:
 *   - helpCenter.startConversation → { conversationId }
 *   - helpCenter.askAI            → { answer, citedArticleIds, confidence }
 * (the same endpoints the in-app Help drawer uses), so this is a real,
 * working assistant rather than a placeholder.
 */
import { useEffect, useRef, useState } from "react";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Sparkles, Send, Loader2, RotateCcw, BookOpen } from "lucide-react";

type Message = { role: "user" | "assistant"; body: string; citedArticleIds?: number[]; confidence?: number };

const SUGGESTED = [
  "How do I enroll prospects into a sequence?",
  "What's a good SDR morning routine?",
  "How does the pipeline board work?",
  "How do I work the Needs Review queue?",
];

export default function AIAssistant() {
  const accent = useAccentColor();
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const startConv = trpc.helpCenter.startConversation.useMutation();
  const askAI = trpc.helpCenter.askAI.useMutation();

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
      const res = await askAI.mutateAsync({ conversationId: convId, message: userMsg });
      setMessages((m) => [...m, { role: "assistant", body: res.answer, citedArticleIds: res.citedArticleIds, confidence: res.confidence }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", body: "Sorry, I couldn't process that. Please try again." }]);
    } finally {
      setIsLoading(false);
    }
  }

  const reset = () => { setMessages([]); setConversationId(null); setInput(""); };

  return (
    <Shell title="AI Assistant">
      <div className="flex flex-col h-full min-h-0">
        {/* compact header */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Sparkles className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">AI Assistant</h1>
          <span className="text-[11px] text-muted-foreground hidden sm:inline">· grounded in your Help Center</span>
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
                <p className="text-sm text-muted-foreground mt-1">Your in-app coach — answers grounded in the Help Center, with sources.</p>
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
                      <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>
                      {m.role === "assistant" && (m.citedArticleIds?.length || m.confidence != null) && (
                        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                          {m.citedArticleIds && m.citedArticleIds.length > 0 && (
                            <span className="inline-flex items-center gap-1"><BookOpen className="size-3" /> {m.citedArticleIds.length} source{m.citedArticleIds.length > 1 ? "s" : ""}</span>
                          )}
                          {m.confidence != null && <span>· {m.confidence}% confidence</span>}
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
              placeholder="Ask anything about using Velocity…"
              rows={1}
              className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 max-h-32"
              style={{ ["--tw-ring-color" as any]: `${accent}66` }}
            />
            <Button onClick={() => send()} disabled={isLoading || !input.trim()} className="gap-1.5" style={{ backgroundColor: accent }}>
              {isLoading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Send
            </Button>
          </div>
          <p className="max-w-2xl mx-auto mt-1.5 text-[11px] text-muted-foreground">Answers are grounded in your Help Center articles and may be imperfect.</p>
        </div>
      </div>
    </Shell>
  );
}
