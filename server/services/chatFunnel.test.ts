import { describe, it, expect } from "vitest";
import { chatFunnelStages, rate } from "./performanceMetrics";

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
 * The subset invariant, tested against the REAL implementation.
 *
 * This is the gap that let the bug through: the drop-off picker below is a
 * reproduction, and the stage split used to be one too — so the test asserted
 * the invariant on a copy that happened to hold it while the shipped code did
 * not. Anything claiming a funnel property must import the funnel.
 */
describe("chat funnel stages", () => {
  const row = (o: Partial<Parameters<typeof chatFunnelStages>[0][number]>) => ({
    messageCount: 6, visitorEmail: "a@b.com", qualified: true, meetingId: null, ...o,
  });

  it("keeps every stage a strict subset of the one above", () => {
    const rows = [
      row({}),
      row({ messageCount: 1, visitorEmail: null, qualified: false }),
      row({ qualified: false }),
      row({ visitorEmail: null, qualified: false }),
      row({ meetingId: 7 }),
    ];
    const s = chatFunnelStages(rows);
    expect(s.engaged.length).toBeLessThanOrEqual(rows.length);
    expect(s.withEmail.length).toBeLessThanOrEqual(s.engaged.length);
    expect(s.qualified.length).toBeLessThanOrEqual(s.withEmail.length);
    expect(s.meetings.length).toBeLessThanOrEqual(s.qualified.length);
    for (const r of s.meetings) expect(s.qualified).toContain(r);
    for (const r of s.qualified) expect(s.withEmail).toContain(r);
    for (const r of s.withEmail) expect(s.engaged).toContain(r);
  });

  /**
   * The case that broke it. A visitor who explicitly asks for a meeting books
   * from MEETING_REQUEST_FLOOR (40) even when the qualify threshold is 60, so a
   * booked-but-unqualified session is a designed outcome, not a corruption.
   * Counted outside `qualified` it produced a booking rate above 100%.
   */
  it("counts a booked-but-unqualified session inside qualified, not beside it", () => {
    const s = chatFunnelStages([
      row({ qualified: false, meetingId: 1 }),
      row({ qualified: false, meetingId: 2 }),
      row({ qualified: true }),
    ]);
    expect(s.qualified.length).toBe(3);
    expect(s.meetings.length).toBe(2);
    expect(rate(s.meetings.length, s.qualified.length)).toBeLessThanOrEqual(100);
  });

  /** A booking is proof of every earlier stage, even a one-line conversation. */
  it("carries a booking up the whole chain", () => {
    const s = chatFunnelStages([row({ messageCount: 1, visitorEmail: null, qualified: false, meetingId: 9 })]);
    expect(s.engaged.length).toBe(1);
    expect(s.withEmail.length).toBe(1);
    expect(s.qualified.length).toBe(1);
    expect(s.meetings.length).toBe(1);
  });

  it("counts an unengaged visitor out at the first stage", () => {
    const s = chatFunnelStages([row({ messageCount: 1, visitorEmail: null, qualified: false })]);
    expect(s.engaged).toHaveLength(0);
    expect(s.meetings).toHaveLength(0);
  });

  it("returns empty stages for no rows rather than throwing", () => {
    const s = chatFunnelStages([]);
    expect(s).toEqual({ engaged: [], withEmail: [], qualified: [], meetings: [] });
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
