/**
 * performanceMetrics — the measurement substrate behind the A/B tab and the
 * "What's working" surfaces. The attribution rules are the part most likely to
 * be subtly wrong, so they're tested as pure functions (no DB mocks).
 */
import { describe, it, expect } from "vitest";
import {
  rate,
  computeVariantCells,
  variantCellKey,
  MIN_VARIANT_SAMPLE,
} from "./services/performanceMetrics";

describe("rate()", () => {
  it("returns 0 rather than NaN/Infinity when nothing was sent", () => {
    expect(rate(0, 0)).toBe(0);
    expect(rate(5, 0)).toBe(0);
    expect(rate(1, -3)).toBe(0);
  });

  it("computes a percentage rounded to one decimal", () => {
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(1, 2)).toBe(50);
    expect(rate(3, 3)).toBe(100);
  });
});

describe("computeVariantCells — send counting", () => {
  it("counts sends per (step, variant) independently", () => {
    const cells = computeVariantCells(
      [
        { prospectQueueId: 1, stepIndex: 0, variantKey: "A", executedAt: "2026-07-01T10:00:00Z" },
        { prospectQueueId: 2, stepIndex: 0, variantKey: "A", executedAt: "2026-07-01T10:00:00Z" },
        { prospectQueueId: 3, stepIndex: 0, variantKey: "B", executedAt: "2026-07-01T10:00:00Z" },
        { prospectQueueId: 4, stepIndex: 1, variantKey: "A", executedAt: "2026-07-01T10:00:00Z" },
      ],
      [],
    );
    expect(cells.get(variantCellKey(0, "A"))?.sent).toBe(2);
    expect(cells.get(variantCellKey(0, "B"))?.sent).toBe(1);
    expect(cells.get(variantCellKey(1, "A"))?.sent).toBe(1);
  });

  it("defaults a missing variantKey to A rather than dropping the send", () => {
    const cells = computeVariantCells(
      [{ prospectQueueId: 1, stepIndex: 0, variantKey: undefined as any, executedAt: null }],
      [],
    );
    expect(cells.get(variantCellKey(0, "A"))?.sent).toBe(1);
  });
});

describe("computeVariantCells — outcome attribution", () => {
  const sends = [
    { prospectQueueId: 7, stepIndex: 0, variantKey: "A", executedAt: "2026-07-01T10:00:00Z" },
    { prospectQueueId: 7, stepIndex: 1, variantKey: "B", executedAt: "2026-07-05T10:00:00Z" },
  ];

  it("credits a reply to the prospect's most recent send (last touch)", () => {
    const cells = computeVariantCells(sends, [{ prospectQueueId: 7, signalType: "email_reply" }]);
    expect(cells.get(variantCellKey(1, "B"))?.replies).toBe(1);
    expect(cells.get(variantCellKey(0, "A"))?.replies).toBe(0);
  });

  it("credits a booked meeting separately from a reply", () => {
    const cells = computeVariantCells(sends, [
      { prospectQueueId: 7, signalType: "email_reply" },
      { prospectQueueId: 7, signalType: "meeting_booked" },
    ]);
    const cell = cells.get(variantCellKey(1, "B"))!;
    expect(cell.replies).toBe(1);
    expect(cell.meetings).toBe(1);
  });

  it("ignores signal types that are not reply/meeting", () => {
    const cells = computeVariantCells(sends, [
      { prospectQueueId: 7, signalType: "email_open" },
      { prospectQueueId: 7, signalType: "email_bounce" },
    ]);
    expect(cells.get(variantCellKey(1, "B"))?.replies).toBe(0);
    expect(cells.get(variantCellKey(1, "B"))?.meetings).toBe(0);
  });

  it("drops a signal for a prospect with no recorded send (cannot invent a source)", () => {
    const cells = computeVariantCells(sends, [{ prospectQueueId: 999, signalType: "email_reply" }]);
    const total = [...cells.values()].reduce((n, c) => n + c.replies, 0);
    expect(total).toBe(0);
  });

  it("breaks a timestamp tie toward the later step", () => {
    const tied = [
      { prospectQueueId: 3, stepIndex: 0, variantKey: "A", executedAt: "2026-07-01T10:00:00Z" },
      { prospectQueueId: 3, stepIndex: 2, variantKey: "B", executedAt: "2026-07-01T10:00:00Z" },
    ];
    const cells = computeVariantCells(tied, [{ prospectQueueId: 3, signalType: "email_reply" }]);
    expect(cells.get(variantCellKey(2, "B"))?.replies).toBe(1);
  });

  it("handles null timestamps without crediting the wrong step", () => {
    const nulls = [
      { prospectQueueId: 4, stepIndex: 0, variantKey: "A", executedAt: null },
      { prospectQueueId: 4, stepIndex: 1, variantKey: "A", executedAt: null },
    ];
    const cells = computeVariantCells(nulls, [{ prospectQueueId: 4, signalType: "meeting_booked" }]);
    expect(cells.get(variantCellKey(1, "A"))?.meetings).toBe(1);
    expect(cells.get(variantCellKey(0, "A"))?.meetings).toBe(0);
  });

  it("never reports a reply rate above 100% for one prospect replying once", () => {
    const cells = computeVariantCells(sends, [{ prospectQueueId: 7, signalType: "email_reply" }]);
    const cell = cells.get(variantCellKey(1, "B"))!;
    expect(rate(cell.replies, cell.sent)).toBeLessThanOrEqual(100);
  });
});

describe("metrics router wiring", () => {
  // A router that exists but was never mounted is this codebase's most common
  // defect — the /are/performance page would 404 on every query with no
  // compile error to catch it.
  it("is mounted on areRouter as `metrics`", async () => {
    const { areRouter } = await import("./routers/are");
    const record = (areRouter as any)._def?.record ?? (areRouter as any)._def?.procedures ?? {};
    expect(Object.keys(record)).toContain("metrics");
  });

  it("exposes every procedure the dashboard queries", async () => {
    const { metricsRouter } = await import("./routers/are/metrics");
    const record = (metricsRouter as any)._def?.record ?? (metricsRouter as any)._def?.procedures ?? {};
    for (const proc of ["sequenceSteps", "sourceYield", "replyMix", "abVariants", "thresholds"]) {
      expect(Object.keys(record)).toContain(proc);
    }
  });
});

describe("sample-size guard", () => {
  it("sets a threshold high enough to avoid crowning winners on noise", () => {
    expect(MIN_VARIANT_SAMPLE).toBeGreaterThanOrEqual(20);
  });
});
