/**
 * The Revenue Engine hub's grouping and refresh, apart from the page so tests
 * can call them (audit 2026-10-20, A61; tracker 11).
 */

/** The query cache the hub reads, as far as a refresh needs it. */
export interface HubUtils {
  are: { invalidate: () => Promise<unknown> };
  attention: { summary: { invalidate: () => Promise<unknown> } };
}

/**
 * Refresh EVERYTHING the hub shows (tracker 11: "Refresh is not working").
 * The button refetched the campaign list only, so the funnel, the signals,
 * the data-quality card, the proposals, the routing suggestions and the
 * "awaiting your approval" count all stayed as they were, and with nothing
 * on screen saying a refresh had happened it read as a dead button. Every
 * one of those is an `are.*` query except the approval count.
 */
export function refreshHub(utils: HubUtils): Promise<unknown> {
  return Promise.all([utils.are.invalidate(), utils.attention.summary.invalidate()]);
}

export interface HubCampaignGroups<C> { active: C[]; paused: C[]; draft: C[]; completed: C[] }

/**
 * Campaigns by status. Completed ones were grouped under Draft — every
 * status that was not active or paused — and labelled "Not activated —
 * nothing has sent", which is false of a campaign that ran to the end.
 */
export function groupHubCampaigns<C extends { status: string }>(campaigns: C[] | null | undefined): HubCampaignGroups<C> {
  const all = campaigns ?? [];
  return {
    active: all.filter((c) => c.status === "active"),
    paused: all.filter((c) => c.status === "paused"),
    completed: all.filter((c) => c.status === "completed"),
    // Drafts, and anything else that has never run.
    draft: all.filter((c) => c.status !== "active" && c.status !== "paused" && c.status !== "completed"),
  };
}
