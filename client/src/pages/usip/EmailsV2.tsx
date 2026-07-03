/**
 * EmailsV2 — the Engage → "Emails" surface (/v2/emails).
 *
 * The outbound email activity log (AI-drafted + sequence emails) with delivery
 * signals (opens/clicks/bounces), plus the autonomous **AI auto-send** control:
 * when enabled, high-scoring AI drafts send themselves without review. Reuses
 * the existing emailDrafts + emailAutoSend routers — no new backend.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Mail, Send, Check, X, Bot, Zap, MailOpen, MousePointerClick, AlertTriangle, Clock,
} from "lucide-react";

type Draft = {
  id: number;
  subject?: string | null;
  toEmail?: string | null;
  toContactId?: number | null;
  status: string;
  sentAt?: string | Date | null;
  openCount?: number | null;
  clickCount?: number | null;
  bouncedAt?: string | Date | null;
  bounceType?: string | null;
  createdAt?: string | Date | null;
};

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "sent", label: "Sent" },
  { value: "pending_review", label: "Needs review" },
  { value: "approved", label: "Approved" },
  { value: "bounced", label: "Bounced" },
];

const STATUS_TONE: Record<string, string> = {
  sent: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  pending_review: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  ai_pending_review: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  approved: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  rejected: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
};

function fmt(d?: string | Date | null): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export default function EmailsV2() {
  const accent = useAccentColor();
  const utils = trpc.useUtils();
  const [tab, setTab] = useState("all");

  const list = trpc.emailDrafts.list.useQuery({} as any, { retry: false });
  const settings = trpc.emailAutoSend.getAutoSendSettings.useQuery(undefined as any, { retry: false });

  const invalidate = () => utils.emailDrafts.list.invalidate();
  const approve = trpc.emailDrafts.approve.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const reject = trpc.emailDrafts.reject.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const send = trpc.emailDrafts.send.useMutation({ onSuccess: () => { invalidate(); toast.success("Email sent"); }, onError: (e) => toast.error(e.message) });
  const updateSettings = trpc.emailAutoSend.updateAutoSendSettings.useMutation({
    onSuccess: () => { utils.emailAutoSend.getAutoSendSettings.invalidate(); toast.success("Auto-send updated"); },
    onError: (e) => toast.error(e.message.includes("FORBIDDEN") ? "Only admins can change auto-send" : e.message),
  });

  const s = settings.data as any;
  const drafts = (list.data as Draft[]) ?? [];

  const filtered = useMemo(() => {
    if (tab === "all") return drafts;
    if (tab === "bounced") return drafts.filter((d) => d.bouncedAt);
    return drafts.filter((d) => d.status === tab);
  }, [drafts, tab]);

  const stats = useMemo(() => {
    const sent = drafts.filter((d) => d.status === "sent");
    const opens = sent.filter((d) => (d.openCount ?? 0) > 0).length;
    const clicks = sent.filter((d) => (d.clickCount ?? 0) > 0).length;
    const bounced = drafts.filter((d) => d.bouncedAt).length;
    const pending = drafts.filter((d) => d.status === "pending_review" || d.status === "ai_pending_review").length;
    return {
      sent: sent.length, pending, bounced,
      openRate: sent.length ? Math.round((opens / sent.length) * 100) : 0,
      clickRate: sent.length ? Math.round((clicks / sent.length) * 100) : 0,
    };
  }, [drafts]);

  const toggleAutoSend = (enabled: boolean) => {
    updateSettings.mutate({
      aiAutoSendEnabled: enabled,
      aiAutoSendScoreMin: s?.aiAutoSendScoreMin ?? 70,
      aiAutoSendConfidenceMin: s?.aiAutoSendConfidenceMin ?? 75,
      aiAutoSendAllowUnscored: s?.aiAutoSendAllowUnscored ?? false,
    } as any);
  };

  const StatCard = ({ label, value, tone }: { label: string; value: string | number; tone?: "good" | "warn" | "danger" }) => {
    const color = tone === "good" ? "#059669" : tone === "warn" ? "#d97706" : tone === "danger" ? "#e11d48" : accent;
    return (
      <div className="rounded-lg border bg-card p-3 shadow-sm" style={{ borderLeft: `3px solid ${color}` }}>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums mt-0.5" style={{ color }}>{value}</div>
      </div>
    );
  };

  return (
    <Shell title="Emails">
      <div className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Mail className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Emails</h1>
          <div className="flex-1" />
          <Select value={tab} onValueChange={setTab}>
            <SelectTrigger className="h-7 w-[140px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{STATUS_TABS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-5">
          {/* AI auto-send control */}
          <div className="rounded-lg border bg-card px-4 py-3 flex items-center gap-3 shadow-sm">
            <span className="shrink-0 size-8 rounded-full flex items-center justify-center" style={{ backgroundColor: s?.aiAutoSendEnabled ? "#7c3aed1f" : "hsl(var(--muted))", color: s?.aiAutoSendEnabled ? "#7c3aed" : undefined }}>
              {s?.aiAutoSendEnabled ? <Zap className="size-4" /> : <Bot className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Autonomous AI auto-send</div>
              <div className="text-[12px] text-muted-foreground">
                {s?.aiAutoSendEnabled
                  ? `On — AI drafts send automatically when lead score ≥ ${s?.aiAutoSendScoreMin ?? 70} and confidence ≥ ${s?.aiAutoSendConfidenceMin ?? 75}%.`
                  : "Off — AI drafts wait for your approval before sending."}
              </div>
            </div>
            <Switch checked={!!s?.aiAutoSendEnabled} onCheckedChange={toggleAutoSend} disabled={updateSettings.isPending || !settings.data} />
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Sent" value={stats.sent} tone="good" />
            <StatCard label="Open rate" value={`${stats.openRate}%`} />
            <StatCard label="Click rate" value={`${stats.clickRate}%`} />
            <StatCard label="Needs review" value={stats.pending} tone={stats.pending ? "warn" : undefined} />
            <StatCard label="Bounced" value={stats.bounced} tone={stats.bounced ? "danger" : undefined} />
          </div>

          {/* Email log */}
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            {list.isLoading ? (
              <div className="p-3 space-y-2">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-11 rounded bg-muted/50 animate-pulse" />)}</div>
            ) : list.error ? (
              <div className="text-center py-12 px-4">
                <p className="text-sm text-muted-foreground">Couldn’t load emails. {list.error.message}</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => list.refetch()}>Retry</Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-14 px-4">
                <Mail className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
                <div className="text-sm font-medium">No emails here</div>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">AI-drafted and sequence emails appear here. Turn on auto-send to let high-confidence drafts go out on their own.</p>
              </div>
            ) : (
              filtered.map((d) => {
                const pending = d.status === "pending_review" || d.status === "ai_pending_review";
                return (
                  <div key={d.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <span className="shrink-0 size-7 rounded-full flex items-center justify-center" style={{ backgroundColor: `${accent}1f`, color: accent }}>
                      {d.bouncedAt ? <AlertTriangle className="size-3.5 text-rose-500" /> : d.status === "sent" ? <Send className="size-3.5" /> : <Clock className="size-3.5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{d.subject || "(no subject)"}</div>
                      <div className="text-[11px] text-muted-foreground truncate">{d.toEmail || "unknown recipient"} · {d.sentAt ? `sent ${fmt(d.sentAt)}` : fmt(d.createdAt)}</div>
                    </div>
                    {d.status === "sent" && (
                      <div className="hidden sm:flex items-center gap-2 text-[11px] text-muted-foreground shrink-0">
                        <span className="inline-flex items-center gap-0.5" title="Opens"><MailOpen className="size-3" /> {d.openCount ?? 0}</span>
                        <span className="inline-flex items-center gap-0.5" title="Clicks"><MousePointerClick className="size-3" /> {d.clickCount ?? 0}</span>
                      </div>
                    )}
                    <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", d.bouncedAt ? STATUS_TONE.rejected : (STATUS_TONE[d.status] ?? "bg-secondary text-muted-foreground"))}>
                      {d.bouncedAt ? `bounced${d.bounceType ? ` · ${d.bounceType}` : ""}` : d.status.replace(/_/g, " ")}
                    </span>
                    {pending && (
                      <div className="flex items-center gap-1 shrink-0">
                        <Button size="sm" variant="outline" className="h-7 gap-1" disabled={send.isPending} onClick={() => send.mutate({ id: d.id })}><Send className="size-3.5" /> Send</Button>
                        <Button size="icon" variant="ghost" className="size-7" title="Approve" onClick={() => approve.mutate({ id: d.id })}><Check className="size-4 text-emerald-500" /></Button>
                        <Button size="icon" variant="ghost" className="size-7" title="Reject" onClick={() => reject.mutate({ id: d.id })}><X className="size-4 text-muted-foreground" /></Button>
                      </div>
                    )}
                    {d.status === "approved" && (
                      <Button size="sm" variant="outline" className="h-7 gap-1 shrink-0" disabled={send.isPending} onClick={() => send.mutate({ id: d.id })}><Send className="size-3.5" /> Send</Button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}
