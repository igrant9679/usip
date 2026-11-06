/**
 * My Calendar with no calendar connected (tracker 2026-11-06, item 6: "can't
 * be tested without a connected calendar"). In its own file so tests render it.
 *
 * It replaced the whole calendar with "Connect a Google, Outlook, or Apple
 * calendar". Two things wrong with that: there is no Google option anywhere
 * (the connect dialog offers Microsoft and CalDAV; Connected Accounts bridges
 * Microsoft only), and hiding the grid hid Velocity's own meetings, which
 * this page overlays precisely so it is useful with nothing connected
 * (ba4114c). The note now sits above the calendar and says where to go.
 */
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { CalendarDays, Plus } from "lucide-react";

export function NoCalendarConnected({ viewingRep, onConnect }: { viewingRep: boolean; onConnect: () => void }) {
  if (viewingRep) {
    return (
      <div className="mb-3 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        This rep hasn't connected a calendar. Their Velocity meetings are shown.
      </div>
    );
  }
  return (
    <div className="mb-3 flex flex-wrap items-start gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
      <CalendarDays className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">No calendar connected</p>
        <p>
          Your Velocity meetings are shown below. To see your own calendar here and create events, connect
          Microsoft 365 / Outlook on Connected Accounts, or add an Apple iCloud or other CalDAV calendar with
          Connect calendar. Google Calendar can't be connected yet.
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href="/connected-accounts">Connected Accounts</Link>
        </Button>
        <Button size="sm" onClick={onConnect}>
          <Plus className="size-3.5 mr-1" /> Connect calendar
        </Button>
      </div>
    </div>
  );
}
