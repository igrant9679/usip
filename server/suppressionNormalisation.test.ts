/**
 * The suppression list is the do-not-contact list. A miss means mailing someone
 * who asked not to be mailed, which the notes correctly call a compliance
 * problem rather than a cosmetic one.
 *
 * It had four writers and two readers normalising four different ways:
 *   unsubscribe.ts        trim + lowercase   (the strict one)
 *   emailSuppressions.ts  lowercase only
 *   emailTracking.ts      RAW event.email    (bounce / spam-complaint webhooks)
 *   replyClassifier.ts    RAW reply.fromEmail
 * and the readers disagreed as well — isSuppressed trimmed, isEmailSuppressed
 * did not.
 *
 * Case was survivable: the column inherits MySQL 8's utf8mb4_0900_ai_ci, which
 * is case-insensitive. Whitespace was not — that collation is NO PAD, so a value
 * carrying a stray space fails to match. A raw webhook payload or an inbound
 * From header is exactly where such a value comes from. Relying on a collation
 * detail to paper over four inconsistent code paths is not a property this list
 * should have.
 *
 * One normaliser now, used on every read and every write.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSuppressionEmail } from "./unsubscribe";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("normalizeSuppressionEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeSuppressionEmail("  John.Doe@Example.COM ")).toBe("john.doe@example.com");
  });

  it("is idempotent", () => {
    const once = normalizeSuppressionEmail(" A@B.com ");
    expect(normalizeSuppressionEmail(once)).toBe(once);
  });

  it("handles null and undefined without throwing", () => {
    // Callers pass straight from webhook payloads and DB columns, both nullable.
    expect(normalizeSuppressionEmail(null)).toBe("");
    expect(normalizeSuppressionEmail(undefined)).toBe("");
    expect(normalizeSuppressionEmail("   ")).toBe("");
  });

  it("collapses the exact pair that used to diverge", () => {
    // isSuppressed said suppressed, isEmailSuppressed said not.
    const padded = " user@host.com";
    expect(normalizeSuppressionEmail(padded)).toBe(normalizeSuppressionEmail("user@host.com"));
  });
});

describe("one implementation, one normalisation", () => {
  it("isEmailSuppressed delegates rather than re-querying", () => {
    const src = stripComments(read("server/routers/emailSuppressions.ts"));
    expect(src).toMatch(/export async function isEmailSuppressed[\s\S]{0,160}return isSuppressed\(/);
    // The duplicated query must be gone, or the two can drift again.
    const body = src.slice(src.indexOf("export async function isEmailSuppressed"));
    expect(body.slice(0, 200)).not.toContain("emailSuppressions.email");
  });

  it("isSuppressed normalises and short-circuits an empty address", () => {
    const src = stripComments(read("server/unsubscribe.ts"));
    expect(src).toMatch(/normalizeSuppressionEmail\(email\)/);
    expect(src).toMatch(/if \(!lower\) return false;/);
  });

  it("every suppression WRITE normalises the address", () => {
    // The two raw ones came from a bounce webhook and an inbound From header —
    // the least trustworthy sources feeding the most consequential list.
    const writers: Array<[string, RegExp]> = [
      ["server/emailTracking.ts", /email: normalizeSuppressionEmail\(event\.email\)/],
      ["server/services/replyClassifier.ts", /email: normalizeSuppressionEmail\(reply\.fromEmail\)/],
      ["server/routers/emailSuppressions.ts", /email: normalizeSuppressionEmail\(input\.email\)/],
      ["server/unsubscribe.ts", /email: lower/],
    ];
    const missing = writers.filter(([f, re]) => !re.test(stripComments(read(f)))).map(([f]) => f);
    expect(
      missing,
      missing.length
        ? `\n\nSuppression write(s) not normalising the address:\n  ${missing.join("\n  ")}\n\n` +
            `Use normalizeSuppressionEmail() from server/unsubscribe.ts. An un-normalised\n` +
            `row is a do-not-contact entry that no reader can match.\n`
        : undefined,
    ).toEqual([]);
  });

  it("no suppression query lowercases without trimming", () => {
    // `.toLowerCase()` on its own was the whole bug; it looks like normalisation
    // and silently is not.
    const files = [
      "server/unsubscribe.ts",
      "server/routers/emailSuppressions.ts",
      "server/emailTracking.ts",
      "server/services/replyClassifier.ts",
    ];
    const offenders: string[] = [];
    for (const f of files) {
      stripComments(read(f)).split("\n").forEach((line, i) => {
        if (!/emailSuppressions\.email|email:/.test(line)) return;
        if (/\.toLowerCase\(\)/.test(line) && !/\.trim\(\)/.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(
      offenders,
      offenders.length ? `\n\nLowercase-without-trim on a suppression address:\n  ${offenders.join("\n  ")}\n` : undefined,
    ).toEqual([]);
  });
});
