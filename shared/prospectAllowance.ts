/**
 * The monthly prospect-data allowance a membership plan includes (owner
 * approved 2026-11-25).
 *
 * A workspace on a membership plan may use the platform's prospect databases
 * (the deployment's own key, or a key another workspace lends it) up to a
 * number of records a month. Its OWN keys are never counted. A workspace with
 * no plan (`workspace_settings.membershipPlan` NULL) has no allowance at all:
 * nothing is counted and nothing is held back, exactly as before the plans.
 *
 * What counts, in the owner's words: a CSV upload with emails and full
 * contact details does not count unless one of our data sources enriches it;
 * if it is enriched, it counts. So one unit is
 *   - a person ADDED to the workspace (net new after dedupe) from a shared
 *     source, at every acquisition point (campaign discovery, Find prospects,
 *     Source search promote, the Search box save), or
 *   - an email a shared source FINDS for a person already in the workspace.
 * Searches and previews with hidden emails, CSV imports, LinkedIn lookups
 * through the member's own account and Reoon verification never count.
 *
 * This file is the ONE definition: the plans, their monthly numbers, the
 * period arithmetic and every sentence a member reads about the allowance.
 * Pure, so a test can read every sentence. The service that meters it is
 * server/services/prospectAllowance.ts.
 */

export const MEMBERSHIP_PLANS = ["trial", "member", "contributor", "steward", "founder"] as const;
export type MembershipPlan = (typeof MEMBERSHIP_PLANS)[number];

/** Records a month each plan includes. */
export const PLAN_MONTHLY_LIMIT: Record<MembershipPlan, number> = {
  trial: 250,
  member: 1000,
  contributor: 3000,
  steward: 5000,
  founder: 6000,
};

export const PLAN_LABEL: Record<MembershipPlan, string> = {
  trial: "Trial",
  member: "Member",
  contributor: "Contributor",
  steward: "Steward",
  founder: "Founder",
};

export function isMembershipPlan(v: unknown): v is MembershipPlan {
  return typeof v === "string" && (MEMBERSHIP_PLANS as readonly string[]).includes(v);
}

/**
 * The prospect-data vendors whose keys can be lent or shared. Each one's data
 * counts only when the key in use is not the workspace's own.
 */
export const ALLOWANCE_VENDORS = ["quickenrich", "apollo", "warmysender", "leadocean"] as const;
export type AllowanceVendor = (typeof ALLOWANCE_VENDORS)[number];

export function isAllowanceVendor(v: unknown): v is AllowanceVendor {
  return typeof v === "string" && (ALLOWANCE_VENDORS as readonly string[]).includes(v);
}

/** The allowance's month, "YYYY-MM" in UTC. A new month is a new usage row, so nothing has to reset it. */
export function allowancePeriod(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}

/** The day a period's allowance is replaced by the next one's: the 1st of the following month, "YYYY-MM-DD" (UTC). */
export function periodResetsOn(period: string): string {
  const [y, m] = period.split("-").map((x) => Number(x));
  const next = new Date(Date.UTC(y, m, 1)); // m is 1-based, so this is the following month
  return next.toISOString().slice(0, 10);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-12-01" → "1 December". */
export function resetDayLong(isoDay: string): string {
  const [, m, d] = isoDay.split("-").map((x) => Number(x));
  return `${d} ${MONTHS[m - 1] ?? ""}`.trim();
}

/** "2026-12-01" → "1 Dec". */
export function resetDayShort(isoDay: string): string {
  const [, m, d] = isoDay.split("-").map((x) => Number(x));
  return `${d} ${(MONTHS[m - 1] ?? "").slice(0, 3)}`.trim();
}

/** A workspace's allowance this month, as every screen shows it. */
export type ProspectAllowance = {
  plan: MembershipPlan;
  planLabel: string;
  limit: number;
  used: number;
  remaining: number;
  /** "YYYY-MM", UTC. */
  period: string;
  /** "YYYY-MM-DD": the 1st of next month. */
  resetsOn: string;
};

/** No plan: no allowance, nothing counted. */
export type NoAllowance = { plan: null };

export type AllowanceState = ProspectAllowance | NoAllowance;

export function buildAllowance(plan: MembershipPlan, used: number, period: string): ProspectAllowance {
  const limit = PLAN_MONTHLY_LIMIT[plan];
  const u = Math.max(0, Math.floor(Number(used) || 0));
  return {
    plan,
    planLabel: PLAN_LABEL[plan],
    limit,
    used: u,
    remaining: Math.max(0, limit - u),
    period,
    resetsOn: periodResetsOn(period),
  };
}

const n = (v: number) => v.toLocaleString("en-US");

/** True once the month's number is spent. */
export function allowanceUsedUp(a: ProspectAllowance): boolean {
  return a.used >= a.limit;
}

/** The top of Settings → Data sources: "Prospect data is included with your plan: 412 of 3,000 used this month · resets 1 Dec". */
export function allowanceSummaryLine(a: ProspectAllowance): string {
  return `Prospect data is included with your plan: ${n(Math.min(a.used, a.limit))} of ${n(a.limit)} used this month · resets ${resetDayShort(a.resetsOn)}`;
}

/** Why a shared source was skipped: the month's number is spent. */
export function allowanceUsedUpReason(a: ProspectAllowance): string {
  return `Prospect data for this month is used up (${n(Math.min(a.used, a.limit))} of ${n(a.limit)}). It resets on ${resetDayLong(a.resetsOn)}. Add your own key under Data sources to keep going.`;
}

/** Why a request was made smaller: only part of it fits in what is left. */
export function allowanceShrunkReason(a: ProspectAllowance, granted: number, asked: number): string {
  return `Only ${n(granted)} of the ${n(asked)} asked for fit in this month's prospect data (${n(Math.min(a.used, a.limit))} of ${n(a.limit)} used; it resets on ${resetDayLong(a.resetsOn)}).`;
}

/**
 * Why a shared source was skipped when the allowance could not be read. An
 * unknown allowance spends nothing shared: a failed read must never become
 * "unlimited" (the platform pays) nor be shown as "used up" (it may not be).
 */
export const ALLOWANCE_UNKNOWN_REASON =
  "This workspace's prospect-data allowance could not be read, so the shared prospect databases were not used this time. Your own keys still work; it is tried again on the next run.";

/** The launchers' line: "Prospect data: 2,588 of 3,000 left this month", or the used-up sentence. */
export function allowanceLauncherLine(a: ProspectAllowance): string {
  if (allowanceUsedUp(a)) return `Prospect data: used up this month (${n(a.limit)} of ${n(a.limit)}), resets ${resetDayShort(a.resetsOn)}; only your own keys run`;
  return `Prospect data: ${n(a.remaining)} of ${n(a.limit)} left this month`;
}

/** The platform owner's plan picker: every plan with its monthly number. */
export function planOptionLabel(plan: MembershipPlan): string {
  return `${PLAN_LABEL[plan]} (${n(PLAN_MONTHLY_LIMIT[plan])} a month)`;
}
