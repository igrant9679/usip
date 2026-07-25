/**
 * attributeMeetingBookingToAre — the seam that makes an autonomously-booked
 * meeting count toward its ARE campaign's `meetingsBooked` KPI.
 *
 * It runs fire-and-forget from sendMeetingInvite, so its non-negotiable contract
 * is: NEVER throw into the booking flow, and never increment the KPI unless the
 * attendee is genuinely an ARE-sourced prospect. These tests lock that contract
 * without a live DB by mocking getDb.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

describe("attributeMeetingBookingToAre — safety contract", () => {
  it("no-ops without throwing when the DB is unavailable", async () => {
    vi.doMock("./db", () => ({ getDb: vi.fn().mockResolvedValue(null) }));
    const { attributeMeetingBookingToAre } = await import("./routers/are/execution");
    await expect(
      attributeMeetingBookingToAre(1, { id: 5, contactEmail: "a@b.com" }),
    ).resolves.toBeUndefined();
    vi.doUnmock("./db");
  });

  it("never queries when the meeting has no attendee email", async () => {
    const select = vi.fn(() => {
      throw new Error("should not query when there is no email");
    });
    vi.doMock("./db", () => ({ getDb: vi.fn().mockResolvedValue({ select }) }));
    const { attributeMeetingBookingToAre } = await import("./routers/are/execution");
    await expect(
      attributeMeetingBookingToAre(1, { id: 5, contactEmail: "" }),
    ).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    vi.doUnmock("./db");
  });

  it("does not increment the KPI when the attendee is not an ARE prospect", async () => {
    const execute = vi.fn(); // meetingsBooked UPDATE runs via db.execute inside processSignal
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve([]), // no matching prospect_queue row
    };
    const db = { select: () => chain, execute };
    vi.doMock("./db", () => ({ getDb: vi.fn().mockResolvedValue(db) }));
    const { attributeMeetingBookingToAre } = await import("./routers/are/execution");
    await attributeMeetingBookingToAre(1, { id: 5, contactEmail: "nobody@example.com" });
    expect(execute).not.toHaveBeenCalled();
    vi.doUnmock("./db");
  });

  it("does not re-fire when the prospect already has a meeting_booked signal (dedup)", async () => {
    const execute = vi.fn();
    // First query (prospect match) resolves a row; second (prior-signal check)
    // resolves a prior signal → the function must bail before processSignal.
    let call = 0;
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => {
        call += 1;
        return Promise.resolve(call === 1 ? [{ id: 10, campaignId: 3 }] : [{ id: 99 }]);
      },
    };
    const db = { select: () => chain, execute };
    vi.doMock("./db", () => ({ getDb: vi.fn().mockResolvedValue(db) }));
    const { attributeMeetingBookingToAre } = await import("./routers/are/execution");
    await attributeMeetingBookingToAre(1, { id: 5, contactEmail: "known@example.com" });
    expect(execute).not.toHaveBeenCalled(); // deduped — no second increment
    vi.doUnmock("./db");
  });
});
