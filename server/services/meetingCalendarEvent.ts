/**
 * meetingCalendarEvent.ts — a meeting's invite follows the meeting (audit
 * 2026-10-20, O28).
 *
 * meetings.cancel and meetings.reschedule changed the row and nothing else.
 * The invite stayed on the owner's calendar at the old time: a cancelled
 * meeting was still in the attendee's calendar, and a moved one was in it at
 * the time they no longer expected, while the reminder (keyed to the row)
 * named the new time. Deleting or moving the provider event is what tells the
 * attendee, so that is what these do — the same way cancelInvites.ts deletes
 * one.
 *
 * A meeting has a provider event when sendMeetingInvite booked it on a
 * connected calendar: `calendarEventId` (Velocity's copy, which holds the
 * provider's externalId) and `calendarAccountId`. Anything else was never on
 * a calendar, and these report "none".
 */
import { and, eq } from "drizzle-orm";
import { calendarAccounts, calendarEvents, type meetings } from "../../drizzle/schema";
import { createCalendarAdapter } from "../calendarAdapter";
import type { getDb } from "../db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Meeting = Pick<typeof meetings.$inferSelect, "id" | "title" | "durationMin" | "calendarEventId" | "calendarAccountId">;

/** none: never on a calendar. done: deleted / moved. gone: already removed there by hand. failed: the provider refused. */
export type CalendarOutcome =
  | { kind: "none" }
  | { kind: "done" }
  | { kind: "gone" }
  | { kind: "failed"; detail: string };

/** Provider errors put the long URL first and the reason last, so the END is kept. */
function tail(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  return msg.length > 220 ? `…${msg.slice(-220)}` : msg;
}

/** Deleted in the calendar by hand: the outcome wanted, not a failure. */
function isGone(e: unknown): boolean {
  return /\b404\b|not[ _]found|does not exist/i.test(String((e as Error)?.message ?? e));
}

async function eventFor(db: Db, workspaceId: number, m: Meeting) {
  if (!m.calendarEventId || !m.calendarAccountId) return null;
  const [ev] = await db.select().from(calendarEvents)
    .where(and(eq(calendarEvents.id, m.calendarEventId), eq(calendarEvents.workspaceId, workspaceId))).limit(1);
  const [acc] = await db.select().from(calendarAccounts)
    .where(and(eq(calendarAccounts.id, m.calendarAccountId), eq(calendarAccounts.workspaceId, workspaceId))).limit(1);
  if (!ev?.externalId || !acc) return null;
  return { ev, acc };
}

/** True when cancelling or moving this meeting would reach an attendee through their calendar. */
export async function hasCalendarEvent(db: Db, workspaceId: number, m: Meeting): Promise<boolean> {
  return (await eventFor(db, workspaceId, m)) !== null;
}

/**
 * Delete the meeting's event on the owner's calendar (the attendee gets the
 * cancellation) and Velocity's copy of it. On a refusal nothing is changed,
 * so the cancel can be tried again.
 */
export async function deleteMeetingEvent(db: Db, workspaceId: number, m: Meeting): Promise<CalendarOutcome> {
  const found = await eventFor(db, workspaceId, m);
  if (!found) return { kind: "none" };
  let outcome: CalendarOutcome = { kind: "done" };
  try {
    await createCalendarAdapter(found.acc as never).deleteEvent(found.acc.calendarId ?? "primary", found.ev.externalId!);
  } catch (e) {
    if (!isGone(e)) return { kind: "failed", detail: tail(e) };
    outcome = { kind: "gone" };
  }
  await db.delete(calendarEvents).where(and(eq(calendarEvents.id, found.ev.id), eq(calendarEvents.workspaceId, workspaceId)));
  return outcome;
}

/**
 * Move the meeting's event to `startAt` (the attendee gets the update) and
 * Velocity's copy with it. The whole event is sent, not only the times: the
 * CalDAV adapter rebuilds the event from what it is given, so a partial
 * update would blank the title.
 */
export async function moveMeetingEvent(db: Db, workspaceId: number, m: Meeting, startAt: Date): Promise<CalendarOutcome> {
  const found = await eventFor(db, workspaceId, m);
  if (!found) return { kind: "none" };
  const { ev, acc } = found;
  const endAt = new Date(startAt.getTime() + (m.durationMin ?? 30) * 60_000);
  const attendees = (Array.isArray(ev.attendees) ? ev.attendees as Array<{ email?: string; name?: string }> : [])
    .filter((a): a is { email: string; name?: string } => typeof a?.email === "string" && !!a.email)
    .map((a) => ({ email: a.email, name: a.name }));
  try {
    await createCalendarAdapter(acc as never).updateEvent(acc.calendarId ?? "primary", ev.externalId!, {
      title: ev.title || m.title,
      description: ev.description ?? undefined,
      location: ev.location ?? undefined,
      startAt,
      endAt,
      attendees: attendees.length ? attendees : undefined,
    });
  } catch (e) {
    if (isGone(e)) {
      // Removed in the calendar by hand: there is nothing left to move, and
      // Velocity's copy is stale.
      await db.delete(calendarEvents).where(and(eq(calendarEvents.id, ev.id), eq(calendarEvents.workspaceId, workspaceId)));
      return { kind: "gone" };
    }
    return { kind: "failed", detail: tail(e) };
  }
  await db.update(calendarEvents).set({ startAt, endAt } as never)
    .where(and(eq(calendarEvents.id, ev.id), eq(calendarEvents.workspaceId, workspaceId)));
  return { kind: "done" };
}
