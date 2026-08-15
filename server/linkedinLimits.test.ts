/**
 * LinkedIn Activity Limits (owner ask 2026-08-14).
 *
 * The protections used to be four hardcoded numbers in four files that could
 * not see each other — 100 lookups, 20 invites, 50 DMs, 25 re-engagements — so
 * one account could take 170 actions in a day with every subsystem correctly
 * believing it was inside its limit. All four were DAILY, while the invite
 * ceiling LinkedIn actually restricts on is WEEKLY: 20/day is 140/week, past
 * the ~100/week figure widely reported since 2022. Respecting the daily cap
 * every single day was a way to breach the real one.
 *
 * The decision is pure, so it can be tested here rather than by waiting a week
 * to find out whether an account got restricted. The wiring is checked
 * structurally, because a gate nothing calls is this codebase's dominant
 * defect shape and the cost of it here is somebody's LinkedIn account.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  evaluateLinkedInAction,
  clampPolicy,
  warmupFactor,
  localHourAndDay,
  usedPct,
  DEFAULT_LINKEDIN_POLICY,
  EMPTY_USAGE,
  type LinkedInLimitPolicy,
  type LinkedInUsage,
} from "@shared/linkedinLimits";

const social = readFileSync("server/services/socialAutopilot.ts", "utf8");
const lookup = readFileSync("server/services/linkedinLookup.ts", "utf8");
const gate = readFileSync("server/services/linkedin/activityGate.ts", "utf8");
const page = readFileSync("client/src/pages/usip/LinkedInLimits.tsx", "utf8");
const registry = readFileSync("client/src/lib/toolRegistry.ts", "utf8");

/** A Wednesday at 10:00 UTC — inside every default window. */
const WED_10AM = new Date("2026-08-12T10:00:00Z");
const policy = (over: Partial<LinkedInLimitPolicy> = {}) => clampPolicy({ ...DEFAULT_LINKEDIN_POLICY, ...over });
const usage = (over: Partial<LinkedInUsage> = {}): LinkedInUsage => ({ ...EMPTY_USAGE, ...over });
const verdict = (p: Partial<LinkedInLimitPolicy>, u: Partial<LinkedInUsage>, kind: any = "invite", now = WED_10AM) =>
  evaluateLinkedInAction({ policy: policy(p), usage: usage(u), kind, now, accountAgeDays: 365 });

describe("the weekly invite ceiling — the one that gets accounts restricted", () => {
  it("blocks on the trailing week even when today is untouched", () => {
    // The exact hole in the old design: a daily cap respected every day, and
    // the weekly limit breached anyway.
    const v = verdict({ weeklyInviteCap: 80, dailyInviteCap: 15 }, { week: { invite: 80 }, today: { invite: 0 } });
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("weekly_invite_cap");
    expect(v.message).toMatch(/week/i);
  });

  it("allows the invite that sits exactly one under the ceiling", () => {
    expect(verdict({ weeklyInviteCap: 80 }, { week: { invite: 79 } }).allowed).toBe(true);
  });

  it("defaults below the widely-reported ~100/week figure", () => {
    // With room left for the invites a rep sends by hand, which we cannot see.
    expect(DEFAULT_LINKEDIN_POLICY.weeklyInviteCap).toBeLessThan(100);
    // And the daily default must not be able to breach it inside a week.
    const impliedWeek = DEFAULT_LINKEDIN_POLICY.dailyInviteCap * DEFAULT_LINKEDIN_POLICY.workingDays.length;
    expect(impliedWeek).toBeLessThanOrEqual(DEFAULT_LINKEDIN_POLICY.weeklyInviteCap);
  });

  it("only applies the weekly ceiling to invites", () => {
    const v = verdict({ weeklyInviteCap: 1 }, { week: { invite: 99 }, today: { message: 0 } }, "message");
    expect(v.allowed).toBe(true);
  });
});

describe("the shared daily budget the four caps never had", () => {
  it("blocks when the account's whole day is spent, even under every kind cap", () => {
    // 60 lookups + 10 invites + 30 messages: each individually fine, together
    // an account that has taken 100 actions.
    const v = verdict(
      { dailyActionCap: 100, dailyInviteCap: 15 },
      { today: { lookup: 60, invite: 10, message: 30 }, todayTotal: 100 },
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("daily_action_cap");
  });

  it("still blocks on the per-kind cap first, which is the more useful reason", () => {
    const v = verdict({ dailyInviteCap: 5, dailyActionCap: 500 }, { today: { invite: 5 }, todayTotal: 5 });
    expect(v.reason).toBe("daily_kind_cap");
  });
});

describe("pacing — bursts read as automation whatever the daily total", () => {
  it("refuses a second action moments after the first", () => {
    const v = verdict(
      { minSpacingSeconds: 90, jitterSeconds: 0 },
      { lastActionAt: new Date(WED_10AM.getTime() - 5_000) },
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("spacing");
    expect(v.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows once the gap has passed", () => {
    const v = verdict(
      { minSpacingSeconds: 90, jitterSeconds: 0 },
      { lastActionAt: new Date(WED_10AM.getTime() - 120_000) },
    );
    expect(v.allowed).toBe(true);
  });

  it("varies the required gap so the cadence is not machine-regular", () => {
    // With jitter, the same inputs must not always produce the same verdict at
    // the boundary — a perfectly regular rhythm is itself a signal.
    const at = { lastActionAt: new Date(WED_10AM.getTime() - 100_000) };
    const results = new Set(
      Array.from({ length: 40 }, () => verdict({ minSpacingSeconds: 60, jitterSeconds: 120 }, at).allowed),
    );
    expect(results.size).toBe(2);
  });

  it("treats a first-ever action as unspaced rather than blocked", () => {
    expect(verdict({ minSpacingSeconds: 300 }, { lastActionAt: null }).allowed).toBe(true);
  });
});

describe("working hours, in the ACCOUNT's timezone", () => {
  it("blocks outside the window", () => {
    const at3am = new Date("2026-08-12T03:00:00Z");
    const v = verdict({ workingHourStart: 8, workingHourEnd: 18, timezone: "UTC" }, {}, "invite", at3am);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("outside_hours");
  });

  it("reads the hour in the configured zone, not the server's", () => {
    // 10:00 UTC is 06:00 in New York — before an 08:00 start there.
    const v = verdict({ workingHourStart: 8, workingHourEnd: 18, timezone: "America/New_York" }, {});
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("outside_hours");
  });

  it("blocks on days that are not selected", () => {
    const saturday = new Date("2026-08-15T10:00:00Z");
    const v = verdict({ workingDays: [1, 2, 3, 4, 5] }, {}, "invite", saturday);
    expect(v.reason).toBe("outside_days");
  });

  it("falls back to the host clock rather than refusing everything on a bad zone", () => {
    const r = localHourAndDay(WED_10AM, "Not/AZone");
    expect(r.isoDay).toBeGreaterThanOrEqual(1);
    expect(r.isoDay).toBeLessThanOrEqual(7);
  });
});

describe("warm-up for newly connected accounts", () => {
  it("scales limits down on day one and up to full at the end", () => {
    expect(warmupFactor(0, 14)).toBeCloseTo(0.2, 5);
    expect(warmupFactor(7, 14)).toBeCloseTo(0.6, 5);
    expect(warmupFactor(14, 14)).toBe(1);
    expect(warmupFactor(400, 14)).toBe(1);
  });

  it("applies no penalty when the age is unknown", () => {
    // Guessing an account is new because we failed to read its connection date
    // would throttle an established account for no reason.
    expect(warmupFactor(null, 14)).toBe(1);
  });

  it("never scales a non-zero cap to nothing", () => {
    const v = evaluateLinkedInAction({
      policy: policy({ dailyInviteCap: 2, warmupDays: 30 }),
      usage: usage(),
      kind: "invite",
      now: WED_10AM,
      accountAgeDays: 0,
    });
    expect(v.effectiveCaps.dailyInvite).toBeGreaterThanOrEqual(1);
  });

  it("reports the caps it actually measured against", () => {
    const v = evaluateLinkedInAction({
      policy: policy({ weeklyInviteCap: 100, warmupDays: 10 }),
      usage: usage(),
      kind: "invite",
      now: WED_10AM,
      accountAgeDays: 0,
    });
    expect(v.effectiveCaps.weeklyInvite).toBe(20); // 20% of 100
  });
});

describe("the policy cannot be saved into a state that refuses everything", () => {
  it("repairs an inverted working window", () => {
    const p = clampPolicy({ workingHourStart: 18, workingHourEnd: 9 });
    expect(p.workingHourEnd).toBeGreaterThan(p.workingHourStart);
  });

  it("falls back to weekdays when every day is deselected", () => {
    expect(clampPolicy({ workingDays: [] }).workingDays.length).toBeGreaterThan(0);
  });

  it("clamps out-of-range and nonsense numbers", () => {
    const p = clampPolicy({ weeklyInviteCap: 99999, minSpacingSeconds: -50, dailyInviteCap: NaN as never });
    expect(p.weeklyInviteCap).toBeLessThanOrEqual(400);
    expect(p.minSpacingSeconds).toBe(0);
    expect(p.dailyInviteCap).toBe(DEFAULT_LINKEDIN_POLICY.dailyInviteCap);
  });

  it("dedupes and sorts the day list", () => {
    expect(clampPolicy({ workingDays: [5, 1, 1, 9, 3] }).workingDays).toEqual([1, 3, 5]);
  });
});

describe("paused means refused, not unlimited", () => {
  it("blocks every action when disabled", () => {
    for (const kind of ["invite", "message", "lookup", "reaction"]) {
      expect(verdict({ enabled: false }, {}, kind).allowed, kind).toBe(false);
    }
    expect(verdict({ enabled: false }, {}).reason).toBe("disabled");
  });

  it("says so on the page too, since 'paused' invites the opposite reading", () => {
    expect(page).toMatch(/does not mean unlimited/i);
  });
});

describe("every LinkedIn action path passes the gate", () => {
  it("gates invites, and stops the run rather than spinning through leads", () => {
    expect(social).toContain('checkLinkedInAction({ workspaceId, unipileAccountId: ownerAcct, kind: "invite" })');
    const inviteBlock = social.slice(social.indexOf('kind: "invite" })'));
    expect(inviteBlock.slice(0, 400)).toContain("break;");
  });

  it("gates opener messages", () => {
    expect(social).toContain('kind: "message" }');
  });

  it("gates profile lookups BEFORE consuming the atomic reservation", () => {
    const checkAt = lookup.indexOf("checkLinkedInAction(");
    const reserveAt = lookup.indexOf("await reserveSlot(");
    expect(checkAt).toBeGreaterThan(0);
    expect(reserveAt).toBeGreaterThan(0);
    // A refusal must not burn a slot.
    expect(checkAt).toBeLessThan(reserveAt);
  });

  it("records the warming like, which is activity LinkedIn sees", () => {
    // Left out of the ledger, an account's real daily total would be
    // understated by one per invite.
    expect(social).toContain('kind: "reaction"');
  });

  it("records AFTER the action, never before", () => {
    for (const [name, src] of [["social", social], ["lookup", lookup]] as const) {
      const record = src.indexOf("recordLinkedInAction(");
      expect(record, name).toBeGreaterThan(0);
    }
    // A refused or failed API call is not activity LinkedIn saw; counting it
    // would shrink the budget for nothing.
    expect(gate).toMatch(/Recorded AFTER|after the action/i);
  });

  it("fails OPEN on an internal error, with the subsystem caps still behind it", () => {
    // A gate that fails closed on a database blip silently stops all outreach.
    const check = gate.slice(gate.indexOf("export async function checkLinkedInAction"));
    expect(check).toContain("allowed: true");
    expect(check).toContain("console.error");
  });

  it("treats an unconfigured account as governed by the default, not unlimited", () => {
    const load = gate.slice(gate.indexOf("export async function loadPolicy"));
    // Falls back account row → workspace default row → built-in defaults.
    // Absence of a row is never permission.
    expect(load).toContain("r.unipileAccountId === null");
    expect(load).toContain("DEFAULT_LINKEDIN_POLICY");
  });
});

describe("the panel is reachable and honest", () => {
  it("is registered in the one nav source", () => {
    // A page missing from toolRegistry is invisible to the rail, the Library
    // and Cmd+K.
    expect(registry).toContain('href: "/settings/linkedin-limits"');
  });

  it("says the defaults are guesses, because LinkedIn publishes nothing", () => {
    expect(page).toMatch(/publishes no limits/i);
  });

  it("warns when a daily cap would breach the weekly ceiling", () => {
    expect(page).toContain("dailyOverrunsWeekly");
  });

  it("leads with the rolling week, not the calendar week", () => {
    expect(page).toContain("Invites this week");
    const router = readFileSync("server/routers/linkedinLimits.ts", "utf8");
    expect(router).toMatch(/ROLLING, not calendar/i);
  });
});

describe("readout maths", () => {
  it("guards a zero cap instead of dividing by it", () => {
    expect(usedPct(0, 0)).toBe(0);
    expect(usedPct(3, 0)).toBe(100);
    expect(usedPct(5, 10)).toBe(50);
    expect(usedPct(50, 10)).toBe(100);
  });
});
