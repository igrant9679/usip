/**
 * ProspectAllowanceCard — the top of Settings → Data sources for a workspace
 * on a membership plan (owner approved 2026-11-25).
 *
 *   "Prospect data is included with your plan: 412 of 3,000 used this month · resets 1 Dec"
 *
 * and, below it, the vendor key cards are described as optional: with a plan,
 * prospect data comes from our prospect databases up to the month's number,
 * and a key of the workspace's own is only needed to go past it (own keys are
 * never counted). Used up, it says so in the words every run uses
 * (shared/prospectAllowance). A workspace on no plan sees nothing here: its
 * page is exactly what it was.
 */
import { trpc } from "@/lib/trpc";
import { Database } from "lucide-react";
import { allowanceSummaryLine, allowanceUsedUp, allowanceUsedUpReason, isMembershipPlan, planDailyCap, type ProspectAllowance } from "@shared/prospectAllowance";

type AllowanceData = ProspectAllowance | { plan: null; unreadable?: true };

function useAllowance(): AllowanceData | undefined {
  const q = trpc.spend.allowance.useQuery(undefined, { staleTime: 30_000, retry: false });
  return q.data as AllowanceData | undefined;
}

export function ProspectAllowanceCard() {
  const d = useAllowance();
  if (!d) return null;
  if (!isMembershipPlan(d.plan)) {
    if (!("unreadable" in d && d.unreadable)) return null;
    return (
      <section role="status" className="rounded-xl border border-amber-300/70 bg-amber-50/60 dark:bg-amber-950/20 p-4 text-[12.5px]" data-prospect-allowance-card>
        This workspace's prospect-data allowance could not be read just now, so the shared prospect databases are not used until it can be. Your own keys below still work.
      </section>
    );
  }
  const a = d as ProspectAllowance;
  const usedUp = allowanceUsedUp(a);
  const pct = a.limit > 0 ? Math.min(100, Math.round((a.used / a.limit) * 100)) : 100;
  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm space-y-3" data-prospect-allowance-card>
      <div className="flex items-start gap-2.5">
        <Database className="size-4 mt-0.5 shrink-0 text-violet-500" />
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-semibold">Prospect data on the {a.planLabel} plan</h2>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">{allowanceSummaryLine(a)} · up to {planDailyCap(a.plan).toLocaleString("en-US")} a day per source</p>
        </div>
      </div>
      <div
        className="h-1.5 w-full rounded-full bg-muted overflow-hidden"
        role="progressbar"
        aria-label="Prospect data used this month"
        aria-valuemin={0}
        aria-valuemax={a.limit}
        aria-valuenow={Math.min(a.used, a.limit)}
      >
        <div className={usedUp ? "h-full bg-amber-500" : "h-full bg-violet-500"} style={{ width: `${pct}%` }} />
      </div>
      {usedUp ? (
        <p role="status" className="text-[12.5px] text-amber-700 dark:text-amber-400">
          {allowanceUsedUpReason(a)} Campaigns keep working with the people already found.
        </p>
      ) : (
        <p className="text-[12px] text-muted-foreground">
          One unit is a new person added from our prospect databases, or an email they find for someone already here. Imports, searches and previews, LinkedIn lookups through your own account, and anything found with your own keys are not counted.
        </p>
      )}
    </section>
  );
}

/**
 * Above the vendor key cards, for a workspace on a plan only: the cards are
 * optional there (prospect data is included up to the month's number).
 */
export function OwnKeysOptionalHeading() {
  const d = useAllowance();
  if (!d || !isMembershipPlan(d.plan)) return null;
  return (
    <div className="px-1 pt-1" data-own-keys-optional>
      <h3 className="text-[13px] font-semibold">Use your own keys (optional)</h3>
      <p className="text-[12px] text-muted-foreground">
        Not needed to get prospect data on your plan. A key of your own is used first, is never counted, and keeps finding people after the month's number is used.
      </p>
    </div>
  );
}
