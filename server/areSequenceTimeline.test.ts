/**
 * Per-prospect sequence timeline override (migration 0170, owner ask
 * 2026-08-20: "mass edit the sequences, especially the sequence timeline").
 *
 * The override is only real if EVERY scheduler consults it — a stored
 * timeline that enrolment ignores is the inert-settings shape, and one that
 * respace flattens is an owner decision silently undone. So:
 *
 *  - sanitizeDayOffsets / dayOffsetForPosition: pure, the ONE reader of the
 *    stored value (never trust the raw column);
 *  - planRespaceForProspect honors an override, so a campaign respace
 *    re-anchors a custom rhythm instead of steamrolling it;
 *  - wiring: enrolment reads it, setSequenceTimeline moves live rows NOW,
 *    the bulk action calls the single-row procedure (the bulk rule), and
 *    0170 is declared in both places.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  dayOffsetForPosition,
  planRespaceForProspect,
  sanitizeDayOffsets,
  MAX_TIMELINE_DAY_OFFSET,
} from "../shared/areStepCadence";

const T = (s: string) => new Date(s);
const NOW = T("2026-08-20T17:00:00Z").getTime();

describe("sanitizeDayOffsets — the one reader", () => {
  it("accepts a plain ascending timeline unchanged", () => {
    expect(sanitizeDayOffsets([0, 3, 10, 17])).toEqual([0, 3, 10, 17]);
  });
  it("rounds fractions and clamps negatives and the ceiling", () => {
    expect(sanitizeDayOffsets([-2, 2.6, 9000])).toEqual([0, 3, MAX_TIMELINE_DAY_OFFSET]);
  });
  it("forces non-decreasing order — a timeline that goes backwards is a typo", () => {
    expect(sanitizeDayOffsets([5, 2, 9])).toEqual([5, 5, 9]);
  });
  it("rejects non-arrays, empties, oversize lists and non-numeric entries", () => {
    expect(sanitizeDayOffsets(null)).toBeNull();
    expect(sanitizeDayOffsets({})).toBeNull();
    expect(sanitizeDayOffsets([])).toBeNull();
    expect(sanitizeDayOffsets([0, "3"])).toBeNull();
    expect(sanitizeDayOffsets([0, NaN])).toBeNull();
    expect(sanitizeDayOffsets(Array.from({ length: 21 }, (_, i) => i))).toBeNull();
  });
});

describe("dayOffsetForPosition", () => {
  it("no override → the campaign grid", () => {
    expect(dayOffsetForPosition(null, 0, 7)).toBe(0);
    expect(dayOffsetForPosition(null, 3, 7)).toBe(21);
  });
  it("override wins inside its range", () => {
    expect(dayOffsetForPosition([0, 3, 10], 1, 7)).toBe(3);
    expect(dayOffsetForPosition([2, 5], 0, 7)).toBe(2); // start delay is a real thing
  });
  it("positions past the override continue at the campaign gap from the last offset", () => {
    // A 7-step sequence with a 3-entry override must still schedule steps
    // 4–7 instead of stacking them on step 3's day.
    expect(dayOffsetForPosition([0, 3, 10], 3, 7)).toBe(17);
    expect(dayOffsetForPosition([0, 3, 10], 5, 7)).toBe(31);
  });
});

describe("planRespaceForProspect with an override", () => {
  it("re-anchors the custom rhythm on the first send — it does not flatten to the uniform grid", () => {
    const rows = [
      { id: 1, stepIndex: 0, status: "sent", scheduledAt: T("2026-08-16T18:14:00Z"), executedAt: T("2026-08-16T18:14:05Z") },
      { id: 2, stepIndex: 1, status: "scheduled", scheduledAt: T("2026-08-19T18:14:00Z") },
      { id: 3, stepIndex: 2, status: "scheduled", scheduledAt: T("2026-08-22T18:14:00Z") },
    ];
    const plan = planRespaceForProspect(rows, 7, NOW, [0, 3, 10]);
    // day 3 from 08-16 = 08-19, already past → floored at now; day 10 = 08-26.
    expect(plan.find((c) => c.id === 2)!.to.getTime()).toBe(NOW);
    expect(plan.find((c) => c.id === 3)!.to.toISOString()).toBe("2026-08-26T18:14:05.000Z");
  });
  it("without an override the behaviour is exactly the uniform grid (regression guard)", () => {
    const rows = [
      { id: 1, stepIndex: 0, status: "sent", scheduledAt: T("2026-08-16T18:14:00Z"), executedAt: T("2026-08-16T18:14:05Z") },
      { id: 2, stepIndex: 1, status: "scheduled", scheduledAt: T("2026-08-19T18:14:00Z") },
    ];
    expect(planRespaceForProspect(rows, 7, NOW)).toEqual(planRespaceForProspect(rows, 7, NOW, null));
    expect(planRespaceForProspect(rows, 7, NOW)[0].to.toISOString()).toBe("2026-08-23T18:14:05.000Z");
  });
});

describe("wiring — the override is consulted everywhere it must be", () => {
  const engine = readFileSync("server/areEngine.ts", "utf8");
  const prospectsRouter = readFileSync("server/routers/are/prospects.ts", "utf8");
  const bulkModule = readFileSync("server/routers/are/prospectsBulk.ts", "utf8");
  const campaignsRouter = readFileSync("server/routers/are/campaigns.ts", "utf8");
  const bar = readFileSync("client/src/components/usip/AreBulkActionBar.tsx", "utf8");
  const page = readFileSync("client/src/pages/usip/ARECampaignDetail.tsx", "utf8");

  it("enrolment selects the column and schedules through the sanitiser", () => {
    const enrol = engine.slice(engine.indexOf("async function enrollApprovedForCampaignUnlocked"), engine.indexOf("async function tickCampaign"));
    expect(enrol).toContain("cadence: prospectIntelligence.cadenceDayOffsets");
    expect(enrol).toContain("sanitizeDayOffsets(row.cadence)");
    expect(enrol).toContain("dayOffsetForPosition(dayOffsets,");
  });

  it("setSequenceTimeline stores through the sanitiser AND moves live scheduled rows now", () => {
    const proc = prospectsRouter.slice(prospectsRouter.indexOf("setSequenceTimeline: workspaceProcedure"), prospectsRouter.indexOf("getAbVariants: workspaceProcedure"));
    expect(proc).toContain("sanitizeDayOffsets(input.dayOffsets)");
    expect(proc).toContain("planRespaceForProspect(execRows, gapDays, Date.now(), clean)");
    // Only scheduled rows may move — sent rows are history.
    expect(proc).toContain('eq(areExecutionQueue.status, "scheduled")');
  });

  it("the bulk action exists and runs the single-row procedure per id (the bulk rule)", () => {
    expect(bulkModule).toContain('"editTimeline"');
    expect(bulkModule).toContain("caller.are.prospects.setSequenceTimeline({ prospectId: r.id, dayOffsets: offsets })");
  });

  it("campaign respace passes each prospect's override through instead of flattening it", () => {
    const rs = campaignsRouter.slice(campaignsRouter.indexOf("respaceSteps: workspaceProcedure"), campaignsRouter.indexOf("setStatus: workspaceProcedure"));
    expect(rs).toContain("sanitizeDayOffsets(i.cadence)");
    expect(rs).toContain("planRespaceForProspect(prows, gapDays, nowMs, overrides.get(pq) ?? null)");
  });

  it("the bar sends dayOffsets (or clearTimeline) and the Sequences tab offers the action with its context", () => {
    expect(bar).toContain('case "timeline": return bulk.mutate({ ...base, ...(tlMode === "campaign" ? { clearTimeline: true } : { dayOffsets: tlOffsets }) });');
    expect(page).toContain('key: "editTimeline"');
    expect(page).toContain("timeline={timelineInfo}");
    // listSequences must return the column or the tab cannot show/prefill it.
    expect(prospectsRouter).toContain("cadenceDayOffsets: prospectIntelligence.cadenceDayOffsets");
  });

  it("migration 0170 is declared in both places", () => {
    const schema = readFileSync("drizzle/schema.ts", "utf8");
    const mig = readFileSync("server/_core/rawMigrations.ts", "utf8");
    expect(schema).toContain('cadenceDayOffsets: json("cadenceDayOffsets")');
    expect(mig).toContain('name: "0170_prospect_intelligence_cadence_offsets.sql"');
    expect(mig).toContain("ALTER TABLE `prospect_intelligence` ADD COLUMN `cadenceDayOffsets` json NULL");
  });
});
