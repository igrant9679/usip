import { describe, it, expect, vi, beforeEach } from "vitest";

const funnel = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../performanceMetrics", () => ({ getChatFunnelStats: funnel.get }));

import { chatAnalyzer, MIN_CHAT_SAMPLE, HIGH_CONFIDENCE_SAMPLE } from "./chatAnalyzer";

const stats = (o: Record<string, number | string> = {}) => ({
  sessions: 100, engaged: 90, emailCaptured: 60, qualified: 50, leads: 55, meetings: 30,
  followUpsActioned: 0, engagedRate: 90, emailRate: 67, qualifiedRate: 83, meetingRate: 60,
  medianMessagesToEmail: 6, biggestDropStage: "booking", biggestDropCount: 20, ...o,
});

beforeEach(() => funnel.get.mockReset());

/**
 * The gate is the point of this analyzer. The outbound side of this product
 * already shows the failure mode — confident advice about almost no data — so
 * silence on a thin funnel is the CORRECT output, not a missing feature.
 */
describe("chatAnalyzer silence on thin data", () => {
  it("says nothing at all below the minimum sample, however bad the rates look", async () => {
    funnel.get.mockResolvedValue(stats({
      sessions: MIN_CHAT_SAMPLE - 1, engaged: 2, emailCaptured: 0, qualified: 0, meetings: 0,
      engagedRate: 7, emailRate: 0, qualifiedRate: 0, meetingRate: 0,
    }));
    expect(await chatAnalyzer.run(1)).toEqual([]);
  });

  it("says nothing for an empty workspace", async () => {
    funnel.get.mockResolvedValue(stats({
      sessions: 0, engaged: 0, emailCaptured: 0, qualified: 0, meetings: 0,
      engagedRate: 0, emailRate: 0, qualifiedRate: 0, meetingRate: 0,
    }));
    expect(await chatAnalyzer.run(1)).toEqual([]);
  });

  it("says nothing when the funnel is healthy", async () => {
    funnel.get.mockResolvedValue(stats());
    expect(await chatAnalyzer.run(1)).toEqual([]);
  });

  /** Enough sessions overall, but the per-stage denominator is still thin. */
  it("does not judge email capture on a handful of engaged visitors", async () => {
    funnel.get.mockResolvedValue(stats({
      sessions: 60, engaged: 5, emailCaptured: 0, emailRate: 0, qualified: 0, meetings: 0,
      engagedRate: 95, qualifiedRate: 0, meetingRate: 0,
    }));
    const kinds = (await chatAnalyzer.run(1)).map((p) => p.kind);
    expect(kinds).not.toContain("chat_email_capture");
  });
});

describe("chatAnalyzer findings", () => {
  it("flags a weak opening line", async () => {
    funnel.get.mockResolvedValue(stats({ sessions: 100, engaged: 20, engagedRate: 20 }));
    const p = (await chatAnalyzer.run(1)).find((x) => x.kind === "chat_opening_line");
    expect(p).toBeTruthy();
    expect(p!.sampleSize).toBe(100);
    expect(p!.evidence).toMatchObject({ engagedRate: 20 });
  });

  it("flags weak email capture, the hard prerequisite for booking", async () => {
    funnel.get.mockResolvedValue(stats({ engaged: 90, emailCaptured: 9, emailRate: 10 }));
    const p = (await chatAnalyzer.run(1)).find((x) => x.kind === "chat_email_capture");
    expect(p).toBeTruthy();
    expect(p!.rationale).toMatch(/hard prerequisite/i);
  });

  it("flags qualified visitors who do not book", async () => {
    funnel.get.mockResolvedValue(stats({ qualified: 50, meetings: 2, meetingRate: 4 }));
    const p = (await chatAnalyzer.run(1)).find((x) => x.kind === "chat_booking_conversion");
    expect(p).toBeTruthy();
    expect(p!.rationale).toMatch(/timezone/i);
  });

  /**
   * Advisory only: persona wording and where the widget is installed are
   * judgement calls. A machine-applicable patch would imply otherwise.
   */
  it("never emits an applicable patch", async () => {
    funnel.get.mockResolvedValue(stats({ engagedRate: 10, emailRate: 5, meetingRate: 1, engaged: 90, qualified: 50 }));
    const all = await chatAnalyzer.run(1);
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) expect(p.proposedValue).toBeNull();
  });

  it("never claims high confidence until the sample is genuinely large", async () => {
    funnel.get.mockResolvedValue(stats({ sessions: 100, engaged: 20, engagedRate: 20 }));
    expect((await chatAnalyzer.run(1))[0].confidence).not.toBe("high");

    funnel.get.mockResolvedValue(stats({ sessions: HIGH_CONFIDENCE_SAMPLE, engaged: 20, engagedRate: 10 }));
    expect((await chatAnalyzer.run(1))[0].confidence).toBe("high");
  });
});
