/**
 * Leads whose engagement just changed, waiting to be re-scored (audit
 * 2026-10-20, P12).
 *
 * An open, a click or a reply should move a lead's score, but the tracking
 * pixel and the reply poller are hot paths, so they only note the lead here,
 * with no database work. The hourly lead re-score (routers/leadScoring
 * `runLeadRescoreTick`) takes them first. Kept in memory and capped: a lead
 * lost to a restart or a full queue is still re-scored by the daily sweep.
 */

/** Pending leads, keyed "workspaceId:leadId" so a lead opened ten times waits once. */
const pending = new Map<string, { workspaceId: number; leadId: number }>();

export const LEAD_RESCORE_QUEUE_MAX = 5000;

export function noteLeadEngagement(workspaceId: number | null | undefined, leadId: number | null | undefined): void {
  if (!workspaceId || !leadId) return;
  const key = `${workspaceId}:${leadId}`;
  if (pending.has(key) || pending.size >= LEAD_RESCORE_QUEUE_MAX) return;
  pending.set(key, { workspaceId, leadId });
}

/** Remove and return up to `n` pending leads, oldest first. */
export function takeEngagedLeads(n: number): Array<{ workspaceId: number; leadId: number }> {
  const out: Array<{ workspaceId: number; leadId: number }> = [];
  for (const [key, v] of Array.from(pending.entries())) {
    if (out.length >= n) break;
    pending.delete(key);
    out.push(v);
  }
  return out;
}

export function pendingEngagedLeads(): number {
  return pending.size;
}

export function __resetLeadRescoreQueueForTests(): void {
  pending.clear();
}
