/**
 * ConversationsV2 — the Engage → "Conversations" surface (/v2/conversations).
 *
 * A unified inbox of inbound email replies with autonomous AI handling. Each
 * reply is classified with the 8-class taxonomy; the per-class action can run
 * automatically. The key autonomous behavior: a positive ("willing to meet")
 * reply spawns a meeting proposal — closing the sequence → reply → meeting loop.
 *
 * Modes (per workspace): Off / Approve (AI classifies + suggests, human applies)
 * / Autonomous (AI classifies AND applies the action). Backed by conversations.*.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { ColorAvatar } from "@/components/usip/ColorAvatar";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  MessageSquare, Inbox, Sparkles, Bot, Zap, Check, CheckCheck, CalendarClock, Mail,
  Link2, CircleDot, Send, Copy, Share2, Phone, PhoneIncoming, PhoneOutgoing, ChevronDown, Settings2,
} from "lucide-react";

type Reply = {
  id: number;
  fromEmail: string;
  fromName?: string | null;
  subject?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  receivedAt?: string | Date | null;
  readAt?: string | Date | null;
  contactId?: number | null;
  leadId?: number | null;
  accountId?: number | null;
  replyClass?: string | null;
  sentiment?: string | null;
  classConfidence?: number | null;
  classReasoning?: string | null;
  suggestedReply?: string | null;
  classifiedAt?: string | Date | null;
  autoActionTaken?: string | null;
  meetingId?: number | null;
  handledAt?: string | Date | null;
  handledBy?: string | null;
};

const CLASS_META: Record<string, { label: string; tone: string }> = {
  willing_to_meet: { label: "Willing to meet", tone: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" },
  follow_up_question: { label: "Question", tone: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
  person_referral: { label: "Referral", tone: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300" },
  out_of_office: { label: "Out of office", tone: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  already_left_company_or_not_right_person: { label: "Wrong person", tone: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
  not_interested: { label: "Not interested", tone: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300" },
  unsubscribe: { label: "Unsubscribe", tone: "bg-rose-200 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200" },
  none_of_the_above: { label: "Other", tone: "bg-secondary text-muted-foreground" },
};

const FILTERS = [
  { value: "all", label: "All replies" },
  { value: "unhandled", label: "Unhandled" },
  { value: "willing_to_meet", label: "Willing to meet" },
  { value: "follow_up_question", label: "Questions" },
  { value: "not_interested", label: "Not interested" },
  { value: "unsubscribe", label: "Unsubscribe" },
  { value: "out_of_office", label: "Out of office" },
];

const MODE_META: Record<string, { label: string; blurb: string }> = {
  off: { label: "Autopilot off", blurb: "Replies aren't classified automatically." },
  approval: { label: "Autopilot: Approve", blurb: "AI classifies each reply and suggests an action for you to apply." },
  auto: { label: "Autopilot: Autonomous", blurb: "AI classifies replies and applies the action automatically — a positive reply books a meeting." },
};

function fmtDate(d?: string | Date | null): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function recordHref(r: Reply): string | null {
  if (r.contactId) return `/contacts/${r.contactId}`;
  if (r.leadId) return `/leads/${r.leadId}`;
  if (r.accountId) return `/accounts/${r.accountId}`;
  return null;
}

function ClassChip({ cls }: { cls?: string | null }) {
  if (!cls) return <span className="rounded px-1.5 py-0.5 text-[10px] bg-secondary text-muted-foreground">Unclassified</span>;
  const meta = CLASS_META[cls] ?? CLASS_META.none_of_the_above;
  return <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", meta.tone)}>{meta.label}</span>;
}

function normSocial(m: any): Reply {
  return {
    id: m.id,
    fromEmail: m.senderProviderId || "",
    fromName: m.senderName,
    subject: (m.provider ? String(m.provider) : "linkedin").replace(/^\w/, (c: string) => c.toUpperCase()),
    bodyText: m.text,
    receivedAt: m.createdAt,
    readAt: m.readAt,
    contactId: m.linkedContactId,
    leadId: m.linkedLeadId,
    replyClass: m.replyClass,
    sentiment: m.sentiment,
    classConfidence: m.classConfidence,
    classReasoning: m.classReasoning,
    suggestedReply: null,
    classifiedAt: m.classifiedAt,
    autoActionTaken: m.autoActionTaken,
    meetingId: m.meetingId,
    handledAt: m.handledAt,
  };
}

export default function ConversationsV2() {
  const accent = useAccentColor();
  const utils = trpc.useUtils();
  const [channel, setChannel] = useState<"email" | "social" | "calls">("email");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<Reply | null>(null);
  const isEmail = channel === "email";
  const isCalls = channel === "calls";

  const emailListQ = trpc.conversations.list.useQuery({ filter: filter as any }, { enabled: isEmail });
  const socialListQ = trpc.conversations.socialList.useQuery({ filter: filter as any }, { enabled: !isEmail });
  const emailStatsQ = trpc.conversations.stats.useQuery(undefined, { enabled: isEmail });
  const socialStatsQ = trpc.conversations.socialStats.useQuery(undefined, { enabled: !isEmail });
  const list = isEmail ? emailListQ : socialListQ;
  const stats = isEmail ? emailStatsQ : socialStatsQ;
  const autopilot = trpc.conversations.getAutopilotSettings.useQuery();

  const invalidateAll = () => {
    utils.conversations.list.invalidate();
    utils.conversations.stats.invalidate();
    utils.conversations.socialList.invalidate();
    utils.conversations.socialStats.invalidate();
  };

  const setMode = trpc.conversations.setAutopilotSettings.useMutation({
    onSuccess: () => { utils.conversations.getAutopilotSettings.invalidate(); toast.success("Autopilot updated"); },
    onError: (e) => toast.error(e.message.includes("FORBIDDEN") ? "Only admins can change Autopilot" : e.message),
  });
  const classifyRecent = trpc.conversations.classifyRecent.useMutation({
    onSuccess: (r) => { invalidateAll(); toast.success(r.classified === 0 ? "Nothing new to classify" : `Classified ${r.classified} repl${r.classified === 1 ? "y" : "ies"}`); },
    onError: (e) => toast.error(e.message),
  });

  const mode = autopilot.data?.mode ?? "off";
  const replies = isEmail ? ((list.data ?? []) as Reply[]) : ((list.data ?? []) as any[]).map(normSocial);
  const s = stats.data ?? { total: 0, unhandled: 0, needsClassify: 0, willingToMeet: 0, meetingsProposed: 0 };

  const StatCard = ({ label, value, tone }: { label: string; value: number; tone?: "good" | "ai" | "warn" }) => {
    const color = tone === "good" ? "#059669" : tone === "ai" ? "#7c3aed" : tone === "warn" ? "#d97706" : accent;
    return (
      <div className="rounded-lg border bg-card p-3 shadow-sm" style={{ borderLeft: `3px solid ${color}` }}>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums mt-0.5" style={{ color }}>{value}</div>
      </div>
    );
  };

  return (
    <Shell title="Conversations">
      <div className="flex flex-col h-full min-h-0">
        {/* Header */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <MessageSquare className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Conversations</h1>
          <div className="ml-2 inline-flex rounded-md border bg-card p-0.5">
            {(["email", "social", "calls"] as const).map((c) => (
              <button key={c} onClick={() => { setChannel(c); setFilter("all"); setSelected(null); }}
                className={cn("h-6 px-2.5 rounded text-[12px] font-medium capitalize flex items-center gap-1", channel === c ? "text-white" : "text-muted-foreground hover:text-foreground")}
                style={channel === c ? { backgroundColor: accent } : undefined}>
                {c === "email" ? <Mail className="size-3" /> : c === "social" ? <Share2 className="size-3" /> : <Phone className="size-3" />} {c}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {!isCalls && <div className="flex items-center gap-1.5">
            <Bot className="size-3.5 text-muted-foreground" />
            <Select value={mode} onValueChange={(v) => setMode.mutate({ mode: v as "off" | "approval" | "auto" })}>
              <SelectTrigger className="h-7 w-[168px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Autopilot: Off</SelectItem>
                <SelectItem value="approval">Autopilot: Approve</SelectItem>
                <SelectItem value="auto">Autopilot: Autonomous</SelectItem>
              </SelectContent>
            </Select>
          </div>}
          {isEmail && (
            <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={classifyRecent.isPending} onClick={() => classifyRecent.mutate({ limit: 20 })}>
              <Sparkles className="size-3.5" /> {classifyRecent.isPending ? "Classifying…" : "Classify with AI"}
            </Button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-5">
          {isCalls && <VoiceCallsChannel accent={accent} />}
          {!isCalls && (<>
          {/* Autopilot status strip */}
          <div className="rounded-lg border bg-card px-4 py-2.5 flex items-center gap-3 shadow-sm">
            <span className="shrink-0 size-8 rounded-full flex items-center justify-center" style={{ backgroundColor: mode === "off" ? "hsl(var(--muted))" : "#7c3aed1f", color: mode === "off" ? undefined : "#7c3aed" }}>
              {mode === "auto" ? <Zap className="size-4" /> : <Bot className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{MODE_META[mode]?.label}</div>
              <div className="text-[12px] text-muted-foreground">{MODE_META[mode]?.blurb}</div>
            </div>
            {autopilot.data?.lastRunAt && (
              <div className="shrink-0 text-[11px] text-muted-foreground hidden sm:block">Last run {fmtDate(autopilot.data.lastRunAt)}</div>
            )}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Replies" value={s.total} />
            <StatCard label="Unhandled" value={s.unhandled} tone={s.unhandled ? "warn" : undefined} />
            <StatCard label="Needs classify" value={s.needsClassify} tone={s.needsClassify ? "ai" : undefined} />
            <StatCard label="Willing to meet" value={s.willingToMeet} tone={s.willingToMeet ? "good" : undefined} />
            <StatCard label="Meetings from replies" value={s.meetingsProposed} tone={s.meetingsProposed ? "good" : undefined} />
          </div>

          {/* Filter + list */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold flex items-center gap-2"><Inbox className="size-4" style={{ color: accent }} /> Inbox</h2>
              <Select value={filter} onValueChange={setFilter}>
                <SelectTrigger className="h-7 w-[168px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{FILTERS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
              {list.isLoading ? (
                <div className="p-3 space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-12 rounded bg-muted/50 animate-pulse" />)}</div>
              ) : list.error ? (
                <div className="text-center py-12 px-4">
                  <p className="text-sm text-muted-foreground">Couldn’t load replies. {list.error.message}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => list.refetch()}>Retry</Button>
                </div>
              ) : replies.length === 0 ? (
                <div className="text-center py-14 px-4">
                  <Mail className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
                  <div className="text-sm font-medium">No replies here</div>
                  <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">Inbound replies to your sequences land here. Turn on Autopilot to classify and act on them automatically.</p>
                </div>
              ) : (
                replies.map((r) => {
                  const href = recordHref(r);
                  const unread = !r.readAt;
                  return (
                    <button key={r.id} onClick={() => setSelected(r)}
                      className="w-full text-left flex items-center gap-3 px-3 py-2.5 border-b border-border/60 last:border-0 hover:bg-muted/40">
                      <span className="relative shrink-0">
                        <ColorAvatar name={r.fromName || r.fromEmail} size="size-8" />
                        {unread && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-background" style={{ backgroundColor: accent }} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className={cn("text-sm truncate flex items-center gap-1.5", unread ? "font-semibold" : "font-medium")}>
                          {r.fromName || r.fromEmail}
                          {r.handledAt && <Check className="size-3 shrink-0 text-emerald-500" />}
                        </div>
                        <div className="text-[12px] text-muted-foreground truncate">{r.subject || "(no subject)"} — {(r.bodyText || "").slice(0, 80)}</div>
                      </div>
                      {href && <Link href={href} onClick={(e) => e.stopPropagation()} className="shrink-0 text-muted-foreground hover:text-foreground" title="Open record"><Link2 className="size-3.5" /></Link>}
                      <ClassChip cls={r.replyClass} />
                      {r.meetingId && <span title="Meeting proposed"><CalendarClock className="size-3.5 text-emerald-500 shrink-0" /></span>}
                      <div className="shrink-0 text-[11px] w-24 text-right tabular-nums text-muted-foreground">{fmtDate(r.receivedAt)}</div>
                    </button>
                  );
                })
              )}
            </div>
          </section>
          </>)}
        </div>
      </div>

      {!isCalls && (isEmail
        ? <ReplyDialog key={selected?.id} reply={selected} onClose={() => setSelected(null)} onChanged={invalidateAll} />
        : <SocialDialog key={selected?.id} reply={selected} onClose={() => setSelected(null)} onChanged={invalidateAll} />)}
    </Shell>
  );
}

/**
 * "Calls" channel — Grok voice-agent phone conversations (voice_calls).
 * Inbound call-backs are answered autonomously by the member's agent; the
 * transcript digest recorded by the answer bridge expands inline. Configure
 * agents in Settings → Voice agents; the operational view lives on /v2/calls.
 */
function VoiceCallsChannel({ accent }: { accent: string }) {
  const calls = trpc.voiceAgents.listCalls.useQuery({ limit: 100 });
  const agents = trpc.voiceAgents.list.useQuery();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const rows = (calls.data ?? []) as Record<string, any>[];
  const inbound = rows.filter((r) => r.direction === "inbound").length;
  const completed = rows.filter((r) => r.status === "completed").length;
  const activeAgents = ((agents.data ?? []) as Record<string, any>[]).filter((a) => a.status === "active").length;

  const tone: Record<string, string> = {
    completed: "text-emerald-600 dark:text-emerald-400",
    in_progress: "text-sky-600 dark:text-sky-400",
    ringing: "text-sky-600 dark:text-sky-400",
    failed: "text-rose-600 dark:text-rose-400",
    no_answer: "text-amber-600 dark:text-amber-400",
    queued: "text-muted-foreground",
  };
  const Stat = ({ label, value }: { label: string; value: number }) => (
    <div className="rounded-lg border bg-card p-3 shadow-sm" style={{ borderLeft: `3px solid ${accent}` }}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums mt-0.5" style={{ color: accent }}>{value}</div>
    </div>
  );

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Agent calls" value={rows.length} />
        <Stat label="Inbound call-backs" value={inbound} />
        <Stat label="Completed" value={completed} />
        <Stat label="Active agents" value={activeAgents} />
      </div>

      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold flex items-center gap-2"><Phone className="size-4" style={{ color: accent }} /> Agent calls</h2>
          <Link href="/v2/settings/voice-agents" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground">
            <Settings2 className="size-3.5" /> Manage voice agents
          </Link>
        </div>
        <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
          {calls.isLoading ? (
            <div className="p-3 space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-11 rounded bg-muted/50 animate-pulse" />)}</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-14 px-4">
              <Phone className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
              <div className="text-sm font-medium">No voice-agent calls yet</div>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                When a prospect calls back a registered agent number, the conversation and its transcript
                land here automatically.
              </p>
            </div>
          ) : (
            rows.map((c) => (
              <div key={c.id} className="border-b border-border/60 last:border-0">
                <button
                  type="button"
                  onClick={() => setExpandedId((cur) => (cur === c.id ? null : c.id))}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
                >
                  <span className="shrink-0 size-8 rounded-full flex items-center justify-center" style={{ backgroundColor: `${accent}1f`, color: accent }}>
                    {c.direction === "inbound" ? <PhoneIncoming className="size-4" /> : <PhoneOutgoing className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{c.fromNumber ?? "Unknown caller"}</div>
                    <div className="text-[12px] text-muted-foreground truncate">
                      {c.agentName} · {c.direction === "inbound" ? "inbound call-back" : "outbound"}
                      {c.durationSec != null ? ` · ${Math.floor(c.durationSec / 60)}:${String(c.durationSec % 60).padStart(2, "0")}` : ""}
                    </div>
                  </div>
                  <span className={cn("shrink-0 text-[12px] font-medium capitalize", tone[c.status] ?? "text-muted-foreground")}>
                    {String(c.status).replace("_", " ")}
                  </span>
                  <div className="shrink-0 text-[11px] w-24 text-right tabular-nums text-muted-foreground">{fmtDate(c.createdAt)}</div>
                  <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expandedId === c.id && "rotate-180")} />
                </button>
                {expandedId === c.id && (
                  <div className="border-t border-border/40 bg-muted/30 px-4 py-3">
                    {c.outcome ? (
                      <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-foreground/90">{c.outcome}</pre>
                    ) : (
                      <p className="text-[12px] text-muted-foreground">No transcript recorded for this call.</p>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}

/**
 * Read-only-ish dialog for an inbound SOCIAL message. Classification + any
 * auto-action already happened server-side (webhook → Conversation Autopilot),
 * so this shows the AI verdict and lets the rep mark it read/handled. When a
 * meeting was auto-proposed, a shortcut to the Meetings tab is offered.
 */
function SocialDialog({ reply, onClose, onChanged }: { reply: Reply | null; onClose: () => void; onChanged: () => void }) {
  const markHandled = trpc.conversations.markSocialHandled.useMutation({
    onSuccess: () => { onChanged(); toast.success("Marked handled"); onClose(); },
    onError: (e) => toast.error(e.message),
  });
  if (!reply) return null;
  return (
    <Dialog open={!!reply} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="truncate flex items-center gap-2"><Share2 className="size-4" style={{ color: "#0A66C2" }} /> {reply.fromName || "Social message"}</DialogTitle>
          <DialogDescription>{reply.subject} · {fmtDate(reply.receivedAt)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[52vh] overflow-auto">
          <div className="flex items-center gap-2 flex-wrap">
            <ClassChip cls={reply.replyClass} />
            {typeof reply.classConfidence === "number" && reply.classifiedAt && (
              <span className="text-[11px] text-muted-foreground">{reply.classConfidence}% confidence</span>
            )}
            {reply.autoActionTaken && reply.autoActionTaken !== "none" && (
              <span className="text-[11px] rounded px-1.5 py-0.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">✓ {reply.autoActionTaken.replace(/_/g, " ")}</span>
            )}
          </div>
          {reply.classReasoning && <p className="text-[12px] text-muted-foreground italic">{reply.classReasoning}</p>}
          <div className="rounded-md border bg-muted/30 p-3 text-[13px] whitespace-pre-wrap max-h-52 overflow-auto">
            {reply.bodyText || "(no message text)"}
          </div>
          {reply.meetingId && (
            <Link href="/v2/meetings" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-emerald-600 hover:underline">
              <CalendarClock className="size-3.5" /> Meeting auto-proposed — open Meetings
            </Link>
          )}
        </div>

        <DialogFooter className="flex-wrap gap-2">
          {recordHref(reply) && (
            <Link href={recordHref(reply)!}><Button variant="outline"><Link2 className="size-3.5 mr-1.5" /> Open record</Button></Link>
          )}
          <div className="flex-1" />
          <Button disabled={markHandled.isPending} onClick={() => markHandled.mutate({ id: reply.id })}>
            <CheckCheck className="size-3.5 mr-1.5" /> Mark handled
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReplyDialog({ reply, onClose, onChanged }: { reply: Reply | null; onClose: () => void; onChanged: () => void }) {
  const utils = trpc.useUtils();
  const classify = trpc.conversations.classify.useMutation({
    onSuccess: () => { utils.conversations.list.invalidate(); utils.conversations.stats.invalidate(); onChanged(); },
    onError: (e) => toast.error(e.message),
  });
  const applyAction = trpc.conversations.applyAction.useMutation({
    onSuccess: (r) => {
      onChanged();
      const msg: Record<string, string> = {
        meeting_proposed: "Meeting proposed — see the Meetings tab",
        task_created: "Task created",
        suppressed: "Contact suppressed",
        marked: "Marked",
        ooo_noted: "Noted as out-of-office",
        none: "No action for this reply",
      };
      toast.success(msg[r.action] ?? "Action applied");
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });
  const markHandled = trpc.conversations.markHandled.useMutation({
    onSuccess: () => { onChanged(); toast.success("Marked handled"); onClose(); },
  });
  const [replyText, setReplyText] = useState(reply?.suggestedReply ?? "");
  const draftReply = trpc.conversations.draftReply.useMutation({
    onSuccess: (r: any) => setReplyText(r?.body || ""),
    onError: (e) => toast.error(e.message),
  });

  if (!reply) return null;
  const meta = reply.replyClass ? (CLASS_META[reply.replyClass] ?? CLASS_META.none_of_the_above) : null;

  return (
    <Dialog open={!!reply} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="truncate">{reply.subject || "(no subject)"}</DialogTitle>
          <DialogDescription>
            From {reply.fromName ? `${reply.fromName} <${reply.fromEmail}>` : reply.fromEmail} · {fmtDate(reply.receivedAt)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[52vh] overflow-auto">
          {/* Classification */}
          <div className="flex items-center gap-2 flex-wrap">
            <ClassChip cls={reply.replyClass} />
            {typeof reply.classConfidence === "number" && reply.classifiedAt && (
              <span className="text-[11px] text-muted-foreground">{reply.classConfidence}% confidence</span>
            )}
            {reply.autoActionTaken && reply.autoActionTaken !== "none" && (
              <span className="text-[11px] rounded px-1.5 py-0.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">✓ {reply.autoActionTaken.replace(/_/g, " ")}</span>
            )}
          </div>
          {reply.classReasoning && <p className="text-[12px] text-muted-foreground italic">{reply.classReasoning}</p>}

          {/* Body */}
          <div className="rounded-md border bg-muted/30 p-3 text-[13px] whitespace-pre-wrap max-h-52 overflow-auto">
            {reply.bodyText || "(no plain-text body)"}
          </div>

          {/* AI reply composer */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-medium text-muted-foreground flex items-center gap-1"><Sparkles className="size-3" style={{ color: "#7c3aed" }} /> AI reply</div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" className="h-6 text-[11px] gap-1" disabled={draftReply.isPending} onClick={() => draftReply.mutate({ id: reply.id })}>
                  <Sparkles className="size-3" /> {draftReply.isPending ? "Drafting…" : "Draft with AI"}
                </Button>
                {replyText && (
                  <Button size="sm" variant="ghost" className="h-6 text-[11px] gap-1" onClick={() => { if (navigator?.clipboard) navigator.clipboard.writeText(replyText).then(() => toast.success("Copied")); }}>
                    <Copy className="size-3" /> Copy
                  </Button>
                )}
              </div>
            </div>
            <Textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} rows={4} className="text-[13px]" placeholder="Draft a reply with AI, or write your own…" />
          </div>
        </div>

        <DialogFooter className="flex-wrap gap-2">
          {!reply.classifiedAt ? (
            <Button variant="outline" disabled={classify.isPending} onClick={() => classify.mutate({ id: reply.id })}>
              <Sparkles className="size-3.5 mr-1.5" /> {classify.isPending ? "Classifying…" : "Classify with AI"}
            </Button>
          ) : (
            <Button variant="outline" disabled={classify.isPending} onClick={() => classify.mutate({ id: reply.id })}>Re-classify</Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" disabled={markHandled.isPending} onClick={() => markHandled.mutate({ id: reply.id })}>
            <CheckCheck className="size-3.5 mr-1.5" /> Mark handled
          </Button>
          <Button disabled={applyAction.isPending} onClick={() => applyAction.mutate({ id: reply.id })}>
            {reply.replyClass === "willing_to_meet" ? <CalendarClock className="size-3.5 mr-1.5" /> : <Send className="size-3.5 mr-1.5" />}
            {applyAction.isPending ? "Applying…" : reply.replyClass === "willing_to_meet" ? "Propose meeting" : "Apply action"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
