import { describe, expect, it, vi } from "vitest";

/**
 * USIP critical-flow tests.
 * These exercise pure logic from the server modules without requiring a live DB.
 */

describe("USIP — role hierarchy", () => {
  it("rep cannot access admin-only procedures", async () => {
    const { roleRank } = await import("./_core/workspace");
    expect(roleRank("rep")).toBeLessThan(roleRank("manager"));
    expect(roleRank("manager")).toBeLessThan(roleRank("admin"));
    expect(roleRank("admin")).toBeLessThan(roleRank("super_admin"));
  });
});

describe("USIP — health score computation", () => {
  it("blends product/engagement/support/nps into a 0-100 score", async () => {
    const { computeHealth } = await import("./seed");
    const score = computeHealth({ productUsage: 80, engagement: 70, supportHealth: 90, npsScore: 60 });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThan(60);
  });

  it("auto-flags churn risk when score is low", async () => {
    const { computeHealth, churnRiskFromScore } = await import("./seed");
    const lowScore = computeHealth({ productUsage: 20, engagement: 15, supportHealth: 30, npsScore: -20 });
    expect(churnRiskFromScore(lowScore)).toBe("high");
    const highScore = computeHealth({ productUsage: 90, engagement: 85, supportHealth: 95, npsScore: 60 });
    expect(churnRiskFromScore(highScore)).toBe("low");
  });
});

describe("USIP — quote totals", () => {
  it("computes subtotal, discount, and total correctly", async () => {
    // @shared/quoteTotals — the one quotes.create writes from. This used to
    // import a dead copy from routers/operations.
    const { computeQuoteTotals } = await import("../shared/quoteTotals");
    const totals = computeQuoteTotals([
      { quantity: 2, unitPrice: 1000, discountPct: 10 },
      { quantity: 5, unitPrice: 200, discountPct: 0 },
    ]);
    expect(totals.subtotalCents).toBe(3000_00);
    expect(totals.discountTotalCents).toBe(200_00);
    expect(totals.totalCents).toBe(2800_00);
  });
});

describe("USIP — workflow rule evaluation", () => {
  it("evaluates simple condition expressions against an event payload", async () => {
    const { evalConditions } = await import("./routers/operations");
    const passing = evalConditions(
      { all: [{ field: "amount", op: "gte", value: 50000 }, { field: "stage", op: "eq", value: "qualified" }] },
      { amount: 75000, stage: "qualified" },
    );
    expect(passing).toBe(true);
    const failing = evalConditions(
      { all: [{ field: "amount", op: "gte", value: 50000 }] },
      { amount: 1000 },
    );
    expect(failing).toBe(false);
  });
});

describe("USIP — SCIM bearer auth", () => {
  it("rejects requests without a bearer token", async () => {
    const { verifyScimBearer } = await import("./scimHttp");
    const result = await verifyScimBearer(undefined);
    expect(result.ok).toBe(false);
  });
  it("rejects malformed headers", async () => {
    const { verifyScimBearer } = await import("./scimHttp");
    const result = await verifyScimBearer("garbage");
    expect(result.ok).toBe(false);
  });
});

describe("USIP — campaigns checklist enforcement", () => {
  it("blocks launch when checklist has incomplete items", async () => {
    const { canLaunchCampaign } = await import("./routers/operations");
    expect(canLaunchCampaign([{ id: "1", label: "x", done: false }])).toBe(false);
    expect(canLaunchCampaign([{ id: "1", label: "x", done: true }])).toBe(true);
    expect(canLaunchCampaign([])).toBe(true);
  });
});
