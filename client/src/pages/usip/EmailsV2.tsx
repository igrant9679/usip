/**
 * EmailsV2 — the Engage → "Emails" surface (/v2/emails).
 *
 * Every email this workspace sends or receives, in one log, whichever part of
 * the product produced it: ARE Hub campaign steps, sequence steps, ad-hoc CRM
 * sends, AI drafts awaiting review, Inbox composes and replies, proposal mail,
 * system notifications, and inbound replies.
 *
 * It used to read `emailDrafts.list` alone. That table holds CRM ad-hoc sends
 * and AI drafts — so ARE campaign mail (which lives on are_execution_queue)
 * was missing entirely, and Inbox composes, proposal mail and transactional
 * mail were recorded nowhere at all. The page's own help text promised
 * "everything that went out, what it was part of, and what came back", and
 * showed a minority of it (owner ask 2026-08-14).
 *
 * The feed comes from `emailActivity.list`, which merges four sources with
 * every filter applied in SQL. Filters here are QUERY INPUT, never a
 * `.filter()` over the rows already fetched — filtering an already-limited
 * page is what emptied the ARE Active tab.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Mail, Send, Check, X, Bot, Zap, MailOpen, MousePointerClick, AlertTriangle, Clock,
  Search, Inbox, Megaphone, ListOrdered, User, FileText, Bell, CornerUpLeft, CalendarClock,
  ExternalLink, Ban,
} from "lucide-react";
import { EMAIL_SOURCES, emailSourceLabel, type EmailFeedRow } from "@shared/emailActivity";

/* ─── vocabulary ───────────────────────────────────────────────────────────── */

const DIRECTIONS = [
  { value: "all", label: "All mail" },
  { value: "outbound", label: "Outbound" },
  { value: "inbound", label: "Inbound" },
];

const STATUSES = [
  { value: "all", label: "Any status" },
  { value: "sent", label: "Sent" },
  { value: "engaged", label: "Opened or clicked" },
  { value: "awaiting", label: "Needs review" },
  { value: "scheduled", label: "Scheduled" },
  { value: "failed", label: "Failed" },
  { value: "bounced", label: "Bounced" },
  { value: "received", label: "Received" },
];

const SOURCE_ICON: Record<string, React.ElementType> = {
  campaign: Megaphone,
  sequence: ListOrdered,
  crm: User,
  ai_draft: Bot,
  mailbox: Mail,
  proposal: FileText,
  transactional: Bell,
  test: Zap,
  other: Mail,
  inbound: CornerUpLeft,
};

const STATUS_TONE: Record<string, string> = {
  sent: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  received: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
  pending_review: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  ai_pending_review: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  approved: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  rejected: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  failed: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  bounced: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  scheduled: "bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300",
  paused: "bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300",
  skipped: "bg-slate-100 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300",
};

function fmt(d?: string | Date | null): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Full date, time and zone — the tooltip half of "when". */
function fmtExact(d?: string | Date | null): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
  });
}

function statusLabel(row: EmailFeedRow): string {
  if (row.status === "bounced") return `bounced${row.bounceType ? ` · ${row.bounceType}` : ""}`;
  return row.status.replace(/_/g, " ");
}

/* ─── detail drawer ────────────────────────────────────────────────────────── */

function EmailDetail({ row, onClose }: { row: EmailFeedRow | null; onClose: () => void }) {
  const detail = trpc.emailActivity.get.useQuery(
    { kind: (row?.kind ?? "log") as "log" | "draft" | "queued" | "inbound", id: row?.id ?? 0 },
    { enabled: !!row, retry: false },
  );
  const d = (detail.data ?? null) as Record<string, any> | null;

  const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="grid grid-cols-[110px_1fr] gap-2 text-xs py-1 border-b border-border/40 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );

  return (
    <Sheet open={!!row} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-base pr-6 break-words">{row?.subject || "(no subject)"}</SheetTitle>
        </SheetHeader>
        {!row ? null : (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border bg-card p-3">
              <Fact label={row.direction === "inbound" ? "From" : "To"}>
                {row.direction === "inbound" ? (row.fromEmail ?? "—") : (row.toEmail ?? "—")}
              </Fact>
              {row.direction === "inbound" ? null : (
                <Fact label="Sent from">
                  {d?.accountEmail || row.fromEmail ? (
                    <>
                      {d?.accountEmail || row.fromEmail}
                      {d?.accountName ? <span className="text-muted-foreground"> · {d.accountName}</span> : null}
                    </>
                  ) : (
                    /* The sender pool picks a mailbox per send and nothing
                       stored the choice until migration 0166, so past campaign
                       sends genuinely cannot say which of several inboxes went
                       out. A dash reads as "no sender"; this says why. */
                    <span
                      className="text-muted-foreground italic"
                      title="The sending mailbox wasn't recorded for messages sent before Velocity started storing it."
                    >
                      Not recorded for this send
                    </span>
                  )}
                </Fact>
              )}
              <Fact label="Source">
                {emailSourceLabel(row.source)}
                {row.sourceLabel ? <span className="text-muted-foreground"> · {row.sourceLabel}</span> : null}
                {row.stepIndex != null ? <span className="text-muted-foreground"> · Step {row.stepIndex + 1}</span> : null}
              </Fact>
              <Fact label="Status">
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", STATUS_TONE[row.status] ?? "bg-secondary")}>
                  {statusLabel(row)}
                </span>
              </Fact>
              <Fact label={row.direction === "inbound" ? "Received" : row.status === "scheduled" ? "Scheduled" : "Sent"}>
                <span title={fmtExact(row.at)}>{fmt(row.at)}</span>
              </Fact>
              {d?.userName ? <Fact label="Triggered by">{d.userName}</Fact> : null}
              {row.direction === "outbound" && !d?.userName && row.kind !== "draft" ? (
                <Fact label="Triggered by"><span className="text-muted-foreground">Velocity (autonomous)</span></Fact>
              ) : null}
              {row.failureReason ? (
                <Fact label="Failure">
                  <span className="text-rose-600 dark:text-rose-400">{row.failureReason}</span>
                </Fact>
              ) : null}
              {row.direction === "outbound" && row.status === "sent" ? (
                <Fact label="Engagement">
                  {row.openCount > 0 || row.openedAt ? `${row.openCount || 1} open${row.openCount === 1 ? "" : "s"}` : "No opens"}
                  {row.clickCount > 0 ? ` · ${row.clickCount} click${row.clickCount === 1 ? "" : "s"}` : ""}
                  {row.repliedAt ? ` · replied ${fmt(row.repliedAt)}` : ""}
                  {row.bouncedAt ? ` · bounced ${fmt(row.bouncedAt)}` : ""}
                </Fact>
              ) : null}
            </div>

            {/* Every record this email belongs to. */}
            {(row.campaignId || row.contactId || row.leadId || row.draftId || row.executionQueueId) && (
              <div className="rounded-lg border bg-card p-3 space-y-1.5">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Records</div>
                <div className="flex flex-wrap gap-1.5">
                  {row.campaignId ? (
                    <Link href={`/are/campaigns/${row.campaignId}`}>
                      <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted cursor-pointer">
                        <Megaphone className="size-3" /> {d?.campaignName || `Campaign #${row.campaignId}`}
                        <ExternalLink className="size-2.5 opacity-60" />
                      </span>
                    </Link>
                  ) : null}
                  {row.contactId ? (
                    <Link href={`/contacts/${row.contactId}`}>
                      <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted cursor-pointer">
                        <User className="size-3" /> Contact #{row.contactId}
                        <ExternalLink className="size-2.5 opacity-60" />
                      </span>
                    </Link>
                  ) : null}
                  {row.leadId ? (
                    <Link href={`/leads/${row.leadId}`}>
                      <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted cursor-pointer">
                        <User className="size-3" /> Lead #{row.leadId}
                        <ExternalLink className="size-2.5 opacity-60" />
                      </span>
                    </Link>
                  ) : null}
                  {row.sequenceId ? (
                    <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]">
                      <ListOrdered className="size-3" /> Sequence #{row.sequenceId}
                    </span>
                  ) : null}
                </div>
              </div>
            )}

            <div className="rounded-lg border bg-card p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Message</div>
              {detail.isLoading ? (
                <div className="h-24 rounded bg-muted/50 animate-pulse" />
              ) : (
                <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed font-sans">
                  {d?.body || row.preview || "No body was recorded for this message."}
                </pre>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/* ─── page ─────────────────────────────────────────────────────────────────── */

export default function EmailsV2() {
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  const [direction, setDirection] = useState("all");
  const [source, setSource] = useState("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<EmailFeedRow | null>(null);
  const PAGE = 50;

  useEffect(() => {
    const t = setTimeout(() => { setSearchDebounced(search.trim()); setPage(0); }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const feed = trpc.emailActivity.list.useQuery(
    { direction: direction as "all" | "outbound" | "inbound", source, status, search: searchDebounced, limit: PAGE, offset: page * PAGE },
    { retry: false },
  );
  const stats = trpc.emailActivity.stats.useQuery({}, { retry: false });
  const settings = trpc.emailAutoSend.getAutoSendSettings.useQuery(undefined as any, { retry: false });

  const invalidate = () => { utils.emailActivity.list.invalidate(); utils.emailActivity.stats.invalidate(); };
  const approve = trpc.emailDrafts.approve.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const reject = trpc.emailDrafts.reject.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const send = trpc.emailDrafts.send.useMutation({ onSuccess: () => { invalidate(); toast.success("Email sent"); }, onError: (e) => toast.error(e.message) });
  const updateSettings = trpc.emailAutoSend.updateAutoSendSettings.useMutation({
    onSuccess: () => { utils.emailAutoSend.getAutoSendSettings.invalidate(); toast.success("Auto-send updated"); },
    onError: (e) => toast.error(e.message.includes("FORBIDDEN") ? "Only admins can change auto-send" : e.message),
  });

  const s = settings.data as any;
  const rows = (feed.data?.rows ?? []) as EmailFeedRow[];
  const st = stats.data;
  const sourceCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of st?.bySource ?? []) m.set(b.source, b.count);
    if (st?.inbound) m.set("inbound", st.inbound);
    return m;
  }, [st]);

  const setFilter = (fn: () => void) => { fn(); setPage(0); };

  const toggleAutoSend = (enabled: boolean) => {
    updateSettings.mutate({
      aiAutoSendEnabled: enabled,
      aiAutoSendScoreMin: s?.aiAutoSendScoreMin ?? 70,
      aiAutoSendConfidenceMin: s?.aiAutoSendConfidenceMin ?? 75,
      aiAutoSendAllowUnscored: s?.aiAutoSendAllowUnscored ?? false,
    } as any);
  };

  const StatCard = ({ label, value, tone, onClick }: {
    label: string; value: string | number; tone?: "good" | "warn" | "danger"; onClick?: () => void;
  }) => {
    const color = tone === "good" ? "#059669" : tone === "warn" ? "#d97706" : tone === "danger" ? "#e11d48" : accent;
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className={cn(
          "rounded-lg border bg-card p-3 shadow-sm text-left",
          onClick && "hover:border-primary/40 transition-colors",
        )}
        style={{ borderLeft: `3px solid ${color}` }}
      >
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums mt-0.5" style={{ color }}>{value}</div>
      </button>
    );
  };

  return (
    <Shell title="Emails">
      <div data-tour-id="emails-list" className="flex flex-col h-full min-h-0">
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <Mail className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Emails</h1>
          <div className="flex-1" />
          <Select value={direction} onValueChange={(v) => setFilter(() => setDirection(v))}>
            <SelectTrigger className="h-7 w-[120px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{DIRECTIONS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={status} onValueChange={(v) => setFilter(() => setStatus(v))}>
            <SelectTrigger className="h-7 w-[150px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{STATUSES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
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
                  ? `On — AI drafts send automatically when lead score ≥ ${s?.aiAutoSendScoreMin ?? 70}.`
                  : "Off — AI drafts wait for your approval before sending."}
              </div>
            </div>
            <Switch checked={!!s?.aiAutoSendEnabled} onCheckedChange={toggleAutoSend} disabled={updateSettings.isPending || !settings.data} />
          </div>

          {/* Stats — every one of them clickable into the matching filter. */}
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
            <StatCard label="Sent" value={(st?.sent ?? 0).toLocaleString()} tone="good" onClick={() => setFilter(() => { setStatus("sent"); setDirection("outbound"); })} />
            <StatCard label="Open rate" value={`${st?.openRate ?? 0}%`} onClick={() => setFilter(() => { setStatus("engaged"); setDirection("outbound"); })} />
            <StatCard label="Click rate" value={`${st?.clickRate ?? 0}%`} />
            <StatCard label="Needs review" value={st?.awaiting ?? 0} tone={st?.awaiting ? "warn" : undefined} onClick={() => setFilter(() => setStatus("awaiting"))} />
            <StatCard label="Scheduled" value={(st?.scheduled ?? 0).toLocaleString()} onClick={() => setFilter(() => setStatus("scheduled"))} />
            <StatCard label="Failed / bounced" value={(st?.failed ?? 0) + (st?.bounced ?? 0)} tone={(st?.failed ?? 0) + (st?.bounced ?? 0) ? "danger" : undefined} onClick={() => setFilter(() => setStatus("failed"))} />
          </div>

          {/* Source chips + search. Both are server-side query input. */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setFilter(() => setSource("all"))}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-[11px] font-medium transition-colors",
                source === "all" ? "border-primary/50 bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              Everything
            </button>
            {EMAIL_SOURCES.filter((src) => (sourceCounts.get(src.id) ?? 0) > 0).map((src) => {
              const Icon = SOURCE_ICON[src.id] ?? Mail;
              const active = source === src.id;
              return (
                <button
                  key={src.id}
                  type="button"
                  title={src.hint}
                  onClick={() => setFilter(() => setSource(active ? "all" : src.id))}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 h-7 text-[11px] font-medium transition-colors",
                    active ? "border-primary/50 bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:text-foreground hover:border-primary/30",
                  )}
                >
                  <Icon className="size-3" />
                  {src.label}
                  <span className="tabular-nums opacity-70">{(sourceCounts.get(src.id) ?? 0).toLocaleString()}</span>
                </button>
              );
            })}
            <div className="flex-1 min-w-[140px]" />
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search subject, recipient or body…"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>

          {/* The log */}
          <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
            {feed.isLoading ? (
              <div className="p-3 space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-12 rounded bg-muted/50 animate-pulse" />)}</div>
            ) : feed.error ? (
              <div className="text-center py-12 px-4">
                <p className="text-sm text-muted-foreground">Couldn’t load emails. {feed.error.message}</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => feed.refetch()}>Retry</Button>
              </div>
            ) : rows.length === 0 ? (
              <div className="text-center py-14 px-4">
                <Mail className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
                <div className="text-sm font-medium">No emails here</div>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                  Campaign steps, sequence steps, CRM sends, Inbox mail, proposals, system notifications and inbound
                  replies all appear in this log. Try clearing the filters.
                </p>
              </div>
            ) : (
              rows.map((row) => {
                const Icon = SOURCE_ICON[row.source] ?? Mail;
                const pending = row.status === "pending_review" || row.status === "ai_pending_review";
                const failed = row.status === "failed" || row.status === "bounced";
                const who = row.direction === "inbound" ? (row.fromName || row.fromEmail) : row.toEmail;
                return (
                  <div
                    key={row.key}
                    className="flex items-center gap-3 px-3 py-2.5 border-b border-border/60 last:border-0 hover:bg-muted/40 cursor-pointer"
                    onClick={() => setSelected(row)}
                  >
                    <span
                      className="shrink-0 size-7 rounded-full flex items-center justify-center"
                      style={{ backgroundColor: `${accent}1f`, color: accent }}
                      title={emailSourceLabel(row.source)}
                    >
                      {failed ? <AlertTriangle className="size-3.5 text-rose-500" />
                        : row.status === "scheduled" ? <CalendarClock className="size-3.5" />
                        : row.status === "skipped" ? <Ban className="size-3.5" />
                        : row.direction === "inbound" ? <Inbox className="size-3.5" />
                        : pending ? <Clock className="size-3.5" />
                        : <Icon className="size-3.5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{row.subject || "(no subject)"}</div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {row.direction === "inbound" ? "from " : "to "}{who || "unknown recipient"}
                        {" · "}
                        <span className="text-foreground/60">{emailSourceLabel(row.source)}</span>
                        {row.sourceLabel ? ` · ${row.sourceLabel}` : ""}
                        {row.stepIndex != null ? ` · Step ${row.stepIndex + 1}` : ""}
                        {" · "}
                        <span title={fmtExact(row.at)}>{fmt(row.at)}</span>
                      </div>
                    </div>
                    {row.direction === "outbound" && row.status === "sent" && (
                      <div className="hidden sm:flex items-center gap-2 text-[11px] text-muted-foreground shrink-0">
                        <span className="inline-flex items-center gap-0.5" title="Opens"><MailOpen className="size-3" /> {row.openCount || (row.openedAt ? 1 : 0)}</span>
                        <span className="inline-flex items-center gap-0.5" title="Clicks"><MousePointerClick className="size-3" /> {row.clickCount}</span>
                      </div>
                    )}
                    <span
                      className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium capitalize", STATUS_TONE[row.status] ?? "bg-secondary text-muted-foreground")}
                      title={row.failureReason ?? undefined}
                    >
                      {statusLabel(row)}
                    </span>
                    {pending && row.draftId && (
                      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <Button size="sm" variant="outline" className="h-7 gap-1" disabled={send.isPending} onClick={() => send.mutate({ id: row.draftId! })}><Send className="size-3.5" /> Send</Button>
                        <Button size="icon" variant="ghost" className="size-7" title="Approve" onClick={() => approve.mutate({ id: row.draftId! })}><Check className="size-4 text-emerald-500" /></Button>
                        <Button size="icon" variant="ghost" className="size-7" title="Reject" onClick={() => reject.mutate({ id: row.draftId! })}><X className="size-4 text-muted-foreground" /></Button>
                      </div>
                    )}
                    {row.status === "approved" && row.draftId && (
                      <div onClick={(e) => e.stopPropagation()}>
                        <Button size="sm" variant="outline" className="h-7 gap-1 shrink-0" disabled={send.isPending} onClick={() => send.mutate({ id: row.draftId! })}><Send className="size-3.5" /> Send</Button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {(page > 0 || feed.data?.hasMore) && (
            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Previous
              </Button>
              <span className="text-[11px] text-muted-foreground">Page {page + 1}</span>
              <Button variant="outline" size="sm" disabled={!feed.data?.hasMore} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          )}
        </div>
      </div>

      <EmailDetail row={selected} onClose={() => setSelected(null)} />
    </Shell>
  );
}
