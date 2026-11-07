/**
 * StuckDraftsCard — emails written and not on their way (audit 2026-10-20,
 * F23).
 *
 * Approved drafts nobody sent, sends whose outcome is unknown, drafts
 * auto-send held for their sender, and drafts held by a paused or ended
 * enrolment were each visible only by filtering the Emails page for them, so
 * nobody noticed them pile up. One card counts all four, and each line opens
 * the Emails page filtered to exactly those rows (the counts come from the
 * same predicates the filters use, in emailActivity.stuckDrafts).
 */
import { Link } from "wouter";
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, PauseCircle, UserX, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function ago(at: Date | string | null | undefined): string {
  if (!at) return "";
  const days = Math.floor((Date.now() - new Date(at).getTime()) / 86_400_000);
  return days <= 0 ? "oldest today" : days === 1 ? "oldest from yesterday" : `oldest ${days} days old`;
}

export function StuckDraftsCard() {
  const q = trpc.emailActivity.stuckDrafts.useQuery(undefined, { retry: false });
  if (q.isLoading) return <Skeleton className="h-40 rounded-xl" />;
  if (q.isError || !q.data) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground flex items-center gap-2">
          <AlertTriangle className="size-4 text-amber-500" />
          Couldn't count stuck drafts{q.error?.message ? `: ${q.error.message}` : "."}
        </CardContent>
      </Card>
    );
  }
  const d = q.data;
  const lines = [
    {
      key: "approved", icon: Clock, count: d.approvedUnsent.count, href: d.approvedUnsent.href,
      label: "Approved, not sent",
      detail: `Nothing sends an approved draft by itself; use Send or Send approved on the Emails page.${d.approvedUnsent.count ? ` (${ago(d.approvedUnsent.oldestAt)})` : ""}`,
    },
    {
      key: "failed", icon: XCircle, count: d.failedSends.count, href: d.failedSends.href,
      label: "Failed sends",
      detail: `The send was tried and may or may not have gone, so nothing retries it. Check, then send again or reject.${d.failedSends.sequenceCount ? ` ${d.failedSends.sequenceCount} from sequences.` : ""}`,
    },
    {
      key: "autosend", icon: UserX, count: d.autoSendHeld.count, href: d.autoSendHeld.href,
      label: "Auto-send held for the sender",
      detail: "The sequence has nobody to send as, or its sender has no mailbox of their own connected.",
    },
    {
      key: "held", icon: PauseCircle, count: d.heldByPause.count, href: d.heldByPause.href,
      label: "Held by a paused enrolment or sequence",
      detail: "The person replied or was paused, their enrolment ended, or the sequence is not running.",
    },
  ];
  const total = lines.reduce((n, l) => n + l.count, 0);
  return (
    <Card>
      <CardContent className="p-0">
        {total === 0 && (
          <div className="px-4 pt-4 text-sm text-muted-foreground flex items-center gap-2">
            <CheckCircle2 className="size-4 text-emerald-500" /> No stuck drafts.
          </div>
        )}
        <ul className="divide-y">
          {lines.map((l) => (
            <li key={l.key}>
              <Link href={l.href} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/50 transition-colors">
                <l.icon className={`size-4 mt-0.5 shrink-0 ${l.count ? "text-amber-600" : "text-muted-foreground"}`} />
                <span className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{l.label}</span>
                  <span className="block text-xs text-muted-foreground">{l.detail}</span>
                </span>
                <span className={`text-lg font-semibold tabular-nums ${l.count ? "" : "text-muted-foreground"}`}>{l.count}</span>
                <ChevronRight className="size-4 mt-1 text-muted-foreground shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
