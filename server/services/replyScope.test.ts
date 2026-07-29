import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/**
 * `email_replies` is NOT "replies to our outbound".
 *
 * inboundReplyPoller inserts a row for EVERY inbound message in the connected
 * mailbox and sets `draftId: matchedDraft?.id ?? null`. An unmatched row is
 * therefore ordinary private correspondence — on this workspace roughly 62,000
 * rows of the owner's Outlook inbox against zero genuine campaign replies.
 *
 * Any ENGINE that reads this table must scope to rows answering something we
 * actually sent. The Conversation Autopilot did not, so it fed the newest
 * private emails to a model and, in auto mode, created meetings from them.
 * Approval mode was no safeguard: it gates the action, not the classification.
 *
 * Asserted over the source because the failing query is DB-backed — a unit test
 * of the function would need the very database this is protecting.
 */
describe("email_replies scope in autonomous engines", () => {
  const ENGINES = [
    "server/services/replyClassifier.ts",
  ];

  for (const file of ENGINES) {
    it(`${file} scopes every emailReplies read to matched replies`, () => {
      const src = readFileSync(file, "utf8");
      // Selections that pull reply ROWS to act on (as opposed to count(*)
      // aggregates used for daily caps) must carry the draftId scope.
      const selects = src.split("\n").filter((l) => /db\.select\(\)\.from\(emailReplies\)/.test(l));
      expect(selects.length).toBeGreaterThan(0); // the read still exists
      expect(src).toContain("isNotNull(emailReplies.draftId)");
    });
  }

  it("keeps importing isNotNull, which a bundler would not catch", () => {
    const src = readFileSync("server/services/replyClassifier.ts", "utf8");
    expect(src).toMatch(/import\s*\{[^}]*\bisNotNull\b[^}]*\}\s*from\s*"drizzle-orm"/);
  });
});
