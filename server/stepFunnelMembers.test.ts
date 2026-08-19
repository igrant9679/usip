/**
 * Sankey sections → the people behind them (owner ask 2026-08-19).
 *
 *  - computeStepFunnel records, in the SAME pass that counts, which prospects
 *    sit behind every node and every link — so a click lists exactly what the
 *    band counted.
 *  - layerFunnel carries each band's original endpoints (a lane hop may carry
 *    several), and selectionFor resolves a clicked node/band to those ids.
 */
import { describe, it, expect } from "vitest";
import { computeStepFunnel } from "./services/performanceMetrics";
import { layerFunnel, selectionFor } from "@/components/usip/are/stepFunnelLayering";

// Three prospects: 101 opened step 0 then got step 1 and replied; 102 did not
// open step 0 and got nothing more; 103 opened step 0 and stopped there.
const sends = [
  { prospectQueueId: 101, stepIndex: 0, openedAt: new Date("2026-08-16"), trackingToken: "t1" },
  { prospectQueueId: 101, stepIndex: 1, openedAt: null, trackingToken: "t2" },
  { prospectQueueId: 102, stepIndex: 0, openedAt: null, trackingToken: "t3" },
  { prospectQueueId: 103, stepIndex: 0, openedAt: new Date("2026-08-16"), trackingToken: "t4" },
];
const signals = [{ prospectQueueId: 101, signalType: "email_reply" }];

describe("computeStepFunnel members", () => {
  const f = computeStepFunnel(sends, signals);
  it("every node knows its people, and the counts are the member counts", () => {
    expect(f.members.nodes["step:0"]).toEqual([101, 102, 103]);
    expect(f.members.nodes["opened:0"]).toEqual([101, 103]);
    expect(f.members.nodes["unopened:0"]).toEqual([102]);
    expect(f.members.nodes["step:1"]).toEqual([101]);
    expect(f.members.nodes["replied"]).toEqual([101]);
    expect(f.members.nodes["dormant"]).toEqual([102, 103]);
    for (const n of f.nodes) expect(f.members.nodes[n.id]?.length ?? 0).toBe(n.value);
  });
  it("every link knows its people, and the counts are the member counts", () => {
    expect(f.members.links["opened:0|step:1"]).toEqual([101]);
    expect(f.members.links["opened:0|dormant"]).toEqual([103]);
    expect(f.members.links["unopened:0|dormant"]).toEqual([102]);
    for (const l of f.links) expect(f.members.links[`${l.source}|${l.target}`]?.length ?? 0).toBe(l.value);
  });
});

describe("selectionFor", () => {
  const f = computeStepFunnel(sends, signals);
  const laid = layerFunnel(f as never);
  it("a real node → its people (a step also offers its message)", () => {
    const step0 = laid.nodes.findIndex((n) => n.id === "step:0");
    expect(selectionFor(f as never, { payload: laid.nodes[step0] }, "node")).toEqual({ title: "Step 1", prospectIds: [101, 102, 103], stepIndex: 0 });
    const opened0 = laid.nodes.findIndex((n) => n.id === "opened:0");
    expect(selectionFor(f as never, { payload: laid.nodes[opened0] }, "node")).toEqual({ title: "Opened step 1", prospectIds: [101, 103], stepIndex: null });
  });
  it("a pass-through lane node is not a thing to list", () => {
    const lane = laid.nodes.find((n) => n.passthrough);
    expect(lane).toBeTruthy();
    expect(selectionFor(f as never, { payload: lane }, "node")).toBeNull();
  });
  it("a band → the people on its original link; a lane hop → the union of the links it carries", () => {
    const direct = laid.links.find((l) => l.origins.length === 1 && l.origins[0].source === "opened:0" && l.origins[0].target === "step:1")!;
    expect(selectionFor(f as never, { payload: direct }, "link")).toEqual({ title: "Opened step 1 → Step 2", prospectIds: [101], stepIndex: null });
    // 103 left after opened:0 → dormant; that band is rerouted through a lane
    // across the Step 2 column and arrives at the terminal as a lane hop.
    const laneHop = laid.links.find((l) => laid.nodes[l.source].passthrough && laid.nodes[l.target].id === "dormant" && l.origins.some((o) => o.source === "opened:0"))!;
    expect(selectionFor(f as never, { payload: laneHop }, "link")).toEqual({ title: "Opened step 1 → No reply yet", prospectIds: [103], stepIndex: null });
  });
});
