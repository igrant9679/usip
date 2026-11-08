/**
 * recipientTime.ts — sending at the recipient's own time of day (audit
 * 2026-10-20, F18).
 *
 * A sequence's email steps came due in the sequence's (or the workspace's)
 * time zone only, so a 9 AM New York step reached London at 2 PM and
 * California at 6 AM. With "Send in each person's time zone" on, a step comes
 * due inside the sequence's send window in the PERSON's zone: the zone stored
 * on their People row, else one told from their state/province where that is
 * reliable (US and Canada, via @shared/callingHours), else the sequence's own
 * zone. It changes when a step comes due, never how many go: the daily caps
 * and the workspace send window are unchanged. Off by default.
 *
 * Pure, so the engine, the Contacts tab's "next send at" and the tests share
 * one rule.
 */
import { timezoneForRegion } from "./callingHours";

export type ZoneSource = "stored" | "location" | "sequence";

export interface SequenceWindow {
  /** "HH:MM", 24 h, in the zone being used. */
  sendWindowStart: string;
  /** "HH:MM"; sending stops AT this time. */
  sendWindowEnd: string;
  skipWeekends: boolean;
}

/** A usable IANA zone name, or null. */
export function validZone(zone: string | null | undefined): string | null {
  const z = String(zone ?? "").trim();
  if (!z) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

/** The person's zone, and where it came from. */
export function recipientZone(
  person: { timezone?: string | null; state?: string | null; country?: string | null } | null | undefined,
  sequenceZone: string,
): { zone: string; source: ZoneSource } {
  const stored = validZone(person?.timezone);
  if (stored) return { zone: stored, source: "stored" };
  const derived = validZone(timezoneForRegion(person?.state ?? null, person?.country ?? null));
  if (derived) return { zone: derived, source: "location" };
  return { zone: validZone(sequenceZone) ?? "UTC", source: "sequence" };
}

function localClock(atMs: number, zone: string): { hhmm: string; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: validZone(zone) ?? "UTC", hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(atMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { hhmm: `${get("hour")}:${get("minute")}`, dow: dow < 0 ? 1 : dow };
}

/** Inside the window in `zone`? Start inclusive, end exclusive, as the engine reads it. */
export function inWindowAt(atMs: number, zone: string, w: SequenceWindow): boolean {
  const { hhmm, dow } = localClock(atMs, zone);
  if (w.skipWeekends && (dow === 0 || dow === 6)) return false;
  return hhmm >= w.sendWindowStart && hhmm < w.sendWindowEnd;
}

/**
 * The first quarter-hour at or after `fromMs` inside the window in `zone`, or
 * null when none falls in the next eight days (a window that never opens).
 * Stepped by real instants, so it is right across daylight-saving changes and
 * for zones on :30 and :45 offsets.
 */
export function nextWindowOpening(fromMs: number, zone: string, w: SequenceWindow): number | null {
  const STEP = 15 * 60_000;
  if (inWindowAt(fromMs, zone, w)) return fromMs;
  let t = Math.ceil(fromMs / STEP) * STEP;
  for (let i = 0; i < 8 * 24 * 4; i++, t += STEP) {
    if (inWindowAt(t, zone, w)) return t;
  }
  return null;
}

/**
 * When an enrolment's next step is due to go, for the Contacts tab: its due
 * time, or now if that has passed, moved to the next opening of the window in
 * the zone in use. Null for an enrolment that is not running.
 */
export function nextSendAt(
  enrollment: { status: string; nextActionAt: Date | string | null },
  zone: string,
  w: SequenceWindow,
  nowMs: number = Date.now(),
): number | null {
  if (enrollment.status !== "active") return null;
  const due = enrollment.nextActionAt ? new Date(enrollment.nextActionAt).getTime() : nowMs;
  return nextWindowOpening(Math.max(due, nowMs), zone, w);
}
