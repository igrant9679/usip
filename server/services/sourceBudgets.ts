/**
 * Each paid source's allowance left today, for the launchers and the cost
 * confirmations (audit 2026-10-20, F8, U16, F10). Read from the caps and
 * ledgers the sources already enforce, so the number shown before a run is
 * the number the run will be held to:
 *
 *   Apollo, QuickEnrich   the daily pull caps and the are_scrape_jobs ledger
 *                         both discovery surfaces write (apolloPulledToday…)
 *   LinkedIn              lookups left today on the accounts this person may
 *                         use (listUsableAccounts, the per-account daily cap)
 *   Reoon                 whose key; on the shared key, its daily cap and the
 *                         spend ledger's units today (sharedUsedToday)
 *   AI                    the workspace's monthly token budget and use
 */
import { and, eq } from "drizzle-orm";
import { usageCounters, workspaceSettings } from "../../drizzle/schema";
import { getDb } from "../db";
import { usageMonthKey } from "../usageCounters";
import type { SourceBudgets } from "@shared/spendPreview";
import { apolloPulledToday, getApolloDailyCap, getApolloKey } from "./apollo";
import { getQuickEnrichKey, getQuickenrichDailyPullCap, quickenrichPulledToday } from "./quickenrich";
import { LINKEDIN_DAILY_CAP, listUsableAccounts } from "./linkedinLookup";
import { getReoonKey } from "./reoon";
import { keySourceOf, sharedKeyPolicy, sharedUsedToday } from "./spend";

export async function sourceBudgets(workspaceId: number, userId: number, isAdmin: boolean): Promise<SourceBudgets> {
  const [apolloKey, qeKey, reoonKey] = await Promise.all([
    getApolloKey(workspaceId).catch(() => ""),
    getQuickEnrichKey(workspaceId).catch(() => ""),
    getReoonKey(workspaceId).catch(() => ""),
  ]);
  const [apolloCap, apolloUsed, qeCap, qeUsed] = await Promise.all([
    getApolloDailyCap(workspaceId),
    apolloPulledToday(workspaceId),
    getQuickenrichDailyPullCap(workspaceId),
    quickenrichPulledToday(workspaceId),
  ]);
  const accounts = await listUsableAccounts({ workspaceId, userId, isAdmin }).catch(() => []);
  const linkedinLeft = accounts.reduce((sum, a) => sum + a.remainingToday, 0);

  let reoon: SourceBudgets["reoon"] = { configured: !!reoonKey, keySource: null, allowance: null };
  if (reoonKey) {
    const keySource = keySourceOf(reoonKey, process.env.REOON_API_KEY);
    reoon = { configured: true, keySource, allowance: null };
    if (keySource === "shared") {
      const policy = await sharedKeyPolicy(workspaceId, "reoon");
      if (policy.dailyCap !== null) reoon.allowance = { used: await sharedUsedToday(workspaceId, "reoon"), cap: policy.dailyCap };
    }
  }

  let ai: SourceBudgets["ai"] = { used: 0, cap: null };
  const db = await getDb();
  if (db) {
    const [[settings], [counter]] = await Promise.all([
      db.select({ cap: workspaceSettings.llmMonthlyTokenCap }).from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)),
      db.select({ used: usageCounters.llmTokens }).from(usageCounters)
        .where(and(eq(usageCounters.workspaceId, workspaceId), eq(usageCounters.month, usageMonthKey()))),
    ]);
    ai = { used: Number(counter?.used ?? 0), cap: settings?.cap ?? null };
  }

  return {
    apollo: { configured: !!apolloKey, allowance: { used: apolloUsed, cap: apolloCap } },
    quickenrich: { configured: !!qeKey, allowance: { used: qeUsed, cap: qeCap } },
    linkedin: { accounts: accounts.length, left: linkedinLeft, cap: accounts.length * LINKEDIN_DAILY_CAP },
    reoon,
    ai,
  };
}
