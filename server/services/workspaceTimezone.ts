/**
 * workspaceTimezone.ts — the one way to ask "what time is it for this customer".
 *
 * `workspace_settings.timezone` (default "UTC", NOT NULL) is settable in Settings
 * under copy reading "Default locale & workspace-wide timezone used for
 * scheduling, reporting, and activity timestamps". Until this module it was read
 * by NOTHING — a saved setting enforced by nothing, promising all three of the
 * things it did not do:
 *
 *   • scheduling — the meeting autopilot built slots with setHours(), i.e. in the
 *     container's zone (UTC), and proposed 6am to Eastern prospects;
 *   • reporting — the activity heatmap bucketed by getDay()/getHours(), so its
 *     "best hour to reach people" was a UTC hour wearing a local label;
 *   • activity timestamps — the Tasks header counted "due today" against a UTC
 *     day, so anything due after 7pm Eastern belonged to tomorrow.
 *
 * All three now read this.
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { safeTimezone } from "@shared/availability";

/**
 * Per-request-ish cache. These call sites run inside loops over rows, and the
 * value changes only when an admin edits it — a 60s window keeps a heatmap over
 * 10k activities from issuing 10k identical reads while still picking up a
 * change while the admin is still looking at the screen.
 */
const cache = new Map<number, { tz: string; at: number }>();
const TTL_MS = 60_000;

export async function getWorkspaceTimezone(workspaceId: number, nowMs = Date.now()): Promise<string> {
  const hit = cache.get(workspaceId);
  // Also refresh on a FUTURE timestamp rather than trusting it: clock skew would
  // otherwise leave now - at negative forever and freeze the value.
  if (hit && hit.at <= nowMs && nowMs - hit.at < TTL_MS) return hit.tz;
  let tz = "UTC";
  try {
    const db = await getDb();
    if (db) {
      const [row] = await db.select({ timezone: workspaceSettings.timezone })
        .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
      tz = safeTimezone(row?.timezone);
    }
  } catch {
    // Never block a page or a proposal on the settings read — UTC is the column
    // default, and a wrong-by-an-offset number beats a 500.
    tz = "UTC";
  }
  cache.set(workspaceId, { tz, at: nowMs });
  return tz;
}

/**
 * The instant the current day began in `tz` — local midnight, as a Date.
 *
 * For day-based limits that must roll over when the customer's day does: a
 * campaign's daily cap counted from UTC midnight while its send window ran in
 * the workspace zone, so for an Eastern workspace the "day" restarted at 7 or
 * 8 PM, mid-evening (audit 2026-10-20, A31). Intl only; a bad zone reads as UTC.
 */
export function startOfLocalDay(tz: string, now: Date = new Date()): Date {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz || "UTC", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(now);
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const sinceMidnight = ((n("hour") * 60 + n("minute")) * 60 + n("second")) * 1000 + now.getUTCMilliseconds();
    return new Date(now.getTime() - sinceMidnight);
  } catch {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
}

/** Test seam: drop memoised zones. */
export function _clearWorkspaceTimezoneCache(): void {
  cache.clear();
}
