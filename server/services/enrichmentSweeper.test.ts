/**
 * The sweeper spends real verification credits in a loop, so the rule that
 * stops the loop is the part that has to be right. Everything else here is the
 * existing finder, already covered where it lives.
 */
import { describe, it, expect } from "vitest";
import { CREDIT_FLOOR, shouldContinue } from "./enrichmentSweeper";

describe("shouldContinue", () => {
  const plenty = { attempted: 0, cap: 50, dailyCreditsLeft: 4000 };

  it("runs while under the cap with credits to spare", () => {
    expect(shouldContinue(plenty)).toBe(true);
  });

  it("stops exactly at the cap, not one past it", () => {
    expect(shouldContinue({ ...plenty, attempted: 49 })).toBe(true);
    expect(shouldContinue({ ...plenty, attempted: 50 })).toBe(false);
    expect(shouldContinue({ ...plenty, attempted: 51 })).toBe(false);
  });

  it("leaves a floor of credits for interactive lookups", () => {
    expect(shouldContinue({ ...plenty, dailyCreditsLeft: CREDIT_FLOOR + 1 })).toBe(true);
    expect(shouldContinue({ ...plenty, dailyCreditsLeft: CREDIT_FLOOR })).toBe(false);
    expect(shouldContinue({ ...plenty, dailyCreditsLeft: 0 })).toBe(false);
  });

  it("never runs on a drained or negative balance", () => {
    expect(shouldContinue({ ...plenty, dailyCreditsLeft: -100 })).toBe(false);
  });

  it("honours the cap even with unlimited credits", () => {
    expect(shouldContinue({ attempted: 200, cap: 200, dailyCreditsLeft: 999999 })).toBe(false);
  });
});
