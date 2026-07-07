/**
 * MeetingsV2 — the Engage → "Meetings" surface (/v2/meetings).
 *
 * A first-class meetings object plus the AI **Meeting Autopilot**: the
 * autonomous scheduler that gets sales meetings booked. Three modes (per ws):
 *   • Off       — fully manual.
 *   • Approve   — AI proposes meetings (times + drafted invite) for review; a
 *                 human approves to send the invite.
 *   • Autopilot — AI proposes AND sends the calendar invite automatically.
 *
 * Backed by the `meetings.*` tRPC procedures. When the owner has a connected
 * calendar the invite is a real provider event; otherwise the meeting is
 * recorded locally and flagged "not sent" (never a false "booked").
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Shell, useAccentColor } from "@/components/usip/Shell";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  CalendarClock, CalendarCheck, CalendarX, Sparkles, Bot, Zap, Check, X, Clock, Video, Send,
  MoreHorizontal, Plus, AlertTriangle, Link2, Building2, MailWarning, Copy, ExternalLink,
} from "lucide-react";

type Meeting = {
  id: number;
  title: string;
  status: string;
  ownerUserId?: number | null;
  relatedType?: string | null;
  relatedId?: number | null;
  contactName?: string | null;
  contactEmail?: string | null;
  company?: string | null;
  proposedTimes?: string[] | null;
  scheduledAt?: string | Date | null;
  durationMin?: number | null;
  meetingUrl?: string | null;
  location?: string | null;
  inviteMessage?: string | null;
  source?: string | null;
  aiReasoning?: string | null;
  aiConfidence?: number | null;
  inviteSent?: boolean | null;
  disposition?: string | null;
  createdAt?: string | Date | null;
};

function recordHref(m: Meeting): string | null {
  if (!m.relatedType || !m.relatedId) return null;
  switch (m.relatedType) {
    case "account": return `/accounts/${m.relatedId}`;
    case "contact": return `/contacts/${m.relatedId}`;
    case "lead": return `/leads/${m.relatedId}`;
    case "opportunity": return `/opportunities/${m.relatedId}`;
    case "prospect": return `/prospects/${m.relatedId}`;
    default: return null;
  }
}

function fmtDateTime(d?: string | Date | null): string {
  if (!d) return "—";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " · " +
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const MODE_META: Record<string, { label: string; blurb: string }> = {
  off: { label: "Autopilot off", blurb: "AI won't schedule meetings. Everything is manual." },
  approval: { label: "Autopilot: Approve", blurb: "AI proposes meetings with times + a drafted invite for your review before anything sends." },
  auto: { label: "Autopilot: Autonomous", blurb: "AI proposes and sends the calendar invite automatically for your best-fit prospects." },
};

export default function MeetingsV2() {
  const accent = useAccentColor();
  const utils = trpc.useUtils();

  const all = trpc.meetings.list.useQuery({});
  const stats = trpc.meetings.stats.useQuery();
  const autopilot = trpc.meetings.getAutopilotSettings.useQuery();
  const bookingLink = trpc.bookingLinks.mine.useQuery(undefined as any, { retry: false });
  const bookingUrl = bookingLink.data?.slug ? `${window.location.origin}/b/${bookingLink.data.slug}` : "";
  const [copied, setCopied] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  const invalidateAll = () => {
    utils.meetings.list.invalidate();
    utils.meetings.stats.invalidate();
  };

  const setMode = trpc.meetings.setAutopilotSettings.useMutation({
    onSuccess: () => { utils.meetings.getAutopilotSettings.invalidate(); toast.success("Autopilot updated"); },
    onError: (e) => toast.error(e.message.includes("FORBIDDEN") ? "Only admins can change Autopilot" : e.message),
  });
  const generate = trpc.meetings.generateProposals.useMutation({
    onSuccess: (r) => {
      invalidateAll();
      if (r.proposed === 0) toast.info(r.skipped > 0 ? "Top prospects already have meetings proposed" : "No best-fit prospects to schedule yet");
      else toast.success(`AI proposed ${r.proposed} meeting${r.proposed === 1 ? "" : "s"} to review`);
    },
    onError: (e) => toast.error(e.message),
  });
  const approveSend = trpc.meetings.approveAndSend.useMutation({
    onSuccess: (r) => {
      invalidateAll();
      if (r.sent) toast.success(`Invite sent for ${fmtDateTime(r.scheduledAt)}`);
      else toast.success(`Meeting booked for ${fmtDateTime(r.scheduledAt)} — connect a calendar to auto-send the invite`);
    },
    onError: (e) => toast.error(e.message),
  });
  const dismiss = trpc.meetings.dismissProposal.useMutation({ onSuccess: invalidateAll });
  const complete = trpc.meetings.complete.useMutation({ onSuccess: invalidateAll });
  const cancel = trpc.meetings.cancel.useMutation({ onSuccess: invalidateAll });
  const create = trpc.meetings.create.useMutation({
    onSuccess: () => { invalidateAll(); toast.success("Meeting created"); setNewOpen(false); },
    onError: (e) => toast.error(e.message),
  });

  const mode = autopilot.data?.mode ?? "off";
  const meetings = (all.data ?? []) as Meeting[];
  const s = stats.data ?? { proposed: 0, upcoming: 0, completed: 0, noShow: 0, booked: 0 };
  const now = Date.now();

  const proposals = useMemo(() => meetings.filter((m) => m.status === "proposed"), [meetings]);
  const upcoming = useMemo(() =>
    meetings
      .filter((m) => (m.status === "scheduled" || m.status === "invited" || m.status === "rescheduled") && (!m.scheduledAt || new Date(m.scheduledAt).getTime() >= now - 3600_000))
      .sort((a, b) => (a.scheduledAt ? new Date(a.scheduledAt).getTime() : Infinity) - (b.scheduledAt ? new Date(b.scheduledAt).getTime() : Infinity)),
    [meetings, now]);
  const past = useMemo(() =>
    meetings
      .filter((m) => m.status === "completed" || m.status === "no_show" || m.status === "cancelled" || ((m.status === "scheduled" || m.status === "rescheduled") && m.scheduledAt && new Date(m.scheduledAt).getTime() < now - 3600_000))
      .slice(0, 15),
    [meetings, now]);

  const StatCard = ({ label, value, tone }: { label: string; value: number; tone?: "danger" | "ai" | "good" }) => {
    const color = tone === "danger" ? "#e11d48" : tone === "ai" ? "#7c3aed" : tone === "good" ? "#059669" : accent;
    return (
      <div className="rounded-lg border bg-card p-3 shadow-sm" style={{ borderLeft: `3px solid ${color}` }}>
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums mt-0.5" style={{ color }}>{value}</div>
      </div>
    );
  };

  const ContactLine = ({ m }: { m: Meeting }) => {
    const href = recordHref(m);
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {m.contactName && <span>{m.contactName}</span>}
        {m.company && <span className="inline-flex items-center gap-1"><Building2 className="size-3" /> {m.company}</span>}
        {href && <Link href={href} className="inline-flex items-center gap-1 hover:underline"><Link2 className="size-3" /> {m.relatedType}</Link>}
      </div>
    );
  };

  return (
    <Shell title="Meetings">
      <div className="flex flex-col h-full min-h-0">
        {/* Header */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <CalendarClock className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Meetings</h1>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <Bot className="size-3.5 text-muted-foreground" />
            <Select value={mode} onValueChange={(v) => setMode.mutate({ mode: v as "off" | "approval" | "auto" })}>
              <SelectTrigger className="h-7 w-[168px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Autopilot: Off</SelectItem>
                <SelectItem value="approval">Autopilot: Approve</SelectItem>
                <SelectItem value="auto">Autopilot: Autonomous</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={generate.isPending} onClick={() => generate.mutate({ limit: 8 })}>
            <Sparkles className="size-3.5" /> {generate.isPending ? "Finding…" : "Find meetings with AI"}
          </Button>
          <Button size="sm" className="h-7 gap-1.5" onClick={() => setNewOpen(true)}><Plus className="size-3.5" /> New meeting</Button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6 space-y-5">
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
              <div className="shrink-0 text-[11px] text-muted-foreground hidden sm:block">Last run {fmtDateTime(autopilot.data.lastRunAt)}</div>
            )}
          </div>

          {/* Self-serve booking link — prospects book straight onto your calendar */}
          {bookingUrl && (
            <div className="rounded-lg border bg-card px-4 py-2.5 flex items-center gap-3 shadow-sm">
              <span className="shrink-0 size-8 rounded-full flex items-center justify-center" style={{ backgroundColor: `${accent}1f`, color: accent }}>
                <Link2 className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Your booking link</div>
                <div className="text-[12px] text-muted-foreground truncate">Share it — prospects self-book an open slot straight onto your calendar.</div>
              </div>
              <code className="shrink-0 hidden md:block text-[11px] bg-muted rounded px-2 py-1 max-w-[280px] truncate">{bookingUrl}</code>
              <Button
                variant="outline" size="sm" className="h-7 gap-1.5 shrink-0"
                onClick={() => { navigator.clipboard?.writeText(bookingUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              >
                {copied ? <><Check className="size-3.5" /> Copied</> : <><Copy className="size-3.5" /> Copy</>}
              </Button>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 shrink-0" onClick={() => window.open(bookingUrl, "_blank")}>
                <ExternalLink className="size-3.5" /> Preview
              </Button>
              <AvailabilityDialog link={bookingLink.data} />
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <StatCard label="Proposed" value={s.proposed} tone={s.proposed ? "ai" : undefined} />
            <StatCard label="Upcoming" value={s.upcoming} />
            <StatCard label="Booked" value={s.booked} tone={s.booked ? "good" : undefined} />
            <StatCard label="Completed" value={s.completed} />
            <StatCard label="No-shows" value={s.noShow} tone={s.noShow ? "danger" : undefined} />
          </div>

          {/* AI proposals to review */}
          {proposals.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2"><Sparkles className="size-4" style={{ color: "#7c3aed" }} /> AI meeting proposals ({proposals.length})</h2>
              <div className="space-y-2">
                {proposals.map((m) => (
                  <ProposalCard key={m.id} m={m}
                    onApprove={(chosenTime) => approveSend.mutate({ id: m.id, chosenTime })}
                    onDismiss={() => dismiss.mutate({ id: m.id })}
                    pending={approveSend.isPending}
                    ContactLine={<ContactLine m={m} />}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Upcoming */}
          <section>
            <h2 className="text-sm font-semibold mb-2 flex items-center gap-2"><CalendarCheck className="size-4" style={{ color: accent }} /> Upcoming</h2>
            <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
              {all.isLoading ? (
                <div className="p-3 space-y-2">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-10 rounded bg-muted/50 animate-pulse" />)}</div>
              ) : all.error ? (
                <div className="text-center py-12 px-4">
                  <p className="text-sm text-muted-foreground">Couldn’t load meetings. {all.error.message}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => all.refetch()}>Retry</Button>
                </div>
              ) : upcoming.length === 0 ? (
                <div className="text-center py-14 px-4">
                  <CalendarClock className="size-8 mx-auto text-muted-foreground opacity-50 mb-2" />
                  <div className="text-sm font-medium">No upcoming meetings</div>
                  <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">Let AI propose meetings with your best-fit prospects, or add one manually.</p>
                  <div className="flex items-center justify-center gap-2 mt-3">
                    <Button size="sm" variant="outline" className="gap-1.5" disabled={generate.isPending} onClick={() => generate.mutate({ limit: 8 })}><Sparkles className="size-3.5" /> Find meetings with AI</Button>
                    <Button size="sm" className="gap-1.5" onClick={() => setNewOpen(true)}><Plus className="size-3.5" /> New meeting</Button>
                  </div>
                </div>
              ) : (
                upcoming.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-border/60 last:border-0 hover:bg-muted/40">
                    <span className="shrink-0 size-8 rounded-full flex items-center justify-center" style={{ backgroundColor: `${accent}1f`, color: accent }}>
                      <CalendarCheck className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate flex items-center gap-1.5">
                        {m.title}
                        {m.inviteSent === false && <span title="No calendar connected — invite not sent" className="inline-flex items-center"><MailWarning className="size-3 text-amber-500" /></span>}
                      </div>
                      <ContactLine m={m} />
                    </div>
                    {m.meetingUrl && <a href={m.meetingUrl} target="_blank" rel="noreferrer"><Button variant="outline" size="sm" className="h-7 gap-1"><Video className="size-3.5" /> Join</Button></a>}
                    <div className="shrink-0 text-[11px] w-40 text-right tabular-nums text-muted-foreground">{fmtDateTime(m.scheduledAt)}</div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 shrink-0"><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onClick={() => complete.mutate({ id: m.id })}><Check className="size-3.5 mr-2" /> Mark completed</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => complete.mutate({ id: m.id, disposition: "no_show" })}>Mark no-show</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => cancel.mutate({ id: m.id })} className="text-rose-600"><X className="size-3.5 mr-2" /> Cancel</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* Past */}
          {past.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold mb-2 flex items-center gap-2 text-muted-foreground"><CalendarX className="size-4" /> Past</h2>
              <div className="rounded-xl border bg-card overflow-hidden shadow-sm opacity-80">
                {past.map((m) => (
                  <div key={m.id} className="flex items-center gap-3 px-3 py-2 border-b border-border/60 last:border-0">
                    <div className="min-w-0 flex-1"><div className="text-sm truncate">{m.title}</div><ContactLine m={m} /></div>
                    <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] capitalize", m.status === "completed" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" : m.status === "no_show" ? "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300" : "bg-secondary text-muted-foreground")}>{(m.disposition || m.status).replace(/_/g, " ")}</span>
                    <div className="shrink-0 text-[11px] w-32 text-right tabular-nums text-muted-foreground">{fmtDateTime(m.scheduledAt)}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      <NewMeetingDialog open={newOpen} onOpenChange={setNewOpen} onCreate={(v) => create.mutate(v)} pending={create.isPending} />
    </Shell>
  );
}

function ProposalCard({
  m, onApprove, onDismiss, pending, ContactLine,
}: {
  m: Meeting;
  onApprove: (chosenTime?: string) => void;
  onDismiss: () => void;
  pending: boolean;
  ContactLine: ReactNode;
}) {
  const times = (m.proposedTimes ?? []) as string[];
  const [chosen, setChosen] = useState<string | undefined>(times[0]);
  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm" style={{ borderColor: "#7c3aed40" }}>
      <div className="flex items-start gap-3">
        <span className="shrink-0 size-8 rounded-full flex items-center justify-center mt-0.5" style={{ backgroundColor: "#7c3aed1f", color: "#7c3aed" }}>
          <CalendarClock className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium flex items-center gap-1.5">
            {m.title}
            {typeof m.aiConfidence === "number" && <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">{m.aiConfidence}% conf.</span>}
          </div>
          {ContactLine}
          {m.inviteMessage && <div className="text-[12px] text-muted-foreground mt-1.5 rounded-md bg-muted/50 px-2.5 py-1.5 italic">“{m.inviteMessage}”</div>}
          {m.aiReasoning && <div className="text-[11px] text-muted-foreground mt-1">{m.aiReasoning}</div>}
          {times.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <span className="text-[11px] text-muted-foreground mr-0.5">Proposed:</span>
              {times.map((t) => (
                <button key={t} onClick={() => setChosen(t)}
                  className={cn("rounded-full border px-2 py-0.5 text-[11px] transition-colors", chosen === t ? "text-white border-transparent" : "hover:bg-muted")}
                  style={chosen === t ? { backgroundColor: "#7c3aed" } : undefined}>
                  {fmtDateTime(t)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" className="h-7 gap-1" disabled={pending} onClick={() => onApprove(chosen)}><Send className="size-3.5" /> Approve &amp; send</Button>
          <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" title="Dismiss" onClick={onDismiss}><X className="size-4" /></Button>
        </div>
      </div>
    </div>
  );
}

function NewMeetingDialog({
  open, onOpenChange, onCreate, pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreate: (v: { title: string; contactName?: string; contactEmail?: string; company?: string; scheduledAt?: string; durationMin: number; inviteMessage?: string }) => void;
  pending: boolean;
}) {
  const [title, setTitle] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [company, setCompany] = useState("");
  const [when, setWhen] = useState("");
  const [duration, setDuration] = useState("30");

  const submit = () => {
    if (!title.trim()) return;
    onCreate({
      title: title.trim(),
      contactName: contactName.trim() || undefined,
      contactEmail: contactEmail.trim() || undefined,
      company: company.trim() || undefined,
      scheduledAt: when ? new Date(when).toISOString() : undefined,
      durationMin: Number(duration) || 30,
    });
    setTitle(""); setContactName(""); setContactEmail(""); setCompany(""); setWhen(""); setDuration("30");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New meeting</DialogTitle>
          <DialogDescription>Schedule a meeting. Leave the time blank to keep it as a proposal.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="m-title">Title</Label>
            <Input id="m-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Velocity intro call" autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label htmlFor="m-name">Contact</Label><Input id="m-name" value={contactName} onChange={(e) => setContactName(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="m-company">Company</Label><Input id="m-company" value={company} onChange={(e) => setCompany(e.target.value)} /></div>
          </div>
          <div className="space-y-1.5"><Label htmlFor="m-email">Contact email</Label><Input id="m-email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="name@company.com" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label htmlFor="m-when">When</Label><Input id="m-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></div>
            <div className="space-y-1.5">
              <Label>Duration</Label>
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15 min</SelectItem>
                  <SelectItem value="30">30 min</SelectItem>
                  <SelectItem value="45">45 min</SelectItem>
                  <SelectItem value="60">60 min</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={pending || !title.trim()} onClick={submit}>{pending ? "Creating…" : "Create meeting"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────── booking-link availability editor ─────────────────── */

const COMMON_TIMEZONES = [
  "UTC",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Phoenix", "America/Toronto", "America/Sao_Paulo",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Amsterdam",
  "Africa/Lagos", "Africa/Johannesburg",
  "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Asia/Shanghai",
  "Australia/Sydney", "Pacific/Auckland",
];

const WEEKDAYS = [
  { n: 1, label: "Mon" }, { n: 2, label: "Tue" }, { n: 3, label: "Wed" },
  { n: 4, label: "Thu" }, { n: 5, label: "Fri" }, { n: 6, label: "Sat" }, { n: 0, label: "Sun" },
];

const fmtHour = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? "AM" : "PM"}`;

/**
 * Working-hours / timezone editor for the rep's booking link. The public page
 * only ever offers slots inside this window (server-enforced on book too).
 */
function AvailabilityDialog({ link }: { link: any }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [tz, setTz] = useState<string>(link?.timezone ?? "UTC");
  const [startHour, setStartHour] = useState<number>(link?.startHour ?? 9);
  const [endHour, setEndHour] = useState<number>(link?.endHour ?? 17);
  const [days, setDays] = useState<number[]>(
    String(link?.workDays ?? "1,2,3,4,5").split(",").map(Number).filter((n) => Number.isInteger(n)),
  );
  const save = trpc.bookingLinks.update.useMutation({
    onSuccess: () => { toast.success("Availability updated"); utils.bookingLinks.mine.invalidate(); setOpen(false); },
    onError: (e) => toast.error(e.message),
  });
  const tzOptions = [...new Set([tz, browserTz, ...COMMON_TIMEZONES])];
  const toggleDay = (n: number) =>
    setDays((prev) => (prev.includes(n) ? prev.filter((d) => d !== n) : [...prev, n]));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" className="h-7 gap-1.5 shrink-0" onClick={() => setOpen(true)}>
        <Clock className="size-3.5" /> Availability
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Booking availability</DialogTitle>
          <DialogDescription>
            Visitors only see open slots inside this window (shown to them in their own local time).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Timezone</Label>
            <Select value={tz} onValueChange={setTz}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-64">
                {tzOptions.map((t) => (
                  <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}{t === browserTz ? " (your timezone)" : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>From</Label>
              <Select value={String(startHour)} onValueChange={(v) => setStartHour(Number(v))}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {Array.from({ length: 24 }, (_, h) => (
                    <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>To</Label>
              <Select value={String(endHour)} onValueChange={(v) => setEndHour(Number(v))}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                    <SelectItem key={h} value={String(h)}>{h === 24 ? "12:00 AM (midnight)" : fmtHour(h)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Bookable days</Label>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d) => (
                <button
                  key={d.n}
                  type="button"
                  onClick={() => toggleDay(d.n)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-[12px] transition-colors",
                    days.includes(d.n) ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted text-muted-foreground",
                  )}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          {startHour >= endHour && <p className="text-[12px] text-rose-600">Working hours must end after they start.</p>}
          {days.length === 0 && <p className="text-[12px] text-rose-600">Pick at least one bookable day.</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={save.isPending || startHour >= endHour || days.length === 0}
            onClick={() => save.mutate({ timezone: tz === "UTC" ? null : tz, startHour, endHour, workDays: days })}
          >
            {save.isPending ? "Saving…" : "Save availability"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
