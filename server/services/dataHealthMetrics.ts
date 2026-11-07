/**
 * What Data Health's Overview reports, from the counts getMetrics reads.
 *
 * Pure, so the rules behind each number are pinned without a database:
 *
 *   Verified Emails  counts `valid` only. It added accept-all, risky and
 *                    invalid, so a list of dead addresses read as green
 *                    (audit 2026-10-20, P79). The breakdown below the card
 *                    still shows every verdict on its own.
 *   Duplicate People counts the groups a merge on the page can act on: one
 *                    usable address on two or more People rows, less shared
 *                    inboxes, which planPeopleMerge never merges. It also
 *                    added name + company groups, which nothing merges, so
 *                    the card could never reach zero (P80).
 */
import { isGenericInboxEmail } from "@shared/genericEmail";
import { usableEmailOrNull } from "@shared/fieldHygiene";

/** How many duplicate-address groups the card reads before it says "+". */
export const DUPLICATE_GROUP_SCAN_CAP = 2000;

export type HealthTotals = {
  total: unknown;
  withEmail: unknown;
  withPhone: unknown;
  withCompany: unknown;
  withTitle: unknown;
  withLinkedIn: unknown;
  verifiedValid: unknown;
  verifiedAcceptAll: unknown;
  verifiedRisky: unknown;
  verifiedInvalid: unknown;
  verifiedUnknown: unknown;
  enrichedLast90Days: unknown;
};

/** Distinct addresses, held by 2+ rows, that the People merge would take. */
export function mergeableEmailGroups(rows: Array<{ email: string | null }>): number {
  const keys = new Set<string>();
  for (const r of rows) {
    const key = usableEmailOrNull(r.email);
    if (key && !isGenericInboxEmail(key)) keys.add(key);
  }
  return keys.size;
}

export function healthMetricsFrom(t: HealthTotals, duplicateEmailRows: Array<{ email: string | null }>) {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  const total = n(t.total);
  const pct = (v: unknown) => (total > 0 ? Math.round((n(v) / total) * 100) : 0);
  const duplicatesCapped = duplicateEmailRows.length > DUPLICATE_GROUP_SCAN_CAP;
  return {
    total,
    withEmail: n(t.withEmail),
    withPhone: n(t.withPhone),
    withCompany: n(t.withCompany),
    withTitle: n(t.withTitle),
    withLinkedIn: n(t.withLinkedIn),
    verifiedValid: n(t.verifiedValid),
    verifiedAcceptAll: n(t.verifiedAcceptAll),
    verifiedRisky: n(t.verifiedRisky),
    verifiedInvalid: n(t.verifiedInvalid),
    verifiedUnknown: n(t.verifiedUnknown),
    enrichedLast90Days: n(t.enrichedLast90Days),
    estimatedDuplicates: mergeableEmailGroups(duplicateEmailRows.slice(0, DUPLICATE_GROUP_SCAN_CAP)),
    /** True when there were more groups than the scan reads: the count is a floor. */
    duplicatesCapped,
    pctWithEmail: pct(t.withEmail),
    pctWithPhone: pct(t.withPhone),
    pctEnriched: pct(t.enrichedLast90Days),
    pctVerified: pct(t.verifiedValid),
  };
}
