/**
 * AttentionPanel — "what needs me?", answered once, acted on in place.
 *
 * Renders attention.summary (the one server-side aggregator over every
 * human-in-the-loop queue). The design promise: when this panel says all
 * clear, there is genuinely nothing waiting anywhere in the product — and
 * when something IS waiting, you can act from here (approve a meeting) or
 * land one click away on the exact queue.
 *
 * Mounted on the Home page; `compact` gives the ARE hub a one-line strip.
 */
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2, Sparkles, CalendarDays, MessageSquare, Bot,
  ListChecks, PauseCircle, Loader2, ChevronRight,
} from "lucide-react";

function Digest({ d }: { d: { emailsSent: number; prospectsDiscovered: number; repliesReceived: number; meetingsBooked: number } }) {
  const parts = [
    `${d.emailsSent} email${d.emailsSent === 1 ? "" : "s"} sent`,
    `${d.prospectsDiscovered} prospect${d.prospectsDiscovered === 1 ? "" : "s"} discovered`,
    `${d.repliesReceived} repl${d.repliesReceived === 1 ? "y" : "ies"} received`,
    `${d.meetingsBooked} meeting${d.meetingsBooked === 1 ? "" : "s"} booked`,
  ];
  return (
    <p className="text-[12px] text-muted-foreground">
      <span className="font-medium text-foreground/80">Last 24h:</span> {parts.join(" · ")}
    </p>
  );
}

function QueueCard({
  icon, tint, title, count, cta, href, children,
}: {
  icon: React.ReactNode; tint: string; title: string; count: number;
  cta: string; href: string; children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card p-3.5 space-y-2.5 min-w-0">
      <div className="flex items-center gap-2">
        <span className="size-7 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: `${tint}1f`, color: tint }}>
          {icon}
        </span>
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className="ml-auto text-lg font-bold tabular-nums" style={{ color: tint }}>{count}</span>
      </div>
      {children}
      <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium hover:underline" style={{ color: tint }}>
        {cta} <ChevronRight className="size-3" />
      </Link>
    </div>
  );
}

export function AttentionPanel() {
  const utils = trpc.useUtils();
  const q = trpc.attention.summary.useQuery(undefined, { refetchInterval: 60_000 });
  const approveMeeting = trpc.meetings.approveAndSend.useMutation({
    onSuccess: () => {
      toast.success("Meeting approved — invite sent");
      utils.attention.summary.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const s = q.data;
  if (!s) {
    return (
      <div className="rounded-xl border bg-card p-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking what needs you…
      </div>
    );
  }

  if (s.totalNeedingYou === 0) {
    return (
      <div className="rounded-xl border border-emerald-300/50 bg-emerald-50 dark:bg-emerald-950/20 p-4 space-y-1.5">
        <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800 dark:text-emerald-300">
          <CheckCircle2 className="size-4.5" /> All clear — nothing needs you right now.
        </div>
        <Digest d={s.digest24h} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-semibold text-foreground">
          Needs your attention
          <span className="ml-2 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-xs font-bold tabular-nums">
            {s.totalNeedingYou}
          </span>
        </h2>
        <Digest d={s.digest24h} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {s.aiDrafts.count > 0 && (
          <QueueCard icon={<Sparkles className="size-4" />} tint="#9333EA" title="AI drafts to review"
            count={s.aiDrafts.count} cta="Review queue" href="/ai-pipeline">
            <ul className="space-y-1">
              {s.aiDrafts.items.slice(0, 3).map((d) => (
                <li key={d.id} className="text-xs text-muted-foreground truncate">
                  <span className="text-foreground/90">{d.subject || "(no subject)"}</span>
                  {d.toEmail ? <span> → {d.toEmail}</span> : null}
                </li>
              ))}
            </ul>
          </QueueCard>
        )}

        {s.proposedMeetings.count > 0 && (
          <QueueCard icon={<CalendarDays className="size-4" />} tint="#10B981" title="Meetings to approve"
            count={s.proposedMeetings.count} cta="All meetings" href="/v2/meetings">
            <ul className="space-y-1.5">
              {s.proposedMeetings.items.map((m) => (
                <li key={m.id} className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-foreground/90 truncate flex-1">
                    {m.title}{m.contactName ? ` — ${m.contactName}` : ""}
                  </span>
                  <Button
                    size="sm" variant="outline" className="h-6 px-2 text-[10px] shrink-0"
                    disabled={approveMeeting.isPending}
                    onClick={() => approveMeeting.mutate({ id: m.id })}
                  >
                    {approveMeeting.isPending ? <Loader2 className="size-3 animate-spin" /> : "Approve & send"}
                  </Button>
                </li>
              ))}
            </ul>
          </QueueCard>
        )}

        {s.unhandledReplies.count > 0 && (
          <QueueCard icon={<MessageSquare className="size-4" />} tint="#8B5CF6" title="Replies to answer"
            count={s.unhandledReplies.count} cta="Open conversations" href="/v2/conversations">
            <ul className="space-y-1">
              {s.unhandledReplies.items.slice(0, 3).map((r, i) => (
                <li key={i} className="text-xs text-muted-foreground truncate">
                  <span className="text-foreground/90">{r.fromEmail}</span>
                  {r.subject ? <span> — {r.subject}</span> : null}
                </li>
              ))}
            </ul>
          </QueueCard>
        )}

        {s.areApprovals.count > 0 && (
          <QueueCard icon={<Bot className="size-4" />} tint="#7C3AED" title="Prospects to approve"
            count={s.areApprovals.count} cta="Revenue Engine" href="/are">
            <ul className="space-y-1">
              {s.areApprovals.byCampaign.slice(0, 3).map((c) => (
                <li key={c.campaignId} className="text-xs text-muted-foreground truncate">
                  <Link href={`/are/campaigns/${c.campaignId}`} className="hover:underline text-foreground/90">
                    {c.count} in {c.name}
                  </Link>
                </li>
              ))}
            </ul>
          </QueueCard>
        )}

        {s.draftTasks.count > 0 && (
          <QueueCard icon={<ListChecks className="size-4" />} tint="#F59E0B" title="AI-drafted tasks"
            count={s.draftTasks.count} cta="Review tasks" href="/v2/tasks" />
        )}

        {/* The four queues the aggregator used to omit (audit 2026-09-02). */}
        {(s.sequenceDrafts?.count ?? 0) > 0 && (
          <QueueCard icon={<ListChecks className="size-4" />} tint="#0EA5E9" title="Sequence drafts to review"
            count={s.sequenceDrafts.count} cta="Review drafts" href="/email-drafts" />
        )}
        {(s.socialReplies?.count ?? 0) > 0 && (
          <QueueCard icon={<ListChecks className="size-4" />} tint="#0A66C2" title="LinkedIn & social replies"
            count={s.socialReplies.count} cta="Open Unified Inbox" href="/unified-inbox" />
        )}
        {(s.optimizationRecs?.count ?? 0) > 0 && (
          <QueueCard icon={<ListChecks className="size-4" />} tint="#10B981" title="Optimisation recommendations"
            count={s.optimizationRecs.count} cta="Review" href="/are/performance" />
        )}
        {(s.chatFollowUps?.count ?? 0) > 0 && (
          <QueueCard icon={<ListChecks className="size-4" />} tint="#14B8A6" title="Chat follow-ups to approve"
            count={s.chatFollowUps.count} cta="Open tasks" href="/v2/tasks" />
        )}
        {(s.routingSuggestions?.count ?? 0) > 0 && (
          <QueueCard icon={<ListChecks className="size-4" />} tint="#7C3AED" title="People the engine wants to put in a campaign"
            count={s.routingSuggestions.count} cta="Review picks" href="/are">
            <ul className="space-y-1">
              {s.routingSuggestions.byCampaign.slice(0, 3).map((c: { campaignId: number; name: string; count: number }) => (
                <li key={c.campaignId} className="text-xs text-muted-foreground truncate">
                  <Link href={`/are/campaigns/${c.campaignId}`} className="hover:underline text-foreground/90">{c.name}</Link>
                  <span> — {c.count} suggested</span>
                </li>
              ))}
            </ul>
          </QueueCard>
        )}

        {s.pausedCampaigns.length > 0 && (
          <QueueCard icon={<PauseCircle className="size-4" />} tint="#F43F5E" title="Paused campaigns"
            count={s.pausedCampaigns.length} cta="All campaigns" href="/are/campaigns">
            <ul className="space-y-1">
              {s.pausedCampaigns.slice(0, 3).map((c) => (
                <li key={c.id} className="text-xs text-muted-foreground truncate">
                  <Link href={`/are/campaigns/${c.id}`} className="hover:underline text-foreground/90">{c.name}</Link>
                  <span> — review copy, then unpause</span>
                </li>
              ))}
            </ul>
          </QueueCard>
        )}
      </div>
    </div>
  );
}
