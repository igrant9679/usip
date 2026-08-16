/**
 * The daily LinkedIn change-check must spend its budget on STALE records.
 *
 * Found by a sweep for the 320072b shape (SQL LIMIT applied before an in-JS
 * filter, no ORDER BY). This worker read `where workspaceId` + LIMIT 250 with
 * no ordering, then skipped — in JS — anything checked within 24h and anything
 * belonging to a rejected prospect. Fresh records are the overwhelming
 * majority, so the budget went to rows that were about to be discarded, and
 * the unordered page made it permanent: the same arbitrary 250 come back every
 * run, so a stale record outside that window is not late, it is unreachable.
 *
 * These are source assertions because the worker needs a live DB and Unipile.
 * Each one is mutation-checked against the pre-fix source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");
const src = readFileSync(join(ROOT, "server/services/linkedinEnrichment/dailyCheck.ts"), "utf8");

// Anchored to the one function, not the file: a sibling test in this repo
// silently widened its scope by slicing to the end of an array.
const start = src.indexOf("export async function runDailyCheckForWorkspace");
const end = src.indexOf("export async function runDailyCheckAllWorkspaces", start);
// No `?? end-of-file` fallback on purpose. A missing end anchor must fail the
// boundary test below, not silently widen every assertion to the whole file —
// which is how the first draft of this very test passed while pointing at a
// function name that does not exist.
const fn = src.slice(start, end);

describe("the candidate query selects the set the run actually wants", () => {
  it("the function boundary is where we think it is", () => {
    expect(start, "runDailyCheckForWorkspace moved — re-anchor").toBeGreaterThan(-1);
    expect(end, "runDailyCheckAllWorkspaces moved — re-anchor").toBeGreaterThan(start);
    // The next function's body must NOT be in scope.
    expect(fn).not.toContain("getLastDailyCheck");
  });

  it("staleness is a SQL predicate, not a post-limit skip", () => {
    expect(fn).toContain("lt(prospectLinkedinEnrichments.linkedinLastCheckedAt, staleBefore)");
    expect(fn).toContain("isNull(prospectLinkedinEnrichments.linkedinLastCheckedAt)");
  });

  it("suppression is a SQL predicate too", () => {
    // enrichmentBlockReason() is `verificationStatus === "rejected"`.
    expect(fn).toMatch(/ne\(\s*prospects\.verificationStatus,\s*"rejected"\s*\)/);
    expect(fn).toContain("isNull(prospects.verificationStatus)");
  });

  it("orders oldest-first so the budget lands on the stalest rows", () => {
    expect(fn).toContain("asc(prospectLinkedinEnrichments.linkedinLastCheckedAt)");
  });

  it("a forced run still bypasses the staleness predicate", () => {
    // Admin force must mean force. The predicate is spread in conditionally
    // rather than being dropped from the loop.
    expect(fn).toContain("...(opts.force ? [] : [or(");
  });

  it("the join does not reshape the row", () => {
    // With a join, a bare .select() makes drizzle nest results by table name
    // and every enr.<field> in the loop would read undefined — the exact
    // producer/consumer drift this codebase keeps re-finding.
    expect(fn).toContain("select(getTableColumns(prospectLinkedinEnrichments))");
    expect(fn).not.toMatch(/\.select\(\)\s*\n?\s*\.from\(prospectLinkedinEnrichments\)/);
  });

  it("no longer re-applies the staleness skip inside the loop", () => {
    // A refusal that can never fire reads like the filter still lives there.
    expect(fn).not.toContain("now - last < TWENTY_FOUR_H");
  });
});
