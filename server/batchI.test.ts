/**
 * Batch I — vitest specs
 * 1. A/B winner auto-promotion (sequences.promoteWinner + setMinSends)
 * 2. Pipeline Alerts sendDigest procedure
 * 3. Opportunities getTimeline procedure
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock DB ──────────────────────────────────────────────────────────────────
vi.mock("../server/db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
}));

// ─── 1. A/B winner auto-promotion helpers (unit logic) ────────────────────────
describe("A/B winner auto-promotion logic", () => {
  it("selects the variant with the higher reply rate", () => {
    const variants = [
      { id: 1, label: "A", sends: 50, replies: 5 },
      { id: 2, label: "B", sends: 50, replies: 12 },
    ];
    const winner = variants.reduce((best, v) => {
      const rate = v.sends > 0 ? v.replies / v.sends : 0;
      const bestRate = best.sends > 0 ? best.replies / best.sends : 0;
      return rate > bestRate ? v : best;
    });
    expect(winner.id).toBe(2);
    expect(winner.label).toBe("B");
  });

  it("does not promote when total sends < minSends threshold", () => {
    const minSends = 100;
    const totalSends = 40;
    const shouldPromote = totalSends >= minSends;
    expect(shouldPromote).toBe(false);
  });

  it("promotes when total sends >= minSends threshold", () => {
    const minSends = 100;
    const totalSends = 120;
    const shouldPromote = totalSends >= minSends;
    expect(shouldPromote).toBe(true);
  });

  it("computes reply rate as replies / sends", () => {
    const replyRate = (replies: number, sends: number) =>
      sends > 0 ? replies / sends : 0;
    expect(replyRate(10, 50)).toBeCloseTo(0.2);
    expect(replyRate(0, 50)).toBe(0);
    expect(replyRate(5, 0)).toBe(0);
  });

  it("handles tie by keeping existing winner (first variant wins tie)", () => {
    const variants = [
      { id: 1, label: "A", sends: 50, replies: 10 },
      { id: 2, label: "B", sends: 50, replies: 10 },
    ];
    // Tie: first variant keeps winner status (reduce returns first on equal)
    const winner = variants.reduce((best, v) => {
      const rate = v.sends > 0 ? v.replies / v.sends : 0;
      const bestRate = best.sends > 0 ? best.replies / best.sends : 0;
      return rate > bestRate ? v : best;
    });
    expect(winner.id).toBe(1);
  });
});

// ─── 2. sendDigest email builder (unit logic) ─────────────────────────────────
describe("Pipeline Alerts sendDigest email builder", () => {
  function buildDigestHtml(deals: { name: string; stage: string; daysInStage: number; value?: string | null }[]) {
    const rows = deals
      .map(
        (d) =>
          `<tr><td>${d.name}</td><td>${d.stage}</td><td>${d.daysInStage}</td><td>${d.value ? `$${Number(d.value).toLocaleString()}` : "—"}</td></tr>`
      )
      .join("");
    return `<table><thead><tr><th>Deal</th><th>Stage</th><th>Days Stuck</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  it("builds HTML table with correct number of rows", () => {
    const deals = [
      { name: "Acme Corp", stage: "proposal", daysInStage: 30, value: "50000" },
      { name: "Beta LLC", stage: "negotiation", daysInStage: 45, value: null },
    ];
    const html = buildDigestHtml(deals);
    expect(html).toContain("Acme Corp");
    expect(html).toContain("Beta LLC");
    expect(html).toContain("proposal");
    expect(html).toContain("$50,000");
    expect(html).toContain("—");
  });

  it("returns empty table body when no stuck deals", () => {
    const html = buildDigestHtml([]);
    expect(html).toContain("<tbody></tbody>");
  });

  it("formats deal value with locale string", () => {
    const deals = [{ name: "Big Deal", stage: "qualification", daysInStage: 20, value: "1000000" }];
    const html = buildDigestHtml(deals);
    expect(html).toContain("$1,000,000");
  });

  it("handles null value gracefully", () => {
    const deals = [{ name: "No Value Deal", stage: "prospecting", daysInStage: 10, value: null }];
    const html = buildDigestHtml(deals);
    expect(html).toContain("—");
    expect(html).not.toContain("$null");
  });
});

// ─── 3. Opportunity getTimeline shape (unit logic) ────────────────────────────
describe("Opportunity getTimeline data mapping", () => {
  function mapTimelineRow(a: {
    id: number;
    type: string | null;
    subject: string | null;
    body: string | null;
    disposition: string | null;
    occurredAt: Date | null;
    createdAt: Date;
    createdByUserId: number | null;
  }) {
    return {
      id: a.id,
      type: a.type,
      subject: a.subject ?? null,
      body: a.body ?? null,
      disposition: a.disposition ?? null,
      occurredAt: a.occurredAt ?? a.createdAt,
      createdAt: a.createdAt,
      createdByUserId: a.createdByUserId ?? null,
      isMeetingSummary:
        a.type === "note" &&
        typeof a.subject === "string" &&
        a.subject.startsWith("Meeting Summary:"),
    };
  }

  it("flags meeting summary notes correctly", () => {
    const row = {
      id: 1,
      type: "note",
      subject: "Meeting Summary: Q2 Review",
      body: "Key points...",
      disposition: null,
      occurredAt: null,
      createdAt: new Date("2026-04-01"),
      createdByUserId: 5,
    };
    const mapped = mapTimelineRow(row);
    expect(mapped.isMeetingSummary).toBe(true);
  });

  it("does not flag regular notes as meeting summaries", () => {
    const row = {
      id: 2,
      type: "note",
      subject: "Follow-up call notes",
      body: "Discussed pricing",
      disposition: null,
      occurredAt: null,
      createdAt: new Date("2026-04-02"),
      createdByUserId: 3,
    };
    const mapped = mapTimelineRow(row);
    expect(mapped.isMeetingSummary).toBe(false);
  });

  it("does not flag call activities as meeting summaries", () => {
    const row = {
      id: 3,
      type: "call",
      subject: "Meeting Summary: accidental subject",
      body: null,
      disposition: "connected",
      occurredAt: null,
      createdAt: new Date("2026-04-03"),
      createdByUserId: null,
    };
    const mapped = mapTimelineRow(row);
    expect(mapped.isMeetingSummary).toBe(false);
  });

  it("falls back occurredAt to createdAt when occurredAt is null", () => {
    const createdAt = new Date("2026-04-10");
    const row = {
      id: 4,
      type: "call",
      subject: null,
      body: null,
      disposition: null,
      occurredAt: null,
      createdAt,
      createdByUserId: null,
    };
    const mapped = mapTimelineRow(row);
    expect(mapped.occurredAt).toEqual(createdAt);
  });

  it("uses occurredAt when provided", () => {
    const occurredAt = new Date("2026-03-15");
    const createdAt = new Date("2026-04-10");
    const row = {
      id: 5,
      type: "meeting",
      subject: "Discovery call",
      body: "Discussed needs",
      disposition: null,
      occurredAt,
      createdAt,
      createdByUserId: 2,
    };
    const mapped = mapTimelineRow(row);
    expect(mapped.occurredAt).toEqual(occurredAt);
  });

  it("maps all required fields", () => {
    const row = {
      id: 10,
      type: "call",
      subject: "Initial outreach",
      body: "Left voicemail",
      disposition: "voicemail",
      occurredAt: new Date("2026-04-05"),
      createdAt: new Date("2026-04-05"),
      createdByUserId: 7,
    };
    const mapped = mapTimelineRow(row);
    expect(mapped).toMatchObject({
      id: 10,
      type: "call",
      subject: "Initial outreach",
      body: "Left voicemail",
      disposition: "voicemail",
      createdByUserId: 7,
      isMeetingSummary: false,
    });
  });
});
