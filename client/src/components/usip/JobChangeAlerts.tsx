/**
 * Pieces of Data Enrichment › "Job change alerts", in their own file so tests
 * render them.
 */
import { Button } from "@/components/ui/button";
import { Briefcase, CheckCircle2 } from "lucide-react";

export type JobChangeRow = {
  prospectId: number;
  changeType: string;
  hasReengagementTask: boolean;
  /** Why Re-engage would be refused (linkedinEnrichment.jobChanges), or null. */
  reengageBlocked?: "incomplete_company_change" | "new_company_not_an_employer" | null;
};

/**
 * The row's action. Re-engage is offered only where the task writer will make
 * a task (tracker 2026-11-06, items 8 and 14): a first sighting — the first
 * company Velocity saw for someone, recorded as a change with no "from" — had
 * the button, and pressing it came back "Could not create the re-engagement
 * task". Those rows now say what they are instead.
 */
export function JobChangeAction({ jc, accent, pending, onReengage }: {
  jc: JobChangeRow;
  accent: string;
  pending: boolean;
  onReengage: (prospectId: number) => void;
}) {
  if (jc.changeType !== "company_changed") return null;
  if (jc.hasReengagementTask) {
    return <span className="shrink-0 inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="size-3.5" /> Queued</span>;
  }
  if (jc.reengageBlocked === "incomplete_company_change") {
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground" title="LinkedIn showed no previous employer, so this is the first company Velocity has seen for them, not a move.">
        First seen, not a move
      </span>
    );
  }
  if (jc.reengageBlocked === "new_company_not_an_employer") {
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground" title="The new LinkedIn company reads as a life change (retired, between roles), not an employer.">
        Not a new employer
      </span>
    );
  }
  return (
    <Button size="sm" className="h-7 shrink-0" style={{ backgroundColor: accent }} disabled={pending} onClick={() => onReengage(jc.prospectId)}>
      Re-engage
    </Button>
  );
}

/**
 * Nothing detected yet (audit 2026-10-20, P97). It said Velocity "monitors
 * your enriched prospects' LinkedIn profiles daily" and its button opened
 * prospect discovery. Only people enriched through LinkedIn are re-checked,
 * oldest first, up to 250 a day and only as fast as the connected LinkedIn
 * account's limits allow (linkedinEnrichment/dailyCheck); the button goes to
 * LinkedIn enrichment, where people get onto that list.
 */
export function JobChangeEmptyState({ accent, onEnrich }: { accent: string; onEnrich: () => void }) {
  return (
    <div className="max-w-md mx-auto text-center py-16">
      <div className="mx-auto size-12 rounded-full bg-secondary flex items-center justify-center mb-3">
        <Briefcase className="size-5 text-muted-foreground" />
      </div>
      <h2 className="text-sm font-semibold">No job changes detected yet</h2>
      <p className="text-sm text-muted-foreground mt-1">
        Velocity re-checks the LinkedIn profiles of people you have enriched through LinkedIn, oldest first:
        up to 250 a day, and only as fast as your connected LinkedIn account's limits allow. When one of them
        changes company or title, it appears here so you can re-engage them.
      </p>
      <Button size="sm" className="mt-4" style={{ backgroundColor: accent }} onClick={onEnrich}>Enrich people from LinkedIn</Button>
    </div>
  );
}
