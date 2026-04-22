import { describe, expect, it } from "vitest";
import {
  composeScore,
  DEFAULT_SCORE_CONFIG,
  pickRoutingMatch,
  type RoutingPayload,
  type RoutingRule,
  scoreAiFit,
  scoreBehavioral,
  scoreFirmographic,
  tierFor,
} from "./leadScoring";
import { evalConditions } from "./routers/operations";

describe("scoreFirmographic", () => {
  it("rewards C-suite + B2B + completeness, capped at 40", () => {
    const out = scoreFirmographic({
      title: "Chief Revenue Officer",
      company: "Acme Corp",
      email: "ceo@acme.com",
      phone: "+1 555 0100",
      source: "webform",
    });
    expect(out.value).toBe(40);
    expect(out.reasons.some((r) => r.includes("C-suite"))).toBe(true);
    expect(out.reasons.some((r) => r.includes("B2B"))).toBe(true);
  });

  it("penalizes free-email domains as half org-type weight", () => {
    const free = scoreFirmographic({ title: "VP Sales", company: "Acme", email: "joe@gmail.com" });
    const biz = scoreFirmographic({ title: "VP Sales", company: "Acme", email: "joe@acme.com" });
    expect(free.value).toBeLessThan(biz.value);
  });

  it("scales by title tier", () => {
    const cxo = scoreFirmographic({ title: "CEO", company: "X", email: "a@x.com" }).value;
    const vp = scoreFirmographic({ title: "VP Marketing", company: "X", email: "a@x.com" }).value;
    const dir = scoreFirmographic({ title: "Director of Ops", company: "X", email: "a@x.com" }).value;
    const mgr = scoreFirmographic({ title: "Marketing Manager", company: "X", email: "a@x.com" }).value;
    expect(cxo).toBeGreaterThan(vp);
    expect(vp).toBeGreaterThan(dir);
    expect(dir).toBeGreaterThan(mgr);
  });

  it("returns zero for completely empty lead", () => {
    expect(scoreFirmographic({}).value).toBe(0);
  });
});

describe("scoreBehavioral", () => {
  it("caps opens and clicks at the configured maximum", () => {
    const out = scoreBehavioral({ opens: 100, clicks: 100, replies: 0, completedSteps: 0, bounces: 0, unsubscribes: 0, daysSinceLastEngagement: 0 });
    expect(out.value).toBeLessThanOrEqual(DEFAULT_SCORE_CONFIG.behavOpenMax + DEFAULT_SCORE_CONFIG.behavClickMax + 5);
  });

  it("adds reply weight strongly", () => {
    const noReply = scoreBehavioral({ opens: 1, clicks: 0, replies: 0, completedSteps: 0, bounces: 0, unsubscribes: 0, daysSinceLastEngagement: 0 });
    const reply = scoreBehavioral({ opens: 1, clicks: 0, replies: 1, completedSteps: 0, bounces: 0, unsubscribes: 0, daysSinceLastEngagement: 0 });
    expect(reply.value - noReply.value).toBeGreaterThanOrEqual(20);
  });

  it("applies penalties for bounces and unsubscribes", () => {
    const out = scoreBehavioral({ opens: 0, clicks: 0, replies: 0, completedSteps: 0, bounces: 1, unsubscribes: 1, daysSinceLastEngagement: 0 });
    expect(out.value).toBeLessThan(0);
    expect(out.reasons.join(" ")).toMatch(/bounce/);
    expect(out.reasons.join(" ")).toMatch(/unsubscribe/);
  });

  it("decays score by 10% per 30 days of inactivity", () => {
    const fresh = scoreBehavioral({ opens: 2, clicks: 2, replies: 1, completedSteps: 1, bounces: 0, unsubscribes: 0, daysSinceLastEngagement: 0 }).value;
    const stale = scoreBehavioral({ opens: 2, clicks: 2, replies: 1, completedSteps: 1, bounces: 0, unsubscribes: 0, daysSinceLastEngagement: 90 }).value;
    expect(stale).toBeLessThan(fresh);
  });
});

describe("scoreAiFit", () => {
  it("scales fit_score (0..1) into points up to aiFitMax", () => {
    expect(scoreAiFit({ fit_score: 1, pain_points: [], recommended_products: [], objection_risks: [] }).value).toBe(30);
    expect(scoreAiFit({ fit_score: 0, pain_points: [], recommended_products: [], objection_risks: [] }).value).toBe(0);
    expect(scoreAiFit({ fit_score: 0.5, pain_points: [], recommended_products: [], objection_risks: [] }).value).toBe(15);
  });
  it("returns zero on null", () => {
    expect(scoreAiFit(null).value).toBe(0);
  });
});

describe("composeScore + tierFor", () => {
  it("classifies tiers around 31/61/81 boundaries", () => {
    expect(tierFor(0)).toBe("cold");
    expect(tierFor(30)).toBe("cold");
    expect(tierFor(31)).toBe("warm");
    expect(tierFor(60)).toBe("warm");
    expect(tierFor(61)).toBe("hot");
    expect(tierFor(80)).toBe("hot");
    expect(tierFor(81)).toBe("sales_ready");
    expect(tierFor(100)).toBe("sales_ready");
  });

  it("clamps composite total to [0,100]", () => {
    const firmo = scoreFirmographic({ title: "CEO", company: "X", email: "a@x.com", phone: "1", source: "y" });
    const behav = scoreBehavioral({ opens: 100, clicks: 100, replies: 5, completedSteps: 50, bounces: 0, unsubscribes: 0, daysSinceLastEngagement: 0 });
    const ai = scoreAiFit({ fit_score: 1, pain_points: [], recommended_products: [], objection_risks: [] });
    const out = composeScore({ firmo, behav, aiFit: ai });
    expect(out.total).toBeLessThanOrEqual(100);
    expect(out.total).toBeGreaterThanOrEqual(0);
  });
});

/* ───────── Routing ───────── */

const baseRule = (over: Partial<RoutingRule>): RoutingRule => ({
  id: 1,
  enabled: true,
  priority: 100,
  conditions: { all: [] },
  strategy: "round_robin",
  targetUserIds: [10, 20, 30],
  rrCursor: 0,
  ...over,
});

describe("pickRoutingMatch", () => {
  const payload: RoutingPayload = { title: "VP Sales", company: "Acme", country: "US", state: "CA", industry: "SaaS", score: 75 };

  it("returns null if nothing matches", () => {
    const r = baseRule({ conditions: { all: [{ field: "country", op: "eq", value: "DE" }] } });
    expect(pickRoutingMatch([r], payload, evalConditions)).toBeNull();
  });

  it("round-robin advances cursor", () => {
    const r = baseRule({ rrCursor: 0 });
    const a = pickRoutingMatch([r], payload, evalConditions)!;
    expect(a.ownerUserId).toBe(10);
    expect(a.newCursor).toBe(1);

    const r2 = { ...r, rrCursor: 1 };
    const b = pickRoutingMatch([r2], payload, evalConditions)!;
    expect(b.ownerUserId).toBe(20);

    const r3 = { ...r, rrCursor: 2 };
    const c = pickRoutingMatch([r3], payload, evalConditions)!;
    expect(c.ownerUserId).toBe(30);

    const r4 = { ...r, rrCursor: 3 };
    const d = pickRoutingMatch([r4], payload, evalConditions)!;
    expect(d.ownerUserId).toBe(10);
  });

  it("priority order: lower priority value wins", () => {
    const high = baseRule({ id: 99, priority: 10, targetUserIds: [99], strategy: "direct" });
    const low = baseRule({ id: 1, priority: 100, targetUserIds: [1], strategy: "direct" });
    const m = pickRoutingMatch([low, high], payload, evalConditions)!;
    expect(m.ownerUserId).toBe(99);
  });

  it("disabled rules are skipped", () => {
    const off = baseRule({ enabled: false, priority: 1, targetUserIds: [99], strategy: "direct" });
    const on = baseRule({ id: 2, priority: 10, targetUserIds: [42], strategy: "direct" });
    const m = pickRoutingMatch([off, on], payload, evalConditions)!;
    expect(m.ownerUserId).toBe(42);
  });

  it("direct strategy returns first target", () => {
    const r = baseRule({ strategy: "direct", targetUserIds: [77, 88] });
    const m = pickRoutingMatch([r], payload, evalConditions)!;
    expect(m.ownerUserId).toBe(77);
    expect(m.newCursor).toBeUndefined();
  });

  it("conditions match against payload fields", () => {
    const r = baseRule({
      strategy: "direct",
      targetUserIds: [55],
      conditions: { all: [{ field: "country", op: "eq", value: "US" }, { field: "score", op: "gte", value: 50 }] },
    });
    const m = pickRoutingMatch([r], payload, evalConditions)!;
    expect(m.ownerUserId).toBe(55);
  });

  it("any-clause OR semantics", () => {
    const r = baseRule({
      strategy: "direct",
      targetUserIds: [11],
      conditions: { any: [{ field: "country", op: "eq", value: "DE" }, { field: "industry", op: "eq", value: "SaaS" }] },
    });
    const m = pickRoutingMatch([r], payload, evalConditions)!;
    expect(m.ownerUserId).toBe(11);
  });

  it("legacy array-form conditions are normalized to all", () => {
    const r = baseRule({
      strategy: "direct",
      targetUserIds: [22],
      conditions: [{ field: "country", op: "eq", value: "US" }] as any,
    });
    const m = pickRoutingMatch([r], payload, evalConditions)!;
    expect(m.ownerUserId).toBe(22);
  });

  it("geography/industry fall back to first target if no lookup provided", () => {
    const r = baseRule({ strategy: "geography", targetUserIds: [33] });
    const m = pickRoutingMatch([r], payload, evalConditions)!;
    expect(m.ownerUserId).toBe(33);
  });

  it("rules with empty target list are skipped", () => {
    const empty = baseRule({ strategy: "direct", targetUserIds: [] });
    const fallback = baseRule({ id: 9, strategy: "direct", priority: 200, targetUserIds: [999] });
    const m = pickRoutingMatch([empty, fallback], payload, evalConditions)!;
    expect(m.ownerUserId).toBe(999);
  });
});
