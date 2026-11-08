/**
 * ics.ts — one calendar file for a booked meeting (audit 2026-10-20, F47).
 *
 * Attached to the booking confirmation email and offered as a download on the
 * booking's own page, so a person whose host has no calendar connected can
 * still put the meeting in theirs. METHOD:PUBLISH ("add this"), not REQUEST:
 * a REQUEST asks the recipient's client to RSVP to an organizer who will never
 * read the answer. Pure, so the server and the page build the same file.
 */

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

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, and newlines. */
export function icsEscape(s: string): string {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** UTC basic format, 20261110T150000Z. */
function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Lines longer than 75 octets are folded with CRLF + space (RFC 5545 3.1). */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += 73) parts.push(line.slice(i, i + 73));
  return parts.join("\r\n ");
}

export function buildIcs(e: IcsEvent, now: Date = new Date()): string {
  const end = new Date(e.startAt.getTime() + e.durationMin * 60_000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Velocity//Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${icsEscape(e.uid)}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(e.startAt)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${icsEscape(e.title)}`,
  ];
  if (e.description) lines.push(`DESCRIPTION:${icsEscape(e.description)}`);
  if (e.location) lines.push(`LOCATION:${icsEscape(e.location)}`);
  if (e.url) lines.push(`URL:${e.url}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
