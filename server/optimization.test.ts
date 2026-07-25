/**
 * Optimisation layer (Phase 2) — the analyzers' restraint is the thing worth
 * testing. An analyzer that invents recommendations from thin data is worse than
 * no analyzer, because Phase 3 will let some of these auto-apply.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { confidenceFromSample, MIN_SOURCE_SAMPLE, MIN_STEP_SAMPLE } from "./services/optimization/types";
import { rankSources } from "./services/optimization/sourceAnalyzer";

beforeEach(() => vi.resetModules());

const step = (o: Partial<any> = {}) => ({
  sequenceId: 1, stepIndex: 0, sent: 0, opens: 0, clicks: 0, replies: 0,
  positiveReplies: 0, meetings: 0, openRate: 0, replyRate: 0, positiveRate: 0, meetingRate: 0, ...o,
});
const source = (o: Partial<any> = {}) => ({
  sourceType: "apollo", discovered: 0, contacted: 0, replied: 0, meetings: 0,
  avgIcpScore: 60, contactedRate: 0, replyRate: 0, meetingRate: 0, ...o,
});

/** Run the sequence analyzer against fixed step stats. */
async function runSequenceWith(rows: any[]) {
  vi.doMock("./services/performanceMetrics", () => ({
    getSequenceStepStats: vi.fn().mockResolvedValue(rows),
  }));
  const { sequenceAnalyzer } = await import("./services/optimization/sequenceAnalyzer");
  return sequenceAnalyzer.run(1);
}

/** Run the source analyzer against fixed source stats. */
async function runSourceWith(rows: any[]) {
  vi.doMock("./services/performanceMetrics", () => ({
    getSourceYieldStats: vi.fn().mockResolvedValue(rows),
  }));
  const { sourceAnalyzer } = await import("./services/optimization/sourceAnalyzer");
  return sourceAnalyzer.run(1);
}

describe("confidenceFromSample", () => {
  it("never calls a small sample high-confidence", () => {
    expect(confidenceFromSample(0)).toBe("low");
    expect(confidenceFromSample(74)).toBe("low");
    expect(confidenceFromSample(75)).toBe("medium");
    expect(confidenceFromSample(199)).toBe("medium");
    expect(confidenceFromSample(200)).toBe("high");
  });
});

describe("sequence analyzer — restraint", () => {
  it("says nothing when there is no data at all", async () => {
    expect(await runSequenceWith([])).toEqual([]);
  });

  it("says nothing when every step is below the volume gate", async () => {
    const out = await runSequenceWith([
      step({ stepIndex: 0, sent: MIN_STEP_SAMPLE - 1, replies: 0 }),
      step({ stepIndex: 1, sent: 3, replies: 0 }),
    ]);
    expect(out).toEqual([]); // a 0-reply step from 3 sends is noise, not a finding
  });

  it("flags a high-volume step that has never earned a reply", async () => {
    const out = await runSequenceWith([step({ stepIndex: 2, sent: 120, replies: 0 })]);
    const dead = out.filter((p) => p.kind === "retire_dead_step");
    expect(dead).toHaveLength(1);
    expect(dead[0].sampleSize).toBe(120);
    expect(dead[0].confidence).toBe("medium");
  });

  it("emits an APPLICABLE patch for the dead-step proposal", async () => {
    const out = await runSequenceWith([step({ stepIndex: 2, sent: 120, replies: 0 })]);
    const dead = out.find((p) => p.kind === "retire_dead_step")!;
    // Phase 3 must be able to act on this without parsing prose.
    expect(dead.proposedValue).toEqual({ stepIndex: 2, enabled: false });
    expect(dead.currentValue).toEqual({ stepIndex: 2, enabled: true });
  });

  it("does not flag a step that is producing replies", async () => {
    const out = await runSequenceWith([step({ stepIndex: 0, sent: 100, replies: 9, replyRate: 9 })]);
    expect(out.filter((p) => p.kind === "retire_dead_step")).toHaveLength(0);
  });

  it("ignores a tiny gap between steps rather than manufacturing advice", async () => {
    const out = await runSequenceWith([
      step({ stepIndex: 0, sent: 100, replies: 10, replyRate: 10 }),
      step({ stepIndex: 1, sent: 100, replies: 9, replyRate: 9 }),
    ]);
    expect(out.filter((p) => p.kind === "copy_winning_step_pattern")).toHaveLength(0);
  });

  it("reports a meaningful gap between best and worst step", async () => {
    const out = await runSequenceWith([
      step({ stepIndex: 0, sent: 100, replies: 12, replyRate: 12 }),
      step({ stepIndex: 1, sent: 100, replies: 2, replyRate: 2 }),
    ]);
    const gap = out.find((p) => p.kind === "copy_winning_step_pattern");
    expect(gap).toBeDefined();
    // Advisory — rewriting copy is not something code should silently apply.
    expect(gap!.proposedValue).toBeNull();
  });

  it("always attaches evidence and a sample size", async () => {
    const out = await runSequenceWith([step({ stepIndex: 0, sent: 60, replies: 0 })]);
    for (const p of out) {
      expect(p.evidence).toBeTruthy();
      expect(Object.keys(p.evidence).length).toBeGreaterThan(0);
      expect(p.sampleSize).toBeGreaterThan(0);
    }
  });
});

describe("source analyzer — restraint", () => {
  it("says nothing with no sources", async () => {
    expect(await runSourceWith([])).toEqual([]);
  });

  it("says nothing when no source has been contacted enough to judge", async () => {
    const out = await runSourceWith([
      source({ sourceType: "apollo", discovered: 500, contacted: MIN_SOURCE_SAMPLE - 1 }),
    ]);
    // High discovery volume must NOT buy a verdict — this is the exact bias
    // (rank by volume) the analyzer exists to correct.
    expect(out).toEqual([]);
  });

  it("flags a well-worked source that has booked nothing", async () => {
    const out = await runSourceWith([
      source({ sourceType: "web_scrape", discovered: 400, contacted: 90, replied: 4, meetings: 0 }),
    ]);
    const dead = out.filter((p) => p.kind === "deprioritise_unproductive_source");
    expect(dead).toHaveLength(1);
    expect(dead[0].scopeLabel).toBe("web_scrape");
    expect(dead[0].sampleSize).toBe(90);
  });

  it("does not flag a source that books meetings", async () => {
    const out = await runSourceWith([
      source({ sourceType: "apollo", discovered: 100, contacted: 50, replied: 8, meetings: 3, meetingRate: 6 }),
    ]);
    expect(out.filter((p) => p.kind === "deprioritise_unproductive_source")).toHaveLength(0);
  });

  it("recommends concentrating on the source that books meetings", async () => {
    const out = await runSourceWith([
      source({ sourceType: "apollo", discovered: 60, contacted: 40, replied: 6, meetings: 3, meetingRate: 7.5, replyRate: 15 }),
      source({ sourceType: "web_scrape", discovered: 900, contacted: 300, replied: 3, meetings: 0, meetingRate: 0, replyRate: 1 }),
    ]);
    const best = out.find((p) => p.kind === "increase_best_source_share");
    expect(best).toBeDefined();
    // The low-volume, meeting-producing source wins over the high-volume one.
    expect(best!.scopeLabel).toBe("apollo");
  });
});

describe("rankSources", () => {
  it("ranks by meeting rate before reply rate, ignoring raw volume", () => {
    const ranked = rankSources([
      source({ sourceType: "loud", discovered: 5000, contacted: 900, replyRate: 20, meetingRate: 0 }),
      source({ sourceType: "quiet", discovered: 20, contacted: 20, replyRate: 5, meetingRate: 10 }),
    ] as any);
    expect(ranked[0].sourceType).toBe("quiet");
  });
});

describe("runner wiring", () => {
  it("registers both analyzers", async () => {
    const { ANALYZERS } = await import("./services/optimization/runner");
    expect(ANALYZERS.map((a) => a.module).sort()).toEqual(["sequences", "sourcing"]);
  });

  it("mounts the optimization router on the app router", async () => {
    const { appRouter } = await import("./routers");
    const record = (appRouter as any)._def?.record ?? (appRouter as any)._def?.procedures ?? {};
    expect(Object.keys(record)).toContain("optimization");
  });
});
