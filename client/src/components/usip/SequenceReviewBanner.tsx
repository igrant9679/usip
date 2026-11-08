/**
 * "N drafts awaiting review" on a sequence's page (audit 2026-10-20, U15).
 * An email step writes a draft and nothing goes until someone sends it (or
 * auto-send does), but no sequence said how many of its own were waiting; you
 * had to open the Emails page and pick them out. This counts this sequence's
 * waiting drafts on the server and links to exactly those (the Emails page
 * filtered to the sequence), so the number and the list agree. Hidden at zero.
 */
import { Link } from "wouter";
import { Inbox } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export function SequenceReviewBanner({ sequenceId, className }: { sequenceId: number; className?: string }) {
  const q = trpc.emailActivity.sequenceDraftsWaiting.useQuery({ sequenceId }, { enabled: Number.isFinite(sequenceId) && sequenceId > 0, retry: false });
  const d = q.data;
  if (!d || d.total === 0) return null;
  const review = d.review > 0 ? `${d.review} draft${d.review === 1 ? "" : "s"} awaiting review` : null;
  const approved = d.approved > 0 ? `${d.approved} approved, not sent yet` : null;
  return (
    <div role="status" className={cn("flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200", className)}>
      <Inbox className="size-3.5 shrink-0" />
      <span className="font-medium">{[review, approved].filter(Boolean).join(" · ")}</span>
      <Link href={d.href} className="underline underline-offset-2 font-medium">Review them</Link>
    </div>
  );
}
