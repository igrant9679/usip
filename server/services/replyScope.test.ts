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
  /**
   * Every consumer that DERIVES A DECISION from this table.
   *
   * leadScoring was added on 2026-07-29. It counted replies with
   * `eq(emailReplies.leadId, leadId)` and no draftId scope — and the poller sets
   * `leadId` from a bare address match (`leads.email = fromEmail`, poller ~line
   * 266) with no requirement that we ever sent that person anything. So ordinary
   * private mail from anyone who happens to be a lead counted as a reply to
   * outreach, which is the strongest positive signal in the score. Same table
   * and same omission as `aecfbbe`; that pass scoped the classifier and missed
   * this consumer, which is exactly why this list exists.
   *
   * Deliberately NOT listed, and why:
   *   routers/conversations.ts  the triage INBOX UI — listing the user's own
   *                             inbound mail is what an inbox does. Narrowing it
   *                             would hide data; that is a product decision.
   *   routers/mailbox.ts        fetches one reply by explicit id for a
   *                             user-initiated action.
   *   unipileWebhook.ts         dedupe lookup by messageId, derives nothing.
   *   services/performanceMetrics.ts  already carries the scope.
   */
  const ENGINES = [
    "server/services/replyClassifier.ts",
    "server/routers/leadScoring.ts",
  ];

  for (const file of ENGINES) {
    it(`${file} scopes every emailReplies read to matched replies`, () => {
      const src = readFileSync(file, "utf8");
      // Reads that pull reply rows to act on — whether the whole row or a
      // projection — must carry the draftId scope.
      const reads = src.split("\n").filter((l) => /\.from\(emailReplies\)/.test(l));
      expect(reads.length, `${file} no longer reads emailReplies — update this list`).toBeGreaterThan(0);
      expect(src).toContain("isNotNull(emailReplies.draftId)");
    });

    it(`${file} imports isNotNull, which a bundler would not catch`, () => {
      // A missing import is a free identifier to esbuild: it compiles, ships,
      // and throws on the first call. This happened three times on 2026-07-29,
      // including in the leadScoring fix above.
      const src = readFileSync(file, "utf8");
      expect(src).toMatch(/import\s*\{[^}]*\bisNotNull\b[^}]*\}\s*from\s*"drizzle-orm"/);
    });
  }
});
