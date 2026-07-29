/**
 * timeWindows.ts — the ONE definition of "today" for spend and send budgets.
 *
 * Written for the reason `72aa576` gives for fixing the ARE campaign cap: a
 * budget must not roll over at an hour that depends on a host setting nobody in
 * this repo controls. That commit moved the campaign cap and the per-account
 * send counter onto UTC via `todayUtc()`, and noted that "every other budget in
 * the codebase uses todayUtc()". Five did not:
 *
 *   routers/sequences.ts     per-account "sent today" for the daily send limit
 *   sendLimits.ts            workspace-wide daily send cap
 *   services/apollo.ts       apolloPulledToday — the Apollo daily credit cap
 *   services/socialAutopilot.ts   LinkedIn opener sends, and invites
 *
 * All five used `new Date(); d.setHours(0,0,0,0)` — midnight in the NODE
 * PROCESS's local timezone. The sharp edge is not abstract: the per-account
 * daily send limit was measured against a UTC day in emailDelivery and a local
 * day in sequences.ts, so on a non-UTC host the two disagreed about which sends
 * counted toward the same cap. Exceeding a per-mailbox daily limit is how a
 * sending domain gets flagged, so "it depends on TZ" is not an acceptable
 * property here.
 *
 * Pure and dependency-free so it can be unit-tested and imported from either
 * side. Note `todayUtc()` in routers/sendingAccounts.ts is the sibling for the
 * same concept as a `YYYY-MM-DD` string, used where a DATE column is compared;
 * this returns a Date for `gte(column, …)` range comparisons.
 */

/** Start of the current UTC day, for `gte(column, utcDayStart())` comparisons. */
export function utcDayStart(nowMs: number = Date.now()): Date {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Start of the UTC day `daysAgo` days back. `daysAgo: 0` is today. */
export function utcDayStartDaysAgo(daysAgo: number, nowMs: number = Date.now()): Date {
  const t = utcDayStart(nowMs);
  t.setUTCDate(t.getUTCDate() - daysAgo);
  return t;
}
