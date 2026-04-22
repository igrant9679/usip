/**
 * Sprint 2 vitest — pure logic tests (no DB).
 * Covers: canvas node/edge validation, integration config validation,
 * dashboard layout serialization.
 */
import { describe, expect, it } from "vitest";

/* ─── Canvas validation helpers ─────────────────────────────────────────── */

type NodeType = "start" | "email" | "wait" | "condition" | "action" | "goal";
interface CanvasNode { id: string; type: NodeType; positionX: number; positionY: number; data: Record<string, unknown> }
interface CanvasEdge { id: string; source: string; target: string; sourceHandle?: string | null }

function validateCanvas(nodes: CanvasNode[], edges: CanvasEdge[]): string[] {
  const errors: string[] = [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Must have exactly one start node
  const starts = nodes.filter((n) => n.type === "start");
  if (starts.length === 0) errors.push("Canvas must have a Start node");
  if (starts.length > 1) errors.push("Canvas must have exactly one Start node");

  // Condition nodes must have exactly 2 outgoing edges (true + false)
  const conditionNodes = nodes.filter((n) => n.type === "condition");
  for (const cn of conditionNodes) {
    const outgoing = edges.filter((e) => e.source === cn.id);
    if (outgoing.length !== 2) {
      errors.push(`Condition node "${cn.id}" must have exactly 2 outgoing edges (true/false), found ${outgoing.length}`);
    } else {
      const handles = outgoing.map((e) => e.sourceHandle).sort();
      if (!handles.includes("true") || !handles.includes("false")) {
        errors.push(`Condition node "${cn.id}" must have one "true" and one "false" edge`);
      }
    }
  }

  // Goal nodes must have no outgoing edges
  const goalNodes = nodes.filter((n) => n.type === "goal");
  for (const gn of goalNodes) {
    const outgoing = edges.filter((e) => e.source === gn.id);
    if (outgoing.length > 0) {
      errors.push(`Goal node "${gn.id}" must not have outgoing edges`);
    }
  }

  // All edge source/target must reference existing nodes
  for (const edge of edges) {
    if (!nodeMap.has(edge.source)) errors.push(`Edge "${edge.id}" references unknown source "${edge.source}"`);
    if (!nodeMap.has(edge.target)) errors.push(`Edge "${edge.id}" references unknown target "${edge.target}"`);
  }

  return errors;
}

describe("Canvas validation", () => {
  const startNode: CanvasNode = { id: "start-1", type: "start", positionX: 0, positionY: 0, data: { label: "Start" } };
  const emailNode: CanvasNode = { id: "email-1", type: "email", positionX: 0, positionY: 100, data: { label: "Email 1" } };
  const condNode: CanvasNode = { id: "cond-1", type: "condition", positionX: 0, positionY: 200, data: { label: "Opened?" } };
  const goalNode: CanvasNode = { id: "goal-1", type: "goal", positionX: 0, positionY: 300, data: { label: "Converted" } };
  const actionNode: CanvasNode = { id: "action-1", type: "action", positionX: 100, positionY: 300, data: { label: "Tag" } };

  it("accepts a valid linear canvas", () => {
    const nodes = [startNode, emailNode];
    const edges: CanvasEdge[] = [{ id: "e1", source: "start-1", target: "email-1" }];
    expect(validateCanvas(nodes, edges)).toEqual([]);
  });

  it("rejects canvas with no start node", () => {
    const errs = validateCanvas([emailNode], []);
    expect(errs.some((e) => e.includes("Start node"))).toBe(true);
  });

  it("rejects canvas with two start nodes", () => {
    const start2: CanvasNode = { ...startNode, id: "start-2" };
    const errs = validateCanvas([startNode, start2], []);
    expect(errs.some((e) => e.includes("exactly one Start"))).toBe(true);
  });

  it("rejects condition node with only one outgoing edge", () => {
    const nodes = [startNode, condNode, goalNode];
    const edges: CanvasEdge[] = [
      { id: "e1", source: "start-1", target: "cond-1" },
      { id: "e2", source: "cond-1", target: "goal-1", sourceHandle: "true" },
      // missing false branch
    ];
    const errs = validateCanvas(nodes, edges);
    expect(errs.some((e) => e.includes("cond-1") && e.includes("2 outgoing"))).toBe(true);
  });

  it("rejects condition node with wrong handle labels", () => {
    const nodes = [startNode, condNode, goalNode, actionNode];
    const edges: CanvasEdge[] = [
      { id: "e1", source: "start-1", target: "cond-1" },
      { id: "e2", source: "cond-1", target: "goal-1", sourceHandle: "yes" },
      { id: "e3", source: "cond-1", target: "action-1", sourceHandle: "no" },
    ];
    const errs = validateCanvas(nodes, edges);
    expect(errs.some((e) => e.includes("true") && e.includes("false"))).toBe(true);
  });

  it("accepts condition node with correct true/false handles", () => {
    const nodes = [startNode, condNode, goalNode, actionNode];
    const edges: CanvasEdge[] = [
      { id: "e1", source: "start-1", target: "cond-1" },
      { id: "e2", source: "cond-1", target: "goal-1", sourceHandle: "true" },
      { id: "e3", source: "cond-1", target: "action-1", sourceHandle: "false" },
    ];
    expect(validateCanvas(nodes, edges)).toEqual([]);
  });

  it("rejects goal node with outgoing edges", () => {
    const nodes = [startNode, goalNode, emailNode];
    const edges: CanvasEdge[] = [
      { id: "e1", source: "start-1", target: "goal-1" },
      { id: "e2", source: "goal-1", target: "email-1" }, // invalid
    ];
    const errs = validateCanvas(nodes, edges);
    expect(errs.some((e) => e.includes("goal-1") && e.includes("outgoing"))).toBe(true);
  });

  it("rejects edges referencing unknown nodes", () => {
    const nodes = [startNode];
    const edges: CanvasEdge[] = [{ id: "e1", source: "start-1", target: "ghost-99" }];
    const errs = validateCanvas(nodes, edges);
    expect(errs.some((e) => e.includes("ghost-99"))).toBe(true);
  });
});

/* ─── Integration config validation ─────────────────────────────────────── */

function validateIntegrationConfig(provider: string, config: Record<string, string>): string[] {
  const errors: string[] = [];
  if (provider === "stripe") {
    if (!config.publishableKey?.startsWith("pk_")) errors.push("Stripe publishable key must start with pk_");
    if (!config.secretKey?.startsWith("sk_")) errors.push("Stripe secret key must start with sk_");
  }
  if (provider === "webhook") {
    if (!config.url) errors.push("Webhook URL is required");
    else {
      try { new URL(config.url); } catch { errors.push("Webhook URL must be a valid URL"); }
    }
  }
  return errors;
}

describe("Integration config validation", () => {
  it("accepts valid Stripe keys", () => {
    expect(validateIntegrationConfig("stripe", { publishableKey: "pk_test_abc", secretKey: "sk_test_xyz" })).toEqual([]);
  });

  it("rejects Stripe keys with wrong prefix", () => {
    const errs = validateIntegrationConfig("stripe", { publishableKey: "bad_key", secretKey: "also_bad" });
    expect(errs.length).toBe(2);
  });

  it("accepts valid webhook URL", () => {
    expect(validateIntegrationConfig("webhook", { url: "https://example.com/hook" })).toEqual([]);
  });

  it("rejects missing webhook URL", () => {
    const errs = validateIntegrationConfig("webhook", {});
    expect(errs.some((e) => e.includes("required"))).toBe(true);
  });

  it("rejects malformed webhook URL", () => {
    const errs = validateIntegrationConfig("webhook", { url: "not-a-url" });
    expect(errs.some((e) => e.includes("valid URL"))).toBe(true);
  });

  it("passes through for built-in providers", () => {
    expect(validateIntegrationConfig("manus_oauth", {})).toEqual([]);
    expect(validateIntegrationConfig("llm", {})).toEqual([]);
    expect(validateIntegrationConfig("google_maps", {})).toEqual([]);
  });
});

/* ─── Dashboard layout serialization ────────────────────────────────────── */

interface WidgetLayout { widgetId: string; col: number; row: number; w: number; h: number; title?: string }

function serializeLayout(widgets: WidgetLayout[]): string {
  return JSON.stringify(widgets.map((w) => ({ ...w })));
}

function deserializeLayout(json: string): WidgetLayout[] {
  return JSON.parse(json);
}

function mergeLayouts(base: WidgetLayout[], override: WidgetLayout[]): WidgetLayout[] {
  const overrideMap = new Map(override.map((w) => [w.widgetId, w]));
  return base.map((w) => overrideMap.get(w.widgetId) ?? w);
}

describe("Dashboard layout serialization", () => {
  const layout: WidgetLayout[] = [
    { widgetId: "w1", col: 0, row: 0, w: 4, h: 3 },
    { widgetId: "w2", col: 4, row: 0, w: 4, h: 3 },
    { widgetId: "w3", col: 8, row: 0, w: 4, h: 3, title: "Custom title" },
  ];

  it("round-trips layout through JSON", () => {
    const serialized = serializeLayout(layout);
    const restored = deserializeLayout(serialized);
    expect(restored).toEqual(layout);
  });

  it("preserves optional title field", () => {
    const restored = deserializeLayout(serializeLayout(layout));
    expect(restored[2]?.title).toBe("Custom title");
  });

  it("merges user override onto base layout", () => {
    const userOverride: WidgetLayout[] = [{ widgetId: "w2", col: 0, row: 1, w: 6, h: 4 }];
    const merged = mergeLayouts(layout, userOverride);
    expect(merged[1]?.col).toBe(0);
    expect(merged[1]?.w).toBe(6);
    // w1 and w3 unchanged
    expect(merged[0]?.col).toBe(0);
    expect(merged[2]?.title).toBe("Custom title");
  });

  it("ignores override for unknown widgetIds", () => {
    const userOverride: WidgetLayout[] = [{ widgetId: "ghost", col: 5, row: 5, w: 2, h: 2 }];
    const merged = mergeLayouts(layout, userOverride);
    expect(merged.length).toBe(3);
    expect(merged.find((w) => w.widgetId === "ghost")).toBeUndefined();
  });
});
