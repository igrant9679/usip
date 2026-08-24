/**
 * Phase 7's queue cap must count the WORKING set, not all-time rows.
 *
 * Owner decision 2026-08-24. Before this, the discovery gate compared an
 * unfiltered count(*) against `targetProspectCount`, so rejected rows
 * (sequenceStatus='skipped' — reject/bulkReject/auto-screen all use that
 * vocabulary) permanently occupied queue headroom: all three live CF
 * campaigns read 101–105/100 with 23–28 rejected rows each, and discovery
 * skipped every tick, forever. Rejecting a prospect must FREE their slot.
 *
 * Source assertions (the engine needs a live DB), same shape as
 * areEnrollPage.test.ts, mutation-checked against the pre-fix source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "areEngine.ts"), "utf8");

const start = src.indexOf("Phase 7: DISCOVERY");
const end = src.indexOf("\nasync function runDiscovery", start);
// No end-of-file fallback — a missing anchor must fail the boundary test
// rather than widening every assertion to the whole engine.
const phase = src.slice(start, end);

describe("phase 7 counts only working rows against targetProspectCount", () => {
  it("the phase boundary is where we think it is", () => {
    expect(start, "Phase 7 marker moved — re-anchor").toBeGreaterThan(-1);
    expect(end, "runDiscovery marker moved — re-anchor").toBeGreaterThan(start);
    expect(phase).toContain("targetProspectCount");
  });

  it("the gate compares the non-rejected count, not count(*)", () => {
    expect(phase).toMatch(
      /sum\(case when \$\{prospectQueue\.sequenceStatus\} <> 'skipped' then 1 else 0 end\)/,
    );
    expect(phase).toContain("working < campaign.targetProspectCount");
    // The old shape must be gone: an unfiltered count(*) SELECT in this
    // phase is the bug returning under a new variable name. (Matched in its
    // drizzle sql-template form so prose in comments doesn't trip it.)
    expect(phase).not.toContain("sql<number>`count(*)`");
  });

  it("the skip log still accounts for the excluded rows", () => {
    // Excluding rejected rows from the cap without saying so would make
    // "queue full (100/100)" unexplainable next to a Prospects tab showing
    // 128 rows — the log must carry both numbers.
    expect(phase).toMatch(
      /sum\(case when \$\{prospectQueue\.sequenceStatus\} = 'skipped' then 1 else 0 end\)/,
    );
    expect(phase).toContain("rejected row");
    expect(phase).toContain("excluded");
  });
});
