/**
 * The workspace send window (owner ask 2026-09-25: "Build the send window,
 * 6 AM–5 PM weekdays" and "give me the ability to adjust the sending window
 * (setting within each workspace)").
 *
 * Everything Velocity sends to prospects ON ITS OWN waits for this window, in
 * the workspace's time zone: Revenue Engine emails, sequence auto-send and
 * LinkedIn DMs, Autonomous meeting invites, meeting reminders, booking-link
 * auto-replies and chat follow-ups. Held work is not dropped; it goes out at
 * the first tick inside the window. What a person clicks (Approve & send,
 * Send now) is not held, and internal reports are not prospect-facing.
 *
 * Pure, so the rule is tested directly and shared by the server and the
 * Settings page's preview.
 */

export interface SendWindow {
  /** First hour sends may start, 0–23, in the workspace's zone. */
  startHour: number;
  /** Sends stop AT this hour, 1–24 (17 = nothing from 17:00 on). */
  endHour: number;
  /** Allowed weekdays, JS numbering: 0 = Sunday … 6 = Saturday. */
  days: number[];
}

export const DEFAULT_SEND_WINDOW: SendWindow = { startHour: 6, endHour: 17, days: [1, 2, 3, 4, 5] };

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** "1,2,3,4,5" → [1,2,3,4,5]; anything unreadable falls back to weekdays. */
export function parseSendDays(raw: string | null | undefined): number[] {
  if (raw == null) return [...DEFAULT_SEND_WINDOW.days];
  // Blank pieces are dropped BEFORE Number(): Number("") is 0, which would
  // read an empty setting as "Sundays only".
  const days = Array.from(new Set(
    String(raw).split(",").map((s) => s.trim()).filter((s) => s !== "").map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
  )).sort((a, b) => a - b);
  return days.length ? days : [...DEFAULT_SEND_WINDOW.days];
}

export function formatSendDays(days: number[]): string {
  return Array.from(new Set(days.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))).sort((a, b) => a - b).join(",");
}

/** A usable window: hours in range and start before end, else the default. */
export function normalizeSendWindow(w: { startHour?: number | null; endHour?: number | null; days?: number[] | string | null }): SendWindow {
  const start = Number(w.startHour);
  const end = Number(w.endHour);
  const days = Array.isArray(w.days) ? parseSendDays(formatSendDays(w.days)) : parseSendDays(w.days);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > 23 || end < 1 || end > 24 || start >= end) {
    return { ...DEFAULT_SEND_WINDOW, days };
  }
  return { startHour: start, endHour: end, days };
}

function localParts(nowMs: number, timezone: string): { dow: number; minutes: number } {
  let zone = timezone || "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { zone = "UTC"; }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const dow = Math.max(0, WEEKDAY_LABELS.indexOf(wd as (typeof WEEKDAY_LABELS)[number]));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return { dow, minutes: h * 60 + m };
}

/** Is `nowMs` inside the window, in `timezone`? Start inclusive, end exclusive. */
export function isWithinSendWindow(nowMs: number, timezone: string, window: SendWindow): boolean {
  const w = normalizeSendWindow(window);
  const { dow, minutes } = localParts(nowMs, timezone);
  if (!w.days.includes(dow)) return false;
  return minutes >= w.startHour * 60 && minutes < w.endHour * 60;
}

/** "6:00 AM–5:00 PM, Mon–Fri" style summary for the Settings page. */
export function describeSendWindow(window: SendWindow): string {
  const w = normalizeSendWindow(window);
  const hour = (h: number) => {
    const hh = h % 24;
    const suffix = hh < 12 ? "AM" : "PM";
    const twelve = hh % 12 === 0 ? 12 : hh % 12;
    return h === 24 ? "midnight" : `${twelve}:00 ${suffix}`;
  };
  const d = w.days;
  const weekdays = d.length === 5 && [1, 2, 3, 4, 5].every((x) => d.includes(x));
  const days = d.length === 7 ? "every day" : weekdays ? "Mon–Fri" : d.map((x) => WEEKDAY_LABELS[x]).join(", ");
  return `${hour(w.startHour)}–${hour(w.endHour)}, ${days}`;
}
