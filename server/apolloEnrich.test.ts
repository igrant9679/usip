/**
 * Apollo People Enrichment — this module spends real money, so the tests pin
 * the cost-safety properties rather than the happy path.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { usableEmail } from "./services/apolloEnrich";

const SRC = readFileSync("server/services/apolloEnrich.ts", "utf8");

describe("usableEmail — the placeholder trap", () => {
  it("rejects Apollo's locked-email sentinel", () => {
    // Storing this would look valid to ARE dispatch, which would then mail into
    // the void and burn sender reputation.
    expect(usableEmail("email_not_unlocked@acme.com")).toBeNull();
    expect(usableEmail("not_unlocked@acme.com")).toBeNull();
  });

  it("rejects anything that isn't a plausible address", () => {
    expect(usableEmail("")).toBeNull();
    expect(usableEmail(null)).toBeNull();
    expect(usableEmail("acme.com")).toBeNull();
    expect(usableEmail("john@localhost")).toBeNull();
  });

  it("accepts and normalises a real address", () => {
    expect(usableEmail("  John.Smith@Acme.com ")).toBe("john.smith@acme.com");
  });
});

describe("cost safety", () => {
  it("never requests a phone number (+8 credits per person)", () => {
    expect(SRC).not.toMatch(/reveal_phone_number:\s*true/);
    expect(SRC).toContain("reveal_personal_emails: false");
  });

  it("defaults to a dry run", () => {
    expect(SRC).toContain("const dryRun = opts.dryRun !== false");
    // The dry run must return before any network call is made.
    expect(SRC).toMatch(/if \(dryRun\) return result;/);
  });

  it("stops the batch on a credit or rate limit rather than hammering", () => {
    expect(SRC).toMatch(/status === 402 \|\| res\.status === 429/);
  });

  it("keeps the paid endpoint out of the search-only module", () => {
    // apollo.ts documents that credit spend is structurally impossible there.
    // It legitimately *mentions* /people/match in prose to explain what it does
    // NOT call, so assert on CODE lines only — a mention is fine, a call is not.
    const searchOnly = readFileSync("server/services/apollo.ts", "utf8");
    const codeHits = searchOnly
      .split("\n")
      .filter((l) => l.includes("people/match"))
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l));
    expect(codeHits).toEqual([]);
  });
});
