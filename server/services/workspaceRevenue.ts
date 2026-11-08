/**
 * A workspace's revenue settings — fiscal year start and currency — with its
 * time zone, read the one way (audit 2026-10-20, F29 and R41). Cached for a
 * minute like the time zone (services/workspaceTimezone): the forecast and
 * quota read it per request, and Settings → General clears it on save.
 */
import { eq } from "drizzle-orm";
import { workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { getWorkspaceTimezone } from "./workspaceTimezone";
import { safeCurrency, safeFiscalStart } from "@shared/revenueSettings";

export type RevenueSettings = { timezone: string; fiscalYearStartMonth: number; currency: string };

const cache = new Map<number, { v: Omit<RevenueSettings, "timezone">; at: number }>();
const TTL_MS = 60_000;

export async function getRevenueSettings(workspaceId: number, nowMs = Date.now()): Promise<RevenueSettings> {
  const timezone = await getWorkspaceTimezone(workspaceId, nowMs);
  const hit = cache.get(workspaceId);
  if (hit && hit.at <= nowMs && nowMs - hit.at < TTL_MS) return { timezone, ...hit.v };
  let v = { fiscalYearStartMonth: safeFiscalStart(null), currency: safeCurrency(null) };
  try {
    const db = await getDb();
    if (db) {
      const [row] = await db.select({ fy: workspaceSettings.fiscalYearStartMonth, currency: workspaceSettings.currency })
        .from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId));
      v = { fiscalYearStartMonth: safeFiscalStart(row?.fy), currency: safeCurrency(row?.currency) };
    }
  } catch {
    // A failed settings read must not fail a forecast: calendar quarters and
    // USD are the defaults every workspace had before the setting existed.
  }
  cache.set(workspaceId, { v, at: nowMs });
  return { timezone, ...v };
}

export function invalidateRevenueSettings(workspaceId: number): void {
  cache.delete(workspaceId);
}

/** For tests. */
export function _clearRevenueSettingsCache(): void {
  cache.clear();
}
