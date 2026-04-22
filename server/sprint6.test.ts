/**
 * Sprint 6 — Opportunity Intelligence vitest specs
 * Pure-logic tests (no DB) covering:
 *   - Win probability clamping
 *   - Stage approval state machine
 *   - Stage history ordering invariants
 *   - Next Best Action priority ordering
 *   - Co-owner list deduplication
 */
import { describe, it, expect } from "vitest";

/* ─── Win probability clamping ───────────────────────────────────────────── */

function clampWinProb(raw: number): number {
  return Math.max(0, Math.min(100, Math.round(raw)));
}

describe("Win probability clamping", () => {
  it("clamps values above 100 to 100", () => {
    expect(clampWinProb(150)).toBe(100);
  });

  it("clamps negative values to 0", () => {
    expect(clampWinProb(-5)).toBe(0);
  });

  it("rounds fractional values", () => {
    expect(clampWinProb(72.6)).toBe(73);
    expect(clampWinProb(72.4)).toBe(72);
  });

  it("passes through valid 0-100 values unchanged", () => {
    expect(clampWinProb(0)).toBe(0);
    expect(clampWinProb(50)).toBe(50);
    expect(clampWinProb(100)).toBe(100);
  });
});

/* ─── Stage approval state machine ──────────────────────────────────────── */

type ApprovalStatus = "pending" | "approved" | "rejected";

function canReview(status: ApprovalStatus): boolean {
  return status === "pending";
}

function nextStatus(approved: boolean): ApprovalStatus {
  return approved ? "approved" : "rejected";
}

describe("Stage approval state machine", () => {
  it("allows reviewing pending approvals", () => {
    expect(canReview("pending")).toBe(true);
  });

  it("does not allow re-reviewing approved approvals", () => {
    expect(canReview("approved")).toBe(false);
  });

  it("does not allow re-reviewing rejected approvals", () => {
    expect(canReview("rejected")).toBe(false);
  });

  it("produces approved status when approved=true", () => {
    expect(nextStatus(true)).toBe("approved");
  });

  it("produces rejected status when approved=false", () => {
    expect(nextStatus(false)).toBe("rejected");
  });
});

/* ─── Stage history ordering ─────────────────────────────────────────────── */

interface StageHistoryEntry {
  fromStage: string | null;
  toStage: string;
  createdAt: Date;
}

function sortStageHistory(entries: StageHistoryEntry[]): StageHistoryEntry[] {
  return [...entries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

describe("Stage history ordering", () => {
  const entries: StageHistoryEntry[] = [
    { fromStage: "qualified", toStage: "proposal", createdAt: new Date("2025-03-10") },
    { fromStage: null, toStage: "discovery", createdAt: new Date("2025-03-01") },
    { fromStage: "proposal", toStage: "negotiation", createdAt: new Date("2025-03-20") },
  ];

  it("sorts entries by createdAt ascending", () => {
    const sorted = sortStageHistory(entries);
    expect(sorted[0]!.toStage).toBe("discovery");
    expect(sorted[1]!.toStage).toBe("proposal");
    expect(sorted[2]!.toStage).toBe("negotiation");
  });

  it("first entry has null fromStage (creation event)", () => {
    const sorted = sortStageHistory(entries);
    expect(sorted[0]!.fromStage).toBeNull();
  });

  it("does not mutate the original array", () => {
    const copy = [...entries];
    sortStageHistory(entries);
    expect(entries).toEqual(copy);
  });
});

/* ─── Next Best Action priority ordering ────────────────────────────────── */

type Priority = "high" | "medium" | "low";

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

function sortNBA(actions: { action: string; priority: Priority }[]) {
  return [...actions].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

describe("Next Best Action priority ordering", () => {
  const actions = [
    { action: "Send follow-up", priority: "low" as Priority },
    { action: "Schedule demo", priority: "high" as Priority },
    { action: "Share case study", priority: "medium" as Priority },
  ];

  it("sorts high before medium before low", () => {
    const sorted = sortNBA(actions);
    expect(sorted[0]!.priority).toBe("high");
    expect(sorted[1]!.priority).toBe("medium");
    expect(sorted[2]!.priority).toBe("low");
  });

  it("does not mutate original array", () => {
    const original = actions.map((a) => ({ ...a }));
    sortNBA(actions);
    expect(actions).toEqual(original);
  });
});

/* ─── Co-owner deduplication ─────────────────────────────────────────────── */

function addCoOwner(coOwners: number[], userId: number): number[] {
  if (coOwners.includes(userId)) return coOwners;
  return [...coOwners, userId];
}

function removeCoOwner(coOwners: number[], userId: number): number[] {
  return coOwners.filter((id) => id !== userId);
}

describe("Co-owner list deduplication", () => {
  it("does not add duplicate user IDs", () => {
    const result = addCoOwner([1, 2], 2);
    expect(result).toEqual([1, 2]);
  });

  it("adds a new user ID", () => {
    const result = addCoOwner([1, 2], 3);
    expect(result).toEqual([1, 2, 3]);
  });

  it("removes an existing user ID", () => {
    const result = removeCoOwner([1, 2, 3], 2);
    expect(result).toEqual([1, 3]);
  });

  it("is a no-op when removing a non-existent user ID", () => {
    const result = removeCoOwner([1, 2], 99);
    expect(result).toEqual([1, 2]);
  });

  it("handles empty list gracefully", () => {
    expect(addCoOwner([], 5)).toEqual([5]);
    expect(removeCoOwner([], 5)).toEqual([]);
  });
});
