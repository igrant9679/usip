/**
 * The campaign header's funnel counters, recounted from the rows — ONE helper
 * (audit 2026-10-20, A50).
 *
 * There were two meanings of "Approved". The engine's counter phase counted
 * everyone approved or further along (approved, enrolled, completed,
 * replied), while "Approve all" and approveBatch wrote the count of rows
 * whose status was exactly `approved` — so the number on the header dropped
 * the moment someone pressed Approve all on a campaign with people already
 * sending. And the engine only recounts ACTIVE campaigns, so a paused
 * campaign's header froze at whatever it said when it was paused, however
 * many people were approved or rejected afterwards.
 *
 * Every stage counts the people who reached it, so the header reads as a
 * funnel. A paused prospect was enrolled, so it counts as approved and
 * enrolled — pausing someone no longer takes them off both counters.
 * Contacted is the engine's own expression (performanceMetrics reads the
 * same): distinct prospects with a sent step. meetingsBooked and
 * opportunitiesCreated are the Signal Feedback Agent's and are not touched.
 */
import { and, eq, sql } from "drizzle-orm";
import { areCampaigns, areExecutionQueue, prospectQueue } from "../../../drizzle/schema";

type Db = any;

const APPROVED_OR_LATER = ["approved", "enrolled", "paused", "completed", "replied"];
const ENROLLED_OR_LATER = ["enrolled", "paused", "completed", "replied"];

export interface CampaignCounters {
  prospectsDiscovered: number;
  prospectsEnriched: number;
  prospectsApproved: number;
  prospectsEnrolled: number;
  prospectsContacted: number;
  prospectsReplied: number;
}

/** Count the campaign's funnel from its rows and store it on the campaign. */
export async function recountCampaignCounters(db: Db, workspaceId: number, campaignId: number): Promise<CampaignCounters> {
  const cells: Array<{ seq: string; enr: string; n: number }> = await db
    .select({ seq: prospectQueue.sequenceStatus, enr: prospectQueue.enrichmentStatus, n: sql<number>`count(*)` })
    .from(prospectQueue)
    .where(and(eq(prospectQueue.campaignId, campaignId), eq(prospectQueue.workspaceId, workspaceId)))
    .groupBy(prospectQueue.sequenceStatus, prospectQueue.enrichmentStatus);
  const [contacted] = await db
    .select({ n: sql<number>`count(distinct ${areExecutionQueue.prospectQueueId})` })
    .from(areExecutionQueue)
    .where(and(
      // Campaign ids are globally unique, so the workspace is defence in
      // depth — but every count here carries the tenant.
      eq(areExecutionQueue.workspaceId, workspaceId),
      eq(areExecutionQueue.campaignId, campaignId),
      eq(areExecutionQueue.status, "sent"),
    ));
  const sum = (pick: (c: { seq: string; enr: string }) => boolean) =>
    cells.reduce((s, c) => s + (pick(c) ? Number(c.n) : 0), 0);
  const counters: CampaignCounters = {
    prospectsDiscovered: sum(() => true),
    prospectsEnriched: sum((c) => c.enr === "complete"),
    prospectsApproved: sum((c) => APPROVED_OR_LATER.includes(c.seq)),
    prospectsEnrolled: sum((c) => ENROLLED_OR_LATER.includes(c.seq)),
    prospectsContacted: Number(contacted?.n ?? 0),
    prospectsReplied: sum((c) => c.seq === "replied"),
  };
  await db.update(areCampaigns).set(counters)
    .where(and(eq(areCampaigns.id, campaignId), eq(areCampaigns.workspaceId, workspaceId)));
  return counters;
}
