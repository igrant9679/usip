/**
 * The one definition of "which meeting statuses are still live".
 *
 * `meetings.status` has seven values. Three places asked a question about them
 * and each answered it with its own array literal — and no two agreed:
 *
 *   bookingLinks.BUSY_MEETING_STATUSES     proposed invited scheduled rescheduled
 *   meetingScheduler.ACTIVE_MEETING_STATUSES  proposed invited scheduled
 *   meetingReminders.REMINDER_STATUSES                 invited scheduled
 *
 * 🔴 `rescheduled` was missing from the autopilot's dedupe. That array decides
 * whether a prospect ALREADY has a live meeting, so a prospect who rescheduled
 * stopped counting, read as having no meeting, and the autopilot proposed a
 * second one — in `auto` mode, sending them a second invite. Verbatim the
 * dealAutopilot/`snoozed` finding (9f2e78f): the user moved the meeting, the
 * engine booked another.
 *
 * 🔴 And missing from the reminder set, where the effect is the opposite: a
 * meeting the attendee MOVED got no reminder at all, while the original time
 * had already had one.
 *
 * LIVE and CLOSED are exhaustive and disjoint over the enum, and the guard
 * parses the enum out of schema.ts — so an eighth status fails the build until
 * somebody decides which side it belongs on, rather than defaulting to "not
 * live" and quietly disabling every check at once.
 */

/**
 * Every value of the `meetings.status` enum, in schema order.
 *
 * A `const` tuple so `z.enum(MEETING_STATUSES)` takes it directly and the union
 * below is DERIVED — a hand-written union beside a hand-written array is its
 * own drift pair.
 */
export const MEETING_STATUSES = [
  "proposed",
  "invited",
  "scheduled",
  "completed",
  "no_show",
  "cancelled",
  "rescheduled",
] as const;

export type MeetingStatus = (typeof MEETING_STATUSES)[number];

/**
 * Statuses meaning "this meeting is still ahead of us".
 *
 * `proposed` counts: it is a real candidate holding a slot, and treating it as
 * absent is what lets a second one be created for the same prospect.
 * `rescheduled` counts for the same reason it counts as busy — it has a new
 * time in the future and somebody is expected to attend it.
 */
export const LIVE_MEETING_STATUSES: readonly MeetingStatus[] = [
  "proposed",
  "invited",
  "scheduled",
  "rescheduled",
];

/** Statuses meaning the meeting is finished with, one way or the other. */
export const CLOSED_MEETING_STATUSES: readonly MeetingStatus[] = [
  "completed",
  "no_show",
  "cancelled",
];

/**
 * Statuses where THE ATTENDEE HAS A TIME — the only ones we may email a
 * reminder about.
 *
 * ⚠️ `proposed` is deliberately excluded and that exclusion is load-bearing.
 * A proposed meeting is an AI-drafted candidate the attendee has never agreed
 * to; "a quick reminder about our meeting" would be asserting an appointment
 * that does not exist, to a stranger. This is NOT the live set minus nothing —
 * it is a narrower question, which is why it has its own name rather than
 * reusing LIVE_MEETING_STATUSES.
 *
 * (A booking-link booking is never left `proposed`: bookSlotForLink inserts it
 * as proposed and sendMeetingInvite moves it to `scheduled` on both the
 * provider-success and local-record paths.)
 */
export const REMINDABLE_MEETING_STATUSES: readonly MeetingStatus[] = [
  "invited",
  "scheduled",
  "rescheduled",
];

/**
 * Statuses meaning A MEETING WAS ACTUALLY BOOKED — it happened, or is still
 * going to.
 *
 * 🔴 Spans LIVE and CLOSED on purpose. `meetings.stats.booked` counts only
 * `scheduled` + `invited`, so the Analytics "Meetings booked" band FELL every
 * time a meeting took place: the number the product optimises for went down
 * when it succeeded (2026-09-20). A funnel band that empties as meetings
 * complete is not a funnel band.
 *
 * `proposed` is excluded — an AI-drafted candidate the attendee never agreed
 * to, the same exclusion REMINDABLE makes and for the same reason — and
 * `cancelled` is excluded because the booking was undone.
 *
 * `invited` is excluded too (owner ask 2026-09-24: "Count bookings only when
 * the prospect accepts"): an invite the attendee has not accepted is not a
 * booking. It becomes `scheduled` when they accept (services/meetingResponses).
 *
 * A third question, not a set operation on the two above: BOOKED deliberately
 * overlaps both, which is why it is named rather than derived.
 */
export const BOOKED_MEETING_STATUSES: readonly MeetingStatus[] = [
  "scheduled",
  "rescheduled",
  "completed",
  "no_show",
];

/** Mutable copies for Drizzle's `inArray`, which does not take a readonly array. */
export function liveMeetingStatuses(): MeetingStatus[] {
  return [...LIVE_MEETING_STATUSES];
}

export function remindableMeetingStatuses(): MeetingStatus[] {
  return [...REMINDABLE_MEETING_STATUSES];
}

export function bookedMeetingStatuses(): MeetingStatus[] {
  return [...BOOKED_MEETING_STATUSES];
}

export function isLiveMeetingStatus(status: string): boolean {
  return (LIVE_MEETING_STATUSES as readonly string[]).includes(status);
}
