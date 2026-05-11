/**
 * UnipileCalendarAdapter — implements CalendarAdapter against Unipile's
 * calendar API (replaces the dead CalDAV path for M365 accounts).
 *
 * Surface coverage:
 *   listCalendars → GET    /calendars
 *   listEvents    → GET    /calendars/{id}/events?start=...&end=...
 *   createEvent   → POST   /calendars/{id}/events
 *   updateEvent   → PATCH  /calendars/{id}/events/{event_id}
 *   deleteEvent   → DELETE /calendars/{id}/events/{event_id}
 *
 * Notes
 * -----
 * - Unipile event start/end are anyOf objects: timed events carry
 *   { date_time, time_zone }, all-day events carry { date: "YYYY-MM-DD" }.
 *   We coerce both directions in unipileEventToResult / dateToTimestamp.
 * - meetingUrl ↔ conference.url with provider detection from the URL host
 *   (Teams/Meet/Zoom/unknown). Unipile requires a provider on the create
 *   path even when we're just passing through an existing URL.
 * - The bridged calendar_accounts row's `unipileAccountId` column points
 *   at the underlying Unipile account UUID. All API calls scope to that.
 */
import type { CalendarAccount } from "../drizzle/schema";
import type {
  CalendarAdapter,
  CalendarEventInput,
  CalendarEventResult,
  CalendarInfo,
} from "./calendarAdapter";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendars,
  listCalendarEvents,
  updateCalendarEvent,
  type UnipileConferenceProvider,
  type UnipileEvent,
  type UnipileEventTimestamp,
} from "./lib/unipile";

/** Convert a Date plus an allDay flag to Unipile's anyOf timestamp shape. */
function dateToTimestamp(d: Date, allDay: boolean): UnipileEventTimestamp {
  if (allDay) {
    // Use UTC date so we don't accidentally shift days by the server tz.
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return { date: `${yyyy}-${mm}-${dd}` };
  }
  return { date_time: d.toISOString(), time_zone: "UTC" };
}

/** Parse Unipile's anyOf timestamp back to a Date + allDay flag. */
function timestampToDate(ts: UnipileEventTimestamp): { date: Date; allDay: boolean } {
  if ("date_time" in ts && ts.date_time) {
    return { date: new Date(ts.date_time), allDay: false };
  }
  if ("date" in ts && ts.date) {
    // All-day events: start of day in UTC. The calendar UI typically renders
    // these via the allDay flag rather than the time component.
    return { date: new Date(`${ts.date}T00:00:00Z`), allDay: true };
  }
  return { date: new Date(), allDay: false };
}

/** Best-effort meeting-provider detection from a URL host. */
function detectConferenceProvider(url: string): UnipileConferenceProvider {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host.includes("teams.microsoft")) return "teams";
    if (host.includes("meet.google")) return "google_meet";
    if (host.includes("zoom.us") || host.includes("zoom.com")) return "zoom";
  } catch {
    /* not a parseable URL — fall through */
  }
  return "unknown";
}

function unipileEventToResult(ev: UnipileEvent): CalendarEventResult {
  const startInfo = timestampToDate(ev.start);
  const endInfo = timestampToDate(ev.end);
  return {
    externalId: ev.id,
    title: ev.title ?? "",
    description: ev.body ?? undefined,
    location: ev.location ?? undefined,
    meetingUrl: ev.conference?.url ?? undefined,
    startAt: startInfo.date,
    endAt: endInfo.date,
    allDay: ev.is_all_day ?? (startInfo.allDay && endInfo.allDay),
    attendees: (ev.attendees ?? []).map((a) => ({
      email: a.email,
      name: a.display_name,
      responseStatus: a.response_status,
    })),
  };
}

export class UnipileCalendarAdapter implements CalendarAdapter {
  private account: CalendarAccount;
  protected readonly unipileAccountId: string;

  constructor(account: CalendarAccount) {
    this.account = account;
    if (!account.unipileAccountId) {
      throw new Error(
        "UnipileCalendarAdapter requires calendar_accounts.unipileAccountId to be set",
      );
    }
    this.unipileAccountId = account.unipileAccountId;
  }

  protected getAccount(): CalendarAccount {
    return this.account;
  }

  /** GET /calendars — every calendar the connected user can see. */
  async listCalendars(): Promise<CalendarInfo[]> {
    console.log(
      `[UnipileCalendarAdapter] listCalendars account=${this.unipileAccountId}`,
    );
    const res = await listCalendars(this.unipileAccountId);
    return (res.data ?? []).map((c) => ({
      id: c.id,
      name: c.name ?? "Calendar",
      description: c.description ?? undefined,
      color: c.background_color ?? undefined,
      primary: c.is_primary ?? c.is_default ?? false,
    }));
  }

  /**
   * GET /calendars/{id}/events — all events overlapping [from, to].
   * Recurring instances are expanded by Unipile by default.
   */
  async listEvents(
    calendarId: string,
    from: Date,
    to: Date,
  ): Promise<CalendarEventResult[]> {
    console.log(
      `[UnipileCalendarAdapter] listEvents account=${this.unipileAccountId} cal=${calendarId} ${from.toISOString()}..${to.toISOString()}`,
    );
    const res = await listCalendarEvents({
      accountId: this.unipileAccountId,
      calendarId,
      start: from.toISOString(),
      end: to.toISOString(),
      limit: 250,
    });
    return (res.data ?? []).map(unipileEventToResult);
  }

  /** POST /calendars/{id}/events — create a new event. */
  async createEvent(
    calendarId: string,
    event: CalendarEventInput,
  ): Promise<CalendarEventResult> {
    const allDay = event.allDay ?? false;
    const conference = event.meetingUrl
      ? {
          provider: detectConferenceProvider(event.meetingUrl),
          url: event.meetingUrl,
        }
      : undefined;

    const res = await createCalendarEvent({
      accountId: this.unipileAccountId,
      calendarId,
      title: event.title,
      body: event.description,
      location: event.location,
      start: dateToTimestamp(event.startAt, allDay),
      end: dateToTimestamp(event.endAt, allDay),
      attendees: (event.attendees ?? []).map((a) => ({ email: a.email })),
      conference,
      notify: true,
    });

    return {
      externalId: res.event_id,
      title: event.title,
      description: event.description,
      location: event.location,
      meetingUrl: event.meetingUrl,
      startAt: event.startAt,
      endAt: event.endAt,
      allDay,
      attendees: event.attendees ?? [],
    };
  }

  /**
   * PATCH /calendars/{id}/events/{event_id} — partial update.
   *
   * Unipile accepts any subset of the create-body fields. We forward
   * whichever Partial<CalendarEventInput> fields were provided and assume
   * start/end pairing: if only one of {startAt, endAt} is provided, we
   * only send that one (Unipile will keep the other as-is).
   */
  async updateEvent(
    calendarId: string,
    externalId: string,
    event: Partial<CalendarEventInput>,
  ): Promise<CalendarEventResult> {
    const allDay = event.allDay ?? false;
    const conference = event.meetingUrl
      ? {
          provider: detectConferenceProvider(event.meetingUrl),
          url: event.meetingUrl,
        }
      : undefined;

    await updateCalendarEvent({
      accountId: this.unipileAccountId,
      calendarId,
      eventId: externalId,
      title: event.title,
      body: event.description,
      location: event.location,
      start: event.startAt ? dateToTimestamp(event.startAt, allDay) : undefined,
      end: event.endAt ? dateToTimestamp(event.endAt, allDay) : undefined,
      attendees: event.attendees
        ? event.attendees.map((a) => ({ email: a.email }))
        : undefined,
      conference,
      notify: true,
    });

    return {
      externalId,
      title: event.title ?? "",
      description: event.description,
      location: event.location,
      meetingUrl: event.meetingUrl,
      startAt: event.startAt ?? new Date(),
      endAt: event.endAt ?? new Date(),
      allDay,
      attendees: event.attendees ?? [],
    };
  }

  /** DELETE /calendars/{id}/events/{event_id} */
  async deleteEvent(calendarId: string, externalId: string): Promise<void> {
    await deleteCalendarEvent({
      accountId: this.unipileAccountId,
      calendarId,
      eventId: externalId,
    });
  }
}
