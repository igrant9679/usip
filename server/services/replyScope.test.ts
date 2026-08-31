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

      /**
       * PER-READ, not per-file.
       *
       * This was `expect(src).toContain("isNotNull(emailReplies.draftId)")`,
       * which one scoped read satisfies for the whole file no matter how many
       * unscoped siblings join it — the same weakness that let two ungated cron
       * endpoints sit behind a file-level `toContain` (b15490d). It was already
       * inaccurate: replyClassifier.ts has TWO reads and one scope.
       *
       * Each read is checked in its own statement window (from `.from(` to the
       * terminating `;`), so adding an unscoped read is what fails, not just
       * deleting the last scope.
       */
      const ALLOWED_UNSCOPED: Record<string, string> = {
        // The daily-cap counter in runConversationAutopilotAllWorkspaces. It
        // counts rows already CLASSIFIED today (`classifiedAt >= dayStart`) to
        // work out remaining budget — it derives no decision about a person and
        // reads no message content. Scoping it would under-count the LLM calls
        // the cap exists to bound, since a rep classifying a message by hand
        // from the triage inbox spends the same money.
        "count(*)": "server/services/replyClassifier.ts",
      };

      const unscoped: string[] = [];
      for (const [i, line] of src.split("\n").entries()) {
        if (!/\.from\(emailReplies\)/.test(line)) continue;
        // The statement this read belongs to: from the `.from(` line forward to
        // the `;` that ends it. Starting EARLIER than the read line is wrong —
        // a `;` on any preceding line truncates the window to nothing, and the
        // read then looks unscoped no matter what it carries. That is how the
        // first version of this check flagged the allowlisted counter.
        const win = src.split("\n").slice(i, i + 12).join("\n");
        const end = win.indexOf(";");
        const stmt = end === -1 ? win : win.slice(0, end + 1);
        // Either form satisfies the invariant: the shared helper (the ONE
        // definition, replyScope.ts — draft-matched OR campaign-matched,
        // 2026-08-28) or the original draft-only literal where a read is
        // legitimately draft-specific.
        if (stmt.includes("genuineReplyScope()")) continue;
        if (stmt.includes("isNotNull(emailReplies.draftId)")) continue;
        const excuse = Object.entries(ALLOWED_UNSCOPED).find(
          ([marker, f]) => f === file && stmt.includes(marker),
        );
        if (excuse) continue;
        unscoped.push(`${file}:${i + 1}  ${line.trim()}`);
      }

      expect(
        unscoped,
        unscoped.length
          ? `\n\nUnscoped read(s) of email_replies in an autonomous engine:\n  ${unscoped.join("\n  ")}\n\n` +
              `This table holds ALL synced inbound mail — ~62,000 rows of private\n` +
              `correspondence against zero genuine campaign replies. A read without\n` +
              `isNotNull(emailReplies.draftId) treats private mail as a reply to\n` +
              `outreach. Add the scope, or allowlist it here with the reason.\n`
          : undefined,
      ).toEqual([]);
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
