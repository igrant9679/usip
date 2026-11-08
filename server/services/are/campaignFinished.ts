/**
 * "This campaign has finished" — an in-app notice to the campaign's owner
 * (audit 2026-10-20, F15). A campaign that reached its target, or whose every
 * sequence had run out, went quiet with nothing saying so: `campaign_completed`
 * was declared in routers/are/notify.ts and sent from nowhere.
 *
 * Two moments, each told once:
 *   · target reached — the working set (every row not rejected, as the
 *     engine's discovery counts it) is at the campaign's target, so discovery
 *     has stopped looking for anyone new;
 *   · sequences ended — at least one step has gone out, nobody is still to be
 *     decided, approved, staged or in a sequence, and no step is waiting.
 * Each stamps its own column (migration 0391) and is cleared when the
 * campaign starts working again (a raised target, new people), so the next
 * finish is told again. In-app only: no email is sent, and the campaign's
 * status is left as it is (marking it complete stays a person's choice).
 *
 * Called from the engine's tick for each active campaign; never throws.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { areCampaigns, areExecutionQueue, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { areNotify } from "../../routers/are/notify";

export interface FinishedCampaign {
  id: number;
  workspaceId: number;
  name: string;
  targetProspectCount: number;
  targetReachedNoticeAt?: Date | null;
  sequencesEndedNoticeAt?: Date | null;
}

export async function noticeCampaignFinished(c: FinishedCampaign, now: Date = new Date()): Promise<{ targetReached: boolean; sequencesEnded: boolean }> {
  const out = { targetReached: false, sequencesEnded: false };
  try {
    const db = await getDb();
    if (!db) return out;
    const scope = and(eq(prospectQueue.workspaceId, c.workspaceId), eq(prospectQueue.campaignId, c.id));
    const [q] = await db.select({
      working: sql<number>`sum(case when ${prospectQueue.sequenceStatus} <> 'skipped' then 1 else 0 end)`,
      inFlight: sql<number>`sum(case when ${prospectQueue.sequenceStatus} in ('pending', 'approved', 'enrolled', 'paused', 'sourcing') then 1 else 0 end)`,
      replied: sql<number>`sum(case when ${prospectQueue.sequenceStatus} = 'replied' then 1 else 0 end)`,
      completed: sql<number>`sum(case when ${prospectQueue.sequenceStatus} = 'completed' then 1 else 0 end)`,
    }).from(prospectQueue).where(scope);
    const working = Number(q?.working ?? 0);
    const inFlight = Number(q?.inFlight ?? 0);
    const exec = and(eq(areExecutionQueue.workspaceId, c.workspaceId), eq(areExecutionQueue.campaignId, c.id));
    const [waiting] = await db.select({ n: sql<number>`count(*)` }).from(areExecutionQueue)
      .where(and(exec, inArray(areExecutionQueue.status, ["scheduled", "paused"])));
    const [sent] = await db.select({ n: sql<number>`count(*)` }).from(areExecutionQueue)
      .where(and(exec, eq(areExecutionQueue.status, "sent")));

    /* Target reached: discovery has stopped. */
    const reached = c.targetProspectCount > 0 && working >= c.targetProspectCount;
    if (reached && !c.targetReachedNoticeAt) {
      await db.update(areCampaigns).set({ targetReachedNoticeAt: now } as never).where(and(eq(areCampaigns.id, c.id), eq(areCampaigns.workspaceId, c.workspaceId)));
      await areNotify({
        workspaceId: c.workspaceId, campaignId: c.id, relatedId: c.id, relatedType: "are_campaign",
        eventType: "campaign_completed",
        title: `${c.name} reached its target`,
        body: `${working.toLocaleString("en-US")} of ${c.targetProspectCount.toLocaleString("en-US")} prospects found, so discovery has stopped looking for more. The people in it carry on through their sequences. Raise the target in the campaign's Settings to find more.`,
      });
      out.targetReached = true;
    } else if (!reached && c.targetReachedNoticeAt) {
      await db.update(areCampaigns).set({ targetReachedNoticeAt: null } as never).where(and(eq(areCampaigns.id, c.id), eq(areCampaigns.workspaceId, c.workspaceId)));
    }

    /* Every sequence has ended. */
    const ended = Number(sent?.n ?? 0) > 0 && inFlight === 0 && Number(waiting?.n ?? 0) === 0;
    if (ended && !c.sequencesEndedNoticeAt) {
      await db.update(areCampaigns).set({ sequencesEndedNoticeAt: now } as never).where(and(eq(areCampaigns.id, c.id), eq(areCampaigns.workspaceId, c.workspaceId)));
      const replied = Number(q?.replied ?? 0), completed = Number(q?.completed ?? 0);
      await areNotify({
        workspaceId: c.workspaceId, campaignId: c.id, relatedId: c.id, relatedType: "are_campaign",
        eventType: "campaign_completed",
        title: `${c.name} has finished its sequences`,
        body: `Every prospect in it has finished: ${replied.toLocaleString("en-US")} replied, ${completed.toLocaleString("en-US")} ran to the end, and no step is waiting.${reached ? "" : ` Discovery keeps looking for more until it reaches the target of ${c.targetProspectCount.toLocaleString("en-US")}.`} Mark it complete or archive it from the campaign page when you are done with it.`,
      });
      out.sequencesEnded = true;
    } else if (!ended && c.sequencesEndedNoticeAt) {
      await db.update(areCampaigns).set({ sequencesEndedNoticeAt: null } as never).where(and(eq(areCampaigns.id, c.id), eq(areCampaigns.workspaceId, c.workspaceId)));
    }
  } catch (e) {
    console.error(`[campaignFinished] campaign ${c.id}:`, (e as Error)?.message ?? e);
  }
  return out;
}

