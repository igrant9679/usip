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

/**
 * Run the sequence analyzer against fixed step stats.
 *
 * Spreads the REAL module so only the one query is stubbed — replacing the whole
 * module would strip `rate()`, which attribution.ts imports from it.
 */
async function runSequenceWith(rows: any[]) {
  vi.doMock("./services/performanceMetrics", async (importOriginal) => ({
    ...(await (importOriginal as any)()),
    getSequenceStepStats: vi.fn().mockResolvedValue(rows),
  }));
  const { sequenceAnalyzer } = await import("./services/optimization/sequenceAnalyzer");
  return sequenceAnalyzer.run(1);
}

/** Run the source analyzer against fixed source stats. */
async function runSourceWith(rows: any[]) {
  vi.doMock("./services/performanceMetrics", async (importOriginal) => ({
    ...(await (importOriginal as any)()),
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

describe("attribution — verdict rules", () => {
  const snap = (o: Partial<any> = {}) => ({
    capturedAt: "2026-07-01T00:00:00.000Z", sent: 0, replies: 0, meetings: 0,
    replyRate: 0, meetingRate: 0, ...o,
  });

  it("refuses to judge before enough post-change sends", async () => {
    const { evaluate, MIN_POST_SAMPLE } = await import("./services/optimization/attribution");
    const before = snap({ sent: 100, replies: 10, replyRate: 10 });
    const after = snap({ sent: 100 + MIN_POST_SAMPLE - 1, replies: 10, replyRate: 8 });
    const e = evaluate(before, after);
    // Reverting on a handful of sends would be worse than never reverting.
    expect(e.verdict).toBe("insufficient_data");
  });

  it("flags a real degradation past the tolerance", async () => {
    const { evaluate } = await import("./services/optimization/attribution");
    // baseline 10%; post-window 100 sends / 5 replies = 5% → beyond 20% relative drop
    const e = evaluate(snap({ sent: 200, replies: 20, replyRate: 10 }), snap({ sent: 300, replies: 25, replyRate: 8.3 }));
    expect(e.verdict).toBe("degraded");
    expect(e.postSent).toBe(100);
    expect(e.postReplies).toBe(5);
  });

  it("tolerates ordinary variation instead of thrashing", async () => {
    const { evaluate } = await import("./services/optimization/attribution");
    // baseline 10%; post-window 100 sends / 9 replies = 9% → within tolerance
    const e = evaluate(snap({ sent: 200, replies: 20, replyRate: 10 }), snap({ sent: 300, replies: 29 }));
    expect(e.verdict).not.toBe("degraded");
  });

  it("counts a first-ever meeting as an improvement even if reply rate dipped", async () => {
    const { evaluate } = await import("./services/optimization/attribution");
    const e = evaluate(
      snap({ sent: 200, replies: 20, replyRate: 10, meetings: 0 }),
      snap({ sent: 300, replies: 21, meetings: 1 }),
    );
    expect(e.verdict).toBe("improved");
  });

  it("treats any reply as improvement when the baseline had none", async () => {
    const { evaluate } = await import("./services/optimization/attribution");
    const e = evaluate(snap({ sent: 100, replies: 0, replyRate: 0 }), snap({ sent: 200, replies: 3 }));
    expect(e.verdict).toBe("improved");
  });

  it("never produces negative post-window counts if totals move oddly", async () => {
    const { evaluate } = await import("./services/optimization/attribution");
    const e = evaluate(snap({ sent: 500, replies: 50, replyRate: 10 }), snap({ sent: 400, replies: 40 }));
    expect(e.postSent).toBeGreaterThanOrEqual(0);
    expect(e.postReplies).toBeGreaterThanOrEqual(0);
  });
});

describe("apply — applicability gate", () => {
  it("treats an advisory proposal (no patch) as not applicable", async () => {
    const { isApplicable } = await import("./services/optimization/apply");
    expect(isApplicable({ kind: "copy_winning_step_pattern", proposedValue: null })).toBe(false);
    expect(isApplicable({ kind: "increase_best_source_share", proposedValue: null })).toBe(false);
  });

  it("treats an unknown kind as not applicable even with a patch", async () => {
    const { isApplicable } = await import("./services/optimization/apply");
    // Must fail loudly rather than report success while doing nothing.
    expect(isApplicable({ kind: "some_future_kind", proposedValue: { x: 1 } })).toBe(false);
  });

  it("recognises the two applicable kinds", async () => {
    const { isApplicable } = await import("./services/optimization/apply");
    expect(isApplicable({ kind: "retire_dead_step", proposedValue: { stepIndex: 1, enabled: false } })).toBe(true);
    expect(isApplicable({ kind: "deprioritise_unproductive_source", proposedValue: { enabled: false } })).toBe(true);
  });

  it("every applicable kind has a revert handler", async () => {
    const { APPLY_HANDLERS } = await import("./services/optimization/apply");
    // Auto mode is only defensible because every change can be undone.
    for (const [kind, h] of Object.entries(APPLY_HANDLERS)) {
      expect(typeof h.apply, `${kind}.apply`).toBe("function");
      expect(typeof h.revert, `${kind}.revert`).toBe("function");
    }
  });
});

describe("sequence engine honours a disabled step", () => {
  it("skips a step marked enabled:false", async () => {
    // The optimisation layer's apply path writes enabled:false into the steps
    // JSON; if the engine ignored it the change would be pure dead-wiring.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("server/sequenceEngine.ts", "utf8"),
    );
    expect(src).toContain("step.enabled === false");
    // normalizeStep rebuilds a fixed field list, so the flag must be carried.
    expect(src).toMatch(/enabled:\s*raw\.enabled === false/);
  });
});

describe("phase 4 analyzers — restraint", () => {
  async function runWith(mod: string, exportName: string, stub: Record<string, any>) {
    vi.doMock("./services/performanceMetrics", async (importOriginal) => ({
      ...(await (importOriginal as any)()),
      ...stub,
    }));
    const m = await import(mod);
    return m[exportName].run(1);
  }

  it("crm analyzer stays silent below the closed-deal gate", async () => {
    const out = await runWith("./services/optimization/crmAnalyzer", "crmAnalyzer", {
      getWinLossStats: vi.fn().mockResolvedValue({
        won: 2, lost: 3, open: 1, winRate: 40, avgWonValue: 1000,
        lostReasons: [{ reason: "price", count: 3, share: 100 }],
        openByStage: [{ stage: "discovery", count: 1 }],
      }),
    });
    // 5 closed deals cannot support a loss-pattern claim.
    expect(out).toEqual([]);
  });

  it("crm analyzer names a dominant loss reason once there is volume", async () => {
    const out = await runWith("./services/optimization/crmAnalyzer", "crmAnalyzer", {
      getWinLossStats: vi.fn().mockResolvedValue({
        won: 10, lost: 20, open: 2, winRate: 33.3, avgWonValue: 5000,
        lostReasons: [{ reason: "price", count: 12, share: 60 }, { reason: "timing", count: 8, share: 40 }],
        openByStage: [{ stage: "discovery", count: 2 }],
      }),
    });
    const p = out.find((x: any) => x.kind === "dominant_loss_reason");
    expect(p).toBeDefined();
    expect(p.proposedValue).toBeNull(); // advisory: no correct automatic action
  });

  it("crm analyzer flags unrecorded loss reasons", async () => {
    const out = await runWith("./services/optimization/crmAnalyzer", "crmAnalyzer", {
      getWinLossStats: vi.fn().mockResolvedValue({
        won: 5, lost: 15, open: 0, winRate: 25, avgWonValue: 0,
        lostReasons: [{ reason: "not recorded", count: 12, share: 80 }],
        openByStage: [],
      }),
    });
    expect(out.some((x: any) => x.kind === "missing_loss_reasons")).toBe(true);
  });

  it("sdr analyzer stays silent with a single rep (nothing to compare)", async () => {
    const out = await runWith("./services/optimization/sdrAnalyzer", "sdrAnalyzer", {
      getRepPerformance: vi.fn().mockResolvedValue([
        { userId: 1, sent: 500, replies: 5, positiveReplies: 1, replyRate: 1, positiveRate: 0.2 },
      ]),
    });
    expect(out).toEqual([]);
  });

  it("sdr analyzer stays silent when reps lack individual volume", async () => {
    const out = await runWith("./services/optimization/sdrAnalyzer", "sdrAnalyzer", {
      getRepPerformance: vi.fn().mockResolvedValue([
        { userId: 1, sent: 40, replies: 8, positiveReplies: 2, replyRate: 20, positiveRate: 5 },
        { userId: 2, sent: 30, replies: 0, positiveReplies: 0, replyRate: 0, positiveRate: 0 },
      ]),
    });
    // Per-rep splitting multiplies small-sample unfairness — must not judge.
    expect(out).toEqual([]);
  });

  it("sdr analyzer raises a genuine gap, framed as advisory", async () => {
    const out = await runWith("./services/optimization/sdrAnalyzer", "sdrAnalyzer", {
      getRepPerformance: vi.fn().mockResolvedValue([
        { userId: 1, sent: 200, replies: 30, positiveReplies: 10, replyRate: 15, positiveRate: 5 },
        { userId: 2, sent: 200, replies: 4, positiveReplies: 0, replyRate: 2, positiveRate: 0 },
      ]),
    });
    const p = out.find((x: any) => x.kind === "rep_reply_rate_below_team");
    expect(p).toBeDefined();
    expect(p.scopeLabel).toBe("Rep #2");
    expect(p.proposedValue).toBeNull(); // coaching is never auto-applied
    expect(p.rationale).toMatch(/not enough to explain it/); // stays fair to the person
  });

  it("voice analyzer stays silent below the dial gate", async () => {
    const out = await runWith("./services/optimization/voiceAnalyzer", "voiceAnalyzer", {
      getVoiceStats: vi.fn().mockResolvedValue([
        { direction: "outbound", calls: 20, connected: 1, noAnswer: 19, failed: 0, connectRate: 5, avgDurationSec: 60 },
      ]),
    });
    expect(out).toEqual([]);
  });

  it("voice analyzer flags a low connect rate with enough dials", async () => {
    const out = await runWith("./services/optimization/voiceAnalyzer", "voiceAnalyzer", {
      getVoiceStats: vi.fn().mockResolvedValue([
        { direction: "outbound", calls: 200, connected: 10, noAnswer: 180, failed: 10, connectRate: 5, avgDurationSec: 90 },
      ]),
    });
    expect(out.some((x: any) => x.kind === "low_call_connect_rate")).toBe(true);
  });

  it("voice analyzer distinguishes immediate hang-ups from not connecting", async () => {
    const out = await runWith("./services/optimization/voiceAnalyzer", "voiceAnalyzer", {
      getVoiceStats: vi.fn().mockResolvedValue([
        { direction: "outbound", calls: 200, connected: 100, noAnswer: 100, failed: 0, connectRate: 50, avgDurationSec: 8 },
      ]),
    });
    expect(out.some((x: any) => x.kind === "calls_ending_immediately")).toBe(true);
    // Connect rate is fine here, so it must NOT also cry "low connect rate".
    expect(out.some((x: any) => x.kind === "low_call_connect_rate")).toBe(false);
  });
});

describe("ICP autonomous loop", () => {
  it("exports the cron entry that was missing", async () => {
    const m = await import("./routers/are/icp");
    // Previously runIcpInference had no scheduled caller inside the app at all.
    expect(typeof m.runIcpInferenceAllWorkspaces).toBe("function");
  }, 20_000);

  it("is registered as a background job in index.ts", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("server/_core/index.ts", "utf8"));
    expect(src).toContain("runIcpInferenceAllWorkspaces");
  });

  /**
   * This assertion used to read `expect(src).toContain("SCHEDULED_TASK_SECRET")`
   * against the whole of emailTracking.ts. One gated endpoint satisfied it
   * forever while its two ungated siblings sat in the same file — which is
   * precisely what happened, for as long as this test was "passing".
   *
   * The per-endpoint version lives in scheduledEndpointAuth.test.ts. What is
   * left here is the narrow claim this describe block is actually about.
   */
  it("the scheduled icp-regen endpoint checks a shared secret", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("server/emailTracking.ts", "utf8"));
    // It triggers an LLM call per workspace; it must not stay open to anyone.
    expect(src).toMatch(/requireScheduledSecret\(req, res, "icp-regen"\)/);
  });
});

describe("retired steps survive being saved", () => {
  // The optimisation layer writes enabled:false into sequences.steps. Every save
  // path must preserve it: while the zod stepSchema omitted the field, saving
  // ANYTHING from the editor silently re-enabled a retired step while the
  // optimisation audit trail still reported it as disabled.
  it("stepSchema accepts enabled on every step type", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("server/routers/sequences.ts", "utf8"),
    );
    expect(src).toContain("const enabledField = { enabled: z.boolean().optional() }");
    // 5 variants + the email object = every branch of the discriminated union.
    const spreads = src.match(/\.\.\.enabledField/g) ?? [];
    expect(spreads.length).toBeGreaterThanOrEqual(5);
  });

  it("the canvas round-trip carries the flag in both directions", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("server/routers/sequences.ts", "utf8"),
    );
    // steps -> canvas
    expect(src).toMatch(/enabled === false\) data\.enabled = false/);
    // canvas -> steps
    expect(src).toContain("const retired = d.enabled === false");
    const spread = src.match(/\.\.\.retired/g) ?? [];
    expect(spread.length).toBeGreaterThanOrEqual(5);
  });

  it("the editor surfaces a retired step instead of showing it as normal", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("client/src/pages/usip/SequenceEditor.tsx", "utf8"),
    );
    expect(src).toContain("Skipped — not sending");
    expect(src).toContain("toggleStepEnabled");
  });
});

describe("runner wiring", () => {
  it("registers every analyzer module", async () => {
    const { ANALYZERS } = await import("./services/optimization/runner");
    expect(ANALYZERS.map((a) => a.module).sort()).toEqual(
      ["crm", "messaging", "sdr_coaching", "sequences", "sourcing", "voice"],
    );
  });

  /**
   * Every module an analyzer claims must exist in the `module` column's enum,
   * or the proposal fails on INSERT at runtime rather than at compile time —
   * the `as never` trap this codebase keeps rediscovering.
   */
  it("only claims modules the recommendations enum can store", async () => {
    const { ANALYZERS } = await import("./services/optimization/runner");
    const allowed = ["sequences", "messaging", "sourcing", "voice", "crm", "icp", "sdr_coaching"];
    for (const a of ANALYZERS) expect(allowed).toContain(a.module);
  });

  // Importing the whole appRouter pulls in every router in the app, which takes
  // several seconds — well past vitest's 5s default as the app grows.
  it("mounts the optimization router on the app router", async () => {
    const { appRouter } = await import("./routers");
    const record = (appRouter as any)._def?.record ?? (appRouter as any)._def?.procedures ?? {};
    expect(Object.keys(record)).toContain("optimization");
  }, 30_000);
});
