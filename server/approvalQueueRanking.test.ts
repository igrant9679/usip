/**
 * The ARE approval queue ranks by ICP FIT, with intent as the tiebreak.
 *
 * This list decides the order a human approves prospects in, and approval is
 * what sends mail. Until now it ordered by `icpMatchScore` alone — whether this
 * is the right KIND of person — while the enrichment pass's evidence that there
 * is a reason to reach out NOW (triggerEvents, painSignals) sat unread in
 * prospect_intelligence.
 *
 * 🔴 FIT REMAINS THE PRIMARY KEY, deliberately. Letting intent outrank fit
 * needs a weight — "an intent signal is worth N points of fit" — and there is
 * nothing in this codebase to derive N from. Inventing one to make the feature
 * look cleverer is the fabrication refused in 974b903. A tiebreak needs no
 * invented number and can never push a worse-fit prospect above a better-fit
 * one. It is not cosmetic either: icpMatchScore is an integer an LLM picks, and
 * those cluster on round numbers, so ties are the common case.
 *
 * The ordering lives in SQL because the query is PAGINATED — re-ranking the
 * rows after `.limit()` would only reorder the page you are looking at, and a
 * high-intent prospect on page 3 would never surface. So these are structural
 * assertions on the query, not a re-implementation of it: a TS copy of the
 * ranking rule would agree with itself forever while the shipped SQL drifted.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

const src = readFileSync(join(ROOT, "server/routers/are/prospects.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The `list` procedure only — the file has many other queries. */
const listProc = (() => {
  const at = src.indexOf("list: workspaceProcedure");
  expect(at, "list procedure not found — every assertion below would be vacuous").toBeGreaterThan(0);
  const end = src.indexOf("getIntelligence:", at);
  expect(end, "could not find the end of the list procedure").toBeGreaterThan(at);
  return src.slice(at, end);
})();

describe("the scanner has something to scan", () => {
  it("isolated the list procedure", () => {
    expect(listProc.length).toBeGreaterThan(500);
    expect(listProc).toContain("prospectQueue");
  });
});

describe("ordering", () => {
  it("orders by ICP fit FIRST, then intent", () => {
    const order = /\.orderBy\(([^;]*?)\)\s*\.limit/s.exec(listProc);
    expect(order, "no .orderBy(...).limit chain found").not.toBeNull();
    const clause = order![1];
    const fitAt = clause.indexOf("icpMatchScore");
    const intentAt = clause.indexOf("intentSignals");
    expect(fitAt, "fit is no longer part of the ordering").toBeGreaterThanOrEqual(0);
    expect(intentAt, "intent is not part of the ordering").toBeGreaterThanOrEqual(0);
    expect(
      fitAt,
      "\n\nIntent must not outrank ICP fit. Promoting it to the primary sort key\n" +
        "changes who gets mailed first, and needs a weight nothing in this repo\n" +
        "can justify. Keep fit first and intent as the tiebreak.\n",
    ).toBeLessThan(intentAt);
  });

  it("sorts both keys descending", () => {
    expect(listProc).toMatch(/desc\(\s*prospectQueue\.icpMatchScore\s*\)/);
    expect(listProc).toMatch(/desc\(\s*intentSignals\s*\)/);
  });

  it("ranks in SQL, before pagination", () => {
    // Not `rows.sort(...)` after the fact — that reorders one page.
    const orderAt = listProc.indexOf(".orderBy(");
    const limitAt = listProc.indexOf(".limit(");
    expect(orderAt).toBeGreaterThan(0);
    expect(orderAt).toBeLessThan(limitAt);
    expect(listProc).not.toMatch(/rows\.sort\(/);
  });
});

describe("the intent signal itself", () => {
  it("counts trigger events and pain signals", () => {
    expect(listProc).toContain("JSON_LENGTH");
    expect(listProc).toContain("triggerEvents");
    expect(listProc).toContain("painSignals");
  });

  it("excludes techStack and recentNews", () => {
    // techStack is FIT, not intent; recentNews is ambient company noise that is
    // often nothing to do with buying. Counting them would inflate the signal.
    const expr = /const intentSignals = sql<number>`([\s\S]*?)`;/.exec(listProc);
    expect(expr, "intentSignals expression not found").not.toBeNull();
    expect(expr![1]).not.toContain("techStack");
    expect(expr![1]).not.toContain("recentNews");
  });

  it("treats a missing intelligence row as 0 rather than NULL", () => {
    // A LEFT JOIN miss makes JSON_LENGTH NULL, and NULL sorts unpredictably.
    expect(listProc).toContain("COALESCE");
  });
});

describe("tenancy", () => {
  it("scopes the join on BOTH the queue id and the workspace", () => {
    const joinAt = listProc.indexOf(".leftJoin(");
    expect(joinAt, "the intelligence join is gone").toBeGreaterThan(0);
    const join = listProc.slice(joinAt, joinAt + 400);
    expect(join).toContain("prospectIntelligence.prospectQueueId");
    expect(
      join,
      "\n\nThe join must carry prospectIntelligence.workspaceId too. Joining a\n" +
        "name-bearing table on a bare id is the shape that leaked another\n" +
        "tenant's data through websiteVisits (24c720e).\n",
    ).toContain("prospectIntelligence.workspaceId");
  });
});

describe("the order is explainable in the UI", () => {
  const ui = readFileSync(join(ROOT, "client/src/pages/usip/ARECampaignDetail.tsx"), "utf8");

  it("renders the signal count the ranking uses", () => {
    // A reordered list with no visible reason is worse than an unordered one —
    // the user cannot tell a ranking change from a bug.
    expect(ui).toContain("intentSignals");
  });
});
