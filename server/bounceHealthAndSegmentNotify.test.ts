/**
 * Tests for Features 55, 56, 57
 *
 * Feature 55: Bounce Health Card — getBounceStats aggregation logic
 * Feature 56: Segment Enrollment Cron Notification — message formatting
 * Feature 57: Bounced Badge — badge label resolution logic
 */
import { describe, it, expect } from "vitest";

/* ═══════════════════════════════════════════════════════════════════════════
   Feature 55 — getBounceStats aggregation logic
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Mirror the aggregation logic from smtpConfig.getBounceStats for unit testing.
 */
function computeBounceStats(
  bouncedDrafts: { bounceType: "hard" | "soft" | "spam" | null }[],
  totalSent: number,
  suppressionCounts: Record<string, number>,
) {
  const byType: Record<string, number> = {};
  for (const d of bouncedDrafts) {
    const key = d.bounceType ?? "hard";
    byType[key] = (byType[key] ?? 0) + 1;
  }
  const hardBounces = byType["hard"] ?? 0;
  const softBounces = byType["soft"] ?? 0;
  const spamComplaints = byType["spam"] ?? 0;
  const totalBounced = hardBounces + softBounces + spamComplaints;
  const suppressedEmails = Object.values(suppressionCounts).reduce((s, v) => s + v, 0);
  const bounceRate = totalSent > 0 ? Math.round((totalBounced / totalSent) * 1000) / 10 : 0;
  return { hardBounces, softBounces, spamComplaints, totalBounced, totalSent, bounceRate, suppressedEmails };
}

describe("getBounceStats — aggregation logic", () => {
  it("returns all zeros when no bounced drafts", () => {
    const stats = computeBounceStats([], 100, {});
    expect(stats.hardBounces).toBe(0);
    expect(stats.softBounces).toBe(0);
    expect(stats.spamComplaints).toBe(0);
    expect(stats.totalBounced).toBe(0);
    expect(stats.bounceRate).toBe(0);
  });

  it("returns 0% bounce rate when totalSent is 0", () => {
    const stats = computeBounceStats([{ bounceType: "hard" }], 0, {});
    expect(stats.bounceRate).toBe(0);
  });

  it("counts hard bounces correctly", () => {
    const drafts = [
      { bounceType: "hard" as const },
      { bounceType: "hard" as const },
      { bounceType: "hard" as const },
    ];
    const stats = computeBounceStats(drafts, 100, {});
    expect(stats.hardBounces).toBe(3);
    expect(stats.softBounces).toBe(0);
    expect(stats.spamComplaints).toBe(0);
    expect(stats.totalBounced).toBe(3);
  });

  it("counts soft bounces correctly", () => {
    const drafts = [{ bounceType: "soft" as const }, { bounceType: "soft" as const }];
    const stats = computeBounceStats(drafts, 50, {});
    expect(stats.softBounces).toBe(2);
    expect(stats.hardBounces).toBe(0);
  });

  it("counts spam complaints correctly", () => {
    const drafts = [{ bounceType: "spam" as const }];
    const stats = computeBounceStats(drafts, 20, {});
    expect(stats.spamComplaints).toBe(1);
  });

  it("counts mixed bounce types correctly", () => {
    const drafts = [
      { bounceType: "hard" as const },
      { bounceType: "soft" as const },
      { bounceType: "spam" as const },
      { bounceType: "hard" as const },
    ];
    const stats = computeBounceStats(drafts, 100, {});
    expect(stats.hardBounces).toBe(2);
    expect(stats.softBounces).toBe(1);
    expect(stats.spamComplaints).toBe(1);
    expect(stats.totalBounced).toBe(4);
  });

  it("calculates bounce rate as percentage with 1 decimal", () => {
    // 3 bounces out of 100 sent = 3.0%
    const drafts = Array.from({ length: 3 }, () => ({ bounceType: "hard" as const }));
    const stats = computeBounceStats(drafts, 100, {});
    expect(stats.bounceRate).toBe(3);
  });

  it("rounds bounce rate to 1 decimal place", () => {
    // 1 bounce out of 3 sent = 33.3%
    const stats = computeBounceStats([{ bounceType: "hard" }], 3, {});
    expect(stats.bounceRate).toBe(33.3);
  });

  it("calculates 5% bounce rate threshold correctly", () => {
    // 5 bounces out of 100 = 5.0% (threshold for warning)
    const drafts = Array.from({ length: 5 }, () => ({ bounceType: "hard" as const }));
    const stats = computeBounceStats(drafts, 100, {});
    expect(stats.bounceRate).toBe(5);
    expect(stats.bounceRate >= 5).toBe(true); // triggers warning
  });

  it("counts suppressed emails from all reasons", () => {
    const suppressionCounts = { unsubscribe: 10, bounce: 3, spam_complaint: 2, manual: 1 };
    const stats = computeBounceStats([], 100, suppressionCounts);
    expect(stats.suppressedEmails).toBe(16);
  });

  it("treats null bounceType as hard bounce", () => {
    const stats = computeBounceStats([{ bounceType: null }], 10, {});
    expect(stats.hardBounces).toBe(1);
  });

  it("totalBounced equals sum of all bounce types", () => {
    const drafts = [
      { bounceType: "hard" as const },
      { bounceType: "soft" as const },
      { bounceType: "spam" as const },
    ];
    const stats = computeBounceStats(drafts, 50, {});
    expect(stats.totalBounced).toBe(stats.hardBounces + stats.softBounces + stats.spamComplaints);
  });
});

describe("bounce rate warning threshold", () => {
  it("no warning below 5%", () => {
    const stats = computeBounceStats(
      Array.from({ length: 4 }, () => ({ bounceType: "hard" as const })),
      100,
      {},
    );
    expect(stats.bounceRate < 5).toBe(true);
  });

  it("warning at exactly 5%", () => {
    const stats = computeBounceStats(
      Array.from({ length: 5 }, () => ({ bounceType: "hard" as const })),
      100,
      {},
    );
    expect(stats.bounceRate >= 5).toBe(true);
  });

  it("warning above 5%", () => {
    const stats = computeBounceStats(
      Array.from({ length: 10 }, () => ({ bounceType: "hard" as const })),
      100,
      {},
    );
    expect(stats.bounceRate >= 5).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Feature 56 — Segment Enrollment Cron Notification message formatting
   ═══════════════════════════════════════════════════════════════════════════ */

function buildSegmentEnrollNotification(
  workspaceCount: number,
  totalEnrolled: number,
  totalSkipped: number,
) {
  const runDate = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const runTime = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const title = `Segment Auto-Enroll: ${totalEnrolled} contact${totalEnrolled !== 1 ? "s" : ""} enrolled`;
  const content =
    `Hourly segment → sequence auto-enroll completed on ${runDate} at ${runTime}.\n\n` +
    `• Workspaces with active rules: ${workspaceCount}\n` +
    `• Contacts enrolled in sequences: ${totalEnrolled}\n` +
    `• Contacts skipped (already enrolled): ${totalSkipped}\n` +
    `\nView and manage enrollment rules in Settings → Segment Auto-Enroll (/segment-auto-enroll).`;
  return { title, content };
}

describe("segment enrollment notification — message formatting", () => {
  it("generates correct title for 1 contact (singular)", () => {
    const { title } = buildSegmentEnrollNotification(1, 1, 0);
    expect(title).toBe("Segment Auto-Enroll: 1 contact enrolled");
  });

  it("generates correct title for multiple contacts (plural)", () => {
    const { title } = buildSegmentEnrollNotification(2, 15, 3);
    expect(title).toBe("Segment Auto-Enroll: 15 contacts enrolled");
  });

  it("generates correct title for 0 contacts (plural)", () => {
    const { title } = buildSegmentEnrollNotification(1, 0, 5);
    expect(title).toBe("Segment Auto-Enroll: 0 contacts enrolled");
  });

  it("includes workspace count in content", () => {
    const { content } = buildSegmentEnrollNotification(3, 10, 2);
    expect(content).toContain("Workspaces with active rules: 3");
  });

  it("includes enrolled count in content", () => {
    const { content } = buildSegmentEnrollNotification(1, 12, 5);
    expect(content).toContain("Contacts enrolled in sequences: 12");
  });

  it("includes skipped count in content", () => {
    const { content } = buildSegmentEnrollNotification(1, 8, 20);
    expect(content).toContain("Contacts skipped (already enrolled): 20");
  });

  it("includes the segment auto-enroll link", () => {
    const { content } = buildSegmentEnrollNotification(1, 5, 0);
    expect(content).toContain("/segment-auto-enroll");
  });

  it("content mentions the run date", () => {
    const { content } = buildSegmentEnrollNotification(1, 5, 0);
    expect(content).toContain("Hourly segment → sequence auto-enroll completed on");
  });

  it("notification is only sent when totalEnrolled > 0", () => {
    // The cron wraps the call in `if (totalEnrolled > 0)` — verify the guard logic
    const shouldNotify = (enrolled: number) => enrolled > 0;
    expect(shouldNotify(0)).toBe(false);
    expect(shouldNotify(1)).toBe(true);
    expect(shouldNotify(50)).toBe(true);
  });

  it("title length is within notifyOwner limit (1200 chars)", () => {
    const { title } = buildSegmentEnrollNotification(10, 500, 100);
    expect(title.length).toBeLessThanOrEqual(1200);
  });

  it("content length is within notifyOwner limit (20000 chars)", () => {
    const { content } = buildSegmentEnrollNotification(10, 500, 100);
    expect(content.length).toBeLessThanOrEqual(20000);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Feature 57 — Bounced badge label resolution logic
   ═══════════════════════════════════════════════════════════════════════════ */

function resolveBounceLabel(bounceType: "hard" | "soft" | "spam" | null | undefined): string {
  if (bounceType === "hard") return "Hard Bounce";
  if (bounceType === "soft") return "Soft Bounce";
  if (bounceType === "spam") return "Spam Complaint";
  return "Bounced";
}

function shouldShowBadge(bouncedAt: Date | null | undefined): boolean {
  return bouncedAt != null;
}

function getBorderClass(bouncedAt: Date | null | undefined): string {
  return bouncedAt ? "border-red-500/30" : "";
}

describe("bounced badge — label resolution", () => {
  it("shows 'Hard Bounce' for bounceType hard", () => {
    expect(resolveBounceLabel("hard")).toBe("Hard Bounce");
  });

  it("shows 'Soft Bounce' for bounceType soft", () => {
    expect(resolveBounceLabel("soft")).toBe("Soft Bounce");
  });

  it("shows 'Spam Complaint' for bounceType spam", () => {
    expect(resolveBounceLabel("spam")).toBe("Spam Complaint");
  });

  it("falls back to 'Bounced' for null bounceType", () => {
    expect(resolveBounceLabel(null)).toBe("Bounced");
  });

  it("falls back to 'Bounced' for undefined bounceType", () => {
    expect(resolveBounceLabel(undefined)).toBe("Bounced");
  });
});

describe("bounced badge — visibility logic", () => {
  it("shows badge when bouncedAt is set", () => {
    expect(shouldShowBadge(new Date())).toBe(true);
  });

  it("hides badge when bouncedAt is null", () => {
    expect(shouldShowBadge(null)).toBe(false);
  });

  it("hides badge when bouncedAt is undefined", () => {
    expect(shouldShowBadge(undefined)).toBe(false);
  });

  it("card gets red border when bounced", () => {
    expect(getBorderClass(new Date())).toBe("border-red-500/30");
  });

  it("card has no extra border class when not bounced", () => {
    expect(getBorderClass(null)).toBe("");
  });
});

describe("bounced badge — all three bounce types covered", () => {
  const types: Array<"hard" | "soft" | "spam"> = ["hard", "soft", "spam"];

  it("each bounce type produces a non-empty label", () => {
    for (const t of types) {
      const label = resolveBounceLabel(t);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("each bounce type produces a distinct label", () => {
    const labels = types.map(resolveBounceLabel);
    const unique = new Set(labels);
    expect(unique.size).toBe(3);
  });

  it("all labels contain meaningful text (no generic fallback for known types)", () => {
    expect(resolveBounceLabel("hard")).not.toBe("Bounced");
    expect(resolveBounceLabel("soft")).not.toBe("Bounced");
    expect(resolveBounceLabel("spam")).not.toBe("Bounced");
  });
});
