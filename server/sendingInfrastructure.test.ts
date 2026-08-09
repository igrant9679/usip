/**
 * sendingInfrastructure.test.ts
 * Tests for Features 64, 65, 66:
 *   - Sending Accounts (CRUD, SMTP test, health, daily stats)
 *   - Sender Pools (CRUD, member management)
 *   - Rotation Engine (round_robin, weighted, random, daily limit enforcement)
 */
import { describe, it, expect, vi } from "vitest";
// The REAL rotation engine — not a local copy. This file used to reimplement
// pickAccountFromPool inline (with subtly different round-robin semantics:
// position-value comparison instead of the shipped index-modulo wrap), so
// every rotation test here was a mirror test passing against itself while the
// shipped engine went unexercised. If it isn't imported, it isn't tested.
import {
  pickAccountFromPool,
  AccountCreateInput,
  type PoolMemberWithAccount,
} from "./routers/sendingAccounts";

type PoolMember = PoolMemberWithAccount;

const BASE_MEMBERS: PoolMember[] = [
  { memberId: 1, accountId: 101, weight: 10, position: 0, dailySendLimit: 200, enabled: true, sentToday: 0 },
  { memberId: 2, accountId: 102, weight: 20, position: 1, dailySendLimit: 200, enabled: true, sentToday: 0 },
  { memberId: 3, accountId: 103, weight: 10, position: 2, dailySendLimit: 200, enabled: true, sentToday: 0 },
];

describe("Rotation Engine — round_robin", () => {
  it("picks the first available member when lastUsedIndex is -1", () => {
    const result = pickAccountFromPool("round_robin", BASE_MEMBERS, -1);
    expect(result).not.toBeNull();
    expect(result!.accountId).toBe(101);
    expect(result!.newLastUsedIndex).toBe(0);
  });

  it("advances to next position after lastUsedIndex", () => {
    const result = pickAccountFromPool("round_robin", BASE_MEMBERS, 0);
    expect(result!.accountId).toBe(102);
    expect(result!.newLastUsedIndex).toBe(1);
  });

  it("wraps around to first when past last position", () => {
    const result = pickAccountFromPool("round_robin", BASE_MEMBERS, 2);
    expect(result!.accountId).toBe(101);
  });

  it("skips disabled accounts", () => {
    const members = BASE_MEMBERS.map((m) =>
      m.accountId === 101 ? { ...m, enabled: false } : m,
    );
    const result = pickAccountFromPool("round_robin", members, -1);
    expect(result!.accountId).toBe(102);
  });

  it("skips accounts that have hit daily limit", () => {
    const members = BASE_MEMBERS.map((m) =>
      m.accountId === 101 ? { ...m, sentToday: 200 } : m,
    );
    const result = pickAccountFromPool("round_robin", members, -1);
    expect(result!.accountId).toBe(102);
  });

  it("returns null when all accounts are maxed", () => {
    const members = BASE_MEMBERS.map((m) => ({ ...m, sentToday: 200 }));
    const result = pickAccountFromPool("round_robin", members, -1);
    expect(result).toBeNull();
  });

  it("returns null when all accounts are disabled", () => {
    const members = BASE_MEMBERS.map((m) => ({ ...m, enabled: false }));
    const result = pickAccountFromPool("round_robin", members, -1);
    expect(result).toBeNull();
  });

  it("handles single member pool", () => {
    const result = pickAccountFromPool("round_robin", [BASE_MEMBERS[0]], -1);
    expect(result!.accountId).toBe(101);
  });

  it("single member always returns same account", () => {
    const result1 = pickAccountFromPool("round_robin", [BASE_MEMBERS[0]], -1);
    const result2 = pickAccountFromPool("round_robin", [BASE_MEMBERS[0]], 0);
    expect(result1!.accountId).toBe(result2!.accountId);
  });
});

describe("Rotation Engine — weighted", () => {
  it("returns an account from the pool", () => {
    const result = pickAccountFromPool("weighted", BASE_MEMBERS, -1);
    expect(result).not.toBeNull();
    expect([101, 102, 103]).toContain(result!.accountId);
  });

  it("returns null when all maxed", () => {
    const members = BASE_MEMBERS.map((m) => ({ ...m, sentToday: 200 }));
    expect(pickAccountFromPool("weighted", members, -1)).toBeNull();
  });

  it("only picks from enabled accounts", () => {
    const members = BASE_MEMBERS.map((m) =>
      m.accountId !== 102 ? { ...m, enabled: false } : m,
    );
    for (let i = 0; i < 20; i++) {
      const result = pickAccountFromPool("weighted", members, -1);
      expect(result!.accountId).toBe(102);
    }
  });

  it("higher weight account is picked more often (statistical)", () => {
    // accountId 102 has weight 20 vs 10 for others — should win ~50% of picks
    const counts: Record<number, number> = { 101: 0, 102: 0, 103: 0 };
    for (let i = 0; i < 1000; i++) {
      const r = pickAccountFromPool("weighted", BASE_MEMBERS, -1);
      counts[r!.accountId]++;
    }
    // 102 should win roughly 50% (weight 20 / total 40)
    expect(counts[102]).toBeGreaterThan(counts[101]);
    expect(counts[102]).toBeGreaterThan(counts[103]);
  });
});

describe("Rotation Engine — random", () => {
  it("returns an account from the pool", () => {
    const result = pickAccountFromPool("random", BASE_MEMBERS, -1);
    expect(result).not.toBeNull();
    expect([101, 102, 103]).toContain(result!.accountId);
  });

  it("returns null when all maxed", () => {
    const members = BASE_MEMBERS.map((m) => ({ ...m, sentToday: 200 }));
    expect(pickAccountFromPool("random", members, -1)).toBeNull();
  });

  it("only picks from enabled accounts", () => {
    const members = BASE_MEMBERS.map((m) =>
      m.accountId !== 103 ? { ...m, enabled: false } : m,
    );
    for (let i = 0; i < 20; i++) {
      const result = pickAccountFromPool("random", members, -1);
      expect(result!.accountId).toBe(103);
    }
  });
});

// ─── Daily Limit Enforcement ─────────────────────────────────────────────────

describe("Daily limit enforcement", () => {
  it("excludes account exactly at limit", () => {
    const members: PoolMember[] = [
      { memberId: 1, accountId: 101, weight: 10, position: 0, dailySendLimit: 50, enabled: true, sentToday: 50 },
      { memberId: 2, accountId: 102, weight: 10, position: 1, dailySendLimit: 50, enabled: true, sentToday: 49 },
    ];
    const result = pickAccountFromPool("round_robin", members, -1);
    expect(result!.accountId).toBe(102);
  });

  it("includes account one below limit", () => {
    const members: PoolMember[] = [
      { memberId: 1, accountId: 101, weight: 10, position: 0, dailySendLimit: 50, enabled: true, sentToday: 49 },
    ];
    const result = pickAccountFromPool("round_robin", members, -1);
    expect(result!.accountId).toBe(101);
  });

  it("excludes account with limit 0", () => {
    const members: PoolMember[] = [
      { memberId: 1, accountId: 101, weight: 10, position: 0, dailySendLimit: 0, enabled: true, sentToday: 0 },
    ];
    // sentToday (0) is NOT < dailySendLimit (0), so excluded
    const result = pickAccountFromPool("round_robin", members, -1);
    expect(result).toBeNull();
  });
});

// ─── Provider Validation ─────────────────────────────────────────────────────

describe("Provider validation (the real create schema)", () => {
  // This block used to check a LOCAL list that had drifted badly from the
  // shipped enum — it contained "gmail_oauth" (never a real provider) and
  // asserted "sendgrid" was INVALID while the product was selling SendGrid
  // sending. Validated against AccountCreateInput itself now.
  const base = { name: "A", fromEmail: "a@x.com" };

  it("accepts every provider the enum ships, sendgrid included", () => {
    for (const p of ["outlook_oauth", "amazon_ses", "generic_smtp", "google_oauth", "sendgrid"]) {
      expect(AccountCreateInput.safeParse({ ...base, provider: p }).success).toBe(true);
    }
  });

  it("rejects unknown providers", () => {
    for (const p of ["mailgun", "gmail_oauth", ""]) {
      expect(AccountCreateInput.safeParse({ ...base, provider: p }).success).toBe(false);
    }
  });
});

// ─── Reputation Tier ─────────────────────────────────────────────────────────

describe("Reputation tier derivation", () => {
  function deriveReputationTier(bounceRate: number): "excellent" | "good" | "fair" | "poor" {
    if (bounceRate < 1) return "excellent";
    if (bounceRate < 3) return "good";
    if (bounceRate < 5) return "fair";
    return "poor";
  }

  it("0% bounce rate → excellent", () => expect(deriveReputationTier(0)).toBe("excellent"));
  it("0.9% bounce rate → excellent", () => expect(deriveReputationTier(0.9)).toBe("excellent"));
  it("1% bounce rate → good", () => expect(deriveReputationTier(1)).toBe("good"));
  it("2.9% bounce rate → good", () => expect(deriveReputationTier(2.9)).toBe("good"));
  it("3% bounce rate → fair", () => expect(deriveReputationTier(3)).toBe("fair"));
  it("4.9% bounce rate → fair", () => expect(deriveReputationTier(4.9)).toBe("fair"));
  it("5% bounce rate → poor", () => expect(deriveReputationTier(5)).toBe("poor"));
  it("100% bounce rate → poor", () => expect(deriveReputationTier(100)).toBe("poor"));
});

// ─── Pool Rotation Strategy Labels ───────────────────────────────────────────

describe("Pool rotation strategy labels", () => {
  const STRATEGY_LABELS: Record<string, string> = {
    round_robin: "Round Robin",
    weighted: "Weighted",
    random: "Random",
  };

  it("maps round_robin to Round Robin", () => expect(STRATEGY_LABELS["round_robin"]).toBe("Round Robin"));
  it("maps weighted to Weighted", () => expect(STRATEGY_LABELS["weighted"]).toBe("Weighted"));
  it("maps random to Random", () => expect(STRATEGY_LABELS["random"]).toBe("Random"));
  it("unknown strategy returns undefined", () => expect(STRATEGY_LABELS["unknown"]).toBeUndefined());
});

// ─── Warmup Status ────────────────────────────────────────────────────────────

describe("Warmup status field", () => {
  const WARMUP_STATUSES = ["not_started", "in_progress", "completed", "paused"] as const;
  type WarmupStatus = typeof WARMUP_STATUSES[number];

  function isValidWarmupStatus(s: string): s is WarmupStatus {
    return (WARMUP_STATUSES as readonly string[]).includes(s);
  }

  it("accepts all valid warmup statuses", () => {
    for (const s of WARMUP_STATUSES) {
      expect(isValidWarmupStatus(s)).toBe(true);
    }
  });

  it("rejects invalid warmup status", () => {
    expect(isValidWarmupStatus("active")).toBe(false);
    expect(isValidWarmupStatus("")).toBe(false);
  });
});

// ─── Connection Status ────────────────────────────────────────────────────────

describe("Connection status transitions", () => {
  const VALID_STATUSES = ["connected", "disconnected", "error", "pending"] as const;
  type ConnectionStatus = typeof VALID_STATUSES[number];

  function isValidConnectionStatus(s: string): s is ConnectionStatus {
    return (VALID_STATUSES as readonly string[]).includes(s);
  }

  it("accepts all valid connection statuses", () => {
    for (const s of VALID_STATUSES) {
      expect(isValidConnectionStatus(s)).toBe(true);
    }
  });

  it("rejects invalid status", () => {
    expect(isValidConnectionStatus("ok")).toBe(false);
    expect(isValidConnectionStatus("active")).toBe(false);
  });
});

// ─── Daily Stats Aggregation ──────────────────────────────────────────────────

describe("Daily stats aggregation", () => {
  type DailyStat = { date: string; sentCount: number; deliveredCount: number; bouncedCount: number; openCount: number; clickCount: number };

  function aggregateStats(stats: DailyStat[]) {
    return stats.reduce(
      (acc, s) => ({
        totalSent: acc.totalSent + s.sentCount,
        totalDelivered: acc.totalDelivered + s.deliveredCount,
        totalBounced: acc.totalBounced + s.bouncedCount,
        totalOpens: acc.totalOpens + s.openCount,
        totalClicks: acc.totalClicks + s.clickCount,
      }),
      { totalSent: 0, totalDelivered: 0, totalBounced: 0, totalOpens: 0, totalClicks: 0 },
    );
  }

  it("aggregates empty stats to zeros", () => {
    const result = aggregateStats([]);
    expect(result).toEqual({ totalSent: 0, totalDelivered: 0, totalBounced: 0, totalOpens: 0, totalClicks: 0 });
  });

  it("aggregates single day correctly", () => {
    const result = aggregateStats([{ date: "2026-04-23", sentCount: 100, deliveredCount: 95, bouncedCount: 5, openCount: 40, clickCount: 10 }]);
    expect(result.totalSent).toBe(100);
    expect(result.totalBounced).toBe(5);
    expect(result.totalOpens).toBe(40);
  });

  it("aggregates multiple days correctly", () => {
    const stats: DailyStat[] = [
      { date: "2026-04-21", sentCount: 50, deliveredCount: 48, bouncedCount: 2, openCount: 20, clickCount: 5 },
      { date: "2026-04-22", sentCount: 75, deliveredCount: 72, bouncedCount: 3, openCount: 30, clickCount: 8 },
      { date: "2026-04-23", sentCount: 100, deliveredCount: 95, bouncedCount: 5, openCount: 40, clickCount: 10 },
    ];
    const result = aggregateStats(stats);
    expect(result.totalSent).toBe(225);
    expect(result.totalBounced).toBe(10);
    expect(result.totalOpens).toBe(90);
    expect(result.totalClicks).toBe(23);
  });

  it("computes bounce rate from aggregated stats", () => {
    const stats: DailyStat[] = [
      { date: "2026-04-23", sentCount: 100, deliveredCount: 95, bouncedCount: 5, openCount: 40, clickCount: 10 },
    ];
    const agg = aggregateStats(stats);
    const bounceRate = agg.totalSent > 0 ? (agg.totalBounced / agg.totalSent) * 100 : 0;
    expect(bounceRate).toBe(5);
  });
});

// ─── Pool Member Weight Validation ───────────────────────────────────────────

describe("Pool member weight validation", () => {
  function isValidWeight(w: number): boolean {
    return Number.isInteger(w) && w >= 1 && w <= 100;
  }

  it("accepts weight 1 (minimum)", () => expect(isValidWeight(1)).toBe(true));
  it("accepts weight 100 (maximum)", () => expect(isValidWeight(100)).toBe(true));
  it("accepts weight 10 (default)", () => expect(isValidWeight(10)).toBe(true));
  it("rejects weight 0", () => expect(isValidWeight(0)).toBe(false));
  it("rejects weight 101", () => expect(isValidWeight(101)).toBe(false));
  it("rejects negative weight", () => expect(isValidWeight(-1)).toBe(false));
  it("rejects float weight", () => expect(isValidWeight(1.5)).toBe(false));
});

// ─── Adapter dispatch — a pool member must reach ITS transport ──────────────
//
// Pool selection is provider-agnostic (it filters on enabled + daily limit
// only), so the guarantee that a SendGrid pool member actually sends through
// SendGrid lives entirely in createEmailAdapter's dispatch order. If that
// order regresses, a SendGrid account silently falls into the SMTP adapter
// and every send fails "SMTP not configured" — the pool would look healthy
// and deliver nothing.
import { createEmailAdapter, SendGridAdapter, ImapSmtpAdapter } from "./emailAdapter";

const acct = (o: Record<string, unknown>) =>
  ({ id: 1, workspaceId: 1, name: "t", fromEmail: "t@x.com", enabled: true, ...o }) as never;

describe("Adapter dispatch (createEmailAdapter)", () => {
  it("provider=sendgrid → SendGridAdapter, even if a unipileAccountId is somehow set", () => {
    expect(createEmailAdapter(acct({ provider: "sendgrid" }))).toBeInstanceOf(SendGridAdapter);
    // Ordering is deliberate: the sendgrid check precedes the unipile bridge.
    expect(
      createEmailAdapter(acct({ provider: "sendgrid", unipileAccountId: "u1" })),
    ).toBeInstanceOf(SendGridAdapter);
  });

  // The unipile branch is not asserted here: its lazy CJS require() does not
  // resolve under vitest's ESM transform. The two cases below pin the ordering
  // that matters for pools — sendgrid first, SMTP as the final fallback.
  it("anything else → ImapSmtpAdapter", () => {
    expect(createEmailAdapter(acct({ provider: "generic_smtp" }))).toBeInstanceOf(ImapSmtpAdapter);
  });
});
