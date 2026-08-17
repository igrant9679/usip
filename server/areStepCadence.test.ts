/**
 * The default ARE step cadence is one week per step, defined ONCE.
 *
 * Owner directive 2026-08-17. The previous rhythm was set only in the
 * template-generator prompt as a "14-day total window for 7-step" — the
 * model divided that itself and produced 0/3/6/8/10/12/14 — while
 * normalizeSequence's fallback for a step arriving without days was a
 * separate literal 2. Two places, two numbers, neither weekly.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_STEP_GAP_DAYS, defaultDayForStep, normalizeSequence } from "../shared/areSequenceSteps";

describe("one week per step, one definition", () => {
  it("the constant is 7", () => {
    expect(DEFAULT_STEP_GAP_DAYS).toBe(7);
  });

  it("a 7-step sequence spans six weeks", () => {
    expect(Array.from({ length: 7 }, (_, i) => defaultDayForStep(i))).toEqual([0, 7, 14, 21, 28, 35, 42]);
  });

  it("normalizeSequence falls back to the constant, not a literal (executed)", () => {
    // Legacy seed shape with no waitDays on steps 2+ → weekly gaps.
    const out = normalizeSequence([
      { step: 0, channel: "email", subject: "a", body: "" },
      { step: 1, channel: "email", subject: "b", body: "" },
      { step: 2, channel: "email", subject: "c", body: "" },
    ]);
    expect(out.map((s) => s.dayOffset)).toEqual([0, 7, 14]);
  });

  it("an explicit day or waitDays still wins over the default", () => {
    expect(normalizeSequence([{ stepIndex: 0, day: 0 }, { stepIndex: 1, day: 3 }]).map((s) => s.dayOffset)).toEqual([0, 3]);
    expect(normalizeSequence([{ step: 0 }, { step: 1, waitDays: 10 }]).map((s) => s.dayOffset)).toEqual([0, 10]);
  });

  it("the template-generator prompt states the exact days from the same constant", () => {
    const src = readFileSync(join(__dirname, "routers/are/prospects.ts"), "utf8");
    expect(src).toContain("import { DEFAULT_STEP_GAP_DAYS, defaultDayForStep, stepIndexOf }");
    const rules = src.slice(src.indexOf("## Cadence rules"), src.indexOf("Final step is a polite break-up"));
    expect(rules).toContain("Exactly ${DEFAULT_STEP_GAP_DAYS} days between consecutive steps");
    expect(rules).toContain("defaultDayForStep(i)");
    // The old window phrasing must be gone — it is what let the model invent
    // its own spacing.
    expect(rules).not.toMatch(/total window/);
  });

  it("no other literal cadence in the shared normaliser", () => {
    const src = readFileSync(join(__dirname, "../shared/areSequenceSteps.ts"), "utf8");
    const fn = src.slice(src.indexOf("export function normalizeSequence"), src.indexOf("\n}", src.indexOf("export function normalizeSequence")));
    expect(fn).toContain("DEFAULT_STEP_GAP_DAYS");
    expect(fn).not.toMatch(/i === 0 \? 0 : 2\b/);
  });
});
