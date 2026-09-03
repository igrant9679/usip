/**
 * StepFunnelSankey layering (2026-08-19). The server's funnel has links that
 * skip columns ("Opened step 1" → "No reply yet" across the Step 2 column),
 * which Recharts drew as long bands behind the intermediate columns — the
 * overlap the owner flagged. layerFunnel rewrites those through invisible
 * pass-through hops so every band spans exactly one column, without changing
 * a single count.
 *
 * Fixture = the screenshot: 31 dispatched step 1 → 23 unopened / 8 opened;
 * 8 reached step 2 (from both sides), 6 unopened / 2 opened there; everyone
 * ends in "No reply yet" (31).
 */
import { describe, it, expect } from "vitest";
import { layerFunnel } from "@/components/usip/are/stepFunnelLayering";
import type { StepFunnelDto } from "@/components/usip/are/StepFunnelSankey";

const funnel: StepFunnelDto = {
  totalProspects: 31, opensTracked: true,
  nodes: [
    { id: "step:0", name: "Step 1", kind: "step", stepIndex: 0, value: 31 },
    { id: "opened:0", name: "Opened step 1", kind: "opened", stepIndex: 0, value: 8 },
    { id: "unopened:0", name: "No open on step 1", kind: "unopened", stepIndex: 0, value: 23 },
    { id: "step:1", name: "Step 2", kind: "step", stepIndex: 1, value: 8 },
    { id: "opened:1", name: "Opened step 2", kind: "opened", stepIndex: 1, value: 2 },
    { id: "unopened:1", name: "No open on step 2", kind: "unopened", stepIndex: 1, value: 6 },
    { id: "dormant", name: "No reply yet", kind: "dormant", stepIndex: null, value: 31 },
  ],
  links: [
    { source: "step:0", target: "opened:0", value: 8 },
    { source: "step:0", target: "unopened:0", value: 23 },
    { source: "opened:0", target: "step:1", value: 3 },
    { source: "unopened:0", target: "step:1", value: 5 },
    { source: "opened:0", target: "dormant", value: 5 },     // skips 2 columns
    { source: "unopened:0", target: "dormant", value: 18 },  // skips 2 columns
    { source: "step:1", target: "opened:1", value: 2 },
    { source: "step:1", target: "unopened:1", value: 6 },
    { source: "opened:1", target: "dormant", value: 2 },
    { source: "unopened:1", target: "dormant", value: 6 },
  ],
};

/** Column of a laid-out node, derived the same way the component does. */
function depthOf(n: { kind: string; stepIndex: number | null; passthrough?: boolean }, ptDepth: Map<number, number>, idx: number, terminal: number): number {
  if (n.passthrough) return ptDepth.get(idx)!;
  if (n.stepIndex === null) return terminal;
  return n.kind === "step" ? 2 * n.stepIndex : 2 * n.stepIndex + 1;
}

describe("layerFunnel", () => {
  const out = layerFunnel(funnel);
  const terminal = 4; // steps 0,1 → columns 0..3, terminals at 4

  it("keeps every real node and adds pass-throughs only where a link skipped a column", () => {
    const real = out.nodes.filter((n) => !n.passthrough);
    expect(real.map((n) => n.name)).toEqual(funnel.nodes.map((n) => n.name));
    const pts = out.nodes.filter((n) => n.passthrough);
    // One lane per terminal, per ORIGIN KIND, per intermediate column (2 and
    // 3): an "opened" lane and an "unopened" lane — so the two splits never
    // have to cross to reach the same lane.
    expect(pts).toHaveLength(4);
    for (const pt of pts) {
      expect(pt.name).toBe("");
      expect(pt.kind).toBe("dormant");   // keeps the final target's colour
      expect(pt.final).toBe("No reply yet");
    }
    expect(pts.map((p) => p.total).sort((a, b) => a - b)).toEqual([5, 5, 18, 18]);
  });

  it("every link now spans exactly one column", () => {
    // Recover each pass-through's column from its key order: chains are built
    // depth-ascending, so walk links from the origin.
    const ptDepth = new Map<number, number>();
    for (const l of out.links) {
      const s = out.nodes[l.source], t = out.nodes[l.target];
      const ds = depthOf(s, ptDepth, l.source, terminal);
      if (t.passthrough && !ptDepth.has(l.target)) ptDepth.set(l.target, ds + 1);
    }
    for (const l of out.links) {
      const ds = depthOf(out.nodes[l.source], ptDepth, l.source, terminal);
      const dt = depthOf(out.nodes[l.target], ptDepth, l.target, terminal);
      expect(dt - ds).toBe(1);
    }
  });

  it("no count changes: every original link's value survives end to end, and the terminal still receives 31", () => {
    // Sum of link values into the terminal equals its value.
    const termIdx = out.nodes.findIndex((n) => n.name === "No reply yet");
    const into = out.links.filter((l) => l.target === termIdx).reduce((a, l) => a + l.value, 0);
    expect(into).toBe(31);
    // Each lane carries its origin kind's leavers through both columns and into the terminal.
    const laneHops = out.links.filter((l) => out.nodes[l.source].passthrough).map((l) => l.value).sort((a, b) => a - b);
    expect(laneHops).toEqual([5, 5, 18, 18]); // opened: lane@2→lane@3, lane@3→terminal; unopened: same
  });

  it("a same-column or backward link is dropped — Recharts has no cycle guard (2026-09-03 crash)", () => {
    // What CF campaigns 19/21 actually sent: one prospect dispatched step 1
    // twice → "No open on step 1" → "Step 1". Fed to Recharts as-is, the
    // depth walk yields NaN for every x and the chart collapses to one column.
    const poisoned: StepFunnelDto = {
      ...funnel,
      links: [...funnel.links, { source: "unopened:0", target: "step:0", value: 1 }, { source: "step:0", target: "step:0", value: 1 }],
    };
    const out = layerFunnel(poisoned);
    const col = (i: number) => {
      const n = out.nodes[i];
      if (n.passthrough) return NaN;
      return n.stepIndex === null ? 4 : n.kind === "step" ? 2 * n.stepIndex : 2 * n.stepIndex + 1;
    };
    for (const l of out.links) {
      const a = col(l.source), b = col(l.target);
      if (Number.isNaN(a) || Number.isNaN(b)) continue; // a lane hop; spans one column by construction
      expect(b, `${l.source}→${l.target}`).toBeGreaterThan(a);
    }
    expect(out.links.some((l) => l.target === out.nodes.findIndex((n) => n.id === "step:0"))).toBe(false);
    // Everything else survives exactly as before.
    expect(out.links.length).toBe(layerFunnel(funnel).links.length);
  });

  it("a link whose endpoint was never emitted is dropped, not mis-attached", () => {
    const bad = { ...funnel, links: [...funnel.links, { source: "step:0", target: "ghost", value: 99 }] };
    const o = layerFunnel(bad);
    expect(o.links.some((l) => l.value === 99)).toBe(false);
  });
});
