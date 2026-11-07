/**
 * Save a booked meeting as a calendar file (audit 2026-10-20, F47). The same
 * builder as the confirmation email's attachment (@shared/ics), so the page
 * and the email give the same event, with the same UID.
 */
import { buildIcs, type IcsEvent } from "@shared/ics";

export function downloadIcs(event: IcsEvent, filename = "meeting.ics"): void {
  try {
    const blob = new Blob([buildIcs(event)], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* a blocked download leaves the page as it was */
  }
}
