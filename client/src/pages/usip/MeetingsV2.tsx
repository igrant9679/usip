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
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { forbiddenMessage } from "@/lib/forbidden";
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
import { ConfirmButton } from "@/components/usip/Common";
import {
  CalendarClock, CalendarCheck, CalendarX, Sparkles, Bot, Zap, Check, X, Clock, Video, Send,
  MoreHorizontal, Plus, AlertTriangle, Link2, Building2, MailWarning, Copy, ExternalLink, UserRound,
} from "lucide-react";

/** A member who can own a proposal, and the calendar its invite would send from. */
type ProposalOwner = { userId: number; name: string; calendar: "teams" | "no_teams" | "none" };

const CALENDAR_NOTE: Record<ProposalOwner["calendar"], string> = {
  teams: "Microsoft 365 calendar connected",
  no_teams: "calendar connected, no Teams links",
  none: "no calendar connected, so invites can't send yet",
};

type Meeting = {
  id: number;
  title: string;
  status: string;
  ownerUserId?: number | null;
  relatedType?: string | null;
  relatedId?: number | null;
  /** The reply that produced this meeting, when a positive reply booked it. */
  sourceReplyId?: number | null;
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
  approval: { label: "Autopilot: Approve", blurb: "AI proposes meetings with times + a drafted invite. Edit any of it; nothing sends until you approve." },
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
    onError: (e) => toast.error(forbiddenMessage(e, "Only admins can change Autopilot")),
  });
  const generate = trpc.meetings.generateProposals.useMutation({
    onSuccess: (r) => {
      invalidateAll();
      if (r.proposed === 0) toast.info(r.skipped > 0 ? "Top prospects already have meetings proposed" : "No best-fit prospects to schedule yet");
      // Proposals only: nothing this button finds is ever sent without approval.
      else toast.success(`AI proposed ${r.proposed} meeting${r.proposed === 1 ? "" : "s"} to review`);
    },
    onError: (e) => toast.error(e.message),
  });
  const approveSend = trpc.meetings.approveAndSend.useMutation({
    onSuccess: (r) => {
      invalidateAll();
      // An invite that was not delivered is not a booking — the proposal is
      // kept and the user is told exactly why nothing was sent. (The old
      // message claimed "Meeting booked" with no invite sent — the phantom-
      // booking fiction removed in migration 0175.)
      if (r.sent) toast.success(`Invite sent for ${fmtDateTime(r.scheduledAt)}`);
      else if (r.reason === "no_calendar_connected") toast.error("No calendar connected — the invite was not sent and the proposal was kept. Connect a calendar in Settings, or record an agreed meeting manually.");
      else if (r.reason === "provider_error") toast.error("The calendar provider rejected the invite — nothing was sent; the proposal was kept.");
      else if (r.reason === "all_times_expired") toast.error("Every proposed time has passed — regenerate the proposal to offer new times.");
      else if (r.reason === "no_attendee_email") toast.error("This prospect has no email address, so there is no one to send the invite to. Nothing was sent.");
      else if (r.reason === "time_taken") toast.error("That time is already booked on the owner's calendar. Pick another offered time; nothing was sent.");
      else if (r.reason === "all_times_taken") toast.error("Every offered time is already booked on the owner's calendar. Regenerate the proposal for free times; nothing was sent.");
      else toast.error(`Invite not sent (${r.reason ?? "unknown"}) — the proposal was kept.`);
    },
    onError: (e) => toast.error(e.message),
  });
  const approveAllProposed = trpc.meetings.approveAllProposed.useMutation({
    onSuccess: (r) => {
      invalidateAll();
      const skippedTotal = Object.values(r.skipped).reduce((a, b) => a + b, 0);
      const why = Object.entries(r.skipped).map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`).join(", ");
      if (r.sent > 0 && skippedTotal === 0) toast.success(`${r.sent} invite${r.sent === 1 ? "" : "s"} sent`);
      else if (r.sent > 0) toast.warning(`${r.sent} sent, ${skippedTotal} not sent (${why}) — those proposals were kept`);
      else toast.error(`Nothing sent (${why || "no proposals"}) — the proposals were kept`);
    },
    onError: (e) => toast.error(e.message),
  });
  const dismiss = trpc.meetings.dismissProposal.useMutation({ onSuccess: invalidateAll, onError: (e) => toast.error(e.message) });
  const regenerate = trpc.meetings.regenerateProposal.useMutation({
    onSuccess: () => { invalidateAll(); toast.success("Proposal regenerated — fresh times offered"); },
    onError: (e) => toast.error(e.message),
  });
  const regenerateAllOutdated = trpc.meetings.regenerateAllOutdated.useMutation({
    onSuccess: (r) => {
      invalidateAll();
      toast.success(
        `${r.regenerated} proposal${r.regenerated === 1 ? "" : "s"} regenerated with fresh times` +
        (r.remaining > 0 ? ` · ${r.remaining} still outdated — click again` : " · none left outdated"),
      );
    },
    onError: (e) => toast.error(e.message),
  });
  const complete = trpc.meetings.complete.useMutation({ onSuccess: invalidateAll, onError: (e) => toast.error(e.message) });
  const cancel = trpc.meetings.cancel.useMutation({ onSuccess: invalidateAll, onError: (e) => toast.error(e.message) });
  const create = trpc.meetings.create.useMutation({
    onSuccess: () => { invalidateAll(); toast.success("Meeting created"); setNewOpen(false); },
    onError: (e) => toast.error(e.message),
  });

  const mode = autopilot.data?.mode ?? "off";
  const updateProposal = trpc.meetings.updateProposal.useMutation({
    onSuccess: () => { invalidateAll(); toast.success("Proposal updated"); },
    onError: (e) => toast.error(e.message),
  });
  // A "Regenerate all" pass: the server anchors it and hands the anchor back
  // until nothing older than it is left (see meetings.regenerateAllProposals).
  const [regenPass, setRegenPass] = useState<{ since: string; remaining: number } | null>(null);
  const regenerateAll = trpc.meetings.regenerateAllProposals.useMutation({
    onSuccess: (r) => {
      invalidateAll();
      setRegenPass(r.remaining > 0 ? { since: r.since, remaining: r.remaining } : null);
      toast.success(
        `${r.regenerated} proposal${r.regenerated === 1 ? "" : "s"} rewritten` +
        (r.remaining > 0 ? ` · ${r.remaining} to go — click Continue` : " · every proposal is current"),
      );
    },
    onError: (e) => toast.error(e.message),
  });
  // Who a proposal belongs to decides whose calendar its invite sends from
  // (owner ask 2026-09-24: move CommunityForce's proposals to Khaja Syed).
  const ownersQ = trpc.meetings.proposalOwners.useQuery();
  const owners = (ownersQ.data ?? []) as ProposalOwner[];
  // Who owns every NEW proposal ("rep" = the default routing).
  const setProposalOwner = trpc.meetings.setProposalOwner.useMutation({
    onSuccess: (_r, v) => {
      utils.meetings.getAutopilotSettings.invalidate();
      const who = owners.find((o) => o.userId === v.userId)?.name;
      toast.success(who ? `New proposals will belong to ${who} and send from ${who}'s calendar` : "New proposals go to each prospect's rep again");
    },
    onError: (e) => toast.error(forbiddenMessage(e, "Only admins can choose who owns new proposals")),
  });
  const proposalOwnerId = autopilot.data?.proposalOwnerUserId ?? null;
  const proposalOwner = owners.find((o) => o.userId === proposalOwnerId);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignTo, setReassignTo] = useState<string>("");
  const reassign = trpc.meetings.reassignProposals.useMutation({
    onSuccess: (r, v) => {
      invalidateAll();
      setReassignOpen(false);
      const who = owners.find((o) => o.userId === v.toUserId)?.name ?? "them";
      if (r.reassigned === 0) toast.info(`Nothing to move: those proposals already belong to ${who}`);
      else toast.success(`${r.reassigned} proposal${r.reassigned === 1 ? "" : "s"} moved to ${who}. Invites will send from ${who}'s calendar.`);
    },
    onError: (e) => toast.error(e.message),
  });
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
        {m.sourceReplyId && <Link href={`/v2/conversations?reply=${m.sourceReplyId}`} className="inline-flex items-center gap-1 hover:underline"><Link2 className="size-3" /> the reply that booked this</Link>}
      </div>
    );
  };

  return (
    <Shell title="Meetings">
      <div data-tour-id="meetings-list" className="flex flex-col h-full min-h-0">
        {/* Header */}
        <div className="relative shrink-0 flex items-center gap-2 px-4 h-11 border-b border-border bg-card/40">
          <span aria-hidden className="absolute inset-x-0 top-0 h-0.5" style={{ backgroundColor: accent }} />
          <CalendarClock className="size-4" style={{ color: accent }} />
          <h1 className="text-[15px] font-semibold tracking-tight">Meetings</h1>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <Bot className="size-3.5 text-muted-foreground" />
            {/* Off or Approve: meeting proposals have no Autonomous mode (2026-09-24). */}
            <Select value={mode} onValueChange={(v) => setMode.mutate({ mode: v as "off" | "approval" })}>
              <SelectTrigger className="h-7 w-[168px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Autopilot: Off</SelectItem>
                <SelectItem value="approval">Autopilot: Approve</SelectItem>
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
          <div className="rounded-lg border bg-card px-4 py-2.5 flex flex-wrap items-center gap-3 shadow-sm">
            <span className="shrink-0 size-8 rounded-full flex items-center justify-center" style={{ backgroundColor: mode === "off" ? "hsl(var(--muted))" : "#7c3aed1f", color: mode === "off" ? undefined : "#7c3aed" }}>
              <Bot className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{MODE_META[mode]?.label}</div>
              <div className="text-[12px] text-muted-foreground">{MODE_META[mode]?.blurb}</div>
            </div>
            {owners.length > 0 && (
              <div className="shrink-0 flex items-center gap-1.5 text-[11px] text-muted-foreground"
                title="Default: the rep who owns the prospect's contact or lead, otherwise whoever asked (a workspace admin for the autopilot). Choosing a member makes them the owner of every new proposal, so its invite sends from their calendar. Existing proposals stay put; use Reassign all… for those.">
                <UserRound className="size-3.5" />
                <span>New proposals go to</span>
                <Select value={proposalOwnerId ? String(proposalOwnerId) : "rep"}
                  onValueChange={(v) => setProposalOwner.mutate({ userId: v === "rep" ? null : Number(v) })}>
                  <SelectTrigger className="h-7 w-auto min-w-[140px] gap-1 text-xs">
                    <SelectValue>{proposalOwnerId ? (proposalOwner?.name ?? "A former member (so each prospect's rep)") : "Each prospect's rep"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rep">Each prospect's rep (default)</SelectItem>
                    {owners.map((o) => (
                      <SelectItem key={o.userId} value={String(o.userId)}>{o.name} · {CALENDAR_NOTE[o.calendar]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
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
              <div className="flex items-center justify-between mb-2 gap-2">
                <h2 className="text-sm font-semibold flex items-center gap-2"><Sparkles className="size-4" style={{ color: "#7c3aed" }} /> AI meeting proposals ({proposals.length})</h2>
                <ConfirmButton size="sm" variant="outline" destructive={false} className="h-7 gap-1.5" disabled={approveAllProposed.isPending || approveSend.isPending}
                  title={`Approve and send all ${proposals.length} proposal${proposals.length === 1 ? "" : "s"}?`}
                  description="Each proposal books its earliest offered time that is still free on the owner's calendar, and the calendar invite is emailed to the prospect now. Proposals whose times have all passed or are all booked are skipped and kept for you to regenerate."
                  confirmLabel="Approve & send all" onConfirm={() => approveAllProposed.mutate()}>
                  <Send className="size-3.5" /> Approve & send all ({proposals.length})
                </ConfirmButton>
                <Button size="sm" variant="outline" className="h-7 gap-1.5"
                  disabled={regenerateAllOutdated.isPending}
                  title="Fresh times and a fresh invite for every proposal whose offered times have all passed or fall outside 9:00–16:00 in the workspace time zone. Sends nothing. Up to 10 per click."
                  onClick={() => regenerateAllOutdated.mutate()}>
                  <Sparkles className="size-3.5" /> {regenerateAllOutdated.isPending ? "Regenerating…" : "Regenerate outdated"}
                </Button>
                {regenPass ? (
                  <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={regenerateAll.isPending}
                    title="Carry on rewriting the proposals this pass has not reached yet. Sends nothing."
                    onClick={() => regenerateAll.mutate({ since: regenPass.since })}>
                    <Sparkles className="size-3.5" /> {regenerateAll.isPending ? "Rewriting…" : `Continue (${regenPass.remaining} to go)`}
                  </Button>
                ) : (
                  <ConfirmButton size="sm" variant="outline" destructive={false} className="h-7 gap-1.5" disabled={regenerateAll.isPending}
                    title={`Rewrite all ${proposals.length} proposal${proposals.length === 1 ? "" : "s"}?`}
                    description="Fresh times and a freshly written invite for every open proposal, using the current brand profile, including proposals you have edited. Nothing is sent. Runs 10 at a time; click Continue until none are left."
                    confirmLabel="Rewrite all" onConfirm={() => regenerateAll.mutate({})}>
                    <Sparkles className="size-3.5" /> {regenerateAll.isPending ? "Rewriting…" : "Regenerate all"}
                  </ConfirmButton>
                )}
                {owners.length > 1 && (
                  <Button size="sm" variant="outline" className="h-7 gap-1.5"
                    title="Move every open proposal to another member, so the invites send from that member's calendar. Sends nothing."
                    onClick={() => { setReassignTo(""); setReassignOpen(true); }}>
                    <UserRound className="size-3.5" /> Reassign all…
                  </Button>
                )}
              </div>
              <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Reassign all open proposals</DialogTitle>
                    <DialogDescription>
                      Each invite sends from its owner's calendar, so the new owner needs a Microsoft 365 calendar connected in this workspace for Teams links. Nothing is sent now. Offered times stay as they are; regenerate to fit them around the new owner's calendar.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-1.5">
                    <Label className="text-[12px]">Move to</Label>
                    <Select value={reassignTo} onValueChange={setReassignTo}>
                      <SelectTrigger className="h-9"><SelectValue placeholder="Choose a member" /></SelectTrigger>
                      <SelectContent>
                        {owners.map((o) => (
                          <SelectItem key={o.userId} value={String(o.userId)}>{o.name} · {CALENDAR_NOTE[o.calendar]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <DialogFooter>
                    <Button variant="ghost" onClick={() => setReassignOpen(false)}>Cancel</Button>
                    {(() => {
                      const to = Number(reassignTo);
                      const moving = reassignTo ? proposals.filter((m) => m.ownerUserId !== to).length : 0;
                      return (
                        <Button disabled={!reassignTo || moving === 0 || reassign.isPending}
                          onClick={() => reassign.mutate({ toUserId: to })}>
                          {reassign.isPending ? "Moving…" : `Move ${moving} proposal${moving === 1 ? "" : "s"}`}
                        </Button>
                      );
                    })()}
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <div className="space-y-2">
                {proposals.map((m) => (
                  <ProposalCard key={m.id} m={m}
                    onApprove={(chosenTime) => approveSend.mutate({ id: m.id, chosenTime })}
                    onDismiss={() => dismiss.mutate({ id: m.id })}
                    onRegenerate={() => regenerate.mutate({ id: m.id })}
                    onEdit={(patch) => updateProposal.mutate({ id: m.id, ...patch })}
                    owners={owners}
                    onReassign={(toUserId) => reassign.mutate({ toUserId, ids: [m.id] })}
                    editPending={updateProposal.isPending}
                    pending={approveSend.isPending || regenerate.isPending}
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

/** ISO instant → the browser-local value a datetime-local input shows. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function ProposalCard({
  m, onApprove, onDismiss, onRegenerate, onEdit, owners, onReassign, editPending, pending, ContactLine,
}: {
  m: Meeting;
  onApprove: (chosenTime?: string) => void;
  onDismiss: () => void;
  onRegenerate: () => void;
  onEdit: (patch: { title?: string; inviteMessage?: string; proposedTimes?: string[]; meetingUrl?: string }) => void;
  owners: ProposalOwner[];
  onReassign: (toUserId: number) => void;
  editPending: boolean;
  pending: boolean;
  ContactLine: ReactNode;
}) {
  // Edit before approving (owner ask 2026-09-24). Times are edited in the
  // browser's own zone and saved as instants.
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(m.title);
  const [draftMessage, setDraftMessage] = useState(m.inviteMessage ?? "");
  const [draftTimes, setDraftTimes] = useState<string[]>([]);
  const [draftLink, setDraftLink] = useState(m.meetingUrl ?? "");
  const startEdit = () => {
    setDraftTitle(m.title);
    setDraftMessage(m.inviteMessage ?? "");
    setDraftLink(m.meetingUrl ?? "");
    setDraftTimes(((m.proposedTimes ?? []) as string[]).map(toLocalInput));
    setEditing(true);
  };
  const saveEdit = () => {
    const times = draftTimes.filter(Boolean).map((v) => new Date(v).toISOString());
    onEdit({
      title: draftTitle.trim() || undefined,
      inviteMessage: draftMessage.trim() || undefined,
      proposedTimes: times.length ? times : undefined,
      // "" clears an alternate link, so the invite goes back to a Teams link.
      meetingUrl: draftLink.trim(),
    });
    setEditing(false);
  };
  const owner = owners.find((o) => o.userId === m.ownerUserId);
  const noEmail = !m.contactEmail?.trim();
  const times = (m.proposedTimes ?? []) as string[];
  // A proposal has no expiry, so its times go stale in place. The server
  // refuses a past booking (sendMeetingInvite is the one path both this and
  // the autonomous scheduler use); this stops the UI OFFERING one, and stops
  // the default selection being a slot that cannot be sent.
  const isPast = (t: string) => { const ms = new Date(t).getTime(); return Number.isFinite(ms) && ms <= Date.now(); };
  const future = times.filter((t) => !isPast(t));
  const expired = times.length > 0 && future.length === 0;
  const [chosen, setChosen] = useState<string | undefined>(future[0]);
  // Times change under the card after an edit or a regeneration: re-pick the
  // earliest future one rather than keep a slot the proposal no longer offers.
  const timesKey = times.join("|");
  useEffect(() => { setChosen(future[0]); }, [timesKey]); // eslint-disable-line react-hooks/exhaustive-deps
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
              {times.map((t) => {
                const past = isPast(t);
                return (
                  <button key={t} onClick={() => !past && setChosen(t)} disabled={past}
                    title={past ? "This time has already passed" : undefined}
                    className={cn("rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                      past ? "opacity-40 line-through cursor-not-allowed" : chosen === t ? "text-white border-transparent" : "hover:bg-muted")}
                    style={chosen === t && !past ? { backgroundColor: "#7c3aed" } : undefined}>
                    {fmtDateTime(t)}
                  </button>
                );
              })}
            </div>
          )}
          {expired && (
            // A disabled button with only a tooltip leaves the user guessing —
            // and on a proposal whose every time has passed, the needed action
            // is regeneration, not a different click.
            <div className="text-[11px] text-amber-700 dark:text-amber-500 mt-1.5">
              Every proposed time has passed. Regenerate this proposal to offer new times.
            </div>
          )}
          {noEmail && (
            <div className="text-[11px] text-amber-700 dark:text-amber-500 mt-1.5">
              No email address for this prospect, so an invite can't be sent. Add one to the prospect, or dismiss this proposal.
            </div>
          )}
          <div className="text-[11px] text-muted-foreground mt-1.5 flex items-center gap-1 min-w-0">
            <Video className="size-3 shrink-0" />
            {m.meetingUrl
              ? <span className="truncate">Meeting link: <a href={m.meetingUrl} target="_blank" rel="noreferrer" className="underline">{m.meetingUrl}</a></span>
              : owner?.calendar === "no_teams"
                ? <span className="text-amber-700 dark:text-amber-500">No meeting link: {owner.name}'s calendar can't create Teams meetings. Add a link with Edit.</span>
                : <span>Microsoft Teams link added to the invite when it is sent</span>}
          </div>
          {owners.length > 0 && (
            <div className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1.5 min-w-0 flex-wrap">
              <UserRound className="size-3 shrink-0" />
              <span>Sends from</span>
              <Select value={m.ownerUserId ? String(m.ownerUserId) : ""} onValueChange={(v) => onReassign(Number(v))}>
                <SelectTrigger className="h-6 w-auto gap-1 px-2 text-[11px]">
                  {/* The name only; the calendar note follows the picker. */}
                  <SelectValue placeholder="No owner">{owner?.name ?? (m.ownerUserId ? "A former member" : undefined)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {owners.map((o) => (
                    <SelectItem key={o.userId} value={String(o.userId)}>{o.name} · {CALENDAR_NOTE[o.calendar]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className={cn(owner?.calendar !== "teams" && "text-amber-700 dark:text-amber-500")}>
                {owner ? CALENDAR_NOTE[owner.calendar] : "no owner, so the invite can't send"}
              </span>
            </div>
          )}
          {editing && (
            <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2.5">
              <div className="space-y-1">
                <Label className="text-[11px]">Title</Label>
                <Input value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} className="h-8 text-[12.5px]" />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Invite text</Label>
                <Textarea value={draftMessage} onChange={(e) => setDraftMessage(e.target.value)} rows={4} className="text-[12.5px]" />
                <div className="text-[10.5px] text-muted-foreground">The invite quotes the times in words. If you change a time below, change it here too.</div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Meeting link (optional)</Label>
                <Input value={draftLink} onChange={(e) => setDraftLink(e.target.value)} placeholder="https://zoom.us/j/… or any meeting link" className="h-8 text-[12.5px]" />
                <div className="text-[10.5px] text-muted-foreground">Leave blank to include a Microsoft Teams link automatically. A link here is used instead, and added to the invite text.</div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px]">Offered times (your local time)</Label>
                {draftTimes.map((v, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <Input type="datetime-local" value={v} className="h-8 w-[220px] text-[12.5px]"
                      onChange={(e) => setDraftTimes((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))} />
                    <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" title="Remove this time"
                      disabled={draftTimes.length <= 1}
                      onClick={() => setDraftTimes((prev) => prev.filter((_, j) => j !== i))}><X className="size-3.5" /></Button>
                  </div>
                ))}
                {draftTimes.length < 5 && (
                  <Button size="sm" variant="ghost" className="h-7 gap-1 text-[11.5px]"
                    onClick={() => setDraftTimes((prev) => [...prev, prev[prev.length - 1] ?? ""])}><Plus className="size-3.5" /> Add a time</Button>
                )}
              </div>
              <div className="flex items-center gap-1.5 pt-1">
                <Button size="sm" className="h-7" disabled={editPending || !draftTitle.trim() || !draftMessage.trim()} onClick={saveEdit}>Save changes</Button>
                <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="outline" className="h-7 gap-1" disabled={pending}
            title="Fresh times and a freshly written invite for this proposal"
            onClick={onRegenerate}><Sparkles className="size-3.5" /> Regenerate</Button>
          <Button size="sm" variant="outline" className="h-7" disabled={pending || editPending}
            title="Edit the title, invite text or offered times before approving"
            onClick={() => (editing ? setEditing(false) : startEdit())}>{editing ? "Close" : "Edit"}</Button>
          <Button size="sm" className="h-7 gap-1" disabled={pending || expired || !chosen || noEmail}
            title={noEmail ? "This prospect has no email address, so there is no one to send the invite to" : expired ? "Every proposed time has passed — regenerate this proposal" : undefined}
            onClick={() => onApprove(chosen)}><Send className="size-3.5" /> Approve &amp; send</Button>
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
