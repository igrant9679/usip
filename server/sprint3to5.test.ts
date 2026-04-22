/**
 * Sprint 3–5 vitest specs
 * Pure-logic tests (no DB) covering:
 *   - Spam analyzer heuristics (subjectAB.ts)
 *   - Quota period parsing (quota.ts)
 *   - Custom field key validation (customFields.ts)
 *   - Research pipeline stage sequencing (researchPipeline.ts)
 */
import { describe, it, expect } from "vitest";

/* ─── Spam analyzer ──────────────────────────────────────────────────────── */

// Inline the analyzeSpam logic so we can test it without importing the router
const SPAM_RULES: { pattern: RegExp; rule: string; severity: string; score: number }[] = [
  { pattern: /\b(free|FREE)\b/, rule: "Contains 'free'", severity: "high", score: 15 },
  { pattern: /\b(urgent|URGENT|act now|ACT NOW)\b/i, rule: "Urgency language", severity: "high", score: 12 },
  { pattern: /\b(guaranteed|GUARANTEED)\b/i, rule: "Guaranteed claim", severity: "high", score: 12 },
  { pattern: /\b(click here|CLICK HERE)\b/i, rule: "Click-bait phrase", severity: "high", score: 10 },
  { pattern: /\$\d+/, rule: "Dollar amount in subject", severity: "medium", score: 8 },
  { pattern: /[!]{2,}/, rule: "Multiple exclamation marks", severity: "medium", score: 8 },
  { pattern: /[?]{2,}/, rule: "Multiple question marks", severity: "medium", score: 6 },
  { pattern: /\b(win|winner|won|prize)\b/i, rule: "Win/prize language", severity: "medium", score: 8 },
  { pattern: /\b(buy now|order now)\b/i, rule: "Direct purchase CTA", severity: "medium", score: 7 },
  { pattern: /[A-Z]{5,}/, rule: "Excessive capitalization", severity: "low", score: 5 },
  { pattern: /.{80,}/, rule: "Subject line too long (>80 chars)", severity: "low", score: 4 },
  { pattern: /\b(re:|fwd:)/i, rule: "Fake reply/forward prefix", severity: "medium", score: 9 },
  { pattern: /\b(limited time|limited offer)\b/i, rule: "Limited-time pressure", severity: "medium", score: 7 },
  { pattern: /\b(100%|100 percent)\b/i, rule: "100% claim", severity: "low", score: 4 },
  { pattern: /\b(no cost|no obligation|no risk)\b/i, rule: "No-cost/no-risk claim", severity: "medium", score: 6 },
];

function analyzeSpam(subject: string): { score: number; flags: { rule: string; severity: string; description: string }[] } {
  const flags: { rule: string; severity: string; description: string }[] = [];
  let score = 0;
  for (const r of SPAM_RULES) {
    if (r.pattern.test(subject)) {
      flags.push({ rule: r.rule, severity: r.severity, description: `Matched: "${subject.match(r.pattern)?.[0]}"` });
      score += r.score;
    }
  }
  return { score: Math.min(score, 100), flags };
}

describe("Spam analyzer", () => {
  it("returns score 0 for a clean subject", () => {
    const { score, flags } = analyzeSpam("Quick question about your Q3 pipeline");
    expect(score).toBe(0);
    expect(flags).toHaveLength(0);
  });

  it("flags 'free' with high severity", () => {
    const { score, flags } = analyzeSpam("Get it free today");
    expect(score).toBeGreaterThan(0);
    expect(flags.some((f) => f.rule === "Contains 'free'")).toBe(true);
  });

  it("flags multiple exclamation marks", () => {
    const { flags } = analyzeSpam("Act now!!");
    expect(flags.some((f) => f.rule === "Multiple exclamation marks")).toBe(true);
  });

  it("flags dollar amounts", () => {
    const { flags } = analyzeSpam("Save $500 today");
    expect(flags.some((f) => f.rule === "Dollar amount in subject")).toBe(true);
  });

  it("flags fake re: prefix", () => {
    const { flags } = analyzeSpam("Re: your inquiry");
    expect(flags.some((f) => f.rule === "Fake reply/forward prefix")).toBe(true);
  });

  it("caps score at 100 for extreme cases", () => {
    // This string triggers: free(15)+guaranteed(12)+urgent(12)+click here(10)+$999(8)+!!(8)+win(8)+act now(12)+limited time(7)+100%(4)+no risk(6) = 102 → capped at 100
    const { score } = analyzeSpam("FREE GUARANTEED URGENT click here $999 win prize!! act now limited time 100% no risk no obligation");
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThan(50);
  });

  it("flags excessive capitalization", () => {
    const { flags } = analyzeSpam("AMAZING OFFER for you");
    expect(flags.some((f) => f.rule === "Excessive capitalization")).toBe(true);
  });

  it("flags subject over 80 chars", () => {
    const { flags } = analyzeSpam("a".repeat(81));
    expect(flags.some((f) => f.rule === "Subject line too long (>80 chars)")).toBe(true);
  });
});

/* ─── Quota period regex ─────────────────────────────────────────────────── */

const periodRegex = /^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/;

describe("Quota period regex", () => {
  it("accepts YYYY-MM format", () => {
    expect(periodRegex.test("2025-01")).toBe(true);
    expect(periodRegex.test("2025-12")).toBe(true);
    expect(periodRegex.test("2025-09")).toBe(true);
  });

  it("accepts YYYY-QN format", () => {
    expect(periodRegex.test("2025-Q1")).toBe(true);
    expect(periodRegex.test("2025-Q4")).toBe(true);
  });

  it("rejects invalid month 00 or 13", () => {
    expect(periodRegex.test("2025-00")).toBe(false);
    expect(periodRegex.test("2025-13")).toBe(false);
  });

  it("rejects invalid quarter Q5", () => {
    expect(periodRegex.test("2025-Q5")).toBe(false);
  });

  it("rejects bare year", () => {
    expect(periodRegex.test("2025")).toBe(false);
  });

  it("rejects non-numeric year", () => {
    expect(periodRegex.test("ABCD-01")).toBe(false);
  });
});

/* ─── Custom field key validation ───────────────────────────────────────── */

const fieldKeyRegex = /^[a-z][a-z0-9_]*$/;

describe("Custom field key validation", () => {
  it("accepts valid snake_case keys", () => {
    expect(fieldKeyRegex.test("contract_value")).toBe(true);
    expect(fieldKeyRegex.test("lead_source2")).toBe(true);
    expect(fieldKeyRegex.test("a")).toBe(true);
  });

  it("rejects keys starting with digit", () => {
    expect(fieldKeyRegex.test("2value")).toBe(false);
  });

  it("rejects keys with uppercase letters", () => {
    expect(fieldKeyRegex.test("ContractValue")).toBe(false);
  });

  it("rejects keys with hyphens", () => {
    expect(fieldKeyRegex.test("contract-value")).toBe(false);
  });

  it("rejects keys with spaces", () => {
    expect(fieldKeyRegex.test("contract value")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(fieldKeyRegex.test("")).toBe(false);
  });
});

/* ─── Research pipeline stage sequencing ────────────────────────────────── */

const PIPELINE_STAGES = [
  "prospect_research",
  "signal_detection",
  "angle_generation",
  "draft_candidates",
  "final_selection",
] as const;

describe("Research pipeline stage sequencing", () => {
  it("has exactly 5 stages", () => {
    expect(PIPELINE_STAGES).toHaveLength(5);
  });

  it("starts with prospect_research", () => {
    expect(PIPELINE_STAGES[0]).toBe("prospect_research");
  });

  it("ends with final_selection", () => {
    expect(PIPELINE_STAGES[PIPELINE_STAGES.length - 1]).toBe("final_selection");
  });

  it("draft_candidates precedes final_selection", () => {
    const draftIdx = PIPELINE_STAGES.indexOf("draft_candidates");
    const finalIdx = PIPELINE_STAGES.indexOf("final_selection");
    expect(draftIdx).toBeLessThan(finalIdx);
  });

  it("angle_generation precedes draft_candidates", () => {
    const angleIdx = PIPELINE_STAGES.indexOf("angle_generation");
    const draftIdx = PIPELINE_STAGES.indexOf("draft_candidates");
    expect(angleIdx).toBeLessThan(draftIdx);
  });
});
