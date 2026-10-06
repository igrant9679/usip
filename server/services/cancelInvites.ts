/**
 * cancelInvites.ts — cancel invites that already went out, for real.
 *
 * Owner ask 2026-10-06 ("Cancel all 9"), after a bulk "Approve & send all"
 * sent nine invites while LSI Media was paused. Unlike meetings.removeBookings
 * (which never touches the provider calendar), this deletes the event on the
 * owner's calendar, which is what sends each attendee a cancellation: the
 * owner chose that. Each meeting is marked cancelled and loses Velocity's copy
 * of the event; no rebound task is made (a cleanup, not a prospect
 * cancelling). Dry run by default; every real cancel is audited.
 */
import { and, eq, inArray } from "drizzle-orm";
import { calendarAccounts, calendarEvents, meetings } from "../../drizzle/schema";
import { getDb } from "../db";
import { createCalendarAdapter } from "../calendarAdapter";
import { recordAudit } from "../audit";
import { remindableMeetingStatuses } from "@shared/meetingStatus";

export type CancelResult = { id: number; contact: string | null; scheduledAt: Date | null; outcome: string };

export async function cancelSentInvites(workspaceId: number, ids: number[], opts: { dryRun: boolean; actorUserId: number }): Promise<CancelResult[]> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const rows = await db.select().from(meetings).where(and(eq(meetings.workspaceId, workspaceId), inArray(meetings.id, ids)));
  const results: CancelResult[] = [];
  for (const m of rows) {
    const base = { id: m.id, contact: m.contactEmail ?? m.contactName ?? null, scheduledAt: m.scheduledAt ?? null };
    if (!(remindableMeetingStatuses() as string[]).includes(String(m.status)) || !m.inviteSent) {
      results.push({ ...base, outcome: `skipped: status ${m.status}${m.inviteSent ? "" : ", no invite sent"}` });
      continue;
    }
    const [ev] = m.calendarEventId
      ? await db.select().from(calendarEvents).where(and(eq(calendarEvents.id, m.calendarEventId), eq(calendarEvents.workspaceId, workspaceId))).limit(1)
      : [];
    const [acc] = m.calendarAccountId
      ? await db.select().from(calendarAccounts).where(and(eq(calendarAccounts.id, m.calendarAccountId), eq(calendarAccounts.workspaceId, workspaceId))).limit(1)
      : [];
    if (opts.dryRun) {
      results.push({ ...base, outcome: ev?.externalId && acc ? "would cancel on the calendar" : "would cancel in Velocity only (no calendar event found)" });
      continue;
    }
    let calendar = "no calendar event found";
    if (ev?.externalId && acc) {
      try {
        await createCalendarAdapter(acc as never).deleteEvent(acc.calendarId ?? "primary", ev.externalId);
        calendar = "deleted on the calendar (attendee notified)";
      } catch (e) {
        calendar = `calendar delete failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
      }
    }
    // A failed delete leaves the meeting as it was, so it can be retried: the event is still on the calendar.
    if (calendar.startsWith("calendar delete failed")) {
      results.push({ ...base, outcome: calendar });
      continue;
    }
    if (ev) await db.delete(calendarEvents).where(and(eq(calendarEvents.id, ev.id), eq(calendarEvents.workspaceId, workspaceId)));
    await db.update(meetings).set({ status: "cancelled", calendarEventId: null } as never)
      .where(and(eq(meetings.id, m.id), eq(meetings.workspaceId, workspaceId)));
    await recordAudit({
      workspaceId, actorUserId: opts.actorUserId, action: "update", entityType: "meeting", entityId: m.id,
      before: { status: m.status, calendarEventId: m.calendarEventId },
      after: { status: "cancelled", cancelledSentInvite: true, calendar },
    });
    results.push({ ...base, outcome: calendar });
  }
  return results;
}
