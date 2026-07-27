import { describe, it, expect } from "vitest";
import {
  followUpEligibility,
  selectForFollowUp,
  MAX_AGE_DAYS,
  MIN_MESSAGES,
  type FollowUpCandidate,
} from "./chatFollowUp";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const minsAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60_000);

const s = (o: Partial<FollowUpCandidate> = {}): FollowUpCandidate => ({
  id: 1,
  visitorEmail: "dana@northwind.org",
  meetingId: null,
  status: "qualified",
  followUpAt: null,
  updatedAt: minsAgo(90),
  messageCount: 6,
  ...o,
});

describe("followUpEligibility", () => {
  it("accepts an abandoned conversation that gave us an email", () => {
    expect(followUpEligibility(s(), NOW, 45)).toBe("eligible");
  });

  it("never emails someone we cannot email", () => {
    expect(followUpEligibility(s({ visitorEmail: null }), NOW, 45)).toBe("no_email");
  });

  it("never chases someone who already booked", () => {
    expect(followUpEligibility(s({ meetingId: 12 }), NOW, 45)).toBe("already_booked");
    expect(followUpEligibility(s({ status: "booked" }), NOW, 45)).toBe("already_booked");
  });

  // followUpAt is the idempotency marker — this is what stops a double-send.
  it("never follows up twice", () => {
    expect(followUpEligibility(s({ followUpAt: minsAgo(5) }), NOW, 45)).toBe("already_followed_up");
  });

  it("waits out the silence window before calling it abandoned", () => {
    expect(followUpEligibility(s({ updatedAt: minsAgo(10) }), NOW, 45)).toBe("too_recent");
    expect(followUpEligibility(s({ updatedAt: minsAgo(44) }), NOW, 45)).toBe("too_recent");
    expect(followUpEligibility(s({ updatedAt: minsAgo(46) }), NOW, 45)).toBe("eligible");
  });

  /**
   * The guard that makes enabling the switch safe: turning follow-up on must
   * not email everyone who ever chatted.
   */
  it("refuses conversations older than the backlog window", () => {
    expect(followUpEligibility(s({ updatedAt: daysAgo(MAX_AGE_DAYS + 1) }), NOW, 45)).toBe("too_old");
    expect(followUpEligibility(s({ updatedAt: daysAgo(MAX_AGE_DAYS - 1) }), NOW, 45)).toBe("eligible");
  });

  it("ignores a one-line drive-by", () => {
    expect(followUpEligibility(s({ messageCount: MIN_MESSAGES - 1 }), NOW, 45)).toBe("too_short");
  });

  it("accepts a string timestamp as the driver may return one", () => {
    expect(followUpEligibility(s({ updatedAt: minsAgo(90).toISOString() }), NOW, 45)).toBe("eligible");
  });
});

describe("selectForFollowUp", () => {
  it("reports WHY each session was skipped, not just how many", () => {
    const r = selectForFollowUp([
      s({ id: 1 }),
      s({ id: 2, visitorEmail: null }),
      s({ id: 3, meetingId: 5 }),
      s({ id: 4, updatedAt: minsAgo(5) }),
      s({ id: 5, messageCount: 1 }),
    ], NOW, 45);
    expect(r.due.map((d) => d.id)).toEqual([1]);
    expect(r.skipped.no_email).toBe(1);
    expect(r.skipped.already_booked).toBe(1);
    expect(r.skipped.too_recent).toBe(1);
    expect(r.skipped.too_short).toBe(1);
  });

  it("hands back stale rows to be retired, so they stop being re-examined forever", () => {
    const r = selectForFollowUp([s({ id: 7, updatedAt: daysAgo(30) })], NOW, 45);
    expect(r.due).toEqual([]);
    expect(r.expired.map((e) => e.id)).toEqual([7]);
    expect(r.skipped.too_old).toBe(1);
  });

  it("caps a run so a backlog drains steadily rather than all at once", () => {
    const many = Array.from({ length: 50 }, (_, i) => s({ id: i + 1 }));
    expect(selectForFollowUp(many, NOW, 45, 5).due).toHaveLength(5);
  });

  it("is empty-safe", () => {
    const r = selectForFollowUp([], NOW, 45);
    expect(r.due).toEqual([]);
    expect(r.expired).toEqual([]);
  });
});
