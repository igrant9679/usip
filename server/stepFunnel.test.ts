/**
 * The Step performance tab: a funnel you can follow, and stats that are true.
 *
 * Two things are under test, and the second one is why the first was asked for.
 *
 * 1. `computeStepFunnel` — per-PROSPECT journeys, not per-step counts. The
 *    cards answer "how did step 2 do"; this answers "of the people who did not
 *    open step 1, how many got step 2, and how many of those replied".
 *
 * 2. The seam that silently dropped two fields. `getAbVariantStats` SELECTed
 *    `openedAt` and `trackingToken`, `computeVariantCells` READ them, and the
 *    object literal between the two never copied them across — so `trackable`
 *    and `opens` were structurally always zero and every step card read
 *    "Opens: not tracked" no matter how many opens had been recorded. Nothing
 *    threw. The owner found it by noticing a step claiming untracked opens
 *    beside a Signals feed showing that very message opened (2026-08-14).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeStepFunnel,
  computeVariantCells,
  variantCellKey,
  type VariantSendRow,
  type VariantSignalRow,
} from "./services/performanceMetrics";

const metrics = readFileSync("server/services/performanceMetrics.ts", "utf8");
const page = readFileSync("client/src/pages/usip/ARECampaignDetail.tsx", "utf8");
const sankey = readFileSync("client/src/components/usip/are/StepFunnelSankey.tsx", "utf8");

function send(p: number, step: number, extra: Partial<VariantSendRow> = {}): VariantSendRow {
  return {
    prospectQueueId: p,
    stepIndex: step,
    variantKey: "A",
    executedAt: new Date(`2026-08-0${step + 1}T10:00:00Z`),
    trackingToken: "tok",
    openedAt: null,
    ...extra,
  };
}
const linkOf = (f: ReturnType<typeof computeStepFunnel>, s: string, t: string) =>
  f.links.find((l) => l.source === s && l.target === t)?.value ?? 0;

describe("the funnel follows people, not steps", () => {
  it("splits each step into opened and not-opened", () => {
    const f = computeStepFunnel(
      [send(1, 0, { openedAt: new Date() }), send(2, 0), send(3, 0)],
      [],
    );
    expect(linkOf(f, "step:0", "opened:0")).toBe(1);
    expect(linkOf(f, "step:0", "unopened:0")).toBe(2);
    expect(f.totalProspects).toBe(3);
  });

  it("carries a prospect from one step into the next through their branch", () => {
    // Opened step 1, then received step 2 — the band has to leave the OPENED
    // node, or the chart cannot answer "did opening change what happened next".
    const f = computeStepFunnel([send(1, 0, { openedAt: new Date() }), send(1, 1)], []);
    expect(linkOf(f, "opened:0", "step:1")).toBe(1);
    expect(linkOf(f, "step:0", "unopened:0")).toBe(0);
  });

  it("ends a prospect at their last send: replied, or not yet", () => {
    const replied: VariantSignalRow[] = [{ prospectQueueId: 1, signalType: "email_reply" }];
    const f = computeStepFunnel([send(1, 0), send(2, 0)], replied);
    expect(linkOf(f, "unopened:0", "replied")).toBe(1);
    expect(linkOf(f, "unopened:0", "dormant")).toBe(1);
  });

  it("carries a booked meeting past the reply", () => {
    const f = computeStepFunnel(
      [send(1, 0, { openedAt: new Date() })],
      [{ prospectQueueId: 1, signalType: "meeting_booked" }],
    );
    expect(linkOf(f, "opened:0", "replied")).toBe(1);
    expect(linkOf(f, "replied", "meeting")).toBe(1);
  });

  it("counts a meeting-without-reply as having answered", () => {
    // A prospect who books straight from the link never sends a reply. Ending
    // them in "No reply yet" would be false.
    const f = computeStepFunnel([send(1, 0)], [{ prospectQueueId: 1, signalType: "meeting_booked" }]);
    expect(linkOf(f, "unopened:0", "dormant")).toBe(0);
    expect(linkOf(f, "unopened:0", "replied")).toBe(1);
  });

  it("ignores signal types that are not an answer", () => {
    const f = computeStepFunnel([send(1, 0)], [{ prospectQueueId: 1, signalType: "email_open" }]);
    expect(linkOf(f, "unopened:0", "dormant")).toBe(1);
    expect(linkOf(f, "unopened:0", "replied")).toBe(0);
  });

  it("flows straight across a step a prospect never received", () => {
    const f = computeStepFunnel([send(1, 0), send(1, 2)], []);
    expect(linkOf(f, "unopened:0", "step:2")).toBe(1);
    expect(f.nodes.some((n) => n.id === "step:1")).toBe(false);
  });

  it("emits no link pointing at a node it did not emit", () => {
    // Recharts resolves links positionally — a dangling endpoint would attach
    // the band to whatever node happened to sit at that index.
    const f = computeStepFunnel(
      [send(1, 0, { openedAt: new Date() }), send(2, 0), send(2, 1)],
      [{ prospectQueueId: 1, signalType: "email_reply" }],
    );
    const ids = new Set(f.nodes.map((n) => n.id));
    for (const l of f.links) {
      expect(ids.has(l.source), l.source).toBe(true);
      expect(ids.has(l.target), l.target).toBe(true);
    }
  });

  it("conserves people: every step's outflow equals its inflow", () => {
    const sends = [
      send(1, 0, { openedAt: new Date() }), send(1, 1),
      send(2, 0), send(2, 1), send(2, 2),
      send(3, 0),
    ];
    const f = computeStepFunnel(sends, [{ prospectQueueId: 1, signalType: "email_reply" }]);
    for (const node of f.nodes.filter((n) => n.kind === "step")) {
      const out = f.links.filter((l) => l.source === node.id).reduce((n, l) => n + l.value, 0);
      expect(out, node.id).toBe(node.value);
    }
  });

  it("says so when nothing can report an open, instead of drawing 100% unopened", () => {
    const untracked = [send(1, 0, { trackingToken: null }), send(2, 0, { trackingToken: null })];
    const f = computeStepFunnel(untracked, []);
    expect(f.opensTracked).toBe(false);
    expect(f.nodes.find((n) => n.kind === "unopened")?.name).toMatch(/untracked/i);
    // …and the chart surfaces that rather than letting it read as disengagement.
    expect(sankey).toContain("opensTracked");
    expect(sankey).toMatch(/missing instrumentation, not disengagement/);
  });

  it("returns an empty funnel rather than throwing on no sends", () => {
    const f = computeStepFunnel([], []);
    expect(f.nodes).toEqual([]);
    expect(f.links).toEqual([]);
    expect(f.totalProspects).toBe(0);
  });
});

describe("the opens that were being thrown away", () => {
  it("counts an open and a trackable send when both are present", () => {
    const cells = computeVariantCells(
      [send(1, 0, { openedAt: new Date() }), send(2, 0)],
      [],
    );
    const c = cells.get(variantCellKey(0, "A"))!;
    expect(c.sent).toBe(2);
    expect(c.trackable).toBe(2);
    expect(c.opens).toBe(1);
  });

  it("reports untracked only when the send really carries no pixel", () => {
    const cells = computeVariantCells([send(1, 0, { trackingToken: null })], []);
    expect(cells.get(variantCellKey(0, "A"))!.trackable).toBe(0);
  });

  it("carries openedAt and trackingToken across the query-to-consumer seam", () => {
    // The regression: the SELECT fetched them, the consumer read them, and the
    // object literal in between quietly dropped both.
    const call = metrics.slice(metrics.indexOf("const cells = computeVariantCells("));
    const literal = call.slice(0, call.indexOf("signals.map("));
    expect(literal).toContain("openedAt:");
    expect(literal).toContain("trackingToken:");
  });

  it("the funnel query carries them too", () => {
    const fn = metrics.slice(metrics.indexOf("export async function getStepFunnel"));
    const literal = fn.slice(fn.indexOf("computeStepFunnel("), fn.indexOf("signals.map("));
    expect(literal).toContain("openedAt:");
    expect(literal).toContain("trackingToken:");
  });
});

describe("the tab lets you read the message", () => {
  it("opens a preview from a step card and from the funnel", () => {
    expect(page).toContain("AreMessageDialog");
    expect(page).toContain("openStepPreview");
    expect(page).toContain("onSelectStep={(i) => void openStepPreview(i)}");
    // A step is not a message — its most recent send has to be resolved first.
    expect(page).toContain("are.execution.findStepMessage.fetch");
  });

  it("opens a preview from a signal, but only when the signal names a message", () => {
    // Reply and meeting signals carry no executionQueueId, so those rows must
    // not pretend to be clickable.
    expect(page).toContain("const openable = !!s.executionQueueId && !!onOpen;");
    expect(page).toContain("onOpen={(id) => setPreviewExecId(id)}");
  });

  it("the preview separates human opens from machine prefetches", () => {
    const dialog = readFileSync("client/src/components/usip/are/AreMessageDialog.tsx", "utf8");
    expect(dialog).toContain("machineOpenCount");
    expect(dialog).toContain("Prefetches");
    // And it never claims an open count for a send that carries no pixel.
    expect(dialog).toContain("m.opensTracked ? m.openCount");
  });

  it("names the inbox a message went from, or says it wasn't recorded", () => {
    const dialog = readFileSync("client/src/components/usip/are/AreMessageDialog.tsx", "utf8");
    const emails = readFileSync("client/src/pages/usip/EmailsV2.tsx", "utf8");
    for (const f of [dialog, emails]) expect(f).toContain("Not recorded for this send");
    // The engine now stores the pool's choice instead of discarding it.
    const engine = readFileSync("server/areEngine.ts", "utf8");
    const success = engine.slice(engine.indexOf("if (sendRes.ok) {"));
    expect(success.slice(0, 1200)).toContain("sendingAccountId: sendRes.accountId");
    expect(success.slice(0, 1200)).toContain("fromEmail: sendRes.fromEmail");
  });
});
