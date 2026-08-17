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
  // The verdict became three-valued on 2026-08-16 (`completed` | `abandoned`
  // | null) — see the second-failure note in sequenceCompletion.ts. The
  // pre-existing cases below keep their meaning exactly; only the vocabulary
  // moved: false → null, true → "completed".
  it("never completes a prospect with no execution rows", () => {
    expect(sequenceCompletionVerdict({ total: 0, stillScheduled: 0, sent: 0, healableFailed: 0 })).toBeNull();
  });

  it("never completes while steps are still scheduled", () => {
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 1, sent: 3, healableFailed: 0 })).toBeNull();
  });

  it("THE LOCKOUT CASE: zero sends + revivable steps is NOT finished", () => {
    // Campaign 13's exact shape: every email step failed no-email, nothing
    // sent. Completing this is what disarmed the heal.
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 0, healableFailed: 4 })).toBeNull();
    // Boundary: a single revivable step is enough to keep it open.
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 0, healableFailed: 1 })).toBeNull();
  });

  it("a sequence that actually sent completes normally", () => {
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 2, healableFailed: 0 })).toBe("completed");
    // Even with healable failures alongside: it RAN; later failures are its
    // history, not grounds to reopen it here (the enrolled-arm heal still
    // retries pool failures on live sequences).
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 1, healableFailed: 2 })).toBe("completed");
  });

  it("zero sends with NOTHING revivable completes — waiting would watch for a recovery that cannot happen", () => {
    // e.g. every step was a LinkedIn step the v1 engine cannot send.
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 0, healableFailed: 0 })).toBe("completed");
  });

  it("THE SECOND FAILURE: one sent, six skipped is ABANDONED, not completed", () => {
    // 2026-08-16: 141 sequences canceled for regeneration and never
    // re-enrolled (the enrol guard counted skipped rows as enrolment). Zero
    // scheduled, one sent, six skipped — the old rule called every one of
    // them finished. 112 prospects "completed" a fourteen-day cadence in an
    // afternoon.
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 1, healableFailed: 0, skipped: 6 })).toBe("abandoned");
    // All skipped, nothing sent: same verdict.
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 0, healableFailed: 0, skipped: 7 })).toBe("abandoned");
  });

  it("a few skips inside a sequence that mostly ran is still completed", () => {
    // Suppression or a throttle skipping two of seven while five sent: the
    // prospect received the cadence. Abandoned means cut short, not imperfect.
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 5, healableFailed: 0, skipped: 2 })).toBe("completed");
    // Boundary — equal counts are NOT abandoned; skipped must EXCEED sent.
    expect(sequenceCompletionVerdict({ total: 6, stillScheduled: 0, sent: 3, healableFailed: 0, skipped: 3 })).toBe("completed");
  });

  it("omitting `skipped` behaves as before (older callers keep compiling and keep their answer)", () => {
    expect(sequenceCompletionVerdict({ total: 7, stillScheduled: 0, sent: 1, healableFailed: 0 })).toBe("completed");
  });
});

describe("the enrol guard counts LIVE rows, not history", () => {
  // The other half of the second failure. Phase 3's idempotency check
  // counted ALL execution rows, so a canceled-then-re-approved prospect
  // (every old step `skipped`) read as already enrolled: status flipped,
  // no new rows minted, and the sweep above then called it done.
  const engine = readFileSync(join(__dirname, "areEngine.ts"), "utf8");
  const start = engine.indexOf("/* ── Phase 3: ENROLL");
  const end = engine.indexOf("/* ── Phase 4", start);
  const phase = engine.slice(start, end);

  it("the phase boundary is where we think it is", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("the idempotency count is restricted to scheduled|sent", () => {
    const guard = phase.slice(phase.indexOf("Idempotency"), phase.indexOf("continue;", phase.indexOf("Idempotency")));
    expect(guard).toContain('inArray(areExecutionQueue.status, ["scheduled", "sent"])');
  });

  it("the completion sweep writes `canceled` for an abandoned verdict, with a reason", () => {
    const sweep = engine.slice(engine.indexOf("/* ── Phase 5: COMPLETE"), engine.indexOf("/* ── Phase 6"));
    expect(sweep).toContain('verdict === "abandoned"');
    expect(sweep).toContain('sequenceStatus: "canceled"');
    expect(sweep).toContain("Sequence cut short");
    expect(sweep).toContain("skipped: Number(c?.skipped ?? 0)");
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
