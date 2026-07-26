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

describe("campaign targeting — added after the pilot mis-spent", () => {
  it("refuses to enrich a prospect with no campaign", async () => {
    const { isEnrichableCampaign } = await import("./services/apolloEnrich");
    // The first pilot spent 17 credits on orphaned rows: prospect_queue held
    // 559 rows while the live campaigns accounted for 177. An orphan will never
    // be mailed, so it must never be paid for.
    expect(isEnrichableCampaign(null)).toBe(false);
    expect(isEnrichableCampaign("")).toBe(false);
    expect(isEnrichableCampaign("   ")).toBe(false);
  });

  it("refuses to enrich seeded demo campaigns", async () => {
    const { isEnrichableCampaign } = await import("./services/apolloEnrich");
    // Demo people are invented — Apollo either finds nothing or matches a real
    // stranger who happens to share the name.
    expect(isEnrichableCampaign("[Demo] Autonomous Outbound — SaaS RevOps")).toBe(false);
    expect(isEnrichableCampaign("[demo] anything")).toBe(false);
  });

  it("allows real campaigns", async () => {
    const { isEnrichableCampaign } = await import("./services/apolloEnrich");
    expect(isEnrichableCampaign("Nonprofit Community Service")).toBe(true);
    expect(isEnrichableCampaign("AI Audit - CFO Cost Savings ROI")).toBe(true);
  });

  it("joins campaigns so orphaned prospects cannot be selected", () => {
    // An INNER join is what structurally excludes orphans; a left join would
    // silently reintroduce the bug.
    expect(SRC).toContain("innerJoin(areCampaigns");
  });

  it("reports spend per campaign so the target is never invisible", () => {
    // A single "eligible: 400" is what hid the wrong list the first time.
    expect(SRC).toContain("byCampaign");
  });
});
