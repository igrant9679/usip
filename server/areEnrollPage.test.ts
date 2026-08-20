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

const start = src.indexOf("export async function enrollApprovedForCampaign");
const end = src.indexOf("\nasync function tickCampaign", start);
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

  it("enrolment RESUMES a partly-sent sequence instead of restarting it", () => {
    // 2026-08-17: 112 prospects with step 1 delivered were about to be
    // handed step 1 again, with the whole cadence re-anchored to today.
    expect(phase).toContain('eq(areExecutionQueue.status, "sent")');
    expect(phase).toContain("const sentIdx = new Set(priorSends.map((r) => r.stepIndex))");
    expect(phase).toContain("steps.filter((s) => !sentIdx.has(s.stepIndex))");
  });

  it("anchors remaining steps to the FIRST send on the campaign's cadence grid, never in the past", () => {
    expect(phase).toContain("const anchor = firstSendMs ?? now");
    // 0169: the campaign owns the cadence; 0170: a per-prospect timeline
    // override wins when set. Both flow through the shared rules
    // (dayOffsetForPosition picks the day, dueAtForDay floors at now) — never
    // the generated sequence's own dayOffset.
    expect(phase).toContain("dueAtForDay(anchor, dayOffsetForPosition(dayOffsets, positionOf.get(s.stepIndex) ?? 0, gapDays), now)");
    expect(phase).toContain("sanitizeDayOffsets(row.cadence)");
    expect(phase).not.toContain("anchor + s.dayOffset");
  });

  it("the email gate holds email-needing prospects in SQL, and still reports them", () => {
    // Owner decision 2026-08-20: an email-less prospect whose sequence has an
    // email step is NOT enrolled — the row stays approved until enrichment
    // lands an address. The gate must be in the WHERE (a loop `continue`
    // would starve the page, the exact 320072b shape this file exists for),
    // and the held rows must be counted into the campaign log, not vanish.
    expect(phase).toMatch(/JSON_SEARCH\(\$\{prospectIntelligence\.generatedSequence\}, 'one', 'email', NULL, '\$\[\*\]\.channel'\)/);
    // The normalizeSequence agreement arm: a step with NO channel key
    // defaults to email, so the SQL must catch those too.
    expect(phase).toMatch(/JSON_EXTRACT\(\$\{prospectIntelligence\.generatedSequence\}, '\$\[\*\]\.channel'\)/);
    expect(phase).toContain("waiting for an email address");
    // The gate holds rows back; it must NOT change their status — approved is
    // what re-admits them when the address arrives.
    const gateLog = phase.slice(phase.indexOf("waitingEmail"), phase.indexOf("waiting for an email address"));
    expect(gateLog).not.toContain('sequenceStatus: "skipped"');
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

describe("enrollOnly — enrolment separable from outreach", () => {
  // 2026-08-17: the only way to enrol partly-sent prospects on a paused
  // campaign was unpause → full tick → re-pause, from a browser session whose
  // calls could time out and complete LATE — twice leaving campaigns active
  // with nobody watching. Enrolment is bookkeeping; dispatch is outreach.
  const router = readFileSync(join(__dirname, "routers/are/engine.ts"), "utf8");
  const a = router.indexOf("enrollOnly: workspaceProcedure");
  const b = router.indexOf("\n});", a);
  const proc = router.slice(a, b);

  it("exists and is bounded", () => {
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });

  it("calls the ONE shared enrol implementation, not a copy", () => {
    expect(proc).toContain("await enrollApprovedForCampaign(campaign, result)");
    // tickCampaign uses the same function.
    const tick = src.slice(src.indexOf("async function tickCampaign"));
    expect(tick).toContain("await enrollApprovedForCampaign(campaign, result)");
  });

  it("does not filter on campaign status — a paused campaign is the point", () => {
    expect(proc).not.toMatch(/eq\(areCampaigns\.status/);
    expect(proc).not.toContain('"active"');
  });

  it("touches nothing but enrolment", () => {
    for (const forbidden of ["runAreEngine(", "tickCampaign(", "dispatch", "sendCampaignEmail", "runDiscovery", "runSequenceAgent", "runEnrichAgent"]) {
      expect(proc, `enrollOnly must not reach ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("scopes the campaign read to the workspace", () => {
    expect(proc).toContain("eq(areCampaigns.workspaceId, ctx.workspace.id)");
  });

  it("reports what remains so a caller can loop until done", () => {
    expect(proc).toContain("remainingApproved");
  });
});

describe("two concurrent enrol runs cannot double-enrol a prospect", () => {
  // 2026-08-17: Heather Daughtery got 12 scheduled rows for a 6-step
  // remainder — two enrollOnly calls 18s apart both read her as approved,
  // both passed the scheduled-rows guard before either inserted.
  it("enrolment takes a per-campaign lock", () => {
    expect(src).toContain("const enrollInFlight = new Set<number>()");
    const fn = src.slice(src.indexOf("export async function enrollApprovedForCampaign"), src.indexOf("async function enrollApprovedForCampaignUnlocked"));
    expect(fn).toContain("if (enrollInFlight.has(campId))");
    expect(fn).toContain("enrollInFlight.add(campId)");
    expect(fn).toMatch(/finally \{\s*enrollInFlight\.delete\(campId\)/);
  });

  it("a lock-skip is reported, not silent", () => {
    // A caller looping until enrolled===0 must not read a lock-skip as done.
    expect(src).toContain("result.enrolSkippedInFlight = (result.enrolSkippedInFlight ?? 0) + 1");
    const router = readFileSync(join(__dirname, "routers/are/engine.ts"), "utf8");
    expect(router).toContain("skippedInFlight: (result.enrolSkippedInFlight ?? 0) > 0");
  });
});
