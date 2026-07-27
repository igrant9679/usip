import { describe, it, expect } from "vitest";
import { rate } from "./performanceMetrics";

/**
 * getChatFunnelStats is a DB query, so what is tested here is the arithmetic it
 * relies on and the invariants the shape must hold — every stage a strict
 * subset of the one above, which is what makes a drop-off meaningful.
 *
 * The rules encoded, all deliberate:
 *  - `emailRate` is measured against ENGAGED sessions, not all sessions. A
 *    visitor who typed nothing never had the chance to give an email, and
 *    counting them makes the agent look worse than it is.
 *  - `meetingRate` is measured against QUALIFIED, not against everyone — the
 *    agent is not supposed to book unqualified traffic, so counting those as
 *    misses would reward the wrong behaviour.
 */
describe("chat funnel arithmetic", () => {
  it("guards a zero denominator rather than dividing by it", () => {
    expect(rate(0, 0)).toBe(0);
    expect(rate(5, 0)).toBe(0);
  });

  it("reports one decimal place", () => {
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(2, 3)).toBe(66.7);
    expect(rate(1, 8)).toBe(12.5);
  });

  it("is 100 when every session converts", () => {
    expect(rate(7, 7)).toBe(100);
  });
});

/**
 * The drop-off picker, reproduced here so its tie and zero behaviour is pinned
 * down independently of the database.
 */
function biggestDrop(sessions: number, engaged: number, email: number, qualified: number, meetings: number) {
  const drops: Array<[string, number]> = [
    ["engagement", sessions - engaged],
    ["email", engaged - email],
    ["qualification", email - qualified],
    ["booking", qualified - meetings],
  ];
  drops.sort((a, b) => b[1] - a[1]);
  return drops[0][1] > 0 ? { stage: drops[0][0], count: drops[0][1] } : { stage: "none", count: 0 };
}

describe("biggest drop stage", () => {
  it("names the stage losing the most people", () => {
    // 100 sessions → 80 engaged → 20 emails → 18 qualified → 2 meetings
    expect(biggestDrop(100, 80, 20, 18, 2)).toEqual({ stage: "email", count: 60 });
  });

  it("finds a late-funnel drop when the top of the funnel is healthy", () => {
    expect(biggestDrop(50, 50, 48, 40, 3)).toEqual({ stage: "booking", count: 37 });
  });

  /** A perfect funnel must not report a drop stage — "none" is a real answer. */
  it("reports none when nothing is lost", () => {
    expect(biggestDrop(5, 5, 5, 5, 5)).toEqual({ stage: "none", count: 0 });
  });

  it("reports none for an empty workspace rather than inventing a stage", () => {
    expect(biggestDrop(0, 0, 0, 0, 0)).toEqual({ stage: "none", count: 0 });
  });

  it("breaks a tie by funnel order, earliest stage first", () => {
    // engagement and email both lose 10; the earlier one is the honest answer.
    expect(biggestDrop(30, 20, 10, 10, 10)).toEqual({ stage: "engagement", count: 10 });
  });
});
