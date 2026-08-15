/**
 * linkedinLimits.ts — the ONE policy governing how hard we work a LinkedIn
 * account, and the pure decision it produces.
 *
 * WHY THIS EXISTS. LinkedIn restricts accounts on BEHAVIOUR, not just volume,
 * and before this the product's protections were four unrelated numbers in
 * four files:
 *
 *   • profile lookups          100/day, a hardcoded constant
 *   • connection invites       20/day, a different hardcoded constant, and the
 *                              stored setting that was supposed to control it
 *                              was overridden every time
 *   • opener DMs               the stored setting at face value (default 50)
 *   • job-change re-engagement 25/day
 *
 * None of them knew the others existed, so one account could take 170 actions
 * in a day with every subsystem correctly believing it was within its limit.
 * And every cap was DAILY, while the invite ceiling that actually gets accounts
 * restricted is WEEKLY — 20/day is 140/week, comfortably past the ~100/week
 * figure widely reported since 2022. Respecting the daily cap every single day
 * was a way to breach the real one.
 *
 * ⚠️ LinkedIn publishes no limits, and the real thresholds vary with account
 * age, history and how the account behaves. Every default here is a
 * conservative guess, not a documented figure. They are settings precisely
 * BECAUSE nobody outside LinkedIn knows the true numbers.
 *
 * The decision below is pure so the rules can be tested without a database and
 * without waiting a week to see whether an account got restricted.
 */

export type LinkedInActionKind = "invite" | "message" | "lookup" | "reaction";

export const LINKEDIN_ACTION_KINDS: readonly LinkedInActionKind[] = [
  "invite", "message", "lookup", "reaction",
] as const;

export const ACTION_LABEL: Record<LinkedInActionKind, string> = {
  invite: "Connection invites",
  message: "Messages",
  lookup: "Profile lookups",
  reaction: "Likes and reactions",
};

export interface LinkedInLimitPolicy {
  /** Master switch. Off means every action is refused, not un-throttled. */
  enabled: boolean;
  /** THE binding invite limit. Daily is a smoothing constraint beneath it. */
  weeklyInviteCap: number;
  dailyInviteCap: number;
  dailyMessageCap: number;
  dailyLookupCap: number;
  /**
   * All action kinds together, per account, per day. The gap the four separate
   * caps left: each was individually reasonable and their sum was not.
   */
  dailyActionCap: number;
  /**
   * Minimum gap between any two actions on one account, plus a random extra of
   * up to `jitterSeconds`. Twenty invites fired back-to-back in one tick reads
   * as automation however modest the daily total is.
   */
  minSpacingSeconds: number;
  jitterSeconds: number;
  /** Local hours during which actions may run, inclusive start, exclusive end. */
  workingHourStart: number;
  workingHourEnd: number;
  /** ISO weekdays permitted, 1 = Monday … 7 = Sunday. */
  workingDays: number[];
  /** IANA zone the hours are read in. The ACCOUNT's timezone, not the server's. */
  timezone: string;
  /**
   * Ramp a newly connected account up to full allowance over this many days.
   * A brand-new account behaving like an established one is the fastest way to
   * get restricted.
   */
  warmupDays: number;
}

/**
 * Deliberately cautious. A user who wants more can raise them; nobody gets a
 * restricted account because a default was ambitious.
 *
 * 80/week sits under the widely-reported ~100 invite ceiling with room for the
 * manual invites a rep sends by hand, which this product cannot see.
 */
export const DEFAULT_LINKEDIN_POLICY: LinkedInLimitPolicy = {
  enabled: true,
  weeklyInviteCap: 80,
  dailyInviteCap: 15,
  dailyMessageCap: 40,
  dailyLookupCap: 100,
  dailyActionCap: 120,
  minSpacingSeconds: 90,
  jitterSeconds: 60,
  workingHourStart: 8,
  workingHourEnd: 18,
  workingDays: [1, 2, 3, 4, 5],
  timezone: "UTC",
  warmupDays: 14,
};

/** Bounds the UI and the API both enforce, so a saved value is always sane. */
export const POLICY_BOUNDS = {
  weeklyInviteCap: { min: 0, max: 400 },
  dailyInviteCap: { min: 0, max: 100 },
  dailyMessageCap: { min: 0, max: 200 },
  dailyLookupCap: { min: 0, max: 500 },
  dailyActionCap: { min: 0, max: 800 },
  minSpacingSeconds: { min: 0, max: 3600 },
  jitterSeconds: { min: 0, max: 3600 },
  workingHourStart: { min: 0, max: 23 },
  workingHourEnd: { min: 1, max: 24 },
  warmupDays: { min: 0, max: 90 },
} as const;

export function clampPolicy(input: Partial<LinkedInLimitPolicy>): LinkedInLimitPolicy {
  const p = { ...DEFAULT_LINKEDIN_POLICY, ...input };
  const clamp = (v: number, k: keyof typeof POLICY_BOUNDS) => {
    const b = POLICY_BOUNDS[k];
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULT_LINKEDIN_POLICY[k] as number;
    return Math.max(b.min, Math.min(b.max, Math.floor(n)));
  };
  const days = Array.isArray(p.workingDays)
    ? Array.from(new Set(p.workingDays.map(Number).filter((d) => d >= 1 && d <= 7))).sort()
    : DEFAULT_LINKEDIN_POLICY.workingDays;
  let start = clamp(p.workingHourStart, "workingHourStart");
  let end = clamp(p.workingHourEnd, "workingHourEnd");
  // An inverted window would refuse every action of every day, silently.
  if (end <= start) end = Math.min(24, start + 1);
  return {
    enabled: !!p.enabled,
    weeklyInviteCap: clamp(p.weeklyInviteCap, "weeklyInviteCap"),
    dailyInviteCap: clamp(p.dailyInviteCap, "dailyInviteCap"),
    dailyMessageCap: clamp(p.dailyMessageCap, "dailyMessageCap"),
    dailyLookupCap: clamp(p.dailyLookupCap, "dailyLookupCap"),
    dailyActionCap: clamp(p.dailyActionCap, "dailyActionCap"),
    minSpacingSeconds: clamp(p.minSpacingSeconds, "minSpacingSeconds"),
    jitterSeconds: clamp(p.jitterSeconds, "jitterSeconds"),
    workingHourStart: start,
    workingHourEnd: end,
    workingDays: days.length ? days : DEFAULT_LINKEDIN_POLICY.workingDays,
    timezone: String(p.timezone || "UTC"),
    warmupDays: clamp(p.warmupDays, "warmupDays"),
  };
}

/* ─── usage ──────────────────────────────────────────────────────────────── */

export interface LinkedInUsage {
  /** Actions today, per kind, in the account's local day. */
  today: Partial<Record<LinkedInActionKind, number>>;
  /** Actions in the trailing 7 days, per kind. */
  week: Partial<Record<LinkedInActionKind, number>>;
  todayTotal: number;
  /** Most recent action of ANY kind on this account. */
  lastActionAt: Date | string | null;
}

export const EMPTY_USAGE: LinkedInUsage = { today: {}, week: {}, todayTotal: 0, lastActionAt: null };

/* ─── the decision ───────────────────────────────────────────────────────── */

export type BlockReason =
  | "disabled"
  | "outside_hours"
  | "outside_days"
  | "spacing"
  | "daily_kind_cap"
  | "weekly_invite_cap"
  | "daily_action_cap";

export interface ActionVerdict {
  allowed: boolean;
  reason: BlockReason | null;
  /** Human sentence, safe to show in a log line or a task. */
  message: string;
  /** When the caller could sensibly try again. Null when it is a day-level wait. */
  retryAfterMs: number | null;
  /**
   * The effective cap applied after warmup scaling — what the caller was
   * actually measured against, which is not always what the policy says.
   */
  effectiveCaps: {
    dailyInvite: number;
    dailyMessage: number;
    dailyLookup: number;
    dailyAction: number;
    weeklyInvite: number;
  };
}

/**
 * Warmup multiplier for an account connected `ageDays` ago.
 *
 * Linear from 20% on day 0 to 100% at `warmupDays`. Starting at zero would
 * make a freshly connected account look broken; starting at full allowance is
 * how a new account gets restricted in its first week.
 */
export function warmupFactor(ageDays: number | null, warmupDays: number): number {
  if (!warmupDays || warmupDays <= 0) return 1;
  if (ageDays === null || !Number.isFinite(ageDays)) return 1; // unknown age → no penalty
  if (ageDays >= warmupDays) return 1;
  const progress = Math.max(0, ageDays) / warmupDays;
  return 0.2 + 0.8 * progress;
}

/** Apply the warmup factor, never rounding a non-zero cap down to zero. */
function scaleCap(cap: number, factor: number): number {
  if (cap <= 0) return 0;
  if (factor >= 1) return cap;
  return Math.max(1, Math.floor(cap * factor));
}

/**
 * Hour and weekday in a given IANA zone, without pulling in a date library.
 * Falls back to the host's own reading if the zone is not recognised — a bad
 * timezone string must not become "no actions ever".
 */
export function localHourAndDay(at: Date, timezone: string): { hour: number; isoDay: number } {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, hour: "2-digit", weekday: "short", hour12: false,
    });
    const parts = fmt.formatToParts(at);
    const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
    const dayPart = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
    const DAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return { hour: Number(hourPart) % 24, isoDay: DAYS[dayPart] ?? 1 };
  } catch {
    const d = at.getDay();
    return { hour: at.getHours(), isoDay: d === 0 ? 7 : d };
  }
}

/**
 * May this account take this action right now?
 *
 * Order matters: the cheapest and most absolute rules first, so a blocked
 * caller gets the most useful reason rather than the first one that happens to
 * match. Spacing is checked before the caps because it is the one a caller can
 * usefully retry after.
 */
export function evaluateLinkedInAction(input: {
  policy: LinkedInLimitPolicy;
  usage: LinkedInUsage;
  kind: LinkedInActionKind;
  now: Date;
  /** Days since the account was connected. Null when unknown. */
  accountAgeDays: number | null;
}): ActionVerdict {
  const { policy, usage, kind, now } = input;
  const factor = warmupFactor(input.accountAgeDays, policy.warmupDays);
  const effectiveCaps = {
    dailyInvite: scaleCap(policy.dailyInviteCap, factor),
    dailyMessage: scaleCap(policy.dailyMessageCap, factor),
    dailyLookup: scaleCap(policy.dailyLookupCap, factor),
    dailyAction: scaleCap(policy.dailyActionCap, factor),
    weeklyInvite: scaleCap(policy.weeklyInviteCap, factor),
  };
  const ok = (): ActionVerdict => ({ allowed: true, reason: null, message: "Within limits", retryAfterMs: null, effectiveCaps });
  const block = (reason: BlockReason, message: string, retryAfterMs: number | null = null): ActionVerdict =>
    ({ allowed: false, reason, message, retryAfterMs, effectiveCaps });

  if (!policy.enabled) {
    return block("disabled", "LinkedIn activity is paused for this account.");
  }

  const { hour, isoDay } = localHourAndDay(now, policy.timezone);
  if (!policy.workingDays.includes(isoDay)) {
    return block("outside_days", `Outside the permitted days for this account (${policy.timezone}).`);
  }
  if (hour < policy.workingHourStart || hour >= policy.workingHourEnd) {
    return block(
      "outside_hours",
      `Outside working hours ${policy.workingHourStart}:00–${policy.workingHourEnd}:00 ${policy.timezone}.`,
    );
  }

  if (policy.minSpacingSeconds > 0 && usage.lastActionAt) {
    const since = now.getTime() - new Date(usage.lastActionAt).getTime();
    // The jitter is added to the REQUIRED gap, so the realised spacing varies
    // between calls instead of landing on a machine-regular cadence.
    const required = (policy.minSpacingSeconds + Math.random() * policy.jitterSeconds) * 1000;
    if (since >= 0 && since < required) {
      return block("spacing", "Too soon after the last action on this account.", Math.ceil(required - since));
    }
  }

  const todayOf = (k: LinkedInActionKind) => Number(usage.today[k] ?? 0);
  const weekOf = (k: LinkedInActionKind) => Number(usage.week[k] ?? 0);

  if (kind === "invite" && weekOf("invite") >= effectiveCaps.weeklyInvite) {
    return block(
      "weekly_invite_cap",
      `Weekly invite limit reached (${weekOf("invite")}/${effectiveCaps.weeklyInvite}). This is the limit LinkedIn actually restricts on.`,
    );
  }

  const kindCap =
    kind === "invite" ? effectiveCaps.dailyInvite
      : kind === "message" ? effectiveCaps.dailyMessage
        : kind === "lookup" ? effectiveCaps.dailyLookup
          : effectiveCaps.dailyAction;
  if (todayOf(kind) >= kindCap) {
    return block("daily_kind_cap", `Daily ${ACTION_LABEL[kind].toLowerCase()} limit reached (${todayOf(kind)}/${kindCap}).`);
  }

  if (usage.todayTotal >= effectiveCaps.dailyAction) {
    return block(
      "daily_action_cap",
      `This account has used its whole daily activity budget (${usage.todayTotal}/${effectiveCaps.dailyAction}) across all action types.`,
    );
  }

  return ok();
}

/** Percentage of a budget consumed, for the readouts. Guards a zero cap. */
export function usedPct(used: number, cap: number): number {
  if (!cap || cap <= 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.round((used / cap) * 100));
}
