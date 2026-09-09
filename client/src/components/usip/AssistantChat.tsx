/**
 * AssistantChat — the conversational operator, shared by the full page
 * (/v2/ai-assistant) and the Shell drawer (Ctrl+J / the sparkles button).
 *
 * What it renders per assistant turn:
 *   - the tool chips (what it looked up on the way),
 *   - the answer,
 *   - in-app links it handed out,
 *   - up to three PROPOSED ACTION cards, each confirmed or declined on its
 *     own (assistant.confirmAction / declineAction consume the nonce), and
 *   - a QUESTION with option buttons when the assistant needs a decision —
 *     pressing one sends it as the next user message (ask_user tool).
 *
 * The conversation lives in lib/assistantStore so it follows the user from
 * page to page. `pageKey` is the page the user is on right now; the server
 * uses it to interpret "this page" and to pick suggestions.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { useAccentColor } from "@/components/usip/Shell";
import { assistantStore, useAssistantStore, type AssistantMessage, type PendingAction } from "@/lib/assistantStore";
import { Sparkles, Send, Loader2, RotateCcw, Wrench, ArrowRight, ShieldCheck, X, Compass } from "lucide-react";
import { toast } from "sonner";

/** Page-aware starters, so the drawer is useful the moment it opens. */
export function suggestionsFor(pageKey: string | undefined): string[] {
  const base = ["What should I do next?", "What's waiting on me today?"];
  const byPage: Record<string, string[]> = {
    home: ["Walk me through today's queue", "Recommend what to focus on this week"],
    dashboard: ["Which deals need attention?", "Summarise the pipeline for me"],
    people: ["Build a list of the best-fit people with valid emails", "Add everyone at a company to a campaign"],
    companies: ["Which companies have no domain?", "Find duplicates"],
    leads: ["Which leads are new for more than 2 days?", "Convert my hottest lead"],
    deals: ["Which deals are stuck?", "Move a deal to the next stage"],
    tasks: ["What's overdue?", "Queue calls for my newest prospects"],
    sequences: ["Create a 5-step sequence for CFOs", "Enroll a batch of people by criteria"],
    "are-campaigns": ["Which campaign should I prioritise?", "Add people to a campaign by criteria"],
    are: ["How are the campaigns performing?", "Should I raise a campaign's daily cap?"],
    conversations: ["Which replies should I answer first?", "Draft a reply to the latest question"],
    meetings: ["Propose meetings for my best-fit prospects", "Which proposals have expired?"],
    reports: ["Run a report of open deals by stage", "Save a weekly leads report"],
    workflows: ["Which dial should I promote to Auto?", "Explain the autopilots"],
  };
  return [...base, ...(byPage[pageKey ?? ""] ?? ["Explain this page", "Recommend my next action here"])].slice(0, 4);
}

export function AssistantChat({ pageKey, compact = false }: { pageKey?: string; compact?: boolean }) {
  const accent = useAccentColor();
  const { conversationId, messages, loading } = useAssistantStore();
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const startConv = trpc.helpCenter.startConversation.useMutation({ onError: (e) => toast.error(e.message) });
  const chat = trpc.assistant.chat.useMutation({ onError: (e) => toast.error(e.message) });
  const confirm = trpc.assistant.confirmAction.useMutation({ onError: (e) => toast.error(e.message) });
  const decline = trpc.assistant.declineAction.useMutation({ meta: { silentError: true } });

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  async function send(override?: string) {
    const userMsg = (override ?? input).trim();
    if (!userMsg || loading) return;
    setInput("");
    // A typed reply (or a picked option) answers any open question.
    const last = messages.length - 1;
    if (last >= 0 && messages[last].question && !messages[last].answered) assistantStore.update(last, { answered: true });
    assistantStore.push({ role: "user", body: userMsg });
    assistantStore.setLoading(true);
    try {
      let convId = conversationId;
      if (!convId) {
        const res = await startConv.mutateAsync();
        convId = res.conversationId;
        assistantStore.setConversationId(convId);
      }
      const res = await chat.mutateAsync({ conversationId: convId, message: userMsg, pageKey });
      const r = res as typeof res & { pendingActions?: PendingAction[]; question?: { text: string; options: string[] } | null };
      assistantStore.push({
        role: "assistant",
        body: r.answer,
        toolEvents: r.toolEvents,
        navigations: r.navigations,
        pendingActions: r.pendingActions ?? (r.pendingAction ? [r.pendingAction] : []),
        question: r.question ?? null,
      });
    } catch {
      assistantStore.push({ role: "assistant", body: "Sorry, I couldn't process that. Please try again." });
    } finally {
      assistantStore.setLoading(false);
    }
  }

  async function runPending(index: number, action: PendingAction) {
    assistantStore.setLoading(true);
    try {
      const r = await confirm.mutateAsync({ nonce: action.nonce });
      const m = assistantStore.get().messages[index];
      assistantStore.update(index, { resolved: { ...(m?.resolved ?? {}), [action.nonce]: "done" } });
      assistantStore.push({ role: "assistant", body: `Done — ${r.summary}.` });
    } catch (e: any) {
      assistantStore.push({ role: "assistant", body: `That didn't work: ${e?.message ?? "unknown error"}` });
    } finally {
      assistantStore.setLoading(false);
    }
  }
  const declinePending = (index: number, action: PendingAction) => {
    decline.mutate({ nonce: action.nonce });
    const m = assistantStore.get().messages[index];
    assistantStore.update(index, { resolved: { ...(m?.resolved ?? {}), [action.nonce]: "declined" } });
  };

  const suggestions = suggestionsFor(pageKey);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className={`${compact ? "px-3 py-4" : "max-w-2xl mx-auto px-4 py-6"}`}>
          {messages.length === 0 ? (
            <div className={`text-center ${compact ? "py-4" : "py-10"}`}>
              <div className="mx-auto size-11 rounded-xl text-white flex items-center justify-center mb-3 shadow-sm" style={{ backgroundColor: accent }}>
                <Sparkles className="size-5" />
              </div>
              <h2 className="text-base font-semibold">{compact ? "What can I do for you?" : "Ask the Velocity Assistant"}</h2>
              <p className="text-[13px] text-muted-foreground mt-1">
                Ask anything, or tell me what you want done — I look things up, recommend, ask when I need a decision, and run actions only when you confirm.
              </p>
              <div className={`mt-4 grid ${compact ? "grid-cols-1" : "sm:grid-cols-2"} gap-2 text-left`}>
                {suggestions.map((p) => (
                  <button key={p} onClick={() => send(p)} className="rounded-lg border bg-card px-3 py-2 text-[13px] hover:bg-muted transition-colors flex items-center gap-2" style={{ borderColor: `${accent}3a` }}>
                    {p === "What should I do next?" ? <Compass className="size-3.5 shrink-0" style={{ color: accent }} /> : null}{p}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((m, i) => (
                <MessageRow key={i} m={m} index={i} accent={accent} loading={loading}
                  onConfirm={runPending} onDecline={declinePending} onPick={(opt) => send(opt)} />
              ))}
              {loading && (
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
      <div className="shrink-0 border-t border-border bg-card/40 px-3 py-2.5">
        <div className={`${compact ? "" : "max-w-2xl mx-auto"} flex items-end gap-2`}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder="Ask, or say what you want done…"
            rows={1}
            className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 max-h-32"
            style={{ ["--tw-ring-color" as any]: `${accent}66` }}
          />
          <Button onClick={() => send()} disabled={loading || !input.trim()} className="gap-1.5" style={{ backgroundColor: accent }}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}{compact ? null : " Send"}
          </Button>
          {messages.length > 0 && (
            <Button variant="ghost" size="icon" className="size-9 shrink-0" title="New chat" onClick={() => assistantStore.reset()}><RotateCcw className="size-4" /></Button>
          )}
        </div>
        <p className={`${compact ? "" : "max-w-2xl mx-auto"} mt-1 text-[11px] text-muted-foreground`}>Actions run only after you confirm, under your own permissions. Cards that send email say so.</p>
      </div>
    </div>
  );
}

function MessageRow({ m, index, accent, loading, onConfirm, onDecline, onPick }: {
  m: AssistantMessage; index: number; accent: string; loading: boolean;
  onConfirm: (i: number, a: PendingAction) => void; onDecline: (i: number, a: PendingAction) => void; onPick: (opt: string) => void;
}) {
  return (
    <div className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
      <div className="max-w-[92%] rounded-2xl px-3.5 py-2 text-sm" style={m.role === "user" ? { backgroundColor: accent, color: "white" } : { backgroundColor: "hsl(var(--muted))" }}>
        {m.role === "assistant" && (m.toolEvents?.length ?? 0) > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {m.toolEvents!.map((t, j) => (
              <span key={j} className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground"><Wrench className="size-2.5" /> {t.summary}</span>
            ))}
          </div>
        )}
        <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>
        {m.role === "assistant" && (m.navigations?.length ?? 0) > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.navigations!.map((n, j) => (
              <Link key={j} href={n.href} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] font-medium hover:bg-background transition-colors" style={{ borderColor: `${accent}55`, color: accent }}>
                {n.label} <ArrowRight className="size-3" />
              </Link>
            ))}
          </div>
        )}
        {m.role === "assistant" && (m.pendingActions ?? []).map((a) => {
          const state = m.resolved?.[a.nonce];
          return (
            <div key={a.nonce} className="mt-2 rounded-lg border bg-background/70 p-2.5" style={{ borderColor: `${accent}55` }}>
              <div className="flex items-center gap-1.5 text-[12px] font-medium"><ShieldCheck className="size-3.5" style={{ color: accent }} /> Proposed action</div>
              <p className="mt-1 text-[13px]">{a.description}</p>
              {state ? (
                <p className="mt-1.5 text-[11px] text-muted-foreground">{state === "done" ? "Confirmed and run." : "Declined."}</p>
              ) : (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" className="h-7 text-[12px]" style={{ backgroundColor: accent }} disabled={loading} onClick={() => onConfirm(index, a)}>
                    {loading ? <Loader2 className="size-3.5 animate-spin" /> : null} Confirm
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 text-[12px]" disabled={loading} onClick={() => onDecline(index, a)}><X className="size-3.5" /> Not now</Button>
                </div>
              )}
            </div>
          );
        })}
        {m.role === "assistant" && m.question && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.question.options.map((opt) => (
              <button key={opt} type="button" disabled={loading || m.answered}
                onClick={() => onPick(opt)}
                className="rounded-full border px-2.5 py-1 text-[12px] font-medium hover:bg-background transition-colors disabled:opacity-50"
                style={{ borderColor: `${accent}66`, color: m.answered ? undefined : accent }}>
                {opt}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
