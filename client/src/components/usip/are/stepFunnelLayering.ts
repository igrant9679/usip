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
import type { ChartNode, FunnelNodeDto, FunnelSelection, StepFunnelDto } from "./StepFunnelSankey";

/** A band's original endpoints (server ids) — a lane hop may carry several. */
export type LinkOrigin = { source: string; target: string; sourceName: string; targetName: string };
export type LayeredLink = { source: number; target: number; value: number; origins: LinkOrigin[] };

export function layerFunnel(funnel: StepFunnelDto): { nodes: ChartNode[]; links: LayeredLink[] } {
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
  for (const n of funnel.nodes) addNode(n.id, { id: n.id, name: n.name, kind: n.kind, stepIndex: n.stepIndex, total: n.value });

  // Merged hops between lanes (and lane → terminal), keyed "from->to". Each
  // hop remembers every original link it carries, so a click on it can list
  // exactly those people.
  const merged = new Map<string, LayeredLink>();
  const addMerged = (source: number, target: number, value: number, origin: LinkOrigin) => {
    const k = `${source}->${target}`;
    const m = merged.get(k);
    if (m) { m.value += value; m.origins.push(origin); } else merged.set(k, { source, target, value, origins: [origin] });
  };
  const direct: LayeredLink[] = [];

  for (const l of funnel.links) {
    const src = byId.get(l.source), tgt = byId.get(l.target);
    // A link whose endpoint was never emitted would attach to the wrong node
    // once Recharts resolves it positionally.
    if (!src || !tgt) continue;
    const ds = depthOf(src), dt = depthOf(tgt);
    // A same-column or BACKWARD link is a cycle to Recharts' depth walk,
    // which recurses with no guard until the stack blows and the chart
    // throws (2026-09-03: a prospect sent step 1 twice produced
    // "No open on step 1" → "Step 1"). The server no longer emits one, but
    // a chart that can be crashed by its data is not a chart — dropped here
    // too, so this component never hands Recharts a cycle whatever it is fed.
    if (dt <= ds) continue;
    const srcIdx = index.get(l.source)!, tgtIdx = index.get(l.target)!;
    const origin: LinkOrigin = { source: l.source, target: l.target, sourceName: src.name, targetName: tgt.name };
    if (dt - ds <= 1) { direct.push({ source: srcIdx, target: tgtIdx, value: l.value, origins: [origin] }); continue; }

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
      if (d === ds + 1) direct.push({ source: prev, target: lane, value: l.value, origins: [origin] }); // keeps the origin's identity
      else addMerged(prev, lane, l.value, origin);
      prev = lane;
    }
    addMerged(prev, tgtIdx, l.value, origin);
  }
  return { nodes, links: direct.concat(Array.from(merged.values())) };
}

/** Resolve a clicked node or band to the people it counted. */
export function selectionFor(funnel: StepFunnelDto, el: any, type: "node" | "link"): FunnelSelection | null {
  const members = funnel.members ?? { nodes: {}, links: {} };
  const uniq = (ids: number[]) => Array.from(new Set(ids));
  if (type === "node") {
    const n = el?.payload as ChartNode | undefined;
    if (!n || n.passthrough || !n.id) return null;
    return { title: n.name, prospectIds: uniq(members.nodes[n.id] ?? []), stepIndex: n.kind === "step" ? n.stepIndex : null };
  }
  const origins = (el?.payload?.origins ?? []) as Array<{ source: string; target: string; sourceName: string; targetName: string }>;
  if (origins.length === 0) return null;
  const ids = uniq(origins.flatMap((o) => members.links[`${o.source}|${o.target}`] ?? []));
  const sources = Array.from(new Set(origins.map((o) => o.sourceName)));
  const targets = Array.from(new Set(origins.map((o) => o.targetName)));
  return { title: `${sources.join(" / ")} → ${targets.join(" / ")}`, prospectIds: ids, stepIndex: null };
}

