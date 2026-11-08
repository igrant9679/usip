/**
 * Every cached read that changes when a deal or a customer does — invalidated
 * together, in one place (audit 2026-10-20, R31).
 *
 * Writers invalidated whatever their own screen showed: moving a card on the
 * Pipeline refreshed the board and nothing else, Deals refreshed the board and
 * the summary, a drawer delete refreshed one list. Quota attainment, Forecast,
 * the Dashboard's numbers, Customers (a win makes one) and the proposals that
 * name the deal stayed on the old figures until the 30-second stale time ran
 * out. The same shape as `invalidateEnrollmentReads` (PR #33): one function
 * per family, called on success, and no change to the global cache timing.
 *
 * These do not wrap `onError`: every writer keeps its own, where
 * `clientMutationErrors` can see it.
 */
import { trpc } from "@/lib/trpc";

type Utils = ReturnType<typeof trpc.useUtils>;

/**
 * Customers, their KPIs, the renewals board, QBRs and amendments. Returns the
 * refetch's promise (audit X1.7, lib/entityCache.ts) so a caller can await it.
 */
export function invalidateCustomerReads(utils: Utils): Promise<void> {
  return utils.cs.invalidate();
}

/** After any deal is created, moved, edited, priced or deleted. */
export function invalidateDealReads(utils: Utils): Promise<void> {
  return Promise.all([
    // board, list, summary, forecast, forecastByRep, dashboardStats,
    // revenueChart, stageFunnel, topReps, winLoss, get, getWithRelated,
    // getTimeline, stageHistory, listLineItems.
    utils.opportunities.invalidate(),
    // Attainment counts won deals.
    utils.quota.progress.invalidate(),
    // A win makes a customer; a deleted deal can take one's value with it.
    invalidateCustomerReads(utils),
    // A proposal shows its linked deal.
    utils.proposals.list.invalidate(),
    utils.proposals.get.invalidate(),
    // Saved dashboards' deal widgets.
    utils.dashboards.invalidate(),
    // Co-owners, deal intelligence and stage history (audit X1.7).
    utils.oppIntelligence.invalidate(),
    // Stuck-deal alerts and the attention panel count open deals.
    utils.pipelineAlerts.invalidate(),
    utils.attention.summary.invalidate(),
  ]).then(() => undefined);
}
