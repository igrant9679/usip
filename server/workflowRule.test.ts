import { describe, expect, it } from "vitest";
import { evalConditions, canLaunchCampaign } from "./routers/operations";
import { computeQuoteTotals } from "../shared/quoteTotals";

describe("workflow rule conditions (evalConditions)", () => {
  it("returns true when no conditions set", () => {
    expect(evalConditions({}, { stage: "won" })).toBe(true);
  });

  it("evaluates eq under .all", () => {
    expect(evalConditions({ all: [{ field: "stage", op: "eq", value: "won" }] }, { stage: "won" })).toBe(true);
    expect(evalConditions({ all: [{ field: "stage", op: "eq", value: "won" }] }, { stage: "lost" })).toBe(false);
  });

  it("evaluates gt/lt with number coercion", () => {
    expect(evalConditions({ all: [{ field: "value", op: "gt", value: 5000 }] }, { value: 6000 })).toBe(true);
    expect(evalConditions({ all: [{ field: "value", op: "lt", value: 5000 }] }, { value: 6000 })).toBe(false);
  });

  it("evaluates contains case-insensitive", () => {
    expect(evalConditions({ all: [{ field: "industry", op: "contains", value: "health" }] }, { industry: "Healthcare" })).toBe(true);
    expect(evalConditions({ all: [{ field: "industry", op: "contains", value: "tech" }] }, { industry: "Healthcare" })).toBe(false);
  });

  /**
   * The condition editor offered "in list" from the day it was written while
   * this switch had no case for it, so it fell to `default: return false`.
   * Every rule using it evaluated false forever — inside an `all` group that
   * means the rule never fires, with no error anywhere to say so. The tests
   * covered eq/gt/lt/contains, i.e. exactly the operators that worked, which
   * is why the suite stayed green the whole time.
   */
  describe("in (the operator that silently never matched)", () => {
    it("matches a value present in an array", () => {
      const spec = { all: [{ field: "stage", op: "in", value: ["proposal", "negotiation"] }] };
      expect(evalConditions(spec, { stage: "negotiation" })).toBe(true);
      expect(evalConditions(spec, { stage: "discovery" })).toBe(false);
    });

    it("accepts the comma-separated STRING the editor actually saves", () => {
      // Cond.value is typed `string` in Workflows.tsx — a user types this by hand.
      const spec = { all: [{ field: "stage", op: "in", value: "proposal, negotiation" }] };
      expect(evalConditions(spec, { stage: "negotiation" })).toBe(true);
      expect(evalConditions(spec, { stage: "closed" })).toBe(false);
    });

    it("compares numeric payloads against a hand-typed list", () => {
      const spec = { all: [{ field: "leadGrade", op: "in", value: "1,2,3" }] };
      expect(evalConditions(spec, { leadGrade: 2 })).toBe(true);
      expect(evalConditions(spec, { leadGrade: 9 })).toBe(false);
    });

    it("does not match on a missing payload field", () => {
      const spec = { all: [{ field: "stage", op: "in", value: ["proposal"] }] };
      expect(evalConditions(spec, {})).toBe(false);
    });

    it("still rejects a genuinely unknown operator", () => {
      // The default branch must keep failing closed — that behaviour was right,
      // it was the missing `in` case that made it wrong here.
      expect(evalConditions({ all: [{ field: "stage", op: "sounds_like", value: "won" }] }, { stage: "won" })).toBe(false);
    });
  });

  it("AND-combines under .all (all must match)", () => {
    const all = [
      { field: "stage", op: "eq", value: "won" },
      { field: "value", op: "gte", value: 10000 },
    ];
    expect(evalConditions({ all }, { stage: "won", value: 12000 })).toBe(true);
    expect(evalConditions({ all }, { stage: "won", value: 5000 })).toBe(false);
    expect(evalConditions({ all }, { stage: "lost", value: 12000 })).toBe(false);
  });

  it("OR-combines under .any (at least one must match)", () => {
    const any = [
      { field: "stage", op: "eq", value: "won" },
      { field: "stage", op: "eq", value: "negotiation" },
    ];
    expect(evalConditions({ any }, { stage: "won" })).toBe(true);
    expect(evalConditions({ any }, { stage: "negotiation" })).toBe(true);
    expect(evalConditions({ any }, { stage: "discovery" })).toBe(false);
  });
});

describe("canLaunchCampaign", () => {
  it("returns true only when every checklist item is done", () => {
    expect(canLaunchCampaign([{ done: true, label: "a" }, { done: true, label: "b" }])).toBe(true);
    expect(canLaunchCampaign([{ done: true, label: "a" }, { done: false, label: "b" }])).toBe(false);
    expect(canLaunchCampaign([])).toBe(true);
  });
});

describe("computeQuoteTotals", () => {
  // Now imported from @shared/quoteTotals — the function quotes.create and the
  // Quotes dialog actually use. This suite previously asserted against a copy in
  // operations.ts that had zero production callers, so it passed regardless of
  // what the shipped arithmetic did. Exact integer cents, not toBeCloseTo:
  // "close enough" is not a property money maths may have.
  it("computes subtotal, discount, and total correctly", () => {
    const t = computeQuoteTotals([
      { quantity: 12, unitPrice: 8500, discountPct: 0 },   // 102000 line, no discount
      { quantity: 1, unitPrice: 14000, discountPct: 5 },   // 14000 - 5% = 13300
    ]);
    expect(t.subtotalCents).toBe(116000_00);
    expect(t.discountTotalCents).toBe(700_00);
    expect(t.totalCents).toBe(115300_00);
  });

  it("treats empty input as zero totals", () => {
    const t = computeQuoteTotals([]);
    expect(t.subtotalCents).toBe(0);
    expect(t.discountTotalCents).toBe(0);
    expect(t.totalCents).toBe(0);
  });
});
