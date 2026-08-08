/**
 * The heal lockout, fixed from both ends.
 *
 * THE INCIDENT (2026-08-08, campaign 13, production): a campaign reactivated
 * after three weeks paused burned through ~126 overdue steps in an hour — 68
 * email steps failed "Prospect has no email address" — and the completion
 * sweep, whose only test was "no steps still scheduled", marked all 17
 * prospects `completed`. The self-heal exists for precisely those failed
 * steps (email found later → re-schedule), but it only considers `enrolled`
 * prospects, so completion disarmed it. Verified emails arrived the next day
 * via QuickEnrich and nothing would ever use them.
 *
 * Two ends, both covered here:
 *   FORWARD  — sequenceCompletionVerdict (pure, executed): a zero-send
 *              sequence holding revivable steps is not finished.
 *   BACKWARD — the heal reaches `completed` prospects with zero sent steps,
 *              and revives their status, repairing rows completed before the
 *              forward fix existed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HEALABLE_NO_EMAIL,
  HEALABLE_POOL_PREFIX,
  sequenceCompletionVerdict,
} from "./services/sequenceCompletion";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("sequenceCompletionVerdict — executed", () => {
  it("never completes a prospect with no execution rows", () => {
    expect(sequenceCompletionVerdict({ total: 0, stillScheduled: 0, sent: 0, healableFailed: 0 })).toBe(false);
  });

  it("never completes while steps are still scheduled", () => {
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 1, sent: 3, healableFailed: 0 })).toBe(false);
  });

  it("THE LOCKOUT CASE: zero sends + revivable steps is NOT finished", () => {
    // Campaign 13's exact shape: every email step failed no-email, nothing
    // sent. Completing this is what disarmed the heal.
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 0, healableFailed: 4 })).toBe(false);
    // Boundary: a single revivable step is enough to keep it open.
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 0, healableFailed: 1 })).toBe(false);
  });

  it("a sequence that actually sent completes normally", () => {
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 2, healableFailed: 0 })).toBe(true);
    // Even with healable failures alongside: it RAN; later failures are its
    // history, not grounds to reopen it here (the enrolled-arm heal still
    // retries pool failures on live sequences).
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 1, healableFailed: 2 })).toBe(true);
  });

  it("zero sends with NOTHING revivable completes — waiting would watch for a recovery that cannot happen", () => {
    // e.g. every step was a LinkedIn step the v1 engine cannot send.
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 0, healableFailed: 0 })).toBe(true);
  });
});

describe("one vocabulary for 'revivable'", () => {
  const engine = read("server/areEngine.ts");

  it("the failure-reason constants are the single definition", () => {
    expect(HEALABLE_NO_EMAIL).toBe("Prospect has no email address");
    expect(HEALABLE_POOL_PREFIX).toBe("Pool send failed:");
  });

  it("the engine's write site, heal, and completion all consume the constants", () => {
    // The heal and the completion sweep disagreeing about what "revivable"
    // means is how the lockout happened — a re-typed literal is the seed of
    // the next disagreement.
    expect(engine.includes("failureReason: HEALABLE_NO_EMAIL"), "the fail-site write re-types the literal").toBe(true);
    expect(engine.includes("eq(areExecutionQueue.failureReason, HEALABLE_NO_EMAIL)"), "the heal re-types the literal").toBe(true);
    expect(engine.includes("${HEALABLE_POOL_PREFIX}%"), "the heal's pool prefix is re-typed").toBe(true);
    expect(
      engine.includes('failureReason: "Prospect has no email address"'),
      "a literal write site survives beside the constant",
    ).toBe(false);
  });

  it("the pool service actually emits the prefix the heal matches", () => {
    // The prefix is produced in emailDelivery.ts and matched in the engine —
    // if the producer rewords it, pool failures silently stop healing.
    const delivery = read("server/emailDelivery.ts");
    expect(delivery.includes("Pool send failed: "), "emailDelivery no longer emits the healable prefix").toBe(true);
  });
});

describe("the heal reaches locked-out prospects (structural — engine execution needs a DB)", () => {
  const engine = read("server/areEngine.ts");
  const healStart = engine.indexOf("const healable = await db");
  const healEnd = engine.indexOf("step heal failed", healStart);
  const heal = engine.slice(healStart, healEnd);

  it("anchors found and the window is the heal block", () => {
    expect(healStart).toBeGreaterThan(-1);
    expect(healEnd).toBeGreaterThan(healStart);
    expect(heal.length).toBeGreaterThan(800);
  });

  it("considers completed prospects, gated on ZERO sent steps", () => {
    expect(heal.includes('eq(prospectQueue.sequenceStatus, "enrolled")'), "the enrolled arm vanished").toBe(true);
    /**
     * COUNTED, not merely found: "completed" appears at TWO sites — the
     * or-arm (the repair) and the flip-back's where (the scope). A mutation
     * of either was satisfied by the other under a bare includes(), the
     * ambiguous-anchor trap in its string form. Two is the contract; the
     * ordering below pins which is which.
     */
    const completedChecks = heal.split('eq(prospectQueue.sequenceStatus, "completed")').length - 1;
    expect(completedChecks, "expected the or-arm AND the flip-back scope to check 'completed'").toBe(2);
    const armAt = heal.indexOf('eq(prospectQueue.sequenceStatus, "completed")');
    const probeAt = heal.indexOf("sent_probe");
    expect(probeAt, "sent probe missing").toBeGreaterThan(-1);
    expect(armAt, "the or-arm must sit immediately before its zero-sent probe").toBeLessThan(probeAt);
    // The guard that keeps genuinely-finished sequences finished: a sequence
    // that ever sent anything is not revivable by this arm. Substring pins,
    // because the sql template's escaped backticks defeat a readable regex.
    expect(heal.includes("NOT EXISTS (SELECT 1 FROM"),
      "the zero-sent guard is gone — genuinely finished sequences can be resurrected").toBe(true);
    expect(heal.includes("sent_probe"), "the sent-probe subquery is gone").toBe(true);
    expect(heal.includes("= 'sent')"), "the probe no longer checks for sent status").toBe(true);
  });

  it("revives the prospect's status alongside its steps", () => {
    // Re-scheduling steps under a still-"completed" prospect dispatches under
    // a lying status and the completion sweep (enrolled-only) never
    // re-evaluates it.
    expect(heal.includes('.set({ sequenceStatus: "enrolled" })'), "the flip-back update is gone").toBe(true);
    expect(heal.includes('eq(prospectQueue.sequenceStatus, "completed"),'), "the flip-back must touch only completed rows").toBe(true);
  });

  it("the completion sweep consults the verdict, not a raw count comparison", () => {
    const at = engine.indexOf("Phase 5: COMPLETE");
    expect(at).toBeGreaterThan(-1);
    const block = engine.slice(at, at + 2200);
    expect(block.includes("sequenceCompletionVerdict("), "completion no longer uses the shared verdict").toBe(true);
    expect(block.includes("healableFailed"), "completion stopped counting revivable failures").toBe(true);
  });
});
