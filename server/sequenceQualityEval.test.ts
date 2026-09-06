/**
 * The sequence quality flag has to be able to SEE what it scores.
 *
 * 2026-09-04: every sequence on two new campaigns scored 7–8/40 across all
 * four dimensions. The evaluator was handed the raw steps — merge tags and
 * the {{bookingLink}} CTA unresolved — and no prospect facts, so
 * "specificity: verifiable prospect facts referenced" was unanswerable and
 * the booking link read as broken. Uniformly low scores were the rubric's
 * blindness, not the copy's. Pinned: the evaluator receives the dossier the
 * writer had and is told how to read the merge mechanics.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sumQualityBreakdown } from "./routers/are/prospects";

const src = readFileSync(join(__dirname, "routers", "are", "prospects.ts"), "utf8");

describe("the total is arithmetic, not the model's word", () => {
  // 2026-09-06, live: dimensions 7/8/9/7 stored beside a score of 8 — the
  // model's totalScore was an average. Half a campaign read 7–8/40 while the
  // other half read 32+, and it was this, not two kinds of copy.
  it("sums the four dimensions, clamped 0–10 each", () => {
    expect(sumQualityBreakdown({ specificity: 7, clarity: 8, brevity: 9, cta: 7 })).toBe(31);
    expect(sumQualityBreakdown({ specificity: 10, clarity: 10, brevity: 10, cta: 10 })).toBe(40);
    expect(sumQualityBreakdown({ specificity: 12, clarity: -3, brevity: 5, cta: 5 })).toBe(20);
  });
  it("a missing or non-numeric dimension counts zero, never NaN", () => {
    expect(sumQualityBreakdown({ specificity: "7", clarity: null, brevity: undefined, cta: "x" })).toBe(7);
    expect(sumQualityBreakdown(null)).toBe(0);
  });
  it("the evaluator uses it and no longer reads data.totalScore", () => {
    const fn = src.slice(src.indexOf("async function evaluateSequenceQuality"), src.indexOf("export function sumQualityBreakdown"));
    expect(fn).toContain("score: sumQualityBreakdown(breakdown),");
    expect(fn).not.toContain("data.totalScore");
  });
});
const fn = src.slice(src.indexOf("async function evaluateSequenceQuality"), src.indexOf("export interface SequenceAgentResult"));

describe("evaluateSequenceQuality sees its subject", () => {
  it("accepts the prospect + intel the writer had, and lists them for the judge", () => {
    expect(fn).toContain("facts?: { prospect: typeof prospectQueue.$inferSelect; intel: typeof prospectIntelligence.$inferSelect }");
    expect(fn).toContain('## What the writer knew about the prospect');
    for (const s of ["`- Name: ${p.firstName} ${p.lastName}`", "`- Title: ${p.title ?? \"unknown\"}`", "i.companyOneLiner", "primaryHookOf(i)", "painSignals"]) expect(fn).toContain(s);
  });

  it("explains merge tags, the booking link and the fixed sign-off, and forbids credit for invented facts", () => {
    expect(fn).toContain("merge fields filled with the real values at send time");
    expect(fn).toContain("{{bookingLink}} is a working scheduling page; it is a clear, low-friction CTA");
    expect(fn).toContain("fixed sign-off block at the end of a body is appended by the system; do not score it");
    expect(fn).toContain("do penalise invented claims about the prospect");
    // Still strict where it should be.
    expect(fn).toContain("Be strict — generic phrases, lack of personalisation, or weak CTAs should score low.");
  });

  it("runSequenceAgent passes the dossier — not just the steps", () => {
    expect(src).toContain("const quality = await evaluateSequenceQuality(steps, workspaceId, { prospect, intel });");
  });
});
