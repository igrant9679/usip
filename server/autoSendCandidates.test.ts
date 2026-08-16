/**
 * Auto-send must not let blocked drafts occupy its per-tick page.
 *
 * Found by a sweep for the 320072b shape. autoSendForAllWorkspaces took an
 * arbitrary 50 pending_review drafts (no ORDER BY) and then applied the
 * recipient-score gate in JS. A draft the gate refuses keeps its
 * pending_review status, so it is back next tick — the comment in that
 * function already recorded that unscored contacts "sat forever pending
 * review". Fifty of those fill the page permanently and auto-send stops for
 * every sendable draft behind them, invisibly: a tick that dispatches nothing
 * looks exactly like a tick with nothing to dispatch.
 *
 * The fix must keep the blocked COUNTS, because the cron summary exists to
 * say "you have 12 unscored contacts blocking auto-send". Source assertions —
 * the worker needs a live DB. Mutation-checked against the pre-fix source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "routers/sequences.ts"), "utf8");

const start = src.indexOf("export async function autoSendForAllWorkspaces");
const end = src.indexOf("\nexport ", start + 10);
// No end-of-file fallback: a missing anchor fails the boundary test instead of
// widening every assertion to this 2,000-line router.
const fn = src.slice(start, end);

describe("the auto-send page contains only sendable drafts", () => {
  it("the function boundary is where we think it is", () => {
    expect(start, "autoSendForAllWorkspaces moved — re-anchor").toBeGreaterThan(-1);
    expect(end, "no export follows — re-anchor").toBeGreaterThan(start);
    expect(fn).toContain("pending_review");
  });

  it("the score gate is part of the query, not a post-limit skip", () => {
    expect(fn).toContain("sendableGate");
    expect(fn).toMatch(/\.where\(\s*\n?\s*and\([\s\S]*sendableGate/);
  });

  it("the gate keeps lead-then-contact precedence, not COALESCE", () => {
    // COALESCE would fall through to the contact's score when a
    // lead-addressed draft has a null one. That is a different rule.
    expect(fn).toContain("CASE WHEN ${emailDrafts.toLeadId} IS NOT NULL");
    expect(fn).not.toMatch(/COALESCE\(\s*\$\{leads\.score\}/i);
  });

  it("the cold-outreach opt-in still decides how NULL scores are treated", () => {
    expect(fn).toContain("ws.aiAutoSendAllowUnscored");
    expect(fn).toMatch(/IS NULL OR \$\{recipientScoreExpr\} >= \$\{scoreMin\}/);
    expect(fn).toMatch(/IS NOT NULL AND \$\{recipientScoreExpr\} >= \$\{scoreMin\}/);
  });

  it("blocked drafts are still counted, over the whole workspace", () => {
    // The reason auto-send is stalled is the most useful thing this cron
    // knows. Filtering in SQL must not silently delete that signal.
    expect(fn).toContain("skippedNullScore +=");
    expect(fn).toContain("skippedLowScore +=");
    expect(fn).toMatch(/SUM\(CASE WHEN .*IS NULL/);
  });

  it("orders oldest-first so the queue is a queue", () => {
    expect(fn).toContain("orderBy(asc(emailDrafts.id))");
  });

  it("no longer re-decides the gate inside the loop", () => {
    // Leaving the old branches would double-count against the new aggregate.
    expect(fn).not.toMatch(/skippedNullScore\+\+/);
    expect(fn).not.toMatch(/skippedLowScore\+\+/);
  });

  it("does not re-query each recipient's score per draft", () => {
    expect(fn).not.toMatch(/select\(\{ score: leads\.score \}\)/);
    expect(fn).not.toMatch(/select\(\{ score: contacts\.relStrengthScore \}\)/);
  });
});
