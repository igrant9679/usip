/**
 * Step Performance shows one card per DISPATCHED message.
 *
 * Owner (2026-08-17): "It says 31 Step 1's were dispatched, so there should be
 * 31 Step 1 cards." The engine writes uniquely personalised copy per prospect,
 * so a step is 31 different messages, not one message 31 times. A single card
 * per step showed one specimen and no way to see the other 30.
 *
 * The invariant worth pinning is not the card count — it is that the
 * per-dispatch view can NEVER disagree with the aggregate and the Sankey
 * above it. Same two tables, same signal vocabulary, same last-touch rule.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const svc = readFileSync(join(__dirname, "services/performanceMetrics.ts"), "utf8");
const a = svc.indexOf("export async function getDispatchStats");
const b = svc.indexOf("/* ─── Sequence A/B variant performance", a);
const fn = svc.slice(a, b);

describe("getDispatchStats reads what the aggregate reads", () => {
  it("is bounded", () => {
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });

  it("selects only SENT rows from the execution queue, like getAbVariantStats", () => {
    expect(fn).toContain('eq(areExecutionQueue.status, "sent" as never)');
    expect(fn).toContain(".from(areExecutionQueue)");
  });

  it("credits replies and meetings from EXACTLY the aggregate's two signal types", () => {
    // computeVariantCells: `if (t !== "email_reply" && t !== "meeting_booked") continue;`
    // Widening this (linkedin_reply, sms_reply) puts a reply on a card the
    // Sankey does not show.
    expect(fn).toContain('const isReply = t === "email_reply"');
    expect(fn).toContain('const isMeeting = t === "meeting_booked"');
    // Asserted on CODE, not prose: the explanatory comment names the excluded
    // types, and a test that cannot tell a comment from a predicate fails on
    // its own documentation (same trap as the job-change placeholder test).
    const code = fn.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/=== "linkedin_reply"|=== "sms_reply"|startsWith\("reply"\)/);
  });

  it("uses last-touch attribution per prospect", () => {
    expect(fn).toContain("if (new Date(s.executedAt ?? 0).getTime() <= at) owner = s;");
  });

  it("carries the tracking-pixel fact so untracked sends do not read as unopened", () => {
    expect(fn).toContain("opensTracked: !!s.trackingToken");
  });

  it("returns one row per execution id — no aggregation", () => {
    expect(fn).toContain("executionId: Number(s.executionId)");
    expect(fn).not.toContain("computeVariantCells(");
  });
});

// 2026-09-03: the cards became rows of ONE table (owner: "a more visually
// efficient table view" — three cards to a row meant 27 rows of scrolling to
// compare two steps). The invariants below are unchanged: one row per
// dispatch, keyed by execution id, opening THAT message, under a step header
// that carries the aggregate.
describe("the tab renders one row per dispatch", () => {
  const page = readFileSync(join(__dirname, "../client/src/pages/usip/ARECampaignDetail.tsx"), "utf8");
  const tab = page.slice(page.indexOf('<TabsContent value="ab"'), page.indexOf('<TabsContent value="signals"'));

  it("queries the per-dispatch proc", () => {
    expect(page).toContain("trpc.are.prospects.getDispatches.useQuery({ campaignId })");
  });

  it("maps table rows over dispatches, keyed by execution id", () => {
    expect(tab).toContain("...items.map((d) => (");
    expect(tab).toContain("key={d.executionId}");
    expect(tab).toContain("<Table>");
    // The step header is a row of the same table, spanning every column.
    expect(tab).toContain("<TableCell colSpan={5}");
  });

  it("each row opens THAT message, not a step's newest specimen", () => {
    expect(tab).toContain("setPreviewExecId(d.executionId)");
    expect(tab).not.toContain("openStepPreview(v.stepIndex, v.variantKey)");
  });

  it("the step header still shows the aggregate so the roll-up is visible", () => {
    expect(tab).toContain("{items.length} dispatched");
    expect(tab).toContain("agg.replies} replied");
  });

  it("the Sankey is untouched", () => {
    expect(tab).toContain("<StepFunnelSankey funnel={stepFunnel}");
  });
});
