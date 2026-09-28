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
const cache = new Map<number, { at: number; tz: string; window: SendWindow; paused: boolean }>();

export function invalidateSendWindowCache(workspaceId?: number): void {
  if (workspaceId === undefined) cache.clear();
  else cache.delete(workspaceId);
}

export async function getWorkspaceSendWindow(workspaceId: number, nowMs = Date.now()): Promise<{ timezone: string; window: SendWindow; paused: boolean }> {
  const hit = cache.get(workspaceId);
  if (hit && hit.at <= nowMs && nowMs - hit.at < TTL_MS) return { timezone: hit.tz, window: hit.window, paused: hit.paused };
  let tz = "UTC";
  let window: SendWindow = DEFAULT_SEND_WINDOW;
  let paused = false;
  try {
    const db = await getDb();
    if (db) {
      const [row] = await db.select({
        timezone: workspaceSettings.timezone,
        startHour: workspaceSettings.sendWindowStartHour,
        endHour: workspaceSettings.sendWindowEndHour,
        days: workspaceSettings.sendWindowDays,
        pausedAt: workspaceSettings.outboundPausedAt,
      }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)).limit(1);
      if (row) {
        tz = row.timezone || "UTC";
        window = normalizeSendWindow({ startHour: row.startHour, endHour: row.endHour, days: row.days });
        paused = !!row.pausedAt;
      }
    }
  } catch (e) {
    // Fail to the default window, never to "always open": a read failure
    // must not become a 3 AM send.
    console.error(`[SendWindow] read failed for workspace ${workspaceId}:`, (e as Error).message);
  }
  cache.set(workspaceId, { at: nowMs, tz, window, paused });
  return { timezone: tz, window, paused };
}

/** May Velocity send to prospects on its own in this workspace right now? */
export async function inSendWindow(workspaceId: number, nowMs = Date.now()): Promise<boolean> {
  const { timezone, window, paused } = await getWorkspaceSendWindow(workspaceId, nowMs);
  // Pause all outbound (owner ask 2026-09-28): the window stays shut.
  if (paused) return false;
  return isWithinSendWindow(nowMs, timezone, window);
}
