/**
 * stepFunnelLayering — the pure half of StepFunnelSankey: give every funnel
 * node a column and reroute any link that would span more than one column
 * through invisible pass-through lanes. See the component header for why
 * (2026-08-19: long bands were drawn behind intermediate columns).
 *
 * Columns: step k at 2·rank(k); its opened/unopened split at 2·rank(k)+1;
 * the terminals (Replied / Meeting booked / No reply yet) after the last
 * split. A link from column a to column b > a+1 is rewritten as
 *   origin → lane(b-target)@a+1 → lane@a+2 → … → lane@b-1 → target,
 * where lane(T,K)@d is ONE node per terminal T, per ORIGIN KIND K (opened /
 * unopened), per intermediate column d, shared by every origin of that kind
 * heading to T through that column. Why per kind: a single merged lane is
 * fed by both the unopened (top) and opened (bottom) splits, as is the next
 * step — a K₂,₂ that always crosses once. Two lanes let the "not opened"
 * leavers hug the top edge and the "opened" leavers the bottom edge all the
 * way to the terminal, so Recharts' relaxation settles every column with no
 * crossing at all. Still only a handful of extra nodes however long the
 * funnel, and each lane is itself meaningful: "the not-opened who are still
 * on their way to No reply yet".
 *
 * The first hop keeps the origin's identity (tooltip "Opened step 1 → No
 * reply yet"); merged hops read "→ No reply yet". Every value survives: the
 * terminal still receives exactly what the server said it receives.
 */
import type { ChartNode, FunnelNodeDto, StepFunnelDto } from "./StepFunnelSankey";

export function layerFunnel(funnel: StepFunnelDto): { nodes: ChartNode[]; links: Array<{ source: number; target: number; value: number }> } {
  const byId = new Map(funnel.nodes.map((n) => [n.id, n] as const));
  const stepRanks = Array.from(new Set(funnel.nodes.filter((n) => n.stepIndex !== null).map((n) => n.stepIndex as number))).sort((a, b) => a - b);
  const rankOf = new Map(stepRanks.map((si, i) => [si, i] as const));
  const terminalDepth = stepRanks.length > 0 ? 2 * (stepRanks.length - 1) + 2 : 1;
  const depthOf = (n: FunnelNodeDto): number => {
    if (n.stepIndex === null) return terminalDepth;
    const r = rankOf.get(n.stepIndex) ?? 0;
    return n.kind === "step" ? 2 * r : 2 * r + 1;
  };

  const nodes: ChartNode[] = [];
  const index = new Map<string, number>();
  const addNode = (key: string, node: ChartNode) => { index.set(key, nodes.length); nodes.push(node); return nodes.length - 1; };
  for (const n of funnel.nodes) addNode(n.id, { name: n.name, kind: n.kind, stepIndex: n.stepIndex, total: n.value });

  // Merged hops between lanes (and lane → terminal), keyed "from->to".
  const merged = new Map<string, { source: number; target: number; value: number }>();
  const addMerged = (source: number, target: number, value: number) => {
    const k = `${source}->${target}`;
    const m = merged.get(k);
    if (m) m.value += value; else merged.set(k, { source, target, value });
  };
  const direct: Array<{ source: number; target: number; value: number }> = [];

  for (const l of funnel.links) {
    const src = byId.get(l.source), tgt = byId.get(l.target);
    // A link whose endpoint was never emitted would attach to the wrong node
    // once Recharts resolves it positionally.
    if (!src || !tgt) continue;
    const ds = depthOf(src), dt = depthOf(tgt);
    const srcIdx = index.get(l.source)!, tgtIdx = index.get(l.target)!;
    if (dt - ds <= 1) { direct.push({ source: srcIdx, target: tgtIdx, value: l.value }); continue; }

    // One lane per terminal, per origin kind, per intermediate column; its
    // total grows with everyone who passes through it.
    const laneAt = (d: number): number => {
      const key = `lane:${l.target}:${src.kind}@${d}`;
      const existing = index.get(key);
      if (existing !== undefined) { nodes[existing].total += l.value; return existing; }
      return addNode(key, { name: "", kind: tgt.kind, stepIndex: null, total: l.value, passthrough: true, final: tgt.name });
    };
    let prev = srcIdx;
    for (let d = ds + 1; d < dt; d++) {
      const lane = laneAt(d);
      if (d === ds + 1) direct.push({ source: prev, target: lane, value: l.value }); // keeps the origin's identity
      else addMerged(prev, lane, l.value);
      prev = lane;
    }
    addMerged(prev, tgtIdx, l.value);
  }
  return { nodes, links: direct.concat(Array.from(merged.values())) };
}
