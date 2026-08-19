/**
 * StepFunnelSankey — where the campaign's prospects actually went.
 *
 * The Step performance cards answer "how did step 2 do". This answers the
 * question they cannot: of the people who did NOT open step 1, how many
 * received step 2, and how many of those replied. Same two tables, same
 * attribution rule (`services/performanceMetrics.computeStepFunnel`), so the
 * chart and the cards below it can never disagree.
 *
 * Interactive: hover any band for the exact count and its share of the entry
 * width; click a step to read the message that step actually sent.
 *
 * Built on Recharts' Sankey (already a dependency — no new chart library).
 * Recharts addresses links by node INDEX, so the id-based links from the
 * server are resolved to indices here; a link naming a node that was never
 * emitted is dropped rather than rendered against the wrong node.
 *
 * LAYERING (2026-08-19). The server's graph has links that skip columns: a
 * prospect who left after step 1 flows from "Opened step 1" (column 1)
 * straight to "No reply yet" (the last column), and Recharts draws that as
 * one long band passing BEHIND the Step 2 column and across every band there
 * — the overlap the owner flagged. A Sankey is only readable when every band
 * spans exactly one column, so multi-column links are routed here through
 * invisible pass-through nodes, one per intermediate column: the band keeps
 * its width, colour and tooltip (origin → final), and simply travels straight
 * through the gap in each column it crosses instead of behind it.
 */
import { useMemo, useState } from "react";
import { ResponsiveContainer, Sankey, Tooltip, Layer, Rectangle } from "recharts";
import { Info } from "lucide-react";
import { layerFunnel, selectionFor } from "./stepFunnelLayering";

export interface FunnelNodeDto {
  id: string;
  name: string;
  kind: "step" | "opened" | "unopened" | "replied" | "meeting" | "dormant";
  stepIndex: number | null;
  value: number;
}
export interface FunnelLinkDto { source: string; target: string; value: number }
export interface StepFunnelDto {
  nodes: FunnelNodeDto[];
  links: FunnelLinkDto[];
  totalProspects: number;
  opensTracked: boolean;
  /** Who is behind each node / link ("source|target") — prospect_queue ids. */
  members?: { nodes: Record<string, number[]>; links: Record<string, number[]> };
}

/** What a click on any section resolves to: the people it counted. */
export interface FunnelSelection {
  title: string;
  prospectIds: number[];
  /** Set when the section is a step, so the list can also offer that step's message. */
  stepIndex: number | null;
}

/** One colour per kind, so a band's meaning is readable without the legend. */
const KIND_COLOR: Record<FunnelNodeDto["kind"], string> = {
  step: "#6366F1",      // indigo — a dispatch
  opened: "#34D399",    // green — engagement
  unopened: "#94A3B8",  // slate — silence, not failure
  replied: "#F59E0B",   // amber — a human answered
  meeting: "#10B981",   // emerald — the outcome the product optimises for
  dormant: "#64748B",   // muted — still in flight or simply quiet
};

const KIND_LABEL: Record<FunnelNodeDto["kind"], string> = {
  step: "Dispatched",
  opened: "Opened",
  unopened: "Not opened",
  replied: "Replied",
  meeting: "Meeting booked",
  dormant: "No reply yet",
};

export type ChartNode = {
  /** Server node id (absent on pass-through lanes). */
  id?: string;
  name: string; kind: FunnelNodeDto["kind"]; stepIndex: number | null; total: number;
  /** Invisible routing node for a link that would otherwise skip columns. */
  passthrough?: boolean;
  /** For a pass-through: the real endpoints, for the tooltip. */
  origin?: string; final?: string;
};

function SankeyNode(props: any) {
  const { x, y, width, height, payload } = props;
  const node = payload as ChartNode & { value: number };
  const color = KIND_COLOR[node.kind] ?? "#64748B";
  // A pass-through is routing, not a thing that happened: no label, no
  // click, and it is painted at the BAND's opacity so the lane reads as one
  // continuous band through the column rather than a band with a notch.
  if (node.passthrough) {
    return (
      <Layer>
        <Rectangle x={x} y={y} width={width} height={height} fill={color} fillOpacity={0.28} style={{ pointerEvents: "none" }} />
      </Layer>
    );
  }
  // Every real node lists its people on click (handled at the chart level).
  return (
    <Layer>
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={height}
        fill={color}
        fillOpacity={0.9}
        radius={2}
        style={{ cursor: "pointer" }}
      />
      <text
        x={x + width + 6}
        y={y + height / 2}
        textAnchor="start"
        dominantBaseline="middle"
        className="fill-foreground"
        style={{ fontSize: 11, pointerEvents: "none" }}
      >
        {node.name}
      </text>
      <text
        x={x + width + 6}
        y={y + height / 2 + 12}
        textAnchor="start"
        dominantBaseline="middle"
        className="fill-muted-foreground"
        style={{ fontSize: 10, pointerEvents: "none" }}
      >
        {node.value.toLocaleString()}
      </text>
    </Layer>
  );
}

function SankeyLink(props: any) {
  const { sourceX, targetX, sourceY, targetY, sourceControlX, targetControlX, linkWidth, index, payload } = props;
  const kind: FunnelNodeDto["kind"] = payload?.target?.kind ?? "step";
  const color = KIND_COLOR[kind] ?? "#64748B";
  return (
    <path
      key={`link-${index}`}
      d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      stroke={color}
      strokeWidth={Math.max(1, linkWidth)}
      strokeOpacity={0.28}
      fill="none"
      style={{ cursor: "pointer" }}
    />
  );
}

export function StepFunnelSankey({
  funnel,
  onSelectStep,
  onSelectMembers,
}: {
  funnel: StepFunnelDto;
  /** Legacy: read a step's message. Still offered from inside the members list. */
  onSelectStep?: (stepIndex: number | null) => void;
  /** Any node or band → the people it counted. */
  onSelectMembers?: (sel: FunnelSelection) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const data = useMemo(() => layerFunnel(funnel), [funnel]);

  if (data.nodes.length === 0 || data.links.length === 0) return null;

  // Height scales with the number of REAL nodes (pass-throughs are routing).
  const realNodes = data.nodes.filter((n) => !n.passthrough).length;
  const height = Math.max(280, Math.min(760, realNodes * 46));
  const kindsPresent = Array.from(new Set(funnel.nodes.map((n) => n.kind)));

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h3 className="text-sm font-semibold">Where prospects went</h3>
        <span className="text-xs text-muted-foreground">
          {funnel.totalProspects.toLocaleString()} prospect{funnel.totalProspects === 1 ? "" : "s"} with at least one dispatched step
        </span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Each band is a real count of people, not a rate. A prospect leaves the flow at their last send — into{" "}
        <strong>Replied</strong> if anything came back, otherwise into <strong>No reply yet</strong>, which includes
        everyone still mid-sequence. Click any band or box to list the people in it.
      </p>

      {!funnel.opensTracked && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          <Info className="size-3.5 mt-0.5 shrink-0" />
          <span>
            No send in this campaign carries a tracking pixel, so the opened / not-opened split cannot be drawn. Every
            prospect is shown on the unopened side — that is missing instrumentation, not disengagement.
          </span>
        </div>
      )}

      <div style={{ width: "100%", height }} onMouseLeave={() => setHovered(null)}>
        <ResponsiveContainer width="100%" height="100%">
          <Sankey
            data={data}
            nodePadding={26}
            nodeWidth={12}
            margin={{ top: 8, right: 150, bottom: 8, left: 8 }}
            link={<SankeyLink />}
            node={<SankeyNode />}
            onClick={(el: any, type: "node" | "link") => {
              const sel = selectionFor(funnel, el, type);
              if (!sel) return;
              if (onSelectMembers) onSelectMembers(sel);
              else if (sel.stepIndex !== null && onSelectStep) onSelectStep(sel.stepIndex);
            }}
          >
            <Tooltip
              content={({ payload }) => {
                const p = payload?.[0]?.payload;
                if (!p) return null;
                if (p.passthrough) return null;
                // Link payloads carry source/target; node payloads do not.
                const isLink = !!p.source && !!p.target && typeof p.value === "number";
                const pct = funnel.totalProspects > 0
                  ? Math.round((Number(p.value) / funnel.totalProspects) * 100)
                  : 0;
                return (
                  <div className="rounded-md border bg-popover px-2.5 py-1.5 shadow-md text-xs">
                    {isLink ? (
                      <>
                        <div className="font-medium">
                          {p.source?.passthrough ? "Still heading to" : `${p.source?.name} →`} {(p.target?.passthrough ? p.target.final : p.target?.name)}
                        </div>
                        <div className="text-muted-foreground tabular-nums">
                          {Number(p.value).toLocaleString()} prospect{Number(p.value) === 1 ? "" : "s"} · {pct}% of all
                        </div>
                        <div className="text-muted-foreground mt-0.5">Click to list these people</div>
                      </>
                    ) : (
                      <>
                        <div className="font-medium">{p.name}</div>
                        <div className="text-muted-foreground tabular-nums">
                          {Number(p.value ?? p.total ?? 0).toLocaleString()} prospect
                          {Number(p.value ?? p.total ?? 0) === 1 ? "" : "s"}
                        </div>
                        <div className="text-muted-foreground mt-0.5">Click to list these people</div>
                      </>
                    )}
                  </div>
                );
              }}
            />
          </Sankey>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        {kindsPresent.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-2.5 rounded-sm" style={{ backgroundColor: KIND_COLOR[k] }} />
            {KIND_LABEL[k]}
          </span>
        ))}
      </div>
      {hovered ? <span className="sr-only">{hovered}</span> : null}
    </div>
  );
}
