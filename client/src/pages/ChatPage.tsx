/**
 * ChatPage — the public inbound chat agent at /c/:slug.
 *
 * Standalone and unauthenticated: it renders full-screen on its own, and drops
 * its own header when embedded in an iframe (the host page already frames it).
 *
 * Every turn posts to chatAgents.send, which may come back with real bookable
 * slots. When it does the visitor picks one and books straight from the chat —
 * the meeting lands on a rep's calendar without anyone at the company touching
 * it. If we still don't have an email by then, the confirm step asks for it
 * rather than failing at the booking call.
 */
import { useEffect, useRef, useState } from "react";
import { useRoute } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Send, CalendarCheck, CheckCircle2, MessageSquare } from "lucide-react";

type Msg = { role: "visitor" | "agent"; text: string };

const isEmbedded = () => {
  try { return window.self !== window.top; } catch { return true; }
};

export default function ChatPage() {
  const [, params] = useRoute("/c/:slug");
  const slug = params?.slug ?? "";
  const embedded = isEmbedded();

  const agent = trpc.chatAgents.getPublic.useQuery({ slug }, { enabled: !!slug, retry: false });
  const send = trpc.chatAgents.send.useMutation();
  const book = trpc.chatAgents.book.useMutation();

  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [token, setToken] = useState<string | undefined>(undefined);
  const [slots, setSlots] = useState<string[]>([]);
  const [durationMin, setDurationMin] = useState(30);
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [bookedAt, setBookedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  const accent = agent.data?.themeColor || "#14B89A";

  // Seed the transcript with the configured greeting once the agent loads.
  useEffect(() => {
    if (agent.data && messages.length === 0) {
      setMessages([{ role: "agent", text: agent.data.greeting }]);
    }
  }, [agent.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, slots, bookedAt]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || send.isPending) return;
    setDraft("");
    setError(null);
    setMessages((m) => [...m, { role: "visitor", text }]);
    send.mutate({ slug, token, message: text }, {
      onSuccess: (r: any) => {
        setToken(r.token);
        setMessages((m) => [...m, { role: "agent", text: r.reply }]);
        setSlots(Array.isArray(r.slots) ? r.slots : []);
        if (r.durationMin) setDurationMin(r.durationMin);
      },
      onError: (err: any) => setError(err?.message ?? "Something went wrong — please try again."),
    });
  };

  const confirmBooking = () => {
    if (!picked || !token) return;
    setError(null);
    book.mutate(
      { token, startAt: picked, name: name.trim() || undefined, email: email.trim() || undefined },
      {
        onSuccess: (r: any) => {
          setBookedAt(r.scheduledAt);
          setSlots([]);
          setPicked(null);
        },
        onError: (err: any) => setError(err?.message ?? "That time couldn't be booked — please pick another."),
      },
    );
  };

  const slotLabel = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  if (agent.isLoading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground"><Loader2 className="size-6 animate-spin" /></div>;
  }
  if (!agent.data) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div>
          <MessageSquare className="size-8 mx-auto text-muted-foreground opacity-40 mb-3" />
          <div className="text-base font-semibold">Chat unavailable</div>
          <p className="text-sm text-muted-foreground mt-1">This chat may be turned off or removed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background">
      {!embedded && (
        <header className="shrink-0 flex items-center gap-2.5 px-4 h-14 border-b border-border">
          <div className="size-8 rounded-full flex items-center justify-center text-white shrink-0" style={{ backgroundColor: accent }}>
            <MessageSquare className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{agent.data.displayName}</div>
            <div className="text-[11px] text-muted-foreground">Usually replies instantly</div>
          </div>
        </header>
      )}

      {/* Transcript */}
      <div className="flex-1 min-h-0 overflow-auto px-4 py-4 space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "visitor" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap ${
                m.role === "visitor" ? "text-white rounded-br-sm" : "bg-muted rounded-bl-sm"
              }`}
              style={m.role === "visitor" ? { backgroundColor: accent } : undefined}
            >
              {m.text}
            </div>
          </div>
        ))}

        {send.isPending && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-2xl rounded-bl-sm px-3.5 py-2.5">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}

        {/* Real availability, offered by the agent itself */}
        {slots.length > 0 && !bookedAt && (
          <div className="rounded-xl border border-border bg-card p-3 space-y-2.5">
            <div className="flex items-center gap-1.5 text-[13px] font-semibold">
              <CalendarCheck className="size-4" style={{ color: accent }} />
              Pick a time ({durationMin} min)
            </div>
            <div className="grid grid-cols-2 gap-2">
              {slots.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setPicked(s)}
                  className={`text-[12px] rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    picked === s ? "text-white border-transparent" : "hover:bg-muted"
                  }`}
                  style={picked === s ? { backgroundColor: accent } : undefined}
                >
                  {slotLabel(s)}
                </button>
              ))}
            </div>
            {picked && (
              <div className="space-y-2 pt-1">
                <Input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
                <Input placeholder="Work email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-9" />
                <Button
                  className="w-full h-9 text-white"
                  style={{ backgroundColor: accent }}
                  disabled={book.isPending}
                  onClick={confirmBooking}
                >
                  {book.isPending ? <Loader2 className="size-4 animate-spin" /> : `Book ${slotLabel(picked)}`}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Leave the fields blank to use the details you've already given me.
                </p>
              </div>
            )}
          </div>
        )}

        {bookedAt && (
          <div className="rounded-xl border p-3 flex items-start gap-2.5" style={{ borderColor: accent }}>
            <CheckCircle2 className="size-5 shrink-0" style={{ color: accent }} />
            <div>
              <div className="text-[13px] font-semibold">You're booked</div>
              <p className="text-[12px] text-muted-foreground mt-0.5">
                {new Date(bookedAt).toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })}
                {" — a calendar invite is on its way."}
              </p>
            </div>
          </div>
        )}

        {error && <p className="text-[12px] text-rose-600 text-center">{error}</p>}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <form onSubmit={submit} className="shrink-0 border-t border-border p-3 flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={bookedAt ? "Anything else?" : "Type your message…"}
          className="h-10"
          autoFocus={!embedded}
        />
        <Button type="submit" size="icon" className="size-10 shrink-0 text-white" style={{ backgroundColor: accent }} disabled={send.isPending || !draft.trim()}>
          <Send className="size-4" />
        </Button>
      </form>
    </div>
  );
}
