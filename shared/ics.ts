/**
 * ics.ts — calendar files (RFC 5545), built here and never sent to a
 * calendar provider.
 *
 * Two batches of the audit's final pass (2026-11-07) each wrote one and they
 * met at the merge; this is the one module now:
 *   · buildCalendarIcs: any event, timed or all-day (U27, a QBR's invite,
 *     downloaded from the QBRs page).
 *   · buildIcs: a booked meeting (F47), attached to the booking confirmation
 *     and offered on the booking's own page. It is buildCalendarIcs with the
 *     meeting's start and length.
 *
 * Both are METHOD:PUBLISH ("add this"), not REQUEST: a REQUEST asks the
 * recipient's client to RSVP to an organizer who will never read the answer.
 * Pure, so the server, the pages and the tests build the same file.
 */

export type CalendarIcsEvent = {
  /** Stable per event, so importing the file twice updates rather than duplicates. */
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  start: Date;
  /** For a timed event (an hour when missing); ignored when allDay. */
  end?: Date | null;
  /** A day with no time: DTSTART;VALUE=DATE, ending the next day. */
  allDay?: boolean;
  /** The calendar day of an all-day event, "YYYY-MM-DD" (start's UTC day when omitted). */
  day?: string | null;
  /** When the file was made (DTSTAMP). */
  stamp?: Date;
  /** The PRODID product name, e.g. "QBR" or "Booking". */
  product?: string;
};

/** A booked meeting (F47). */
export type IcsEvent = {
  /** Stable per meeting, so a second download replaces rather than duplicates. */
  uid: string;
  title: string;
  startAt: Date;
  durationMin: number;
  description?: string | null;
  location?: string | null;
  url?: string | null;
};

/** The UID of a booked meeting's file: the same from the email, the booking page and its own page. */
export function bookingIcsUid(workspaceId: number, meetingId: number): string {
  return `booking-${workspaceId}-${meetingId}@velocity`;
}

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const ymd = (day: string) => day.replace(/-/g, "");

/** RFC 5545 TEXT: backslash, semicolon, comma and line breaks escaped. */
export function icsText(v: string): string {
  return String(v ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

/** The booking module's name for icsText. */
export const icsEscape = icsText;

/** Lines longer than 75 octets are folded: CRLF then one space (RFC 5545 §3.1). */
export function foldIcsLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  for (const ch of Array.from(line)) {
    const n = new TextEncoder().encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (curLen + n > limit) { out.push(cur); cur = ""; curLen = 0; }
    cur += ch;
    curLen += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

function nextDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function buildCalendarIcs(e: CalendarIcsEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//Velocity//${e.product ?? "Velocity"}//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsText(e.uid)}`,
    `DTSTAMP:${utcStamp(e.stamp ?? new Date())}`,
  ];
  if (e.allDay) {
    const day = e.day ?? e.start.toISOString().slice(0, 10);
    lines.push(`DTSTART;VALUE=DATE:${ymd(day)}`, `DTEND;VALUE=DATE:${ymd(nextDay(day))}`);
  } else {
    const end = e.end && e.end.getTime() > e.start.getTime() ? e.end : new Date(e.start.getTime() + 60 * 60_000);
    lines.push(`DTSTART:${utcStamp(e.start)}`, `DTEND:${utcStamp(end)}`);
  }
  lines.push(`SUMMARY:${icsText(e.title)}`);
  if (e.description) lines.push(`DESCRIPTION:${icsText(e.description)}`);
  if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/** A booked meeting's file (F47): its start and length. */
export function buildIcs(e: IcsEvent, now: Date = new Date()): string {
  return buildCalendarIcs({
    uid: e.uid,
    title: e.title,
    description: e.description,
    location: e.location,
    url: e.url,
    start: e.startAt,
    end: new Date(e.startAt.getTime() + e.durationMin * 60_000),
    stamp: now,
    product: "Booking",
  });
}
