/**
 * The bounce / opt-out feedback loop.
 *
 * handleBounceEvent marks the draft and writes a suppression row, and stops
 * there — it never touches enrollments. sequenceEngine, in turn, checked
 * suppression nowhere. So a hard-bounced or unsubscribed recipient stayed
 * ACTIVELY enrolled and the engine minted a fresh `pending_review` draft for
 * every remaining step, once per five-minute tick.
 *
 * No mail escaped: every send path does check suppression (verified in the
 * previous sweep). What went wrong was quieter:
 *   • the review queue filled with drafts that can never be sent;
 *   • sequenceAbVariants.sentCount is bumped at DRAFT CREATION, so variant
 *     denominators counted sends that would never happen — understating the
 *     winning variant;
 *   • the enrollment ran its full course for someone who had already bounced or
 *     opted out.
 *
 * areEngine has always checked suppression at BOTH enrolment and dispatch. This
 * engine checked at neither, which is the same asymmetry that keeps producing
 * defects here: two engines doing the same job, one of them thoroughly.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("sequenceEngine honours the suppression list", () => {
  const src = stripComments(read("server/sequenceEngine.ts"));

  it("checks suppression before creating a draft", () => {
    expect(src).toMatch(/isSuppressed\(enrollment\.workspaceId,\s*toEmail\)/);
    expect(src).toMatch(/import \{ isSuppressed \} from "\.\/unsubscribe"/);
  });

  it("gates the draft insert on the suppression result", () => {
    // Paired with the existing hasContent guard, so a suppressed recipient
    // produces no draft while the enrollment still advances past the step —
    // skipping WITHOUT advancing would stall it on that step forever, the same
    // shape as an unhandled step type.
    expect(src).toMatch(/if \(hasContent && !suppressed\)/);
  });

  it("skips only the EMAIL step, and does not exit the enrollment", () => {
    /**
     * First attempt gated the whole enrollment and set status "exited". That was
     * an overreach: an email opt-out would also have cancelled this sequence's
     * `task` steps (a rep's phone call) and its LinkedIn steps, which are
     * different channels the person never opted out of. It also broke the
     * engine's own empty-body test, which was the signal worth listening to.
     */
    const guard = src.slice(src.indexOf("const suppressed = await isSuppressed"));
    expect(guard.slice(0, 300)).not.toMatch(/status: "exited"/);
    expect(guard.slice(0, 300)).not.toMatch(/status: "finished"/);
  });
});

describe("suppression existence checks match the stored form", () => {
  /**
   * Regression from the PREVIOUS sweep, found one iteration later.
   *
   * That commit normalised the suppression INSERT in handleBounceEvent but left
   * the existence check above it querying the raw `event.email`. The two then
   * disagreed: the check looks for a form that is never stored, misses every
   * time, and inserts a duplicate row on each repeat bounce for that address.
   *
   * The guard written alongside that fix did not catch it because it only
   * inspected `email:` assignment lines — the write — and not `eq(...)` reads.
   * Normalising a write without normalising the read that guards it is its own
   * little bug class.
   */
  it("handleBounceEvent normalises both the check and the insert", () => {
    const src = stripComments(read("server/emailTracking.ts"));
    const block = src.slice(src.indexOf("const suppressionReason"));
    const window = block.slice(0, 1200);
    expect(window).toMatch(/eq\(emailSuppressions\.email, normalizeSuppressionEmail\(event\.email\)\)/);
    expect(window).toMatch(/email: normalizeSuppressionEmail\(event\.email\)/);
    // The raw form must appear in neither.
    expect(window).not.toMatch(/emailSuppressions\.email,\s*event\.email\)/);
  });

  it("no suppression equality check compares against a raw value", () => {
    const files = [
      "server/emailTracking.ts",
      "server/unsubscribe.ts",
      "server/routers/emailSuppressions.ts",
      "server/services/replyClassifier.ts",
    ];
    const offenders: string[] = [];
    for (const f of files) {
      for (const line of stripComments(read(f)).split("\n")) {
        const m = line.match(/eq\(emailSuppressions\.email,\s*([^)]+)\)/);
        if (!m) continue;
        const arg = m[1].trim();
        const normalised =
          /normalizeSuppressionEmail\(/.test(arg) || arg === "lower" || /\.trim\(\)/.test(arg);
        if (!normalised) offenders.push(`${f}: eq(emailSuppressions.email, ${arg})`);
      }
    }
    expect(
      offenders,
      offenders.length
        ? `\n\nSuppression lookup(s) comparing an un-normalised value:\n  ${offenders.join("\n  ")}\n\n` +
            `The stored side is normalised, so an un-normalised query silently misses —\n` +
            `which reads as "not suppressed" on a do-not-contact list.\n`
        : undefined,
    ).toEqual([]);
  });
});
