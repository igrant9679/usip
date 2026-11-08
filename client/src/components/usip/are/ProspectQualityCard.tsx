/**
 * Workspace-wide prospect data quality on the Revenue Engine hub (owner ask,
 * 2026-08-12): what the audit sees across ALL campaigns, and the fix. Fixes
 * flow through the canonical person + the capped enrichment machinery —
 * nothing here fabricates data; unreconcilable rows land in the Rejections
 * tab, and cross-campaign duplicates collapse to the most-engaged row (one
 * campaign per prospect).
 *
 * WHAT CHANGED (tracker 3; audit 2026-10-20, A43). "Audit & fix" ran at a
 * click, with no word of what it was about to do, and answered with one long
 * toast of counters that vanished after twelve seconds; the row-by-row notes
 * went to the browser console. A tester could not tell what had been found
 * or what had changed. It now asks first, saying what it does and what it
 * may spend, and leaves a report on the card: what it found, what it
 * changed, which rows went to Rejections and why, and what it could not fix.
 * It is a manager's action (the server refuses anyone else), so a rep sees
 * the numbers and who can run it, not a button that fails.
 */
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { invalidateCampaignReads } from "@/lib/entityCache";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmButton } from "@/components/usip/Common";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { ROLE_RANK, rankOf } from "@shared/roleRank";
import { RefreshCw, Sparkles, X } from "lucide-react";

/** LinkedIn searches one run may spend (the server caps it at 50). */
export const RECONCILE_SEARCH_BUDGET = 10;

/** What a run reports — are.prospects.reconcile's result. */
export interface ReconcileReportData {
  scanned: number;
  found: {
    missingName: number; badLinkedinUrl: number; badSourceUrl: number; unlinkedPerson: number;
    duplicateRows: number; crossCampaignGroups: number; unreconcilable: number;
  };
  linksScrubbed: number;
  personsLinked: number;
  personsCreated: number;
  requeuedForEnrichment: number;
  linkedinFound: number;
  linkedinSearched: number;
  linkedinSearchesSaved: number;
  profileRetrievesQueued: number;
  duplicatesSkipped: number;
  flaggedUnreconcilable: number;
  changes: string[];
  notes: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The run's report in plain lines: found, changed, could not fix. */
export function reconcileReportLines(r: ReconcileReportData): { found: string[]; changed: string[]; summary: string } {
  const f = r.found;
  const found = [
    f.missingName > 0 && `${plural(f.missingName, "prospect")} with no name`,
    f.badLinkedinUrl + f.badSourceUrl > 0 && `${plural(f.badLinkedinUrl + f.badSourceUrl, "broken link")}`,
    f.unlinkedPerson > 0 && `${plural(f.unlinkedPerson, "row")} not linked to a People record`,
    f.duplicateRows > 0 && `${plural(f.duplicateRows, "duplicate row")}${f.crossCampaignGroups > 0 ? ` (${plural(f.crossCampaignGroups, "person", "people")} in more than one campaign)` : ""}`,
    f.unreconcilable > 0 && `${plural(f.unreconcilable, "row")} with no name, email or LinkedIn profile`,
  ].filter((x): x is string => !!x);
  const changed = [
    r.linksScrubbed > 0 && `Cleared broken links on ${plural(r.linksScrubbed, "row")}`,
    r.personsLinked > 0 && `Linked ${plural(r.personsLinked, "row")} to People${r.personsCreated > 0 ? ` (${plural(r.personsCreated, "new record")})` : ""}`,
    r.requeuedForEnrichment > 0 && `Sent ${plural(r.requeuedForEnrichment, "nameless row")} with a LinkedIn profile back to enrichment`,
    r.linkedinSearched > 0 && `Searched LinkedIn for ${plural(r.linkedinSearched, "person", "people")}; found ${plural(r.linkedinFound, "confident match", "confident matches")}`,
    r.profileRetrievesQueued > 0 && `Queued ${plural(r.profileRetrievesQueued, "LinkedIn profile retrieve")} (names and photos fill in as they finish)`,
    r.duplicatesSkipped > 0 && `Moved ${plural(r.duplicatesSkipped, "duplicate")} to Rejections, keeping the most engaged row`,
    r.flaggedUnreconcilable > 0 && `Moved ${plural(r.flaggedUnreconcilable, "unidentifiable row")} to Rejections`,
  ].filter((x): x is string => !!x);
  const summary = found.length === 0 && changed.length === 0
    ? `Checked ${plural(r.scanned, "prospect")}: nothing needed fixing.`
    : `Checked ${plural(r.scanned, "prospect")}: found ${found.length === 0 ? "no problems" : plural(found.length, "kind of problem", "kinds of problem")}, made ${plural(changed.length, "kind of change", "kinds of change")}.`;
  return { found, changed, summary };
}

/** The report the card keeps after a run. */
export function ReconcileReport({ result, onClose }: { result: ReconcileReportData; onClose?: () => void }) {
  const { found, changed, summary } = reconcileReportLines(result);
  return (
    <div className="w-full rounded-md border bg-muted/30 p-3 text-xs space-y-2" role="status">
      <div className="flex items-start gap-2">
        <div className="font-medium flex-1">Last Audit &amp; fix: {summary}</div>
        {onClose && (
          <button type="button" aria-label="Close the report" className="text-muted-foreground hover:text-foreground" onClick={onClose}>
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Found</div>
          {found.length === 0 ? <div className="text-muted-foreground">No problems.</div> : (
            <ul className="list-disc pl-4 space-y-0.5">{found.map((l) => <li key={l}>{l}</li>)}</ul>
          )}
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Changed</div>
          {changed.length === 0 ? <div className="text-muted-foreground">Nothing.</div> : (
            <ul className="list-disc pl-4 space-y-0.5">{changed.map((l) => <li key={l}>{l}</li>)}</ul>
          )}
        </div>
      </div>
      {result.linkedinSearchesSaved > 0 && (
        <div className="text-muted-foreground">
          Not searched again: {plural(result.linkedinSearchesSaved, "person", "people")} searched in the last 30 days with no confident match.
        </div>
      )}
      {result.changes.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Rows moved to Rejections ({result.changes.length})</summary>
          <ul className="mt-1 list-disc pl-4 space-y-0.5 max-h-48 overflow-y-auto">{result.changes.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </details>
      )}
      {result.notes.length > 0 && (
        <details open>
          <summary className="cursor-pointer text-amber-700 dark:text-amber-400">Could not fix, or worth a look ({result.notes.length})</summary>
          <ul className="mt-1 list-disc pl-4 space-y-0.5 max-h-48 overflow-y-auto">{result.notes.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

export function ProspectQualityCard() {
  const { current } = useWorkspace();
  const canFix = rankOf(current?.role) >= ROLE_RANK.manager;
  const [report, setReport] = useState<ReconcileReportData | null>(null);
  const audit = trpc.are.prospects.audit.useQuery(undefined, { refetchOnWindowFocus: false });
  const utils = trpc.useUtils();
  const reconcile = trpc.are.prospects.reconcile.useMutation({
    onSuccess: (r) => {
      setReport(r);
      toast.success(reconcileReportLines(r).summary + " The report is on the data-quality card.", { duration: 8000 });
      // Reconcile moves prospects between states across campaigns (X1.7).
      invalidateCampaignReads(utils);
    },
    onError: (e) => toast.error(e.message),
  });
  const a = audit.data;
  if (!a || (a.scanned === 0 && !report)) return null;

  const issues = a.missingName + a.badLinkedinUrl + a.badSourceUrl + a.unlinkedPerson + a.duplicateRows + a.unreconcilable;
  const stat = (label: string, value: number, warn: boolean) => (
    <div className="flex items-center gap-1.5 text-xs">
      <span className={warn && value > 0 ? "font-semibold text-amber-600" : "font-semibold"}>{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </div>
  );

  return (
    <Card className="bg-card border">
      <CardContent className="p-4 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="text-sm font-medium shrink-0">Prospect data quality</div>
        {stat("prospects", a.scanned, false)}
        {stat("missing names", a.missingName, true)}
        {stat("broken links", a.badLinkedinUrl + a.badSourceUrl, true)}
        {stat("no LinkedIn", a.missingLinkedinUrl, false)}
        {stat("duplicates", a.duplicateRows, true)}
        {stat("in multiple campaigns", a.crossCampaignGroups, true)}
        {stat("unreconcilable", a.unreconcilable, true)}
        <div className="ml-auto">
          {canFix ? (
            <ConfirmButton
              size="sm" variant={issues > 0 ? "default" : "outline"} destructive={false} className="gap-1.5 text-xs"
              disabled={reconcile.isPending}
              title="Run Audit & fix on every campaign?"
              description={
                <>
                  It clears broken links, links each prospect to a People record, sends nameless prospects that have a LinkedIn
                  profile back to enrichment, and searches LinkedIn for up to {RECONCILE_SEARCH_BUDGET} named prospects with no
                  profile (this uses your bridged account's search allowance). Duplicates — including one person in two campaigns —
                  keep the most engaged row and the rest move to the Rejections tab with the reason, as do rows with no name, email
                  or LinkedIn profile. Nothing is deleted, and anything moved can be restored from Rejections. A report stays on
                  this card.
                </>
              }
              confirmLabel="Run Audit & fix"
              onConfirm={() => reconcile.mutate({ linkedinSearchBudget: RECONCILE_SEARCH_BUDGET })}
            >
              {reconcile.isPending ? <RefreshCw className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              {reconcile.isPending ? "Reconciling…" : issues > 0 ? "Audit & fix" : "Re-audit"}
            </ConfirmButton>
          ) : (
            <span className="text-[11px] text-muted-foreground">A manager or admin can run Audit &amp; fix.</span>
          )}
        </div>
        {report && <ReconcileReport result={report} onClose={() => setReport(null)} />}
      </CardContent>
    </Card>
  );
}
