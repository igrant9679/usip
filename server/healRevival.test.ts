/**
 * The self-heal revives one copy per step, spaced a campaign gap apart
 * (audit 2026-09-24).
 *
 * It used to flip every revivable failed row back to `scheduled` at its
 * ORIGINAL time. Eight CommunityForce prospects parked since Aug 17 (enrolled
 * twice, every step failed "Prospect has no email address") had every step
 * overdue and step 0 queued twice: the moment an email turned up, dispatch —
 * every due row up to the daily cap, no per-person limit — would have sent
 * the whole sequence at once, the first email twice. Nine LSI prospects had
 * the same exposure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { planHealRevival, type HealRow } from "@shared/areStepCadence";
import { HEAL_SUPERSEDED, HEALABLE_NO_EMAIL, HEALABLE_POOL_PREFIX } from "./services/sequenceCompletion";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-24T17:00:00Z");
const ago = (days: number) => new Date(NOW - days * DAY);
const row = (id: number, stepIndex: number, status: string, over: Partial<HealRow> = {}): HealRow => ({
  id, stepIndex, status, scheduledAt: ago(30), executedAt: null, healable: status === "failed", ...over,
});

describe("planHealRevival", () => {
  it("the CommunityForce shape: two enrolments, step 0 failed twice — one copy per step, spaced from now", () => {
    // First enrolment (ids 1..7): step 0 failed, steps 1-6 skipped by the cancel.
    // Second enrolment (ids 11..17): every step failed "no email".
    const rows: HealRow[] = [
      row(1, 0, "failed"),
      ...[1, 2, 3, 4, 5, 6].map((s) => row(1 + s, s, "skipped", { healable: false })),
      ...[0, 1, 2, 3, 4, 5, 6].map((s) => row(11 + s, s, "failed")),
    ];
    const plan = planHealRevival(rows, 3, NOW);
    expect(plan.revive.map((r) => r.stepIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // The newest copy of step 0 is the one revived; the older one is superseded.
    expect(plan.revive[0].id).toBe(11);
    expect(plan.supersede).toEqual([1]);
    // First at now, each next a full gap later: never two due together.
    expect(plan.revive.map((r) => (r.to.getTime() - NOW) / DAY)).toEqual([0, 3, 6, 9, 12, 15, 18]);
    expect(plan.reschedule).toEqual([]);
  });

  it("mid-sequence: resumes one gap after the last send and pushes the next scheduled step back", () => {
    const rows: HealRow[] = [
      row(1, 0, "sent", { executedAt: ago(1), healable: false }),
      row(2, 1, "failed"),                                            // pool failure, revivable
      row(3, 2, "scheduled", { scheduledAt: new Date(NOW + 1 * DAY), healable: false }),
      row(4, 3, "scheduled", { scheduledAt: new Date(NOW + 30 * DAY), healable: false }),
    ];
    const plan = planHealRevival(rows, 3, NOW);
    // Last send 1 day ago + 3-day gap = due in 2 days.
    expect(plan.revive).toEqual([{ id: 2, stepIndex: 1, to: new Date(NOW + 2 * DAY) }]);
    // Step 2 was due tomorrow: moved back to keep the gap after the revived step.
    expect(plan.reschedule.map((c) => ({ id: c.id, days: (c.to.getTime() - NOW) / DAY }))).toEqual([{ id: 3, days: 5 }]);
    // Step 3 already sits far enough out: untouched (only ever moved later).
  });

  it("a far-out scheduled step keeps its time, and spacing continues from it, not from the revived one", () => {
    const rows: HealRow[] = [
      row(1, 0, "sent", { executedAt: ago(1), healable: false }),
      row(2, 1, "failed"),
      row(3, 2, "scheduled", { scheduledAt: new Date(NOW + 30 * DAY), healable: false }),
      row(4, 3, "scheduled", { scheduledAt: new Date(NOW + 31 * DAY), healable: false }),
    ];
    const plan = planHealRevival(rows, 3, NOW);
    expect(plan.revive).toEqual([{ id: 2, stepIndex: 1, to: new Date(NOW + 2 * DAY) }]);
    // Step 2 stays on day 30 (never pulled earlier); step 3 was only one day
    // after it, so it moves to day 33 to keep the gap.
    expect(plan.reschedule.map((c) => ({ id: c.id, days: (c.to.getTime() - NOW) / DAY }))).toEqual([{ id: 4, days: 33 }]);
  });

  it("never revives a step already sent, already scheduled, or earlier than a sent step", () => {
    const rows: HealRow[] = [
      row(1, 0, "sent", { executedAt: ago(5), healable: false }),
      row(2, 0, "failed"),                                            // copy of a sent step
      row(3, 1, "failed"),                                            // earlier than step 2, which was sent
      row(4, 2, "sent", { executedAt: ago(2), healable: false }),
      row(5, 3, "scheduled", { scheduledAt: new Date(NOW + 5 * DAY), healable: false }),
      row(6, 3, "failed"),                                            // copy of a scheduled step
    ];
    const plan = planHealRevival(rows, 3, NOW);
    expect(plan.revive).toEqual([]);
    expect(plan.supersede.sort()).toEqual([2, 3, 6]);
    expect(plan.reschedule).toEqual([]);
  });

  it("ignores failed rows the heal's own query did not select", () => {
    const rows: HealRow[] = [row(1, 0, "failed", { healable: false }), row(2, 1, "failed", { healable: false })];
    expect(planHealRevival(rows, 3, NOW)).toEqual({ revive: [], supersede: [], reschedule: [] });
  });

  it("a revived step is never due in the past", () => {
    const plan = planHealRevival([row(1, 0, "failed", { scheduledAt: ago(60) })], 3, NOW);
    expect(plan.revive[0].to.getTime()).toBeGreaterThanOrEqual(NOW);
  });
});

describe("the superseded reason can never be revived", () => {
  it("is neither healable class", () => {
    expect(HEAL_SUPERSEDED).not.toBe(HEALABLE_NO_EMAIL);
    expect(HEAL_SUPERSEDED.startsWith(HEALABLE_POOL_PREFIX)).toBe(false);
  });
});

describe("the engine applies the plan for both heals", () => {
  const engine = readFileSync("server/areEngine.ts", "utf8");
  const apply = engine.slice(engine.indexOf("async function applyHealRevival("), engine.indexOf("/* ─── Per-campaign tick"));

  it("the email heal and the LinkedIn heal both go through applyHealRevival", () => {
    expect(engine).toContain("const healed = await applyHealRevival(db, wsId, campId, healGapDays, healable);");
    expect(engine).toContain("const healedLi = await applyHealRevival(db, wsId, campId, healGapDays, linkedinHealable);");
    // The blanket revive at the original time is gone from both.
    const healBlock = engine.slice(engine.indexOf("const healable = await db"), engine.indexOf("step heal failed"));
    expect(healBlock).not.toContain('.set({ status: "scheduled", failureReason: null, executedAt: null })');
  });

  it("the gap is the campaign's own cadence", () => {
    expect(engine).toContain("const healGapDays = effectiveStepGapDays((campaign as { stepGapDays?: number | null }).stepGapDays);");
  });

  it("every write is conditional on the state the plan read, and supersedes as skipped", () => {
    expect(apply.length).toBeGreaterThan(500);
    expect(apply).toContain("planHealRevival(mine, gapDays, nowMs)");
    expect(apply).toContain('.set({ status: "scheduled", failureReason: null, executedAt: null, scheduledAt: v.to } as never)');
    expect(apply).toContain('.where(and(eq(areExecutionQueue.id, v.id), eq(areExecutionQueue.status, "failed")));');
    expect(apply).toContain('.set({ status: "skipped", failureReason: HEAL_SUPERSEDED, executedAt: new Date() } as never)');
    expect(apply).toContain('.where(and(inArray(areExecutionQueue.id, plan.supersede), eq(areExecutionQueue.status, "failed")));');
    expect(apply).toContain('.where(and(eq(areExecutionQueue.id, c.id), eq(areExecutionQueue.status, "scheduled")));');
    expect(apply).toContain("eq(areExecutionQueue.workspaceId, wsId)");
  });

  it("only prospects that actually got a step back flip from completed to enrolled", () => {
    expect(engine).toContain("const revivedIds = healed.revivedProspectIds;");
    expect(apply).toContain("if (plan.revive.length > 0) revivedProspectIds.push(pid);");
  });
});
