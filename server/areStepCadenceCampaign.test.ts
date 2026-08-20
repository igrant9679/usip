/**
 * The campaign owns its step cadence (migration 0169, owner ask 2026-08-19:
 * "make all of the current sequence steps automatically 1 week apart").
 *
 *  - planRespaceForProspect: pure, with the live CommunityForce shapes — a
 *    prospect whose step 0 went on 08-16 and whose steps 1–6 sat at 1–4-day
 *    gaps; a never-touched prospect whose first slot is kept; sent rows never
 *    move; nothing lands in the past.
 *  - enrolment schedules anchor + k × gap (source-checked: the engine no
 *    longer reads s.dayOffset for scheduledAt).
 *  - update/create accept stepGapDays and update WRITES it (the router copies
 *    fields one by one — an accepted-but-uncopied field is an inert setting).
 *  - 0169 declared in both places.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { planRespaceForProspect, effectiveStepGapDays, dueAtForPosition, MAX_STEP_GAP_DAYS } from "../shared/areStepCadence";

const T = (s: string) => new Date(s);
const NOW = T("2026-08-19T16:45:00Z").getTime();

describe("planRespaceForProspect", () => {
  it("re-anchors an in-flight prospect on its FIRST send: sent row untouched, steps 1..6 at +7d each", () => {
    // pq 16106 as measured live on 08-19: step 0 sent 08-16 18:14, then 08-19, 08-22, 08-25, 08-27, 08-29, 08-30.
    const rows = [
      { id: 1, stepIndex: 0, status: "sent", scheduledAt: T("2026-08-16T18:14:00Z"), executedAt: T("2026-08-16T18:14:05Z") },
      { id: 2, stepIndex: 1, status: "scheduled", scheduledAt: T("2026-08-19T18:14:00Z") },
      { id: 3, stepIndex: 2, status: "scheduled", scheduledAt: T("2026-08-22T18:14:00Z") },
      { id: 4, stepIndex: 3, status: "scheduled", scheduledAt: T("2026-08-25T18:14:00Z") },
      { id: 5, stepIndex: 4, status: "scheduled", scheduledAt: T("2026-08-27T18:14:00Z") },
      { id: 6, stepIndex: 5, status: "scheduled", scheduledAt: T("2026-08-29T18:14:00Z") },
      { id: 7, stepIndex: 6, status: "scheduled", scheduledAt: T("2026-08-30T18:14:00Z") },
    ];
    const plan = planRespaceForProspect(rows, 7, NOW);
    expect(plan.map((c) => c.id)).toEqual([2, 3, 4, 5, 6, 7]); // the sent row is not in the plan
    expect(plan.map((c) => c.to.toISOString())).toEqual([
      "2026-08-23T18:14:05.000Z", "2026-08-30T18:14:05.000Z", "2026-09-06T18:14:05.000Z",
      "2026-09-13T18:14:05.000Z", "2026-09-20T18:14:05.000Z", "2026-09-27T18:14:05.000Z",
    ]);
  });

  it("a never-touched prospect keeps its first slot as the anchor; later steps fan out from it", () => {
    // pq 16103 live shape: steps 1..6 scheduled (no step 0 in the conversation), first at 08-20 14:50.
    const rows = [1, 2, 3, 4, 5, 6].map((i) => ({ id: 10 + i, stepIndex: i, status: "scheduled", scheduledAt: T(`2026-08-${19 + i}T14:50:00Z`) }));
    const plan = planRespaceForProspect(rows, 7, NOW);
    // step 1 already sits on its anchor (08-20 14:50) → no change for it
    expect(plan.find((c) => c.stepIndex === 1)).toBeUndefined();
    expect(plan.find((c) => c.stepIndex === 2)!.to.toISOString()).toBe("2026-08-27T14:50:00.000Z");
    expect(plan.find((c) => c.stepIndex === 6)!.to.toISOString()).toBe("2026-09-24T14:50:00.000Z");
  });

  it("skipped and failed rows are not part of the conversation", () => {
    const rows = [
      { id: 1, stepIndex: 0, status: "failed", scheduledAt: T("2026-08-10T00:00:00Z") },
      { id: 2, stepIndex: 1, status: "sent", scheduledAt: T("2026-08-12T00:00:00Z"), executedAt: T("2026-08-12T00:00:00Z") },
      { id: 3, stepIndex: 2, status: "skipped", scheduledAt: T("2026-08-14T00:00:00Z") },
      { id: 4, stepIndex: 3, status: "scheduled", scheduledAt: T("2026-08-16T00:00:00Z") },
    ];
    const plan = planRespaceForProspect(rows, 7, NOW);
    // live order: [sent(1), scheduled(3)] → position 1 → 08-12 + 7d = 08-19 00:00, which is in the past → now
    expect(plan).toHaveLength(1);
    expect(plan[0].to.getTime()).toBe(NOW);
  });

  it("nothing lands in the past", () => {
    const rows = [
      { id: 1, stepIndex: 0, status: "sent", scheduledAt: T("2026-08-01T00:00:00Z"), executedAt: T("2026-08-01T00:00:00Z") },
      { id: 2, stepIndex: 1, status: "scheduled", scheduledAt: T("2026-08-03T00:00:00Z") },
    ];
    const [c] = planRespaceForProspect(rows, 7, NOW);
    expect(c.to.getTime()).toBe(NOW); // 08-08 would be past → now
  });

  it("a row already on the grid does not move (idempotent re-runs)", () => {
    const rows = [
      { id: 1, stepIndex: 0, status: "sent", scheduledAt: T("2026-08-16T18:14:00Z"), executedAt: T("2026-08-16T18:14:05Z") },
      { id: 2, stepIndex: 1, status: "scheduled", scheduledAt: T("2026-08-23T18:14:05Z") },
    ];
    expect(planRespaceForProspect(rows, 7, NOW)).toEqual([]);
  });
});

describe("cadence helpers", () => {
  it("effectiveStepGapDays defaults to 7 and clamps", () => {
    expect(effectiveStepGapDays(null)).toBe(7);
    expect(effectiveStepGapDays(undefined)).toBe(7);
    expect(effectiveStepGapDays(0)).toBe(1);
    expect(effectiveStepGapDays(90)).toBe(MAX_STEP_GAP_DAYS);
    expect(effectiveStepGapDays(14)).toBe(14);
  });
  it("dueAtForPosition is anchor + k×gap, floored at now", () => {
    const a = T("2026-08-16T18:14:00Z").getTime();
    expect(dueAtForPosition(a, 3, 7, NOW).toISOString()).toBe("2026-09-06T18:14:00.000Z");
    expect(dueAtForPosition(a, 0, 7, NOW).getTime()).toBe(NOW);
  });
});

describe("wiring", () => {
  const engine = readFileSync("server/areEngine.ts", "utf8");
  const router = readFileSync("server/routers/are/campaigns.ts", "utf8");

  it("enrolment schedules from the campaign cadence (or the 0170 prospect override), not the generated day offsets", () => {
    const enrol = engine.slice(engine.indexOf("async function enrollApprovedForCampaignUnlocked"), engine.indexOf("async function tickCampaign"));
    expect(enrol).toContain("effectiveStepGapDays(");
    expect(enrol).toContain("dueAtForDay(anchor, dayOffsetForPosition(dayOffsets, positionOf.get(s.stepIndex)");
    expect(enrol).not.toMatch(/anchor \+ s\.dayOffset/);
  });

  it("update copies stepGapDays into the write (an accepted-but-uncopied field would be an inert setting)", () => {
    const upd = router.slice(router.indexOf("  update: workspaceProcedure"), router.indexOf("  respaceSteps: workspaceProcedure"));
    expect(upd).toContain("stepGapDays: z.number().int()");
    expect(upd).toContain("updates.stepGapDays = effectiveStepGapDays(rest.stepGapDays)");
    expect(upd).toContain("updates.autonomyMode = rest.autonomyMode");
  });

  it("respaceSteps is dry-run by default and only ever moves `scheduled` rows", () => {
    const rs = router.slice(router.indexOf("  respaceSteps: workspaceProcedure"), router.indexOf("  setStatus: workspaceProcedure"));
    expect(rs).toContain("apply: z.boolean().default(false)");
    expect(rs).toContain('eq(areExecutionQueue.status, "scheduled")');
    expect(rs).toContain("planRespaceForProspect(");
  });

  it("migration 0169 is declared in both places", () => {
    const schema = readFileSync("drizzle/schema.ts", "utf8").replace(/\r\n/g, "\n");
    const mig = readFileSync("server/_core/rawMigrations.ts", "utf8");
    expect(schema).toContain('stepGapDays: int("stepGapDays").default(7).notNull()');
    expect(mig).toContain('name: "0169_are_campaign_step_gap.sql"');
    expect(mig).toContain("ALTER TABLE `are_campaigns` ADD COLUMN `stepGapDays` int NOT NULL DEFAULT 7");
  });
});
