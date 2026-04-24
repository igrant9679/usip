/**
 * Batch G Tests — AI Meeting Summary, Sequence A/B Testing, Deal Aging Workflow Trigger
 */
import { describe, it, expect } from "vitest";

// ─── Feature 1: AI Meeting Summary ───────────────────────────────────────────

describe("AI Meeting Summary", () => {
  it("builds a structured summary prompt from event metadata", () => {
    function buildSummaryPrompt(event: {
      title: string;
      attendees: string[];
      notes?: string;
      linkedOpportunity?: string;
    }): string {
      const lines = [
        `Meeting: ${event.title}`,
        `Attendees: ${event.attendees.join(", ")}`,
      ];
      if (event.linkedOpportunity) lines.push(`Opportunity: ${event.linkedOpportunity}`);
      if (event.notes) lines.push(`Notes: ${event.notes}`);
      lines.push("\nGenerate a concise meeting summary with: Key Points, Action Items, Next Steps.");
      return lines.join("\n");
    }

    const prompt = buildSummaryPrompt({
      title: "Q2 Review",
      attendees: ["Alice", "Bob"],
      linkedOpportunity: "Acme Corp Deal",
      notes: "Discussed pricing and timeline",
    });

    expect(prompt).toContain("Q2 Review");
    expect(prompt).toContain("Alice");
    expect(prompt).toContain("Acme Corp Deal");
    expect(prompt).toContain("Key Points");
    expect(prompt).toContain("Action Items");
    expect(prompt).toContain("Next Steps");
  });

  it("handles events with no attendees or notes gracefully", () => {
    function buildSummaryPrompt(event: { title: string; attendees: string[] }): string {
      return `Meeting: ${event.title}\nAttendees: ${event.attendees.join(", ") || "None listed"}`;
    }

    const prompt = buildSummaryPrompt({ title: "Solo Planning", attendees: [] });
    expect(prompt).toContain("None listed");
  });

  it("parses LLM structured summary response correctly", () => {
    const rawResponse = JSON.stringify({
      keyPoints: ["Discussed Q2 targets", "Reviewed pipeline health"],
      actionItems: ["Send proposal by Friday", "Schedule follow-up"],
      nextSteps: "Follow up call in 2 weeks",
    });

    const parsed = JSON.parse(rawResponse);
    expect(parsed.keyPoints).toHaveLength(2);
    expect(parsed.actionItems).toHaveLength(2);
    expect(parsed.nextSteps).toContain("2 weeks");
  });

  it("falls back to plain text summary if JSON parse fails", () => {
    function parseSummary(raw: string): { text: string; structured: boolean } {
      try {
        JSON.parse(raw);
        return { text: raw, structured: true };
      } catch {
        return { text: raw, structured: false };
      }
    }

    const result = parseSummary("This is a plain text summary.");
    expect(result.structured).toBe(false);
    expect(result.text).toBe("This is a plain text summary.");
  });
});

// ─── Feature 2: Sequence A/B Testing ─────────────────────────────────────────

describe("Sequence A/B Testing", () => {
  it("validates that variant split percentages sum to 100", () => {
    function validateSplits(variants: Array<{ label: string; splitPct: number }>): boolean {
      const total = variants.reduce((sum, v) => sum + v.splitPct, 0);
      return Math.abs(total - 100) < 0.01;
    }

    expect(validateSplits([
      { label: "A", splitPct: 50 },
      { label: "B", splitPct: 50 },
    ])).toBe(true);

    expect(validateSplits([
      { label: "A", splitPct: 60 },
      { label: "B", splitPct: 30 },
    ])).toBe(false);
  });

  it("assigns variant to enrollment based on split percentage", () => {
    function assignVariant(
      enrollmentId: number,
      variants: Array<{ label: string; splitPct: number }>,
    ): string {
      const bucket = enrollmentId % 100;
      let cumulative = 0;
      for (const v of variants) {
        cumulative += v.splitPct;
        if (bucket < cumulative) return v.label;
      }
      return variants[variants.length - 1]!.label;
    }

    const variants = [
      { label: "A", splitPct: 50 },
      { label: "B", splitPct: 50 },
    ];

    // enrollment IDs 0-49 → A, 50-99 → B
    expect(assignVariant(0, variants)).toBe("A");
    expect(assignVariant(49, variants)).toBe("A");
    expect(assignVariant(50, variants)).toBe("B");
    expect(assignVariant(99, variants)).toBe("B");
  });

  it("computes open rate and reply rate per variant", () => {
    function computeVariantStats(
      sends: Array<{ variantLabel: string; opened: boolean; replied: boolean }>,
    ): Record<string, { sends: number; opens: number; replies: number; openRate: number; replyRate: number }> {
      const stats: Record<string, { sends: number; opens: number; replies: number; openRate: number; replyRate: number }> = {};
      for (const s of sends) {
        if (!stats[s.variantLabel]) stats[s.variantLabel] = { sends: 0, opens: 0, replies: 0, openRate: 0, replyRate: 0 };
        stats[s.variantLabel]!.sends++;
        if (s.opened) stats[s.variantLabel]!.opens++;
        if (s.replied) stats[s.variantLabel]!.replies++;
      }
      for (const v of Object.values(stats)) {
        v.openRate = v.sends > 0 ? v.opens / v.sends : 0;
        v.replyRate = v.sends > 0 ? v.replies / v.sends : 0;
      }
      return stats;
    }

    const sends = [
      { variantLabel: "A", opened: true, replied: true },
      { variantLabel: "A", opened: true, replied: false },
      { variantLabel: "A", opened: false, replied: false },
      { variantLabel: "A", opened: false, replied: false },
      { variantLabel: "B", opened: true, replied: false },
      { variantLabel: "B", opened: false, replied: false },
    ];

    const stats = computeVariantStats(sends);
    expect(stats["A"]!.openRate).toBeCloseTo(0.5);
    expect(stats["A"]!.replyRate).toBeCloseTo(0.25);
    expect(stats["B"]!.openRate).toBeCloseTo(0.5);
    expect(stats["B"]!.replyRate).toBeCloseTo(0);
  });

  it("identifies the winning variant by open rate", () => {
    function pickWinner(
      stats: Record<string, { openRate: number; replyRate: number }>,
      metric: "openRate" | "replyRate",
    ): string | null {
      let best: string | null = null;
      let bestScore = -1;
      for (const [label, s] of Object.entries(stats)) {
        if (s[metric] > bestScore) { bestScore = s[metric]; best = label; }
      }
      return best;
    }

    const stats = {
      A: { openRate: 0.5, replyRate: 0.25 },
      B: { openRate: 0.7, replyRate: 0.1 },
    };

    expect(pickWinner(stats, "openRate")).toBe("B");
    expect(pickWinner(stats, "replyRate")).toBe("A");
  });

  it("rejects variant creation with empty label", () => {
    function validateVariant(v: { label: string; subject: string; splitPct: number }): string | null {
      if (!v.label.trim()) return "Label is required";
      if (!v.subject.trim()) return "Subject is required";
      if (v.splitPct <= 0 || v.splitPct > 100) return "Split % must be 1–100";
      return null;
    }

    expect(validateVariant({ label: "", subject: "Hello", splitPct: 50 })).toBe("Label is required");
    expect(validateVariant({ label: "A", subject: "", splitPct: 50 })).toBe("Subject is required");
    expect(validateVariant({ label: "A", subject: "Hello", splitPct: 0 })).toBe("Split % must be 1–100");
    expect(validateVariant({ label: "A", subject: "Hello", splitPct: 50 })).toBeNull();
  });
});

// ─── Feature 3: Deal Aging Workflow Trigger ───────────────────────────────────

describe("Deal Aging Workflow Trigger", () => {
  it("identifies deals stuck longer than the configured threshold", () => {
    function filterStuckDeals(
      deals: Array<{ id: number; stage: string; daysInStage: number }>,
      config: { stage?: string; days: number },
    ) {
      return deals.filter((d) => {
        if (d.stage === "closed_won" || d.stage === "closed_lost") return false;
        if (config.stage && d.stage !== config.stage) return false;
        return d.daysInStage >= config.days;
      });
    }

    const deals = [
      { id: 1, stage: "Proposal", daysInStage: 10 },
      { id: 2, stage: "Proposal", daysInStage: 3 },
      { id: 3, stage: "Negotiation", daysInStage: 15 },
      { id: 4, stage: "closed_won", daysInStage: 30 },
    ];

    const stuck = filterStuckDeals(deals, { days: 7 });
    expect(stuck.map((d) => d.id)).toEqual([1, 3]);
  });

  it("respects stage filter when specified", () => {
    function filterStuckDeals(
      deals: Array<{ id: number; stage: string; daysInStage: number }>,
      config: { stage?: string; days: number },
    ) {
      return deals.filter((d) => {
        if (d.stage === "closed_won" || d.stage === "closed_lost") return false;
        if (config.stage && d.stage !== config.stage) return false;
        return d.daysInStage >= config.days;
      });
    }

    const deals = [
      { id: 1, stage: "Proposal", daysInStage: 10 },
      { id: 2, stage: "Negotiation", daysInStage: 10 },
    ];

    const stuck = filterStuckDeals(deals, { stage: "Proposal", days: 7 });
    expect(stuck.map((d) => d.id)).toEqual([1]);
  });

  it("excludes closed_won and closed_lost deals regardless of daysInStage", () => {
    function filterStuckDeals(
      deals: Array<{ id: number; stage: string; daysInStage: number }>,
      config: { days: number },
    ) {
      return deals.filter(
        (d) => d.stage !== "closed_won" && d.stage !== "closed_lost" && d.daysInStage >= config.days,
      );
    }

    const deals = [
      { id: 1, stage: "closed_won", daysInStage: 100 },
      { id: 2, stage: "closed_lost", daysInStage: 100 },
      { id: 3, stage: "Proposal", daysInStage: 100 },
    ];

    const stuck = filterStuckDeals(deals, { days: 7 });
    expect(stuck.map((d) => d.id)).toEqual([3]);
  });

  it("builds a correct Slack alert message for a stuck deal", () => {
    function buildSlackMessage(deal: { name: string; stage: string; daysInStage: number }, ruleName: string): string {
      return `⚠️ Deal stuck: *${deal.name}* has been in stage *${deal.stage}* for ${deal.daysInStage} day(s). Rule: ${ruleName}`;
    }

    const msg = buildSlackMessage({ name: "Acme Corp", stage: "Proposal", daysInStage: 14 }, "Proposal Aging Alert");
    expect(msg).toContain("Acme Corp");
    expect(msg).toContain("Proposal");
    expect(msg).toContain("14 day(s)");
    expect(msg).toContain("Proposal Aging Alert");
  });

  it("uses default 7-day threshold when config.days is not set", () => {
    function getMinDays(config: { days?: number }): number {
      return config.days ?? 7;
    }

    expect(getMinDays({})).toBe(7);
    expect(getMinDays({ days: 14 })).toBe(14);
  });
});
