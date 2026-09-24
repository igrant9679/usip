/**
 * meetingResponses — reads each outstanding meeting invite's answer back from
 * the owner's calendar (owner ask 2026-09-24: "Count bookings only when the
 * prospect accepts").
 *
 * An invite Velocity offered is `invited` until the attendee answers:
 *   accepted  → `scheduled`, and only now the ARE `meeting_booked` signal
 *               (which stops the sequence, bumps the campaign's bookings and
 *               promotes the prospect to the CRM)
 *   declined  → `cancelled`, so no reminder goes to someone who said no
 *   tentative → recorded; still `invited`
 * Only Unipile-bridged (Microsoft 365) calendars report attendee answers; a
 * CalDAV one has none to read and is skipped.
 */
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { calendarAccounts, calendarEvents, meetings } from "../../drizzle/schema";
import { getDb } from "../db";
import { createCalendarAdapter, type CalendarAdapter } from "../calendarAdapter";
import { attributeMeetingBookingToAre } from "../routers/are/execution";
import { archivedWorkspaceIds } from "../_core/workspaceArchive";

export type AttendeeResponse = "none" | "accepted" | "tentative" | "declined";

/**
 * A calendar's answer string, ours. Microsoft says "tentativelyAccepted", so
 * tentative is checked BEFORE accepted; "notResponded", "needsAction" and
 * anything unrecognised are "none".
 */
export function normalizeResponse(raw: string | null | undefined): AttendeeResponse {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("tentative")) return "tentative";
  if (s.includes("declin")) return "declined";
  if (s.includes("accept")) return "accepted";
  return "none";
}

export async function syncInviteResponses(limit = 200): Promise<{
  checked: number; accepted: number; declined: number; tentative: number; failed: number;
}> {
  const out = { checked: 0, accepted: 0, declined: 0, tentative: 0, failed: 0 };
  const db = await getDb();
  if (!db) return out;
  const rows = await db.select({
    id: meetings.id, workspaceId: meetings.workspaceId, contactEmail: meetings.contactEmail,
    calendarEventId: meetings.calendarEventId, calendarAccountId: meetings.calendarAccountId,
    attendeeResponse: meetings.attendeeResponse,
  }).from(meetings).where(and(
    eq(meetings.status, "invited"),
    eq(meetings.inviteSent, true),
    isNotNull(meetings.calendarEventId),
    isNotNull(meetings.calendarAccountId),
    // Answers after the meeting has been and gone change nothing.
    gt(meetings.scheduledAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
  )).limit(limit);
  if (rows.length === 0) return out;

  const archived = await archivedWorkspaceIds();
  const adapters = new Map<number, { adapter: CalendarAdapter; calendarId: string } | null>();
  for (const m of rows) {
    if (archived.has(m.workspaceId)) continue;
    try {
      const accId = m.calendarAccountId!;
      if (!adapters.has(accId)) {
        const [acc] = await db.select().from(calendarAccounts)
          .where(and(eq(calendarAccounts.id, accId), eq(calendarAccounts.workspaceId, m.workspaceId))).limit(1);
        adapters.set(accId, acc ? { adapter: createCalendarAdapter(acc as any), calendarId: acc.calendarId ?? "primary" } : null);
      }
      const cal = adapters.get(accId);
      if (!cal?.adapter.getEvent) continue;
      const [ev] = await db.select({ externalId: calendarEvents.externalId }).from(calendarEvents)
        .where(and(eq(calendarEvents.id, m.calendarEventId!), eq(calendarEvents.workspaceId, m.workspaceId))).limit(1);
      if (!ev) continue;

      out.checked++;
      const event = await cal.adapter.getEvent(cal.calendarId, ev.externalId);
      const email = (m.contactEmail ?? "").trim().toLowerCase();
      const attendee = (event.attendees ?? []).find((a) => (a.email ?? "").trim().toLowerCase() === email);
      const answer = normalizeResponse(attendee?.responseStatus);
      if (answer === ((m.attendeeResponse as AttendeeResponse | null) ?? "none")) continue;

      const set: Record<string, unknown> = {
        attendeeResponse: answer,
        attendeeRespondedAt: answer === "none" ? null : new Date(),
      };
      if (answer === "accepted") set.status = "scheduled";
      if (answer === "declined") set.status = "cancelled";
      await db.update(meetings).set(set as never).where(and(
        eq(meetings.id, m.id), eq(meetings.workspaceId, m.workspaceId), eq(meetings.status, "invited"),
      ));
      if (answer === "accepted") {
        out.accepted++;
        await attributeMeetingBookingToAre(m.workspaceId, { id: m.id, contactEmail: m.contactEmail });
      } else if (answer === "declined") out.declined++;
      else if (answer === "tentative") out.tentative++;
    } catch (e) {
      out.failed++;
      console.error(`[MeetingResponses] meeting ${m.id}:`, e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}
