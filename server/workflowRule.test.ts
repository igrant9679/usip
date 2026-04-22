import { describe, expect, it } from "vitest";
import { evalConditions, canLaunchCampaign, computeQuoteTotals } from "./routers/operations";

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
  it("computes subtotal, discount, and total correctly", () => {
    const t = computeQuoteTotals([
      { quantity: 12, unitPrice: 8500, discountPct: 0 },   // 102000 line, no discount
      { quantity: 1, unitPrice: 14000, discountPct: 5 },   // 14000 - 5% = 13300
    ]);
    expect(t.subtotal).toBeCloseTo(116000, 2);
    expect(t.discount).toBeCloseTo(700, 2);
    expect(t.total).toBeCloseTo(115300, 2);
  });

  it("treats empty input as zero totals", () => {
    const t = computeQuoteTotals([]);
    expect(t.subtotal).toBe(0);
    expect(t.discount).toBe(0);
    expect(t.total).toBe(0);
  });
});
