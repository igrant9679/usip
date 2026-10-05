/**
 * A person enriching one record may do so while the account's LinkedIn
 * activity is switched off (owner ask 2026-10-05, option 3): the switch is
 * there to stop automated activity. Hours, spacing and every cap still
 * apply, and bulk/list enrichment and the daily check stay behind the switch.
 */
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { evaluateLinkedInAction } from "../shared/linkedinLimits";

const policy = {
  enabled: false, weeklyInviteCap: 80, dailyInviteCap: 15, dailyMessageCap: 40, dailyLookupCap: 100, dailySearchCap: 30,
  dailyActionCap: 120, minSpacingSeconds: 90, jitterSeconds: 0, workingHourStart: 8, workingHourEnd: 18,
  workingDays: [1, 2, 3, 4, 5], timezone: "America/New_York", warmupDays: 14,
};
const quiet = { today: {}, week: {}, todayTotal: 0, lastActionAt: null };
// Monday 2026-10-05, 5:19 PM Eastern: when the owner's enrichment failed.
const AT = new Date("2026-10-05T21:19:00Z");
const run = (over: Record<string, unknown> = {}) =>
  evaluateLinkedInAction({ policy: policy as any, usage: quiet as any, kind: "lookup", now: AT, accountAgeDays: 136, ...over } as any);

describe("LinkedIn switched off", () => {
  it("still blocks anything not asked for by a person", () => {
    expect(run()).toMatchObject({ allowed: false, reason: "disabled" });
  });
  it("lets a person's single lookup or search through", () => {
    expect(run({ personInitiated: true }).allowed).toBe(true);
    expect(run({ personInitiated: true, kind: "search" }).allowed).toBe(true);
  });
  it("but not outside the account's hours, too soon after the last action, or over a cap", () => {
    expect(run({ personInitiated: true, now: new Date("2026-10-05T23:30:00Z") })).toMatchObject({ allowed: false, reason: "outside_hours" });
    expect(run({ personInitiated: true, usage: { ...quiet, lastActionAt: new Date(AT.getTime() - 10_000) } })).toMatchObject({ allowed: false, reason: "spacing" });
    expect(run({ personInitiated: true, usage: { ...quiet, today: { lookup: 100 }, todayTotal: 100 } })).toMatchObject({ allowed: false, reason: "daily_kind_cap" });
  });
});

describe("who counts as a person asking", () => {
  const read = (...p: string[]) => readFileSync(path.join(__dirname, ...p), "utf8");
  it("one record, from a record-level action; never a list, a bulk run of many, or the daily check", () => {
    const o = read("services", "linkedinEnrichment", "orchestrator.ts");
    expect(o).toContain('export const PERSON_TRIGGERS = ["people_row_action", "open_profile_action", "full_profile_action", "people_bulk_action"] as const;');
    expect(o).toContain("const personInitiated = ids.length === 1 && (PERSON_TRIGGERS as readonly string[]).includes(opts.triggerType);");
    expect(o.match(/personInitiated: ctx\.personInitiated/g)).toHaveLength(3);
  });
  it("a manager's refresh or confirm of one record counts", () => {
    const r = read("routers", "linkedinEnrichment.ts");
    expect(r.match(/personInitiated: true/g)).toHaveLength(3);
  });
  it("the flag reaches the gate for lookups and searches", () => {
    const l = read("services", "linkedinLookup.ts");
    expect(l).toContain('kind: "lookup",\n    personInitiated: opts.personInitiated,');
    expect(l).toContain('kind: "search", personInitiated: opts.personInitiated });');
    const g = read("services", "linkedin", "activityGate.ts");
    expect(g).toContain("accountAgeDays: ageDays, personInitiated: input.personInitiated });");
    expect(g).toContain("      personInitiated: input.personInitiated,\n    });\n    if (verdict.allowed)");
  });
});
