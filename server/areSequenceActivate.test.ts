/**
 * Mass "Activate" on the Sequences tab (owner ask 2026-08-20: "mass activate
 * the generated sequence" from the Pending view).
 *
 * Activate = approve + enroll NOW — an approval that waits for the next cron
 * tick looks like a button that did nothing. But it is also the
 * outward-facing bulk action (enrolled step 1s dispatch on the next engine
 * cycle of an active campaign), and 2026-08-16 is what happens when that
 * consequence is not stated: 152 prospects bulk-approved on a misread. So
 * the wiring under test here is as much about the GUARDS and the confirm
 * copy as the happy path.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { BULK_ACTIONS } from "./routers/are/prospectsBulk";

const bulkSrc = readFileSync("server/routers/are/prospectsBulk.ts", "utf8");
const caseSrc = bulkSrc.slice(bulkSrc.indexOf('case "activateSequence"'), bulkSrc.indexOf('case "linkToPeople"'));
const page = readFileSync("client/src/pages/usip/ARECampaignDetail.tsx", "utf8");
const bar = readFileSync("client/src/components/usip/AreBulkActionBar.tsx", "utf8");

describe("activateSequence — wiring", () => {
  it("is a declared bulk action and the case block is where we think it is", () => {
    expect(BULK_ACTIONS).toContain("activateSequence");
    expect(caseSrc.length).toBeGreaterThan(0);
  });

  it("approves ONLY pending rows, through the single-row procedure", () => {
    // The bulk rule: nothing re-implemented. And approved rows are already
    // decided — re-approving them is what clobbered approval stamps on 08-17
    // (the procedure's COALESCE guards it, but not calling it is stricter).
    expect(caseSrc).toContain('if (r.sequenceStatus === "pending") await caller.are.prospects.approve({ prospectId: r.id })');
  });

  it("guards the non-activatable statuses and requires a generated sequence", () => {
    expect(caseSrc).toContain("already active (status");
    expect(caseSrc).toContain("not activatable from status");
    expect(caseSrc).toContain("no generated sequence — run Generate first");
  });

  it("enrolment is enrol-ONLY, bounded, gated on at least one row passing, and stops on a held lock", () => {
    // enrollOnly and never a full engine tick: dispatch from a user-initiated
    // request path is the browser-calls-complete-late hazard.
    expect(caseSrc).toContain("caller.are.engine.enrollOnly({ campaignId: input.campaignId })");
    expect(caseSrc).not.toContain("runOnce");
    expect(caseSrc).not.toContain("runEngine");
    expect(caseSrc).toContain("if (result.ok > 0)");
    expect(caseSrc).toContain("res.skippedInFlight");
    expect(caseSrc).toMatch(/for \(let pass = 0; pass < \d+; pass\+\+\)/);
  });

  it("reports the outcome from re-read statuses, excluding failed rows, and names the held ones", () => {
    // "Activated N" must be what happened, not what was asked: rows that
    // failed guards cannot count, and email-gate holds are said out loud.
    expect(caseSrc).toContain("const failedIds = new Set(result.failed.map((f) => f.id))");
    expect(caseSrc).toContain('okRows.filter((a) => a.status === "enrolled")');
    expect(caseSrc).toContain("held at enrolment");
  });

  it("the Sequences tab offers it under Pending/Approved with a consequence-naming confirm", () => {
    const fn = page.slice(page.indexOf("function sequenceTabActions"), page.indexOf("const REJECTION_TAB_ACTIONS"));
    expect(fn).toContain('key: "activateSequence"');
    expect(fn).toContain('title: "Activate sequences"');
    // The confirm body must state the outward consequence, not just rename it.
    expect(fn).toContain("step 1 emails start going out on the next engine cycle");
    expect(bar).toContain('"activateSequence"');
  });
});
