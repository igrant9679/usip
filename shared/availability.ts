/**
 * availability.ts — the ONE definition of "when is this rep free", and the
 * timezone primitives underneath it.
 *
 * There were two slot generators, and only one of them knew what a timezone is:
 *
 *   • `bookingLinks.generateSlots` — DST-aware via Intl, working-hours window
 *     defined in the rep's own timezone. Correct, and the fix recorded in
 *     SESSION_STATUS: the `/b/:slug` page used to run on UTC and offered
 *     prospects 4am ET.
 *   • `meetingScheduler.computeSlots` — "business-hour slots (10:00 / 14:00
 *     local)" built with `setHours()` and `getDay()`. **Local means the Node
 *     process's timezone**, which on Railway is UTC. So the meeting autopilot
 *     proposed 10:00 and 14:00 UTC — 6am and 10am for an ET prospect, and
 *     it decided "is this a weekend?" in UTC too. The identical bug, in the
 *     path that mails strangers a proposal, fixed in one copy and missed in the
 *     other.
 *
 * They could not be shared before without a cycle: `bookingLinks` (a router)
 * imports `sendMeetingInvite` from `meetingScheduler` (a service), so the
 * service cannot import back from the router. Hence this module.
 *
 * A third timezone clock lives in `sequenceEngine.nowInTz` for send windows. It
 * is correct, tested, and deliberately left alone — its window logic is
 * per-sequence rather than per-availability. If it ever needs changing, move it
 * here rather than adding a fourth.
 *
 * Rule going forward: nothing computes an offerable time with `setHours` or
 * `getDay`. Those read the host's timezone, which is a deployment detail, not a
 * property of the person being offered the slot.
 */

export const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5]; // Mon–Fri (JS weekday numbers)
export const DEFAULT_HORIZON_DAYS = 14;
export const DEFAULT_MAX_SLOTS = 40;

/** Is this a resolvable IANA timezone on this runtime? */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Coerce anything to a usable IANA zone, falling back to UTC. */
export function safeTimezone(tz?: string | null): string {
  return tz && isValidTimezone(tz) ? tz : "UTC";
}

/** Offset (ms) of `tz` from UTC at the given instant (DST-aware, via Intl). */
export function tzOffsetMs(tz: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - utcMs;
}

/** UTC instant for the wall-clock time (y, m, d, minutes-past-midnight) in `tz`. */
export function wallTimeToUtcMs(tz: string, y: number, m: number, d: number, minutes: number): number {
  const naive = Date.UTC(y, m - 1, d) + minutes * 60000;
  // Two-pass correction handles DST transitions at the boundary.
  let utc = naive - tzOffsetMs(tz, naive);
  utc = naive - tzOffsetMs(tz, utc);
  return utc;
}

/** The (y, m, d, weekday) of the given instant, in `tz`. */
export function localDateOf(tz: string, utcMs: number): { y: number; m: number; d: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), dow: DOW[get("weekday")] ?? 1 };
}

/**
 * `YYYY-MM-DD` of an instant, as that calendar day is read in `tz`.
 *
 * The tz-aware counterpart of `d.toISOString().slice(0, 10)`, which is a UTC
 * day wearing whatever label the reader assumes. Anything that buckets rows by
 * day, or asks "have we already done this today", wants this instead — in
 * UTC-8 an activity at 5pm local belongs to the NEXT UTC day, so the two
 * disagree for a third of every day.
 */
export function zonedDayKey(tz: string, utcMs: number): string {
  const { y, m, d } = localDateOf(safeTimezone(tz), utcMs);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A time as a human reads it, IN a named zone, with the zone said out loud.
 *
 * The autopilot used to hand the LLM `new Date(s).toLocaleString()` — the host's
 * zone, unlabelled — and the model wrote those digits into an invite email. So
 * the prospect read a bare "10:00 AM" that meant 10:00 UTC. A proposed time
 * without a zone is not a time.
 */
export function formatInZone(utc: Date | string | number, tz: string): string {
  const zone = safeTimezone(tz);
  const d = utc instanceof Date ? utc : new Date(utc);
  const body = d.toLocaleString("en-US", {
    timeZone: zone, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  // Intl's own short name for the zone at that instant ("EDT", "GMT+2"), so a
  // reader can tell 10am EDT from 10am UTC without knowing the IANA id.
  const label = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
    .formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? zone;
  return `${body} ${label}`;
}

/**
 * Weekday (0=Sun) and hour-of-day of an instant, as read in `tz`.
 *
 * For bucketing analytics by "day and hour". `getDay()`/`getHours()` answer the
 * same question about the CONTAINER, which is how the activity heatmap came to
 * plot UTC hours under local labels.
 */
export function zonedDowHour(utc: Date | string | number, tz: string): { dow: number; hour: number } {
  const zone = safeTimezone(tz);
  const d = utc instanceof Date ? utc : new Date(utc);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, weekday: "short", hour: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dow: DOW[get("weekday")] ?? 0, hour: Number(get("hour").replace(/\D/g, "")) % 24 };
}

/** Last millisecond of the day that contains `nowMs`, as that day is read in `tz`. */
export function endOfZonedDay(tz: string, nowMs: number): number {
  const zone = safeTimezone(tz);
  const { y, m, d } = localDateOf(zone, nowMs);
  // Midnight at the START of tomorrow, minus 1ms — computed through the tz-aware
  // converter so a DST transition inside the day cannot shift the boundary.
  return wallTimeToUtcMs(zone, y, m, d + 1, 0) - 1;
}

export interface AvailabilityOpts {
  /** IANA timezone the window is defined in. Null/undefined = UTC. */
  timezone?: string | null;
  startHour?: number;
  endHour?: number;
  /** JS weekday numbers (0=Sun … 6=Sat) that are bookable. */
  workDays?: number[];
  /** Minimum notice before the first offerable slot. */
  leadMs?: number;
  horizonDays?: number;
  maxSlots?: number;
}

/**
 * Generate open ISO slots from a working-hours window defined in the rep's OWN
 * timezone (DST-aware), minus busy events. Pure over its inputs (busy list +
 * now + opts).
 */
export function generateSlots(
  busy: Array<{ startAt: Date; endAt: Date }>,
  durationMin: number,
  nowMs: number,
  opts: AvailabilityOpts = {},
): string[] {
  const tz = safeTimezone(opts.timezone);
  const startHour = Math.min(23, Math.max(0, opts.startHour ?? 9));
  const endHour = Math.min(24, Math.max(startHour + 1, opts.endHour ?? 17));
  const workDays = opts.workDays?.length ? opts.workDays : DEFAULT_WORK_DAYS;
  const horizonDays = opts.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const maxSlots = opts.maxSlots ?? DEFAULT_MAX_SLOTS;
  const leadMs = opts.leadMs ?? 60 * 60 * 1000; // require ≥1h notice

  const slots: string[] = [];
  const today = localDateOf(tz, nowMs);

  for (let d = 0; d < horizonDays && slots.length < maxSlots; d++) {
    // Advance the LOCAL calendar date by d days (proleptic arithmetic is safe
    // here; the tz conversion happens in wallTimeToUtcMs per slot).
    const dayUtcNoon = Date.UTC(today.y, today.m - 1, today.d + d, 12);
    const local = localDateOf(tz, dayUtcNoon);
    if (!workDays.includes(local.dow)) continue;
    for (let mins = startHour * 60; mins + durationMin <= endHour * 60; mins += durationMin) {
      const startMs = wallTimeToUtcMs(tz, local.y, local.m, local.d, mins);
      const start = new Date(startMs);
      const end = new Date(startMs + durationMin * 60000);
      if (startMs < nowMs + leadMs) continue;
      const overlaps = busy.some((b) => start < b.endAt && end > b.startAt);
      if (!overlaps) slots.push(start.toISOString());
      if (slots.length >= maxSlots) break;
    }
  }
  return slots;
}
