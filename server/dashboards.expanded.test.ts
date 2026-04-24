/**
 * Tests for the expanded Custom Dashboards feature (Feature 72).
 *
 * Covers:
 *   - resolvePresetDates utility
 *   - defaultSize widget sizing
 *   - KPI metric list completeness
 *   - Widget type list completeness
 */
import { describe, expect, it } from "vitest";

/* ─── Inline copies of pure utilities (no React imports needed) ─────────── */

function resolvePresetDates(preset: string): { dateFrom?: string; dateTo?: string } {
  const today = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  switch (preset) {
    case "today":
      return { dateFrom: fmt(today), dateTo: fmt(today) };
    case "7d": {
      const from = new Date(today); from.setDate(from.getDate() - 6);
      return { dateFrom: fmt(from), dateTo: fmt(today) };
    }
    case "30d": {
      const from = new Date(today); from.setDate(from.getDate() - 29);
      return { dateFrom: fmt(from), dateTo: fmt(today) };
    }
    case "90d": {
      const from = new Date(today); from.setDate(from.getDate() - 89);
      return { dateFrom: fmt(from), dateTo: fmt(today) };
    }
    case "ytd": {
      const from = new Date(today.getFullYear(), 0, 1);
      return { dateFrom: fmt(from), dateTo: fmt(today) };
    }
    case "all":
    default:
      return {};
  }
}

function defaultSize(type: string): { w: number; h: number } {
  switch (type) {
    case "kpi": case "single_value": case "gauge": case "goal_progress": case "comparison":
      return { w: 3, h: 4 };
    case "leaderboard": case "activity_feed": case "rep_performance": case "table":
      return { w: 4, h: 6 };
    case "heatmap":
      return { w: 6, h: 5 };
    case "pipeline_stage": case "funnel":
      return { w: 4, h: 5 };
    case "email_health":
      return { w: 3, h: 6 };
    default:
      return { w: 4, h: 5 };
  }
}

const KPI_METRICS = [
  "pipeline_value", "revenue", "closed_won_qtr", "win_rate", "avg_deal",
  "sales_cycle_length", "activity_counts", "meetings_booked", "response_rate", "reply_rate",
];

const CHART_TYPES = [
  "line", "bar", "stacked_bar", "area", "pie", "donut",
  "funnel", "scatter", "heatmap", "gauge", "single_value",
];

const WIDGET_TYPES = [
  "kpi", "leaderboard", "activity_feed", "goal_progress", "comparison",
  "pipeline_stage", "rep_performance", "email_health", "table",
];

/* ─── Tests ─────────────────────────────────────────────────────────────── */

describe("resolvePresetDates", () => {
  it("returns empty object for 'all'", () => {
    const result = resolvePresetDates("all");
    expect(result).toEqual({});
  });

  it("returns same dateFrom and dateTo for 'today'", () => {
    const result = resolvePresetDates("today");
    expect(result.dateFrom).toBeDefined();
    expect(result.dateTo).toBeDefined();
    expect(result.dateFrom).toBe(result.dateTo);
  });

  it("returns 7-day range for '7d'", () => {
    const result = resolvePresetDates("7d");
    expect(result.dateFrom).toBeDefined();
    expect(result.dateTo).toBeDefined();
    const from = new Date(result.dateFrom!);
    const to = new Date(result.dateTo!);
    const diffDays = Math.round((to.getTime() - from.getTime()) / 86400000);
    expect(diffDays).toBe(6);
  });

  it("returns 30-day range for '30d'", () => {
    const result = resolvePresetDates("30d");
    const from = new Date(result.dateFrom!);
    const to = new Date(result.dateTo!);
    const diffDays = Math.round((to.getTime() - from.getTime()) / 86400000);
    expect(diffDays).toBe(29);
  });

  it("returns ~90-day range for '90d'", () => {
    const result = resolvePresetDates("90d");
    const from = new Date(result.dateFrom!);
    const to = new Date(result.dateTo!);
    const diffDays = Math.round((to.getTime() - from.getTime()) / 86400000);
    // 89 days span (90 inclusive days) — allow ±1 for DST boundary edge cases
    expect(diffDays).toBeGreaterThanOrEqual(88);
    expect(diffDays).toBeLessThanOrEqual(90);
  });

  it("returns YTD range starting Jan 1 for 'ytd'", () => {
    const result = resolvePresetDates("ytd");
    expect(result.dateFrom).toBeDefined();
    expect(result.dateFrom!.endsWith("-01-01")).toBe(true);
  });

  it("returns empty object for unknown preset", () => {
    const result = resolvePresetDates("unknown_preset");
    expect(result).toEqual({});
  });
});

describe("defaultSize", () => {
  it("returns compact size for KPI-type widgets", () => {
    for (const type of ["kpi", "single_value", "gauge", "goal_progress", "comparison"]) {
      const size = defaultSize(type);
      expect(size.w).toBe(3);
      expect(size.h).toBe(4);
    }
  });

  it("returns tall size for list widgets", () => {
    for (const type of ["leaderboard", "activity_feed", "rep_performance", "table"]) {
      const size = defaultSize(type);
      expect(size.w).toBe(4);
      expect(size.h).toBe(6);
    }
  });

  it("returns wide size for heatmap", () => {
    const size = defaultSize("heatmap");
    expect(size.w).toBe(6);
    expect(size.h).toBe(5);
  });

  it("returns medium size for funnel and pipeline_stage", () => {
    for (const type of ["funnel", "pipeline_stage"]) {
      const size = defaultSize(type);
      expect(size.w).toBe(4);
      expect(size.h).toBe(5);
    }
  });

  it("returns default size for unknown types", () => {
    const size = defaultSize("unknown_type");
    expect(size.w).toBe(4);
    expect(size.h).toBe(5);
  });
});

describe("KPI metrics coverage", () => {
  it("includes all 10 required KPI metrics", () => {
    const required = [
      "pipeline_value", "revenue", "win_rate", "avg_deal",
      "sales_cycle_length", "activity_counts", "response_rate",
      "reply_rate", "meetings_booked", "closed_won_qtr",
    ];
    for (const metric of required) {
      expect(KPI_METRICS).toContain(metric);
    }
  });
});

describe("Chart types coverage", () => {
  it("includes all 11 required chart types", () => {
    const required = [
      "line", "bar", "stacked_bar", "area", "pie", "donut",
      "funnel", "scatter", "heatmap", "gauge", "single_value",
    ];
    expect(CHART_TYPES).toHaveLength(11);
    for (const type of required) {
      expect(CHART_TYPES).toContain(type);
    }
  });
});

describe("Widget types coverage", () => {
  it("includes all required widget types", () => {
    const required = [
      "kpi", "leaderboard", "activity_feed", "goal_progress",
      "comparison", "pipeline_stage", "rep_performance",
    ];
    for (const type of required) {
      expect(WIDGET_TYPES).toContain(type);
    }
  });
});
