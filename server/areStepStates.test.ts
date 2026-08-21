/**
 * The Sequences tab's per-step progress must survive a queue with history.
 *
 * Owner report 2026-08-20: campaign 21 prospects two emails into their
 * sequences rendered as "0/7 sent · next: step 4 Sep 6". The tab read raw
 * getQueue rows with limit 200; the campaign holds 1,000+ rows (canceled
 * regeneration copies, failed no-email attempts, re-enrolled schedules), the
 * page was the 200 FUTURE-most by scheduledAt, and every SENT row — past
 * dates by definition — fell off it. The unfiltered-page-boundary class
 * (320072b, the day-12 LIMIT sweep) again; the fix is a reduction, not a
 * bigger limit: ONE representative row per (prospect, step), ranked
 * sent > scheduled > paused > failed > skipped, newest among equals.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { reduceStepStates } from "./routers/are/execution";

const R = (id: number, step: number, status: string, pq = 16106) => ({ id, prospectQueueId: pq, stepIndex: step, status });

describe("reduceStepStates", () => {
  it("Barbara's live shape: a sent step outranks its canceled copy, a scheduled step outranks its canceled copy", () => {
    // pq 16106 as measured 2026-08-20: step 1 sent 08-19 beside a skipped
    // regeneration copy; steps 2–6 scheduled beside skipped copies.
    const rows = [
      R(100, 0, "sent"),
      R(101, 1, "skipped"), R(102, 1, "sent"),
      R(103, 2, "skipped"), R(104, 2, "scheduled"),
      R(105, 3, "skipped"), R(106, 3, "scheduled"),
    ];
    const out = reduceStepStates(rows).sort((a, b) => a.stepIndex - b.stepIndex);
    expect(out.map((r) => r.status)).toEqual(["sent", "sent", "scheduled", "scheduled"]);
    expect(out.map((r) => r.id)).toEqual([100, 102, 104, 106]);
  });

  it("a scheduled row outranks a failed attempt — the live plan beats the dead try", () => {
    const out = reduceStepStates([R(1, 1, "failed"), R(2, 1, "scheduled")]);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("scheduled");
  });

  it("among equals the newest row wins (the current generation)", () => {
    const out = reduceStepStates([R(5, 1, "skipped"), R(9, 1, "skipped"), R(7, 1, "skipped")]);
    expect(out[0].id).toBe(9);
  });

  it("prospects do not bleed into each other", () => {
    const out = reduceStepStates([R(1, 0, "sent", 111), R(2, 0, "failed", 222)]);
    expect(out).toHaveLength(2);
  });

  it("an unknown status never beats a known one", () => {
    const out = reduceStepStates([R(1, 0, "bogus"), R(2, 0, "skipped")]);
    expect(out[0].status).toBe("skipped");
  });
});

describe("wiring", () => {
  const execution = readFileSync("server/routers/are/execution.ts", "utf8");
  const page = readFileSync("client/src/pages/usip/ARECampaignDetail.tsx", "utf8");
  const bar = readFileSync("client/src/components/usip/AreBulkActionBar.tsx", "utf8");

  it("getStepStates scans the campaign WITHOUT a limit — a limited scan is the truncation this replaces", () => {
    const proc = execution.slice(execution.indexOf("getStepStates: workspaceProcedure"), execution.indexOf("getQueue: workspaceProcedure"));
    expect(proc).toContain("reduceStepStates(rows)");
    expect(proc).not.toContain(".limit(");
    expect(proc).toContain("eq(areExecutionQueue.campaignId, input.campaignId)");
    expect(proc).toContain("eq(areExecutionQueue.workspaceId, ctx.workspace.id)");
  });

  it("the Sequences tab reads the reduction, not a raw page, and surfaces executedAt as the sent date", () => {
    const tab = page.slice(page.indexOf("function SequencesTab"), page.indexOf("function SequenceDrawer"));
    expect(tab).toContain("trpc.are.execution.getStepStates.useQuery({ campaignId })");
    expect(tab).not.toContain("are.execution.getQueue.useQuery");
    expect(tab).toContain("sentAt: e.executedAt");
  });

  it("both invalidation funnels cover the new query", () => {
    expect(page).toContain("utils.are.execution.getStepStates.invalidate({ campaignId })");
    expect(bar).toContain("utils.are.execution.getStepStates.invalidate()");
  });
});
