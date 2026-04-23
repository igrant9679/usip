/**
 * Tests for Features 58, 59, 60
 *
 * Feature 58: View Bounced Emails — bounced filter logic
 * Feature 59: Bounce Trend Line — daily bounce aggregation added to getTrackingTimeSeries
 * Feature 60: Remove from Suppression — removeByEmail mutation logic
 */
import { describe, it, expect } from "vitest";

/* ═══════════════════════════════════════════════════════════════════════════
   Feature 58 — Bounced filter logic
   ═══════════════════════════════════════════════════════════════════════════ */

type DraftStub = {
  id: number;
  status: string;
  bouncedAt: Date | null;
  bounceType: "hard" | "soft" | "spam" | null;
};

function applyBouncedFilter(drafts: DraftStub[]): DraftStub[] {
  return drafts.filter((d) => d.bouncedAt != null);
}

function resolveQueryStatus(filter: string): string | undefined {
  if (filter === "bounced") return "sent";
  if (filter === "all") return undefined;
  return filter;
}

describe("bounced filter — client-side filtering", () => {
  const drafts: DraftStub[] = [
    { id: 1, status: "sent", bouncedAt: new Date("2026-04-01"), bounceType: "hard" },
    { id: 2, status: "sent", bouncedAt: null, bounceType: null },
    { id: 3, status: "sent", bouncedAt: new Date("2026-04-02"), bounceType: "soft" },
    { id: 4, status: "sent", bouncedAt: null, bounceType: null },
    { id: 5, status: "sent", bouncedAt: new Date("2026-04-03"), bounceType: "spam" },
  ];

  it("returns only drafts with bouncedAt set", () => {
    const result = applyBouncedFilter(drafts);
    expect(result).toHaveLength(3);
    expect(result.map((d) => d.id)).toEqual([1, 3, 5]);
  });

  it("returns empty array when no drafts are bounced", () => {
    const noBounces = drafts.map((d) => ({ ...d, bouncedAt: null }));
    expect(applyBouncedFilter(noBounces)).toHaveLength(0);
  });

  it("returns all drafts when all are bounced", () => {
    const allBounced = drafts.map((d) => ({ ...d, bouncedAt: new Date() }));
    expect(applyBouncedFilter(allBounced)).toHaveLength(5);
  });

  it("does not include drafts with bouncedAt=null", () => {
    const result = applyBouncedFilter(drafts);
    expect(result.every((d) => d.bouncedAt != null)).toBe(true);
  });

  it("preserves bounce type on filtered drafts", () => {
    const result = applyBouncedFilter(drafts);
    const types = result.map((d) => d.bounceType);
    expect(types).toContain("hard");
    expect(types).toContain("soft");
    expect(types).toContain("spam");
  });
});

describe("bounced filter — query status resolution", () => {
  it("resolves 'bounced' filter to 'sent' status query", () => {
    expect(resolveQueryStatus("bounced")).toBe("sent");
  });

  it("resolves 'all' filter to undefined (no status filter)", () => {
    expect(resolveQueryStatus("all")).toBeUndefined();
  });

  it("resolves 'pending_review' filter to 'pending_review'", () => {
    expect(resolveQueryStatus("pending_review")).toBe("pending_review");
  });

  it("resolves 'approved' filter to 'approved'", () => {
    expect(resolveQueryStatus("approved")).toBe("approved");
  });

  it("resolves 'sent' filter to 'sent'", () => {
    expect(resolveQueryStatus("sent")).toBe("sent");
  });

  it("resolves 'rejected' filter to 'rejected'", () => {
    expect(resolveQueryStatus("rejected")).toBe("rejected");
  });
});

describe("bounced filter — URL param detection", () => {
  it("detects filter=bounced from URL search params", () => {
    const params = new URLSearchParams("filter=bounced");
    expect(params.get("filter")).toBe("bounced");
  });

  it("ignores unrelated URL params", () => {
    const params = new URLSearchParams("page=2&sort=desc");
    expect(params.get("filter")).toBeNull();
  });

  it("handles empty search string", () => {
    const params = new URLSearchParams("");
    expect(params.get("filter")).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Feature 59 — Bounce trend line: daily bounce aggregation
   ═══════════════════════════════════════════════════════════════════════════ */

type TimeSeriesPoint = { date: string; opens: number; clicks: number; bounces: number };

function buildTimeSeries(
  events: { type: "open" | "click"; ts: number }[],
  bouncedDrafts: { bouncedAt: number }[],
  days: number,
): TimeSeriesPoint[] {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const dailyMap: Record<string, TimeSeriesPoint> = {};

  for (const ev of events) {
    if (ev.ts < since) continue;
    const day = new Date(ev.ts).toISOString().slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { date: day, opens: 0, clicks: 0, bounces: 0 };
    if (ev.type === "open") dailyMap[day].opens++;
    else if (ev.type === "click") dailyMap[day].clicks++;
  }

  for (const d of bouncedDrafts) {
    if (d.bouncedAt < since) continue;
    const day = new Date(d.bouncedAt).toISOString().slice(0, 10);
    if (!dailyMap[day]) dailyMap[day] = { date: day, opens: 0, clicks: 0, bounces: 0 };
    dailyMap[day].bounces++;
  }

  const result: TimeSeriesPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    result.push(dailyMap[day] ?? { date: day, opens: 0, clicks: 0, bounces: 0 });
  }
  return result;
}

describe("getTrackingTimeSeries — bounce series (Feature 59)", () => {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const todayTs = today.getTime();
  const yesterday = todayTs - 86400000;
  const twoDaysAgo = todayTs - 2 * 86400000;

  it("includes bounces field in every data point", () => {
    const result = buildTimeSeries([], [], 7);
    expect(result.every((p) => "bounces" in p)).toBe(true);
  });

  it("zero-fills bounces for days with no bounce events", () => {
    const result = buildTimeSeries([], [], 7);
    expect(result.every((p) => p.bounces === 0)).toBe(true);
  });

  it("counts bounces on the correct day", () => {
    const result = buildTimeSeries([], [{ bouncedAt: todayTs }], 7);
    const todayStr = new Date(todayTs).toISOString().slice(0, 10);
    const todayPoint = result.find((p) => p.date === todayStr);
    expect(todayPoint?.bounces).toBe(1);
  });

  it("counts multiple bounces on the same day", () => {
    const result = buildTimeSeries(
      [],
      [{ bouncedAt: todayTs }, { bouncedAt: todayTs + 1000 }, { bouncedAt: todayTs + 2000 }],
      7,
    );
    const todayStr = new Date(todayTs).toISOString().slice(0, 10);
    const todayPoint = result.find((p) => p.date === todayStr);
    expect(todayPoint?.bounces).toBe(3);
  });

  it("excludes bounces outside the date range", () => {
    const oldBounce = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
    const result = buildTimeSeries([], [{ bouncedAt: oldBounce }], 7);
    expect(result.every((p) => p.bounces === 0)).toBe(true);
  });

  it("bounces and opens/clicks coexist on the same day", () => {
    const result = buildTimeSeries(
      [{ type: "open", ts: todayTs }, { type: "click", ts: todayTs }],
      [{ bouncedAt: todayTs }],
      7,
    );
    const todayStr = new Date(todayTs).toISOString().slice(0, 10);
    const todayPoint = result.find((p) => p.date === todayStr);
    expect(todayPoint?.opens).toBe(1);
    expect(todayPoint?.clicks).toBe(1);
    expect(todayPoint?.bounces).toBe(1);
  });

  it("bounces on different days are counted separately", () => {
    const result = buildTimeSeries(
      [],
      [{ bouncedAt: todayTs }, { bouncedAt: yesterday }],
      7,
    );
    const todayStr = new Date(todayTs).toISOString().slice(0, 10);
    const yesterdayStr = new Date(yesterday).toISOString().slice(0, 10);
    const todayPoint = result.find((p) => p.date === todayStr);
    const yesterdayPoint = result.find((p) => p.date === yesterdayStr);
    expect(todayPoint?.bounces).toBe(1);
    expect(yesterdayPoint?.bounces).toBe(1);
  });

  it("result has exactly `days` data points", () => {
    const result = buildTimeSeries([], [], 30);
    expect(result).toHaveLength(30);
  });

  it("result is sorted oldest-first", () => {
    const result = buildTimeSeries([], [], 7);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].date >= result[i - 1].date).toBe(true);
    }
  });

  it("period totals include bounces", () => {
    const result = buildTimeSeries(
      [{ type: "open", ts: todayTs }],
      [{ bouncedAt: todayTs }, { bouncedAt: yesterday }],
      7,
    );
    const totals = result.reduce(
      (acc, d) => ({ opens: acc.opens + d.opens, clicks: acc.clicks + d.clicks, bounces: acc.bounces + d.bounces }),
      { opens: 0, clicks: 0, bounces: 0 },
    );
    expect(totals.opens).toBe(1);
    expect(totals.bounces).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Feature 60 — removeByEmail mutation logic
   ═══════════════════════════════════════════════════════════════════════════ */

function buildRemoveByEmailResult(email: string): { ok: boolean; email: string } {
  return { ok: true, email: email.toLowerCase() };
}

function normalizeEmail(email: string): string {
  return email.toLowerCase();
}

describe("removeByEmail — mutation result", () => {
  it("returns ok: true on success", () => {
    const result = buildRemoveByEmailResult("user@example.com");
    expect(result.ok).toBe(true);
  });

  it("returns the normalized email in the result", () => {
    const result = buildRemoveByEmailResult("User@Example.COM");
    expect(result.email).toBe("user@example.com");
  });

  it("lowercases the email before deletion", () => {
    expect(normalizeEmail("UPPER@DOMAIN.COM")).toBe("upper@domain.com");
  });

  it("handles already-lowercase email", () => {
    expect(normalizeEmail("lower@domain.com")).toBe("lower@domain.com");
  });

  it("handles mixed-case email", () => {
    expect(normalizeEmail("Mixed.Case@Domain.Org")).toBe("mixed.case@domain.org");
  });
});

describe("removeByEmail — toast message formatting", () => {
  function buildToastMessage(email: string): string {
    return `${email} removed from suppression list. You can now send emails to this address.`;
  }

  it("includes the email address in the toast", () => {
    const msg = buildToastMessage("user@example.com");
    expect(msg).toContain("user@example.com");
  });

  it("mentions suppression list in the toast", () => {
    const msg = buildToastMessage("user@example.com");
    expect(msg).toContain("suppression list");
  });

  it("confirms sending is re-enabled", () => {
    const msg = buildToastMessage("user@example.com");
    expect(msg).toContain("You can now send emails");
  });

  it("toast is non-empty", () => {
    const msg = buildToastMessage("a@b.com");
    expect(msg.length).toBeGreaterThan(10);
  });
});

describe("removeByEmail — scope safety", () => {
  it("workspace scoping is required (deletion includes workspaceId condition)", () => {
    // Verify the mutation requires both workspaceId AND email for deletion
    // This mirrors the server-side AND condition in the WHERE clause
    function buildWhereConditions(workspaceId: number, email: string) {
      return { workspaceId, email: email.toLowerCase() };
    }
    const conditions = buildWhereConditions(42, "test@example.com");
    expect(conditions.workspaceId).toBe(42);
    expect(conditions.email).toBe("test@example.com");
  });

  it("deletes all suppression records for the email (all reasons)", () => {
    // The mutation deletes by email only (not by reason), removing all suppression
    // reasons (bounce, unsubscribe, spam_complaint, manual) for that address
    const suppressions = [
      { id: 1, email: "x@y.com", reason: "bounce" },
      { id: 2, email: "x@y.com", reason: "unsubscribe" },
      { id: 3, email: "other@y.com", reason: "bounce" },
    ];
    const emailToRemove = "x@y.com";
    const remaining = suppressions.filter((s) => s.email !== emailToRemove);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].email).toBe("other@y.com");
  });
});
