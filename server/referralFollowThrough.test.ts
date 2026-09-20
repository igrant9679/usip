/**
 * Referral + wrong-person follow-through (owner ask 2026-09-20): the
 * classifier's person_referral and left-company branches must do what the
 * Help Center has always claimed — create the referred person in People
 * (through the ONE person seam), draft the intro into the review queue
 * (never send), and flag departed contacts. These pins guard the seam the
 * dead-wiring class eats: a classifier that detects and then drops.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), "utf8");

describe("referral replies follow through", () => {
  it("the classifier's referral branch calls the handler and carries the reply's words", () => {
    const rc = read("services", "replyClassifier.ts");
    expect(rc).toContain("handleReferralReply");
    expect(rc).toContain("handleWrongPersonReply");
    // The task description now quotes the reply, not just "Re: subject".
    expect(rc).toContain('They wrote: "');
  });

  it("the handler goes through the one person seam and the review queue, never a send", () => {
    const h = read("services", "referralHandler.ts");
    // People creation through personLink — never a bare prospects insert.
    expect(h).toContain("upsertPersonForRow");
    expect(h).not.toContain("db.insert(prospects)");
    // The draft is a review-queue row (pending_review, AI-flagged) so it
    // shows on Home and under the Emails ai_draft chip; no send call.
    expect(h).toContain('status: "pending_review"');
    expect(h).toContain("aiGenerated: true");
    expect(h).not.toContain("sendWorkspaceEmail");
    expect(h).not.toContain("sendCampaignEmailViaPool");
    // The no-email door: a draft exists only when an address does.
    expect(h).toContain("usableEmailOrNull");
    // Grounded extraction — the model may not invent the person.
    expect(h).toContain("Never invent names");
  });

  it("wrong-person flags departed without deleting", () => {
    const h = read("services", "referralHandler.ts");
    expect(h).toContain("departed: true");
    expect(h).not.toContain("db.delete(contacts)");
  });

  it("the operator manual's promise matches the code now", () => {
    const manual = read("seedHelpOperatorManual.ts");
    expect(manual).toContain("the referred person is created in People");
    expect(manual).toContain("flagged departed");
  });
});
