/**
 * One calendar event as an .ics file (RFC 5545), for a download the person
 * opens in their own calendar (audit 2026-10-20, U27: a QBR carried no time
 * and no invite). Nothing is sent and no calendar provider is called: the
 * file is built here and saved by the browser.
 *
 * Pure, so a test reads every line.
 */

export type IcsEvent = {
  /** Stable per event, so importing the file twice updates rather than duplicates. */
  uid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  start: Date;
  /** For a timed event; ignored when allDay. */
  end?: Date | null;
  /** A day with no time: DTSTART;VALUE=DATE, ending the next day. */
  allDay?: boolean;
  /** The calendar day of an all-day event, "YYYY-MM-DD" (start's UTC day when omitted). */
  day?: string | null;
  /** When the file was made (DTSTAMP). */
  stamp?: Date;
};

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const ymd = (day: string) => day.replace(/-/g, "");

/** RFC 5545 TEXT: backslash, semicolon, comma and line breaks escaped. */
export function icsText(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

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

export function buildIcs(e: IcsEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Velocity//QBR//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
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
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
