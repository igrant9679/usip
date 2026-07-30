/**
 * Sequence A/B variants: a counter nobody writes, and a promotion that acted on
 * it anyway.
 *
 * `sequenceAbVariants.openCount` and `replyCount` are written by NOTHING in this
 * codebase — only `sentCount` is, by the engine at draft creation. emailTracking
 * (opens/clicks) and inboundReplyPoller (replies) never touch the table, and they
 * could not: `emailDrafts` carries `stepIndex` but no reference to the VARIANT it
 * used, so an open or a reply cannot be attributed to one.
 *
 * autoPromoteAbWinners scored each variant as
 *   (replyCount / sentCount) * 100 + (openCount / sentCount) * 10
 * which is 0 for every variant when both counters are permanently 0. `score >
 * bestScore` is then never true, reduce() returns its seed, and the function
 * promoted `group[0]` — the FIRST VARIANT BY ARRAY ORDER — then set isWinner,
 * which makes its own "already promoted" check skip that group forever.
 *
 * So the A/B feature silently locked in an arbitrary variant, stopped
 * experimenting, and reported the result as a winner. Worse than not having it.
 *
 * It now declines when there is no signal, matching how the optimisation
 * analyzers behave on thin data. Real attribution needs a variant reference on
 * emailDrafts — a migration, and the user's call.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The scoring function as the router implements it, to reason about directly. */
function score(v: { sentCount: number; openCount: number; replyCount: number }): number {
  return v.sentCount > 0 ? (v.replyCount / v.sentCount) * 100 + (v.openCount / v.sentCount) * 10 : 0;
}

describe("the promotion scoring is degenerate without signal", () => {
  it("scores every variant 0 when open/reply counts are 0", () => {
    // This is the state the table is actually in: sentCount grows, the other two
    // never move.
    const a = { sentCount: 50, openCount: 0, replyCount: 0 };
    const b = { sentCount: 50, openCount: 0, replyCount: 0 };
    expect(score(a)).toBe(0);
    expect(score(b)).toBe(0);
  });

  it("a strict `>` comparison over equal scores returns the FIRST element", () => {
    // Demonstrates the bug precisely: with all scores equal, reduce keeps its
    // seed, so the "winner" was decided by array order.
    const group = [
      { label: "A", sentCount: 50, openCount: 0, replyCount: 0 },
      { label: "B", sentCount: 50, openCount: 0, replyCount: 0 },
    ];
    const winner = group.reduce((best, v) => (score(v) > score(best) ? v : best));
    expect(winner.label).toBe("A");
    // Reversing the input flips the "winner" — nothing about the data changed.
    expect([...group].reverse().reduce((best, v) => (score(v) > score(best) ? v : best)).label).toBe("B");
  });

  it("ranks correctly once real signal exists", () => {
    // The scoring itself is fine — it was the input that was always empty.
    const a = { sentCount: 100, openCount: 40, replyCount: 2 };
    const b = { sentCount: 100, openCount: 20, replyCount: 5 };
    expect(score(b)).toBeGreaterThan(score(a)); // replies weigh 10x opens
  });
});

describe("autoPromoteAbWinners declines without signal", () => {
  const src = stripComments(read("server/routers/sequences.ts"));

  it("checks for a non-zero open or reply count before promoting", () => {
    // Reads DERIVED stats now, not the counter columns — see abAttribution.test.ts.
    expect(src).toMatch(/hasSignal/);
    expect(src).toMatch(/st\.replies > 0 \|\| st\.opens > 0/);
  });

  it("skips the group rather than promoting a default", () => {
    const guard = src.slice(src.indexOf("hasSignal"));
    expect(guard.slice(0, 700)).toMatch(/if \(!hasSignal\)/);
    expect(guard.slice(0, 700)).toMatch(/continue;/);
  });

  it("the guard sits BEFORE the reduce that picks a winner", () => {
    // Ordering is the whole point — after the reduce it would not prevent
    // anything.
    expect(src.indexOf("hasSignal")).toBeLessThan(src.indexOf("group.reduce"));
  });
});

describe("variant sentCount is no longer a maintained counter", () => {
  it("the engine does not increment it at all", () => {
    /**
     * It briefly did — an atomic SQL increment replacing a JS read-modify-write
     * lost update — before the whole counter approach was reverted in favour of
     * deriving from email_drafts. Both versions were wrong for the same deeper
     * reason: the bump ran at draft CREATION, and a pending_review draft may
     * never send, so it credited sends that did not happen AND gated
     * minSendsForPromotion on them.
     *
     * See server/abAttribution.test.ts for the derived design.
     */
    const src = stripComments(read("server/sequenceEngine.ts"));
    expect(src).not.toMatch(/sentCount: chosenVariantCount \+ 1/);
    expect(src).not.toMatch(/sentCount: sql`\$\{sequenceAbVariants\.sentCount\} \+ 1`/);
  });
});
