/**
 * Undo the ARE "meeting booked" signals that fired for invites nobody accepted
 * (owner ask 2026-09-24: "Undo the meeting-booked effects for the 24
 * prospects": 22 CommunityForce, 2 LSI Media).
 *
 * Until b247ad0 sending an invite fired `meeting_booked` at once. For each
 * such signal whose meeting was never accepted (the bookings were since
 * removed: status `cancelled`, no `accepted` answer), this reverses what the
 * signal did, the same reversal migration 0175 made for the phantom
 * bookings:
 *   • the prospect's sequenceStatus goes from `replied` back to `enrolled`,
 *     unless a real reply signal of theirs justifies `replied`;
 *   • steps the dispatch skipped BECAUSE of that status ("Prospect no longer
 *     enrolled (status: replied)") since the signal are put back, spaced a
 *     campaign gap apart by the self-heal planner, never as a burst;
 *   • the campaign's meetingsBooked comes back down;
 *   • the signal row is deleted, so a REAL acceptance later still counts
 *     (attribution counts only a prospect's first meeting_booked).
 * CRM records the signal created (a contact, maybe an opportunity) are
 * reported, never deleted here: that is the owner's separate call.
 * Dry run by default.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { areCampaigns, areExecutionQueue, areSignalLog, meetings, prospectQueue } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { effectiveStepGapDays, planHealRevival, type HealRow } from "@shared/areStepCadence";

export const REPLIED_SKIP_REASON = "Prospect no longer enrolled (status: replied)";
const REPLY_SIGNALS = ["email_reply", "linkedin_reply", "sms_reply", "voice_connected_interested", "voice_connected_not_interested"] as const;

export interface UndoRow {
  signalId: number;
  prospectQueueId: number;
  campaignId: number;
  meetingId: number;
  name: string;
  statusBefore: string;
  restoresStatus: boolean;
  keptReason?: string;
  stepsRevived: number;
  crm: { contactId: number | null; opportunityId: number | null };
}

export async function undoInviteBookingSignals(
  workspaceId: number,
  opts: { dryRun?: boolean } = {},
): Promise<{ dryRun: boolean; undone: number; rows: UndoRow[] }> {
  const dryRun = opts.dryRun ?? true;
  const db = await getDb();
  if (!db) return { dryRun, undone: 0, rows: [] };

  const signals = await db.select({
    id: areSignalLog.id, prospectQueueId: areSignalLog.prospectQueueId, campaignId: areSignalLog.campaignId,
    rawPayload: areSignalLog.rawPayload, processedAt: areSignalLog.processedAt,
  }).from(areSignalLog).where(and(
    eq(areSignalLog.workspaceId, workspaceId),
    eq(areSignalLog.signalType, "meeting_booked"),
  ));
  const bySend = signals
    .map((s) => ({ ...s, payload: (s.rawPayload ?? {}) as { source?: string; meetingId?: number } }))
    .filter((s) => s.payload.source === "autonomous_booking" && typeof s.payload.meetingId === "number");
  if (bySend.length === 0) return { dryRun, undone: 0, rows: [] };

  // Only meetings that were never accepted and have since been taken out.
  const mtgs = await db.select({ id: meetings.id, status: meetings.status, attendeeResponse: meetings.attendeeResponse })
    .from(meetings).where(and(eq(meetings.workspaceId, workspaceId), inArray(meetings.id, bySend.map((s) => s.payload.meetingId!))));
  const unaccepted = new Set(mtgs.filter((m) => m.status === "cancelled" && m.attendeeResponse !== "accepted").map((m) => m.id));
  const targets = bySend.filter((s) => unaccepted.has(s.payload.meetingId!));
  if (targets.length === 0) return { dryRun, undone: 0, rows: [] };

  const pids = Array.from(new Set(targets.map((t) => t.prospectQueueId)));
  const prospects = await db.select({
    id: prospectQueue.id, firstName: prospectQueue.firstName, lastName: prospectQueue.lastName,
    sequenceStatus: prospectQueue.sequenceStatus, linkedContactId: prospectQueue.linkedContactId,
    linkedOpportunityId: prospectQueue.linkedOpportunityId,
  }).from(prospectQueue).where(and(eq(prospectQueue.workspaceId, workspaceId), inArray(prospectQueue.id, pids)));
  const replies = await db.select({ prospectQueueId: areSignalLog.prospectQueueId }).from(areSignalLog).where(and(
    eq(areSignalLog.workspaceId, workspaceId),
    inArray(areSignalLog.prospectQueueId, pids),
    inArray(areSignalLog.signalType, [...REPLY_SIGNALS]),
  ));
  const replied = new Set(replies.map((r) => r.prospectQueueId));
  const campIds = Array.from(new Set(targets.map((t) => t.campaignId)));
  const camps = await db.select({ id: areCampaigns.id, stepGapDays: areCampaigns.stepGapDays })
    .from(areCampaigns).where(and(eq(areCampaigns.workspaceId, workspaceId), inArray(areCampaigns.id, campIds)));
  const gapOf = new Map(camps.map((c) => [c.id, effectiveStepGapDays(c.stepGapDays)]));

  const rows: UndoRow[] = [];
  const nowMs = Date.now();
  for (const t of targets) {
    const p = prospects.find((x) => x.id === t.prospectQueueId);
    if (!p) continue;
    const restoresStatus = p.sequenceStatus === "replied" && !replied.has(p.id);
    const keptReason = p.sequenceStatus !== "replied"
      ? `status is ${p.sequenceStatus}, not replied`
      : replied.has(p.id) ? "they really replied" : undefined;

    // Every queue row of this prospect in this campaign; the ones skipped by
    // the fake "replied" since the signal are the revivable ones.
    const q = await db.select({
      id: areExecutionQueue.id, stepIndex: areExecutionQueue.stepIndex, status: areExecutionQueue.status,
      scheduledAt: areExecutionQueue.scheduledAt, executedAt: areExecutionQueue.executedAt,
      failureReason: areExecutionQueue.failureReason,
    }).from(areExecutionQueue).where(and(
      eq(areExecutionQueue.workspaceId, workspaceId),
      eq(areExecutionQueue.campaignId, t.campaignId),
      eq(areExecutionQueue.prospectQueueId, p.id),
    ));
    const since = new Date(t.processedAt).getTime() - 60_000;
    const skippedByUs = new Set(q.filter((r) =>
      r.status === "skipped" && r.failureReason === REPLIED_SKIP_REASON
      && r.executedAt && new Date(r.executedAt).getTime() >= since).map((r) => r.id));
    const plan = restoresStatus
      ? planHealRevival(q.map((r): HealRow => ({
          id: r.id, stepIndex: r.stepIndex, scheduledAt: r.scheduledAt, executedAt: r.executedAt,
          // The planner revives `failed` rows it is told are healable.
          status: skippedByUs.has(r.id) ? "failed" : r.status,
          healable: skippedByUs.has(r.id),
        })), gapOf.get(t.campaignId) ?? effectiveStepGapDays(null), nowMs)
      : { revive: [], supersede: [], reschedule: [] };

    rows.push({
      signalId: t.id, prospectQueueId: p.id, campaignId: t.campaignId, meetingId: t.payload.meetingId!,
      name: `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim(),
      statusBefore: p.sequenceStatus, restoresStatus, keptReason,
      stepsRevived: plan.revive.length,
      crm: { contactId: p.linkedContactId ?? null, opportunityId: p.linkedOpportunityId ?? null },
    });
    if (dryRun) continue;

    if (restoresStatus) {
      await db.update(prospectQueue).set({ sequenceStatus: "enrolled" } as never).where(and(
        eq(prospectQueue.id, p.id), eq(prospectQueue.workspaceId, workspaceId), eq(prospectQueue.sequenceStatus, "replied"),
      ));
      for (const v of plan.revive) {
        await db.update(areExecutionQueue)
          .set({ status: "scheduled", failureReason: null, executedAt: null, scheduledAt: v.to } as never)
          .where(and(eq(areExecutionQueue.id, v.id), eq(areExecutionQueue.status, "skipped"), eq(areExecutionQueue.failureReason, REPLIED_SKIP_REASON)));
      }
      for (const c of plan.reschedule) {
        await db.update(areExecutionQueue).set({ scheduledAt: c.to } as never)
          .where(and(eq(areExecutionQueue.id, c.id), eq(areExecutionQueue.status, "scheduled")));
      }
    }
    await db.execute(sql`UPDATE are_campaigns SET meetingsBooked = GREATEST(0, meetingsBooked - 1) WHERE id = ${t.campaignId} AND workspaceId = ${workspaceId}`);
    await db.delete(areSignalLog).where(and(eq(areSignalLog.id, t.id), eq(areSignalLog.workspaceId, workspaceId)));
  }
  return { dryRun, undone: dryRun ? 0 : rows.length, rows };
}

