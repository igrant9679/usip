/**
 * calendarFreeBusy — a rep's busy time read live from their calendar provider.
 *
 * Stored `calendar_events` only change on a sync, and a Unipile-bridged
 * Microsoft 365 calendar reaches them only on a manual one, so anything that
 * offers or books a time must also ask the provider (2026-09-24 for meeting
 * proposals; audit 2026-10-20, G42 for booking links, which read the stored
 * events alone and could book over a meeting made in Outlook an hour earlier).
 *
 * Neither adapter has a dedicated free/busy call (calendarAdapter.ts: CalDAV
 * and Unipile both offer listEvents), so the live read is the events in the
 * window. Two ways to ask:
 *   - cached (default): one read per calendar per five minutes, for building
 *     slot lists, so a page load or a Regenerate-all pass reads each calendar
 *     once rather than once per proposal or per visitor;
 *   - fresh: no cache, and never written to it, for the last check before a
 *     booking is accepted.
 * A read that fails or takes too long reports `failed` and no busy time: the
 * stored events still decide, as they did before this read existed. Refusing
 * every booking while a provider is slow would take the booking page down
 * with it.
 */
import { and, eq } from "drizzle-orm";
import { calendarAccounts } from "../../drizzle/schema";
import { getDb } from "../db";
import { createCalendarAdapter } from "../calendarAdapter";

export type BusyRange = { startAt: Date; endAt: Date };
export type LiveBusyRead = { busy: BusyRange[]; read: "ok" | "no_calendar" | "failed" };

export const LIVE_BUSY_TTL_MS = 5 * 60_000;
/** Longest a booking waits on the provider before the stored events decide alone. */
export const LIVE_BUSY_TIMEOUT_MS = 8_000;

const cache = new Map<number, { at: number; busy: BusyRange[] }>();

export function __resetCalendarFreeBusyCacheForTests(): void {
  cache.clear();
}

/** Drop one calendar's cached read: something was just booked on it. */
export function forgetCalendarBusy(calendarAccountId: number): void {
  cache.delete(calendarAccountId);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`calendar read timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** The owner's busy ranges between `from` and `to`, read from their connected calendar. */
export async function liveCalendarBusy(
  workspaceId: number,
  ownerUserId: number,
  from: Date,
  to: Date,
  opts: { fresh?: boolean; timeoutMs?: number } = {},
): Promise<LiveBusyRead> {
  const db = await getDb();
  if (!db) return { busy: [], read: "failed" };
  const [acc] = await db.select().from(calendarAccounts)
    .where(and(eq(calendarAccounts.workspaceId, workspaceId), eq(calendarAccounts.userId, ownerUserId)))
    .limit(1);
  if (!acc) return { busy: [], read: "no_calendar" };
  if (!opts.fresh) {
    const hit = cache.get(acc.id);
    if (hit && Date.now() - hit.at < LIVE_BUSY_TTL_MS) return { busy: hit.busy, read: "ok" };
  }
  try {
    const events = await withTimeout(
      createCalendarAdapter(acc as never).listEvents(acc.calendarId ?? "primary", from, to),
      opts.timeoutMs ?? LIVE_BUSY_TIMEOUT_MS,
    );
    const busy = events
      .map((e) => ({ startAt: new Date(e.startAt), endAt: new Date(e.endAt) }))
      .filter((r) => Number.isFinite(r.startAt.getTime()) && Number.isFinite(r.endAt.getTime()));
    if (!opts.fresh) cache.set(acc.id, { at: Date.now(), busy });
    return { busy, read: "ok" };
  } catch (e) {
    console.error(`[calendarFreeBusy] live calendar read failed for calendar ${acc.id}:`, e instanceof Error ? e.message : String(e));
    return { busy: [], read: "failed" };
  }
}

/** Whether any range overlaps [start, end). */
export function overlapsAny(ranges: BusyRange[], start: Date, end: Date): boolean {
  const s = start.getTime(), e = end.getTime();
  return ranges.some((r) => r.startAt.getTime() < e && r.endAt.getTime() > s);
}
