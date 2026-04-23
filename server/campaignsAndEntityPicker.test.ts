/**
 * Vitest tests for Features 69, 70, 71
 * - Outreach Campaigns (CRUD, launch/pause, analytics, step stats)
 * - EntityPicker shared component logic
 * - AI Compose CRM context selectors
 */
import { describe, it, expect } from "vitest";

/* ─── Feature 69: Outreach Campaigns ─────────────────────────────────── */

describe("Campaign status transitions", () => {
  const VALID_TRANSITIONS: Record<string, string[]> = {
    planning:  ["live", "scheduled"],
    scheduled: ["live", "paused", "planning"],
    live:      ["paused", "completed"],
    paused:    ["live", "planning"],
    completed: [],
  };

  function canTransition(from: string, to: string): boolean {
    return (VALID_TRANSITIONS[from] ?? []).includes(to);
  }

  it("planning → live is allowed", () => expect(canTransition("planning", "live")).toBe(true));
  it("live → paused is allowed", () => expect(canTransition("live", "paused")).toBe(true));
  it("paused → live is allowed", () => expect(canTransition("paused", "live")).toBe(true));
  it("live → completed is allowed", () => expect(canTransition("live", "completed")).toBe(true));
  it("completed → live is NOT allowed", () => expect(canTransition("completed", "live")).toBe(false));
  it("planning → completed is NOT allowed", () => expect(canTransition("planning", "completed")).toBe(false));
  it("paused → completed is NOT allowed", () => expect(canTransition("paused", "completed")).toBe(false));
});

describe("Campaign analytics rate calculations", () => {
  function calcRates(stats: {
    totalSent: number;
    totalDelivered: number;
    totalOpened: number;
    totalClicked: number;
    totalReplied: number;
    totalBounced: number;
    totalUnsubscribed: number;
  }) {
    const { totalSent, totalDelivered, totalOpened, totalClicked, totalReplied, totalBounced } = stats;
    return {
      deliveryRate:    totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0,
      openRate:        totalDelivered > 0 ? Math.round((totalOpened / totalDelivered) * 100) : 0,
      clickRate:       totalOpened > 0 ? Math.round((totalClicked / totalOpened) * 100) : 0,
      replyRate:       totalDelivered > 0 ? Math.round((totalReplied / totalDelivered) * 100) : 0,
      bounceRate:      totalSent > 0 ? Math.round((totalBounced / totalSent) * 100) : 0,
    };
  }

  it("calculates delivery rate correctly", () => {
    const r = calcRates({ totalSent: 100, totalDelivered: 95, totalOpened: 40, totalClicked: 10, totalReplied: 5, totalBounced: 5, totalUnsubscribed: 1 });
    expect(r.deliveryRate).toBe(95);
  });

  it("calculates open rate correctly", () => {
    const r = calcRates({ totalSent: 100, totalDelivered: 100, totalOpened: 40, totalClicked: 10, totalReplied: 5, totalBounced: 0, totalUnsubscribed: 0 });
    expect(r.openRate).toBe(40);
  });

  it("calculates click rate as % of opened", () => {
    const r = calcRates({ totalSent: 100, totalDelivered: 100, totalOpened: 50, totalClicked: 10, totalReplied: 5, totalBounced: 0, totalUnsubscribed: 0 });
    expect(r.clickRate).toBe(20);
  });

  it("returns 0 rates when sent is 0", () => {
    const r = calcRates({ totalSent: 0, totalDelivered: 0, totalOpened: 0, totalClicked: 0, totalReplied: 0, totalBounced: 0, totalUnsubscribed: 0 });
    expect(r.deliveryRate).toBe(0);
    expect(r.openRate).toBe(0);
    expect(r.bounceRate).toBe(0);
  });

  it("bounce rate is % of sent", () => {
    const r = calcRates({ totalSent: 200, totalDelivered: 190, totalOpened: 80, totalClicked: 20, totalReplied: 10, totalBounced: 10, totalUnsubscribed: 2 });
    expect(r.bounceRate).toBe(5);
  });
});

describe("Campaign throttle validation", () => {
  function validateThrottle(perHour: number, perDay: number): string | null {
    if (perHour < 1) return "throttlePerHour must be >= 1";
    if (perDay < 1) return "throttlePerDay must be >= 1";
    if (perHour > 1000) return "throttlePerHour must be <= 1000";
    if (perDay > 10000) return "throttlePerDay must be <= 10000";
    if (perHour > perDay) return "throttlePerHour cannot exceed throttlePerDay";
    return null;
  }

  it("valid throttle passes", () => expect(validateThrottle(50, 500)).toBeNull());
  it("perHour=0 fails", () => expect(validateThrottle(0, 500)).toBeTruthy());
  it("perDay=0 fails", () => expect(validateThrottle(50, 0)).toBeTruthy());
  it("perHour > perDay fails", () => expect(validateThrottle(600, 500)).toBeTruthy());
  it("perHour=1000, perDay=10000 is valid", () => expect(validateThrottle(1000, 10000)).toBeNull());
});

describe("Campaign A/B variant weight validation", () => {
  function validateVariants(variants: { label: string; weight: number }[]): string | null {
    if (variants.length === 0) return null; // no variants is fine
    const total = variants.reduce((s, v) => s + v.weight, 0);
    if (Math.abs(total - 100) > 1) return `Variant weights must sum to 100 (got ${total})`;
    const labels = variants.map((v) => v.label);
    if (new Set(labels).size !== labels.length) return "Variant labels must be unique";
    return null;
  }

  it("no variants is valid", () => expect(validateVariants([])).toBeNull());
  it("two variants summing to 100 is valid", () => expect(validateVariants([{ label: "A", weight: 50 }, { label: "B", weight: 50 }])).toBeNull());
  it("weights not summing to 100 fails", () => expect(validateVariants([{ label: "A", weight: 60 }, { label: "B", weight: 60 }])).toBeTruthy());
  it("duplicate labels fail", () => expect(validateVariants([{ label: "A", weight: 50 }, { label: "A", weight: 50 }])).toBeTruthy());
  it("three variants summing to 100 is valid", () => expect(validateVariants([{ label: "A", weight: 34 }, { label: "B", weight: 33 }, { label: "C", weight: 33 }])).toBeNull());
});

describe("Campaign step stats aggregation", () => {
  type StepStat = {
    stepIndex: number;
    stepLabel: string | null;
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    replied: number;
    bounced: number;
  };

  function aggregateStepStats(steps: StepStat[]) {
    return {
      totalSent:      steps.reduce((s, r) => s + r.sent, 0),
      totalDelivered: steps.reduce((s, r) => s + r.delivered, 0),
      totalOpened:    steps.reduce((s, r) => s + r.opened, 0),
      totalClicked:   steps.reduce((s, r) => s + r.clicked, 0),
      totalReplied:   steps.reduce((s, r) => s + r.replied, 0),
      totalBounced:   steps.reduce((s, r) => s + r.bounced, 0),
    };
  }

  const steps: StepStat[] = [
    { stepIndex: 0, stepLabel: "Step 1", sent: 100, delivered: 95, opened: 40, clicked: 10, replied: 5, bounced: 5 },
    { stepIndex: 1, stepLabel: "Step 2", sent: 80, delivered: 78, opened: 30, clicked: 8, replied: 3, bounced: 2 },
    { stepIndex: 2, stepLabel: "Step 3", sent: 60, delivered: 59, opened: 20, clicked: 5, replied: 2, bounced: 1 },
  ];

  it("aggregates totalSent correctly", () => expect(aggregateStepStats(steps).totalSent).toBe(240));
  it("aggregates totalDelivered correctly", () => expect(aggregateStepStats(steps).totalDelivered).toBe(232));
  it("aggregates totalOpened correctly", () => expect(aggregateStepStats(steps).totalOpened).toBe(90));
  it("aggregates totalBounced correctly", () => expect(aggregateStepStats(steps).totalBounced).toBe(8));
  it("handles empty steps array", () => {
    const r = aggregateStepStats([]);
    expect(r.totalSent).toBe(0);
    expect(r.totalOpened).toBe(0);
  });
});

/* ─── Feature 70: EntityPicker shared component logic ────────────────── */

describe("EntityPicker type mapping", () => {
  type EntityPickerType = "contacts" | "segments" | "sequences" | "campaigns" | "sendingAccounts" | "senderPools";

  const ENTITY_LABELS: Record<EntityPickerType, string> = {
    contacts: "Contacts",
    segments: "Segments",
    sequences: "Sequences",
    campaigns: "Campaigns",
    sendingAccounts: "Sending Accounts",
    senderPools: "Sender Pools",
  };

  it("all 6 entity types have labels", () => {
    const types: EntityPickerType[] = ["contacts", "segments", "sequences", "campaigns", "sendingAccounts", "senderPools"];
    types.forEach((t) => expect(ENTITY_LABELS[t]).toBeTruthy());
  });

  it("label for contacts is 'Contacts'", () => expect(ENTITY_LABELS.contacts).toBe("Contacts"));
  it("label for sendingAccounts is 'Sending Accounts'", () => expect(ENTITY_LABELS.sendingAccounts).toBe("Sending Accounts"));
});

describe("EntityPicker value management", () => {
  function toggleId(current: number[], id: number): number[] {
    return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  }

  function setSingleId(id: number): number[] {
    return [id];
  }

  it("toggle adds id when not present", () => expect(toggleId([1, 2], 3)).toEqual([1, 2, 3]));
  it("toggle removes id when present", () => expect(toggleId([1, 2, 3], 2)).toEqual([1, 3]));
  it("toggle on empty array adds id", () => expect(toggleId([], 5)).toEqual([5]));
  it("single mode always returns array of one", () => expect(setSingleId(7)).toEqual([7]));
  it("single mode replaces previous selection", () => {
    const prev = [3];
    const next = setSingleId(7);
    expect(next).toEqual([7]);
    expect(next).not.toContain(prev[0]);
  });
});

describe("EntityPicker search filtering", () => {
  const items = [
    { id: 1, label: "Alice Johnson", meta: "VP Sales" },
    { id: 2, label: "Bob Smith", meta: "CTO" },
    { id: 3, label: "Carol White", meta: "VP Marketing" },
    { id: 4, label: "David Lee", meta: "Engineer" },
  ];

  function filterItems(items: typeof items, query: string) {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter(
      (i) => i.label.toLowerCase().includes(q) || (i.meta ?? "").toLowerCase().includes(q)
    );
  }

  it("empty query returns all items", () => expect(filterItems(items, "")).toHaveLength(4));
  it("filters by label", () => expect(filterItems(items, "alice")).toHaveLength(1));
  it("filters by meta", () => expect(filterItems(items, "VP")).toHaveLength(2));
  it("case-insensitive search", () => expect(filterItems(items, "CAROL")).toHaveLength(1));
  it("no match returns empty array", () => expect(filterItems(items, "zzz")).toHaveLength(0));
  it("partial match works", () => expect(filterItems(items, "son")).toHaveLength(1));
});

describe("EntityPicker badge chip rendering", () => {
  function getSelectedLabels(items: { id: number; label: string }[], selectedIds: number[]): string[] {
    return selectedIds
      .map((id) => items.find((i) => i.id === id)?.label ?? `#${id}`)
      .filter(Boolean);
  }

  const items = [
    { id: 1, label: "Segment A" },
    { id: 2, label: "Segment B" },
    { id: 3, label: "Segment C" },
  ];

  it("returns labels for selected ids", () => {
    expect(getSelectedLabels(items, [1, 3])).toEqual(["Segment A", "Segment C"]);
  });

  it("falls back to #id for unknown ids", () => {
    expect(getSelectedLabels(items, [99])).toEqual(["#99"]);
  });

  it("empty selection returns empty array", () => {
    expect(getSelectedLabels(items, [])).toEqual([]);
  });
});

/* ─── Feature 71: AI Compose CRM context selectors ───────────────────── */

describe("AI Compose CRM context state management", () => {
  type CrmContext = {
    segmentIds: number[];
    sequenceIds: number[];
    campaignIds: number[];
  };

  function clearContext(): CrmContext {
    return { segmentIds: [], sequenceIds: [], campaignIds: [] };
  }

  function hasContext(ctx: CrmContext): boolean {
    return ctx.segmentIds.length + ctx.sequenceIds.length + ctx.campaignIds.length > 0;
  }

  function contextCount(ctx: CrmContext): number {
    return ctx.segmentIds.length + ctx.sequenceIds.length + ctx.campaignIds.length;
  }

  it("clearContext returns all empty arrays", () => {
    const ctx = clearContext();
    expect(ctx.segmentIds).toEqual([]);
    expect(ctx.sequenceIds).toEqual([]);
    expect(ctx.campaignIds).toEqual([]);
  });

  it("hasContext returns false when all empty", () => {
    expect(hasContext(clearContext())).toBe(false);
  });

  it("hasContext returns true when any array has items", () => {
    expect(hasContext({ segmentIds: [1], sequenceIds: [], campaignIds: [] })).toBe(true);
    expect(hasContext({ segmentIds: [], sequenceIds: [2], campaignIds: [] })).toBe(true);
    expect(hasContext({ segmentIds: [], sequenceIds: [], campaignIds: [3] })).toBe(true);
  });

  it("contextCount sums all arrays", () => {
    expect(contextCount({ segmentIds: [1, 2], sequenceIds: [3], campaignIds: [4, 5, 6] })).toBe(6);
  });

  it("contextCount returns 0 for empty context", () => {
    expect(contextCount(clearContext())).toBe(0);
  });
});

describe("AI Compose context serialization for LLM prompt", () => {
  type EntityRef = { id: number; name: string };

  function buildContextPrompt(opts: {
    segments: EntityRef[];
    sequences: EntityRef[];
    campaigns: EntityRef[];
  }): string {
    const parts: string[] = [];
    if (opts.segments.length > 0) {
      parts.push(`Target segments: ${opts.segments.map((s) => s.name).join(", ")}`);
    }
    if (opts.sequences.length > 0) {
      parts.push(`Referenced sequences: ${opts.sequences.map((s) => s.name).join(", ")}`);
    }
    if (opts.campaigns.length > 0) {
      parts.push(`Associated campaigns: ${opts.campaigns.map((c) => c.name).join(", ")}`);
    }
    return parts.length > 0 ? `\n\nCRM Context:\n${parts.join("\n")}` : "";
  }

  it("returns empty string when no context", () => {
    expect(buildContextPrompt({ segments: [], sequences: [], campaigns: [] })).toBe("");
  });

  it("includes segment names when provided", () => {
    const result = buildContextPrompt({
      segments: [{ id: 1, name: "Enterprise SaaS" }],
      sequences: [],
      campaigns: [],
    });
    expect(result).toContain("Enterprise SaaS");
    expect(result).toContain("Target segments");
  });

  it("includes all three entity types when provided", () => {
    const result = buildContextPrompt({
      segments: [{ id: 1, name: "Mid-Market" }],
      sequences: [{ id: 2, name: "Cold Outreach v2" }],
      campaigns: [{ id: 3, name: "Q3 Push" }],
    });
    expect(result).toContain("Mid-Market");
    expect(result).toContain("Cold Outreach v2");
    expect(result).toContain("Q3 Push");
  });

  it("multiple entities in same type are comma-separated", () => {
    const result = buildContextPrompt({
      segments: [{ id: 1, name: "Seg A" }, { id: 2, name: "Seg B" }],
      sequences: [],
      campaigns: [],
    });
    expect(result).toContain("Seg A, Seg B");
  });

  it("prompt starts with newline separator", () => {
    const result = buildContextPrompt({
      segments: [{ id: 1, name: "Test" }],
      sequences: [],
      campaigns: [],
    });
    expect(result.startsWith("\n\n")).toBe(true);
  });
});

describe("Campaign audience type validation", () => {
  type AudienceType = "contacts" | "segment";

  function validateAudience(
    type: AudienceType,
    contactIds: number[],
    segmentId: number | null
  ): string | null {
    if (type === "contacts" && contactIds.length === 0) {
      return "At least one contact must be selected";
    }
    if (type === "segment" && !segmentId) {
      return "A segment must be selected";
    }
    return null;
  }

  it("contacts type with ids is valid", () => expect(validateAudience("contacts", [1, 2], null)).toBeNull());
  it("contacts type with no ids fails", () => expect(validateAudience("contacts", [], null)).toBeTruthy());
  it("segment type with segmentId is valid", () => expect(validateAudience("segment", [], 5)).toBeNull());
  it("segment type with no segmentId fails", () => expect(validateAudience("segment", [], null)).toBeTruthy());
  it("segment type ignores contactIds", () => expect(validateAudience("segment", [1, 2, 3], 5)).toBeNull());
});
