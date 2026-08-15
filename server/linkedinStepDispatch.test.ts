/**
 * Wiring the LinkedIn channel into the ARE engine (owner ask 2026-08-15).
 *
 * Every non-email step was skipped with "Channel 'linkedin' not wired". On the
 * live campaigns that was 54 steps — 57 of campaign 13's 126, so a sequence
 * designed as a multi-channel cadence ran as email-only and roughly 45% of it
 * never happened.
 *
 * The reason it is safe to wire NOW and was not before is the activity gate
 * (migration 0167). Adding a second automated source of LinkedIn activity to
 * an account that already runs Social Autopilot, with no shared budget between
 * them, is how accounts get restricted — so the test that matters most here is
 * that no send path skips the gate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { toInviteNote, INVITE_NOTE_MAX, HEALABLE_NO_LINKEDIN } from "./services/are/linkedinStep";
import { sequenceCompletionVerdict } from "./services/sequenceCompletion";

const step = readFileSync("server/services/are/linkedinStep.ts", "utf8");
const engine = readFileSync("server/areEngine.ts", "utf8");
const execution = readFileSync("server/routers/are/execution.ts", "utf8");

describe("a connection note is not an email body", () => {
  it("passes short copy through untouched", () => {
    expect(toInviteNote("Hi Dana, quick question about your ops team.")).toBe("Hi Dana, quick question about your ops team.");
  });

  it("prefers ANY sentence boundary over a longer truncated line", () => {
    // Even an early break: a trailing "…" in a connection request is what an
    // automated request looks like to the recipient, and a short complete
    // thought reads as a person being brief.
    const body = "Hi Dana, I work with nonprofit ops teams. We just published a benchmark on grant throughput that I think would land well with your team, and I would love to share it plus hear how you are approaching this in the current funding climate.";
    const note = toInviteNote(body);
    expect(note.length).toBeLessThanOrEqual(INVITE_NOTE_MAX);
    expect(note.endsWith(".")).toBe(true);
    expect(note).not.toContain("…");
  });

  it("falls back to a word boundary with an ellipsis when there is no sentence break", () => {
    const note = toInviteNote("word ".repeat(120));
    expect(note.length).toBeLessThanOrEqual(INVITE_NOTE_MAX + 1);
    expect(note.endsWith("…")).toBe(true);
    expect(note).not.toMatch(/\s…$/); // no dangling space before the ellipsis
  });

  it("never exceeds the limit, on any input", () => {
    for (const body of ["", "x".repeat(5000), "a. ".repeat(400), "no-spaces" + "y".repeat(400)]) {
      expect(toInviteNote(body).length, JSON.stringify(body.slice(0, 12))).toBeLessThanOrEqual(INVITE_NOTE_MAX + 1);
    }
  });

  it("flattens the whitespace an email body carries", () => {
    expect(toInviteNote("Hi Dana,\n\nQuick   question.\n")).toBe("Hi Dana, Quick question.");
  });
});

describe("nothing reaches LinkedIn without passing the gate", () => {
  it("checks before every send, and records after", () => {
    const check = step.indexOf("checkLinkedInAction(");
    const invite = step.indexOf("sendLinkedInInvitation(");
    const message = step.indexOf("await sendMessage(");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(invite);
    expect(check).toBeLessThan(message);
    // Both send paths record, or the budget under-counts what the account did.
    expect((step.match(/recordLinkedInAction\(/g) ?? []).length).toBe(2);
  });

  it("defers rather than failing when the gate refuses", () => {
    // A throttled step is a wait, not a failure — failing it would burn a
    // touch the sequence still needs.
    const gateBlock = step.slice(step.indexOf("if (!gate.allowed)"));
    expect(gateBlock.slice(0, 200)).toContain('kind: "deferred"');
    expect(gateBlock.slice(0, 200)).toContain("stopChannel: true");
  });

  it("stops the channel for the tick instead of re-asking per step", () => {
    // Three queries per step to be told the same thing is the cost this avoids.
    expect(engine).toContain("let linkedinHeld: string | null = null;");
    expect(engine).toContain("if (linkedinHeld) continue;");
  });
});

describe("invite or message, decided by the relationship", () => {
  it("reads the state from unipile_invites rather than the sequence", () => {
    // You cannot message a non-connection, so the step's meaning depends on
    // whether they accepted — not on what the sequence author intended.
    expect(step).toContain("unipileInvites");
    expect(step).toContain('invite?.status === "accepted"');
  });

  it("waits on a pending invitation instead of re-inviting", () => {
    // A duplicate connection request is both useless and a risk signal.
    const pending = step.slice(step.indexOf("if (invite && !wantsMessage)"));
    expect(pending.slice(0, 400)).toContain('kind: "deferred"');
    expect(pending.slice(0, 400)).toContain("stopChannel: false");
  });

  it("records the invite it sends, so nothing invites that person twice", () => {
    // Social Autopilot dedupes against this table too.
    const sendBlock = step.slice(step.indexOf("sendLinkedInInvitation("));
    expect(sendBlock).toContain("db.insert(unipileInvites)");
  });
});

describe("a missing LinkedIn URL heals, like a missing email does", () => {
  it("fails with the healable reason", () => {
    expect(step).toContain("HEALABLE_NO_LINKEDIN");
    expect(HEALABLE_NO_LINKEDIN).toMatch(/LinkedIn/);
  });

  it("has its own heal, keyed on the profile URL rather than the email", () => {
    // One query covering both would revive each on the other's evidence.
    const heal = engine.slice(engine.indexOf("const linkedinHealable"));
    expect(heal.slice(0, 900)).toContain("isNotNull(prospectQueue.linkedinUrl)");
    expect(heal.slice(0, 900)).toContain("HEALABLE_NO_LINKEDIN");
  });

  it("counts as healable in the completion verdict too", () => {
    // The heal and the completion sweep disagreeing about "revivable" is
    // exactly how the 2026-08-08 lockout happened.
    const counting = engine.slice(engine.indexOf("healableFailed: sql"));
    expect(counting.slice(0, 500)).toContain("HEALABLE_NO_LINKEDIN");
    // And the verdict itself still refuses to finish a sequence with revivable
    // steps and no sends.
    expect(sequenceCompletionVerdict({ total: 3, stillScheduled: 0, sent: 0, healableFailed: 2 })).toBe(false);
  });
});

describe("the campaign's own switches still govern", () => {
  it("respects channelsEnabled.linkedin", () => {
    expect(engine).toContain("if (!channels.linkedin)");
    expect(engine).toContain("LinkedIn channel disabled on campaign");
  });

  it("still skips the channels that remain unwired", () => {
    expect(engine).toContain("the ARE engine sends email and LinkedIn");
  });

  it("stops a step whose prospect is no longer enrolled", () => {
    const branch = engine.slice(engine.indexOf('if (step.channel === "linkedin")'));
    expect(branch.slice(0, 3000)).toContain("no longer enrolled");
  });
});

describe("reviving the already-skipped steps is a decision, not a migration", () => {
  it("is a procedure the owner calls, and dry-runs by default", () => {
    // A migration flipping 54 rows silently would send touches written for a
    // moment two months gone.
    expect(execution).toContain("reviveSkippedSteps:");
    expect(execution).toContain("dryRun: z.boolean().default(true)");
  });

  it("matches the old wording as well as the new one", () => {
    // The reason sentence changed when the channel was wired; matching it
    // exactly would revive nothing.
    expect(execution).toContain("not wired%");
  });

  it("re-enrols prospects it revives", () => {
    // The completion sweep only scans "enrolled", so a re-queued step under a
    // completed prospect would dispatch beneath a lying status.
    const proc = execution.slice(execution.indexOf("reviveSkippedSteps:"));
    expect(proc.slice(0, 3000)).toContain('sequenceStatus: "enrolled"');
  });
});
