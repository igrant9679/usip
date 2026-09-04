/**
 * The enrichment gate has to mean the same thing in both places that read it.
 *
 * enrichPendingGlobally spends LLM budget only on
 *   icpMatchScore >= COALESCE(minConfidence, ENRICH_MIN_CONFIDENCE_DEFAULT)
 *   OR icpMatchScore = 0
 * A row scored between 1 and the gate satisfies neither branch, so it is never
 * enriched, never reaches enrichmentStatus 'complete', and therefore is never
 * seen by the screen pass — it sits 'pending' forever with no reason recorded.
 * Measured on prod 2026-08-16: 44 of CommunityForce's 258 queued prospects,
 * and every enrichment-pending row across three active campaigns was in that
 * band while no eligible row was.
 *
 * The screen pass now rejects them. That makes the two predicates a matched
 * pair, and the failure mode if they drift is NOT symmetric: too-loose
 * rejection throws away prospects enrichment would have accepted. Hence the
 * shared constant, and hence this file.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "areEngine.ts"), "utf8");

const selStart = src.indexOf("async function enrichPendingGlobally");
const selEnd = src.indexOf("\nasync function tickCampaign", selStart);
const selector = src.slice(selStart, selEnd);

const screenStart = src.indexOf("/* ── Phase 1: SCREEN");
const screenEnd = src.indexOf("/* ── Phase 2", screenStart);
// The raw SQL lives in a template literal, so every identifier backtick is
// stored escaped (\`prospect_queue\`). Unescape once here so the assertions
// below read like the SQL they are about.
const screen = src.slice(screenStart, screenEnd).replace(/\\`/g, "`");

describe("the gate is defined once and read the same way twice", () => {
  it("the anchors are where we think they are", () => {
    expect(selStart, "enrichPendingGlobally moved — re-anchor").toBeGreaterThan(-1);
    expect(selEnd, "tickCampaign moved — re-anchor").toBeGreaterThan(selStart);
    expect(screenStart, "Phase 1 marker moved — re-anchor").toBeGreaterThan(-1);
    expect(screenEnd, "Phase 2 marker moved — re-anchor").toBeGreaterThan(screenStart);
  });

  it("the selector uses the shared constant, not a literal", () => {
    expect(selector).toContain("COALESCE(${areCampaigns.minConfidence}, ${ENRICH_MIN_CONFIDENCE_DEFAULT})");
    expect(selector).not.toMatch(/COALESCE\(\$\{areCampaigns\.minConfidence\},\s*\d+\)/);
  });

  it("an APPROVED row is admitted regardless of score — the human decision outranks the budget gate", () => {
    // ARE audit 2026-08-20: four owner-approved prospects at score 33 (gates
    // 35) sat approved/pending forever — invisible to this selector, while
    // phase 2 waited on dossiers that could never come. The gate exists to
    // protect enrichment spend from prospects we may never contact; a row a
    // human approved WILL be contacted and needs its dossier.
    expect(selector).toContain("OR ${prospectQueue.sequenceStatus} = 'approved'");
    // The screen pass's reject arm stays the complement for PENDING rows
    // only — approved rows in the below-gate band are enriched, not rejected.
    expect(screen).toContain("`sequenceStatus` = 'pending'");
  });

  it("human intent outranks fit in the queue order: approved, then pushed (score 0), then best score", () => {
    // 2026-09-04: seven pushed people (score 0) whose first enrichment hit
    // the AI rate limit sat "pending — will retry on the next pass" for an
    // hour while plain `score DESC` gave every tick's five slots to scored
    // discovery rows engine-wide. The promised retry was unreachable.
    expect(selector).toContain("CASE WHEN ${prospectQueue.sequenceStatus} = 'approved' THEN 2 WHEN ${prospectQueue.icpMatchScore} = 0 THEN 1 ELSE 0 END");
    expect(selector).not.toContain(".orderBy(desc(prospectQueue.icpMatchScore))");
    // Still bounded per tick, still serial.
    expect(selector).toContain(".limit(ENRICH_PER_TICK)");
  });

  it("the screen pass derives its gate from the same constant", () => {
    expect(screen).toContain("campaign.minConfidence ?? ENRICH_MIN_CONFIDENCE_DEFAULT");
    // No second opinion about what the default is.
    expect(screen).not.toMatch(/minConfidence\s*\?\?\s*\d+/);
  });

  it("rejects the exact complement of what the selector accepts", () => {
    // selector accepts: score >= gate OR score = 0
    // so the complement is: score > 0 AND score < gate — no boundary overlap,
    // and score 0 (legacy rows, always eligible) is never touched.
    expect(screen).toContain("`icpMatchScore` > 0");
    expect(screen).toContain("`icpMatchScore` < ${gate}");
    expect(screen).not.toMatch(/`icpMatchScore` <= \$\{gate\}/);
  });

  it("only touches rows enrichment has not finished with", () => {
    expect(screen).toContain("`enrichmentStatus` IN ('pending', 'enriching')");
    // 'complete' rows below the gate already have a path: AUTO_REJECT_FLOOR.
    // 'failed' rows are a SEPARATE population (36 on prod) and a separate
    // decision — deliberately out of scope here.
    expect(screen).not.toMatch(/enrichmentStatus` IN \([^)]*'failed'/);
  });

  it("only touches rows nobody has dispositioned", () => {
    expect(screen).toContain("`sequenceStatus` = 'pending'");
  });

  it("the UPDATE carries its tenant scope at the statement", () => {
    // Same rule tenantScope.test.ts enforces: a WHERE assembled from variables
    // reads as scoped whether or not it is, so a later edit can drop the
    // workspace predicate unnoticed.
    const upd = screen.slice(screen.indexOf("UPDATE `prospect_queue`"));
    expect(upd).toContain("`campaignId` = ${campId}");
    expect(upd).toContain("`workspaceId` = ${wsId}");
  });

  it("says why, in the row and in the campaign log", () => {
    // The whole point is that the old state was indistinguishable from
    // "we have not got to it yet".
    expect(screen).toContain("rejectionReason");
    expect(screen).toContain("below the enrichment gate");
    expect(screen).toMatch(/emitLog\(wsId, campId, "screen", "info"/);
  });
});
