/**
 * SendingStatusBar — what is stopping sends right now, on the page where you
 * would send (audit 2026-10-20, U1): "Outbound paused", "Outside send window
 * (opens 6:00 AM EST)", "LinkedIn paused", "Apollo cap reached" and the like.
 * Sends held by these used to fail as bare toasts, or wait without a word.
 *
 * One component and one server read (sendingStatus.current), the same sources
 * the senders ask; each page names its surface and sees only what holds its
 * sends (the send window holds automatic sends, not what a person sends from
 * the mailbox). Display only. Hidden when nothing is in the way.
 */
import { Link } from "wouter";
import { Clock, PauseCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export type SendingSurface = "sequences" | "emails" | "mailbox" | "meetings" | "social" | "are";

export function SendingStatusBar({ surface, className }: { surface: SendingSurface; className?: string }) {
  // Re-read every minute while the page is open: the window opens and caps
  // reset on the clock, not on anything this page does.
  const q = trpc.sendingStatus.current.useQuery(undefined, { staleTime: 30_000, refetchInterval: 60_000, retry: false });
  const blocks = (q.data?.blocks ?? []).filter((b) => b.surfaces.includes(surface));
  if (blocks.length === 0) return null;
  return (
    <div role="status" aria-label="What is holding sends" className={cn("flex flex-wrap items-start gap-x-4 gap-y-1.5 border-b px-4 py-2 text-[12px]", blocks.some((b) => b.tone === "stop") ? "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200" : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200", className)}>
      {blocks.map((b) => {
        const Icon = b.tone === "stop" ? PauseCircle : Clock;
        return (
          <div key={b.key} className="flex min-w-0 items-start gap-1.5">
            <Icon className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">
              <span className="font-semibold">{b.label}</span>
              <span className="opacity-90"> — {b.detail}</span>
              {b.href ? <> <Link href={b.href} className="underline underline-offset-2">Open</Link></> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
