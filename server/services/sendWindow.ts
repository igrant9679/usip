/**
 * The workspace send window, read for the senders (see @shared/sendWindow).
 * Cached for a minute per workspace: every engine tick asks, and the answer
 * changes only when an admin saves Settings.
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { DEFAULT_SEND_WINDOW, isWithinSendWindow, normalizeSendWindow, type SendWindow } from "@shared/sendWindow";

const TTL_MS = 60_000;
const cache = new Map<number, { at: number; tz: string; window: SendWindow }>();

export function invalidateSendWindowCache(workspaceId?: number): void {
  if (workspaceId === undefined) cache.clear();
  else cache.delete(workspaceId);
}

export async function getWorkspaceSendWindow(workspaceId: number, nowMs = Date.now()): Promise<{ timezone: string; window: SendWindow }> {
  const hit = cache.get(workspaceId);
  if (hit && hit.at <= nowMs && nowMs - hit.at < TTL_MS) return { timezone: hit.tz, window: hit.window };
  let tz = "UTC";
  let window: SendWindow = DEFAULT_SEND_WINDOW;
  try {
    const db = await getDb();
    if (db) {
      const [row] = await db.select({
        timezone: workspaceSettings.timezone,
        startHour: workspaceSettings.sendWindowStartHour,
        endHour: workspaceSettings.sendWindowEndHour,
        days: workspaceSettings.sendWindowDays,
      }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)).limit(1);
      if (row) {
        tz = row.timezone || "UTC";
        window = normalizeSendWindow({ startHour: row.startHour, endHour: row.endHour, days: row.days });
      }
    }
  } catch (e) {
    // Fail to the default window, never to "always open": a read failure
    // must not become a 3 AM send.
    console.error(`[SendWindow] read failed for workspace ${workspaceId}:`, (e as Error).message);
  }
  cache.set(workspaceId, { at: nowMs, tz, window });
  return { timezone: tz, window };
}

/** May Velocity send to prospects on its own in this workspace right now? */
export async function inSendWindow(workspaceId: number, nowMs = Date.now()): Promise<boolean> {
  const { timezone, window } = await getWorkspaceSendWindow(workspaceId, nowMs);
  return isWithinSendWindow(nowMs, timezone, window);
}
