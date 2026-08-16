/**
 * The ARE enrollment page must not fill with rows it can never enrol.
 *
 * Sixth and last from the sweep for the 320072b shape, and the one the sweep
 * itself under-called: the first pass checked two of the loop's exits, found
 * both drained the row, and stopped reading. The third does not.
 *
 * Phase 3 selects `sequenceStatus = 'approved' AND generatedSequence IS NOT
 * NULL` LIMIT 10, no ORDER BY. Every exit in the loop changes the row —
 * idempotent re-sync sets `enrolled`, suppression sets `skipped` — except
 * `normalizeSequence(row.sequence).length === 0`, which was a bare `continue`.
 * That row stays approved with a non-null sequence, so it matches again next
 * tick. Ten of them is the entire per-campaign allowance, and the campaign
 * stops enrolling anyone, permanently.
 *
 * Source assertions (the engine needs a live DB), mutation-checked against the
 * pre-fix source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "areEngine.ts"), "utf8");

const start = src.indexOf("/* ── Phase 3: ENROLL");
const end = src.indexOf("/* ── Phase 4", start);
// No end-of-file fallback — a missing anchor must fail the boundary test
// rather than widening every assertion to the whole engine.
const phase = src.slice(start, end);

describe("phase 3 selects only enrollable rows", () => {
  it("the phase boundary is where we think it is", () => {
    expect(start, "Phase 3 marker moved — re-anchor").toBeGreaterThan(-1);
    expect(end, "Phase 4 marker moved — re-anchor").toBeGreaterThan(start);
    expect(phase).toContain("ENROLL_PER_CAMPAIGN_TICK");
  });

  it("excludes unusable sequences in SQL", () => {
    expect(phase).toMatch(/JSON_TYPE\(\$\{prospectIntelligence\.generatedSequence\}\) = 'ARRAY'/);
    expect(phase).toMatch(/JSON_LENGTH\(\$\{prospectIntelligence\.generatedSequence\}\) > 0/);
  });

  it("orders the page", () => {
    expect(phase).toContain("orderBy(prospectQueue.id)");
  });

  it("still reports the rows it excluded", () => {
    // Filtering them out of the page fixes the starvation and would otherwise
    // make them invisible — approved forever, never enrolled, no reason given.
    expect(phase).toMatch(/NOT \(JSON_TYPE/);
    expect(phase).toContain("no usable steps");
    expect(phase).toMatch(/emitLog\(wsId, campId, "enroll", "warn"/);
  });

  it("the zero-step branch drains the row instead of cycling it", () => {
    // Unreachable now, but it is the guard for SQL and normalizeSequence
    // disagreeing — and falling through would insert zero execution rows and
    // then mark the prospect enrolled.
    const branch = phase.slice(phase.indexOf("if (steps.length === 0)"));
    expect(branch).toContain('sequenceStatus: "skipped"');
    expect(branch).toContain("rejectionReason:");
    expect(branch.indexOf('sequenceStatus: "skipped"')).toBeLessThan(branch.indexOf("continue;"));
  });

  it("every exit from the enrol loop changes the row it examined", () => {
    // The property that was violated. A `continue` that leaves the row
    // matching the WHERE it came from is how a page silts up.
    const loop = phase.slice(phase.indexOf("for (const row of rows)"));
    const continues = loop.match(/\bcontinue;/g) ?? [];
    expect(continues.length).toBeGreaterThanOrEqual(3);
    // Each `continue` must be preceded by an update to prospectQueue.
    for (const seg of loop.split(/\bcontinue;/).slice(0, continues.length)) {
      expect(seg).toMatch(/\.update\(prospectQueue\)/);
    }
  });
});
