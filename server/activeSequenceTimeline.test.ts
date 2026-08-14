/**
 * The active sequence, visualised in the campaign's Sequences tab
 * (owner ask 2026-08-14).
 *
 * The steps were only visible behind a click into the side drawer, and even
 * there they were the STORED copy — what the sequence says, never where it has
 * got to. Live on campaign 21: one enrolled prospect (Lucas Grant, 7 steps)
 * with six execution rows scheduled 17–28 Aug and the opener already sent.
 * That progress existed and was shown nowhere.
 *
 * The one thing worth guarding is the JOIN. Step indices in this codebase have
 * already been derived twice and disagreed — the opener's A/B card rendered
 * empty beside a phantom cell because of exactly that. So the timeline must use
 * the shared rule, not its own.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stepIndexOf } from "@shared/areSequenceSteps";

const timeline = readFileSync("client/src/components/usip/are/ActiveSequenceTimeline.tsx", "utf8");
const page = readFileSync("client/src/pages/usip/ARECampaignDetail.tsx", "utf8");

describe("it joins on the shared step-index rule", () => {
  it("imports stepIndexOf rather than deriving an index", () => {
    expect(timeline).toContain('from "@shared/areSequenceSteps"');
    expect(timeline).toContain("stepIndexOf(raw, pos)");
    // No local re-derivation of the same number.
    expect(timeline).not.toMatch(/stepIndex\s*\?\?\s*\w+\.step\s*\?\?/);
  });

  it("the shared rule is what the execution queue also keys on", () => {
    // Engine shape, legacy seed shape, and positional fallback.
    expect(stepIndexOf({ stepIndex: 3 }, 0)).toBe(3);
    expect(stepIndexOf({ step: 2 }, 0)).toBe(2);
    expect(stepIndexOf({}, 5)).toBe(5);
  });
});

describe("it shows where the sequence actually is", () => {
  it("distinguishes every execution state", () => {
    for (const st of ["sent", "scheduled", "paused", "failed", "skipped"]) {
      expect(timeline, st).toContain(`${st}:`);
    }
  });

  it("names the NEXT step by earliest scheduled time, not array order", () => {
    expect(timeline).toContain('e.status === "scheduled" && e.scheduledAt');
    expect(timeline).toContain("new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime()");
  });

  it("counts sent against total steps", () => {
    expect(timeline).toContain('exec.filter((e) => e.status === "sent").length');
    expect(timeline).toContain("{sent}/{steps.length} sent");
  });

  it("treats a step with no execution row as pending, not broken", () => {
    // Enrolled-but-not-yet-scheduled is a real state.
    expect(timeline).toContain('(row?.status ?? "scheduled")');
  });
});

describe("it is mounted where the owner asked", () => {
  it("renders inline on active rows in the Sequences tab", () => {
    expect(page).toContain("<ActiveSequenceTimeline");
    expect(page).toContain('const isActive = r.sequenceStatus === "enrolled" || r.sequenceStatus === "paused";');
    expect(page).toContain("{isActive && hasSeq && (");
  });

  it("fetches the execution queue ONCE for the campaign, not per row", () => {
    expect(page).toContain("trpc.are.execution.getQueue.useQuery({ campaignId, limit: 200 })");
    expect(page).toContain("execByProspect");
  });
});
